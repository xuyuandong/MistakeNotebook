import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  concepts,
  learnerSummaries,
  learningEvents,
  mastery,
  memoryEvidence,
  memoryFacts,
  mistakeConcepts,
  mistakes,
  modelRuns,
} from "../../db/schema.js";
import {
  AnalyzeMistakeResult,
  BatchAnalyzeMistakeResult,
  LearnerSummaryUpdate,
  type Subject,
} from "@mistake-book/shared";
import { parseModelJson, normalizeAnalyzeBatch } from "../../ai/parse.js";
import type { JobRecord } from "../queue.js";
import type { JobHandler } from "../loop.js";
import type { HandlerContext } from "./judge.js";
import { promptFor, ERROR_TYPE_NAMES } from "../../prompts/registry.js";
import { resolveOrCreateConcept } from "../../services/concepts.js";
import { recomputeMasteryForConcept } from "../../services/mastery.js";

const BATCH_SIZE = 10;

interface PendingMistake {
  id: string;
  subject: string;
  version: number;
  contentJson: string;
  gradeAtTime: string | null;
}

/** 水位语义:只处理 learning_event.occurred_at <= 水位的题目(任务期间新录入留给下一次)。
 *  pending_analysis(待错误归因)与 waiting_input(缺学生答案)都参与:
 *  waiting_input 只做知识概念发现与疑问追问,不臆测错误原因(PRD 5.2.2/5.2.5)。 */
function loadPending(
  db: HandlerContext["db"],
  userId: string,
  toEventId: string | null,
): PendingMistake[] {
  if (!toEventId) return [];
  const watermark = db
    .select()
    .from(learningEvents)
    .where(eq(learningEvents.id, toEventId))
    .get();
  if (!watermark) return [];
  const rows = db.all<{
    id: string;
    subject: string;
    current_version_id: string;
    grade_at_time: string | null;
    content_json: string;
  }>(sql`
    SELECT m.id, m.subject, m.current_version_id, m.grade_at_time, v.content_json
    FROM mistakes m
    JOIN mistake_versions v ON v.id = m.current_version_id
    WHERE m.user_id = ${userId}
      AND m.status IN ('pending_analysis', 'waiting_input')
      AND EXISTS (
        SELECT 1 FROM learning_events e
        WHERE e.source_id = m.id AND e.event_type = 'mistake_recorded'
          AND e.occurred_at <= ${watermark.occurredAt}
      )
  `);
  return rows.map((r) => {
    const ver = db.get<{ version: number }>(
      sql`SELECT version FROM mistake_versions WHERE id = ${r.current_version_id}`,
    );
    return {
      id: r.id,
      subject: r.subject,
      version: ver?.version ?? 1,
      contentJson: r.content_json,
      gradeAtTime: r.grade_at_time,
    };
  });
}

interface AnalysisPayload {
  index: number;
  questionMd: string;
  options?: string[];
  myAnswer?: string;
  correctAnswer?: string;
  note?: string;
  gradeAtTime?: string | null;
}

/**
 * refresh_learner_analysis(AGENTS §5 / HLD §9.4):
 * 按学科分批(≤10 道)调文本模型 → 每题短事务幂等落库 + 确定性重算
 * → 生成新版学科总结 → 推进水位。部分失败保留旧总结,失败题留待下次。
 */
export function makeAnalyzeHandler(
  ctx: HandlerContext & { rawStore: import("../../ai/rawlog.js").RawRunStore },
): JobHandler {
  return async (job: JobRecord) => {
    const { db, logger } = ctx;
    const pending = loadPending(db, job.userId, job.toEventId);
    if (pending.length === 0) return;

    const bySubject = new Map<string, PendingMistake[]>();
    for (const m of pending) {
      const list = bySubject.get(m.subject) ?? [];
      list.push(m);
      bySubject.set(m.subject, list);
    }

    for (const [subject, list] of bySubject) {
      for (let i = 0; i < list.length; i += BATCH_SIZE) {
        const batch = list.slice(i, i + BATCH_SIZE);
        await analyzeBatch(ctx, job, subject as Subject, batch);
      }
      await summarizeSubject(ctx, job, subject as Subject);
    }
  };
}

async function analyzeBatch(
  ctx: HandlerContext,
  job: JobRecord,
  subject: Subject,
  batch: PendingMistake[],
): Promise<void> {
  const { db, chat, logger } = ctx;
  const prompt = promptFor("analyze_mistake");

  const items: AnalysisPayload[] = batch.map((m, idx) => {
    const content = JSON.parse(m.contentJson) as {
      stemMd: string;
      options?: string[];
      myAnswer?: string;
      correctAnswer?: string;
      note?: string;
    };
    return {
      index: idx,
      questionMd: content.stemMd,
      options: content.options,
      myAnswer: content.myAnswer,
      correctAnswer: content.correctAnswer,
      note: content.note,
      gradeAtTime: m.gradeAtTime,
    };
  });

  const res = await chat.chat("text", {
    taskType: "analyze_mistake",
    system: prompt.system,
    messages: [
      { role: "user", content: prompt.buildUser({ subject, items, currentGrade: null }) },
    ],
    jsonMode: true,
    jobId: job.id,
  });
  ctx.rawStore.save(
    "analyze_mistake",
    `job-${job.id}-batch-${Math.floor(batch[0].version)}`,
    {
      taskType: "analyze_mistake",
      provider: res.run.provider,
      model: res.run.model,
      promptVersion: prompt.version,
      createdAt: new Date().toISOString(),
      key: `job-${job.id}`,
      rawText: res.text,
      parsed: null,
      status: res.run.status === "ok" ? "ok" : "api_error",
    },
  );
  db.insert(modelRuns)
    .values({
      id: res.run.id,
      jobId: job.id,
      taskType: res.run.taskType,
      provider: res.run.provider,
      model: res.run.model,
      promptVersion: prompt.version,
      status: res.run.status,
      durationMs: res.run.durationMs,
      usageJson: res.run.usageJson,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();

  let parsed: ReturnType<typeof BatchAnalyzeMistakeResult.parse>;
  try {
    parsed = BatchAnalyzeMistakeResult.parse(
      normalizeAnalyzeBatch(parseModelJson(res.text)),
    );
  } catch (e) {
    db.update(modelRuns)
      .set({ status: "schema_fail", error: (e as Error).message })
      .where(eq(modelRuns.id, res.run.id))
      .run();
    // 批次失败:本批题目保持 pending_analysis,下次重试(HLD §9.4 部分失败恢复)
    logger.warn(`analyze batch schema fail: ${(e as Error).message}`);
    return;
  }

  for (const item of parsed.results) {
    const mistake = batch[item.index];
    if (!mistake) continue;
    try {
      // 硬约束:无学生答案且无备注 → 不得归因为任何具体错误类型(空白 ≠ 完全不会)
      const payload = items[item.index];
      const hasStudentInput = Boolean(payload?.myAnswer || payload?.note);
      const analysis = AnalyzeMistakeResult.parse(item);
      writeAnalysis(db, job.userId, mistake, analysis, prompt.version, hasStudentInput);
    } catch (e) {
      logger.warn(`write analysis for ${mistake.id} failed: ${(e as Error).message}`);
    }
  }
}

/** 单题分析结果幂等落库:按 (错题版本, 提示词版本) 跳过;重试与提示词升级语义见 LLD §7.5 */
function writeAnalysis(
  db: HandlerContext["db"],
  userId: string,
  mistake: PendingMistake,
  analysis: ReturnType<typeof AnalyzeMistakeResult.parse>,
  promptVersion: string,
  hasStudentInput: boolean,
): void {
  const affectedConceptIds: string[] = [];

  // 空白题 = 学生完全不会(用户 2026-08-29 决策):正常归因,不追问补充
  const effective = hasStudentInput
    ? analysis
    : { ...analysis, needsFollowUp: false, followUpQuestion: null };

  db.transaction((tx) => {
    const row = tx
      .select()
      .from(mistakes)
      .where(and(eq(mistakes.id, mistake.id), eq(mistakes.userId, userId)))
      .get();
    if (!row) return;
    if (
      row.analysisVersion === mistake.version &&
      row.analysisPromptVersion === promptVersion
    ) {
      return; // 幂等:该版本 + 该提示词版本已分析过
      }

    for (const c of effective.concepts) {
      const conceptId = resolveOrCreateConcept(
        tx as unknown as Parameters<typeof resolveOrCreateConcept>[0],
        userId,
        mistake.subject as Subject,
        c.name,
        mistake.id,
        c.confidence,
      );
      affectedConceptIds.push(conceptId);
      tx.insert(mistakeConcepts)
        .values({
          id: randomUUID(),
          mistakeId: mistake.id,
          conceptId,
          mistakeVersion: mistake.version,
          isPrimary: c.isPrimary ? 1 : 0,
          evidence: c.evidence ?? null,
          confidence: c.confidence,
          confirmedAt: null, // AI 建议,待用户确认
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
    }

    // 主动归因(2026-08-29 决策):已给出归因 → analyzed;追问仅作展示,不阻塞;
    // 只有完全无依据(unconfirmed)且模型要求追问时才回 waiting_input
    tx.update(mistakes)
      .set({
        status:
          effective.needsFollowUp && effective.primaryErrorType === "unconfirmed"
            ? "waiting_input"
            : "analyzed",
        errorType: effective.primaryErrorType,
        errorEvidence: effective.evidence ?? null,
        improvementsJson: JSON.stringify({
          technical: effective.improvementSuggestions,
          method: effective.methodAdvice ?? [],
          cognitive: effective.cognitiveAdvice ?? [],
          profileInferred: effective.profileInferred ?? false,
        }),
        analysisConfidence: effective.confidence,
        analysisVersion: mistake.version,
        analysisPromptVersion: promptVersion,
        needsFollowUp: effective.needsFollowUp ? 1 : 0,
        followUpQuestion: effective.followUpQuestion ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(mistakes.id, mistake.id))
      .run();

    // 学习方法/习惯画像 → memory_facts(kind='habit_pattern'),带证据与置信度(PRD 5.2.2)
    for (const statement of effective.habitIssues ?? []) {
      const exists = tx
        .select()
        .from(memoryFacts)
        .all()
        .some(
          (f) =>
            f.userId === userId &&
            f.scope === mistake.subject &&
            f.kind === "habit_pattern" &&
            f.statement === statement &&
            f.status !== "rejected",
        );
      if (exists) continue; // 同结论不重复入档
      const factId = randomUUID();
      tx.insert(memoryFacts)
        .values({
          id: factId,
          userId,
          scope: mistake.subject,
          kind: "habit_pattern",
          statement,
          confidence: effective.confidence,
          status: "active",
          validFrom: new Date().toISOString(),
          modelRunId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();
      tx.insert(memoryEvidence)
        .values({
          id: randomUUID(),
          memoryFactId: factId,
          sourceType: "mistake",
          sourceId: mistake.id,
          weight: 1,
        })
        .onConflictDoNothing()
        .run();
    }
  });

  // 事务外确定性重算受影响概念的掌握度
  for (const conceptId of new Set(affectedConceptIds)) {
    recomputeMasteryForConcept(db, userId, conceptId);
  }
}

/** 学科总结:上一版 + 本次新增 + 最新统计 → 新版总结(校验失败保留旧总结) */
async function summarizeSubject(
  ctx: HandlerContext,
  job: JobRecord,
  scope: Subject,
): Promise<void> {
  const { db, chat, logger } = ctx;
  const prompt = promptFor("summarize_learner");
  const previous = db
    .select()
    .from(learnerSummaries)
    .where(and(eq(learnerSummaries.userId, job.userId), eq(learnerSummaries.scope, scope)))
    .get();

  const conceptRows = db
    .select()
    .from(concepts)
    .all()
    .filter((c) => c.userId === job.userId && c.subject === scope && c.status === "active");
  const masteryRows = db.select().from(mastery).all();
  const stats: string[] = [];
  for (const c of conceptRows.slice(0, 20)) {
    const m = masteryRows.find((x) => x.conceptId === c.id);
    if (m) stats.push(`${c.canonicalName}: 掌握分 ${m.score},样本 ${m.sampleCount}`);
  }

  const recent = db
    .select()
    .from(mistakes)
    .all()
    .filter(
      (m) =>
        m.userId === job.userId && m.subject === scope && m.errorType && m.status === "analyzed",
    )
    .slice(-10)
    .map((m) => {
      const content = m.currentVersionId
        ? (JSON.parse(
            db.get<{ content_json: string }>(
              sql`SELECT content_json FROM mistake_versions WHERE id = ${m.currentVersionId}`,
            )?.content_json ?? "{}",
          ) as { stemMd?: string })
        : {};
      return `${m.id}: ${String(content.stemMd ?? "").slice(0, 80)} → ${ERROR_TYPE_NAMES[m.errorType as keyof typeof ERROR_TYPE_NAMES] ?? m.errorType}`;
    });

  try {
    const res = await chat.chat("text", {
      taskType: "summarize_learner",
      system: prompt.system,
      messages: [
        {
          role: "user",
          content: prompt.buildUser({
            scope,
            previousSummary: previous
              ? ((JSON.parse(previous.summaryJson) as { summaryMd?: string }).summaryMd ?? null)
              : null,
            newAnalyses: recent,
            stats,
          }),
        },
      ],
      jsonMode: true,
      jobId: job.id,
    });
    db.insert(modelRuns)
      .values({
        id: res.run.id,
        jobId: job.id,
        taskType: res.run.taskType,
        provider: res.run.provider,
        model: res.run.model,
        promptVersion: prompt.version,
        status: res.run.status,
        durationMs: res.run.durationMs,
        usageJson: res.run.usageJson,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();

    const parsed = LearnerSummaryUpdate.parse(JSON.parse(res.text));
    const asOf = db
      .select()
      .from(learningEvents)
      .where(eq(learningEvents.userId, job.userId))
      .all()
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];

    db.transaction((tx) => {
      if (previous) {
        tx.update(learnerSummaries)
          .set({
            summaryJson: JSON.stringify(parsed),
            asOfEventId: asOf?.id ?? previous.asOfEventId,
            version: previous.version + 1,
            generatedAt: new Date().toISOString(),
            modelRunId: res.run.id,
          })
          .where(eq(learnerSummaries.id, previous.id))
          .run();
      } else {
        tx.insert(learnerSummaries)
          .values({
            id: randomUUID(),
            userId: job.userId,
            scope,
            summaryJson: JSON.stringify(parsed),
            asOfEventId: asOf?.id ?? "",
            version: 1,
            generatedAt: new Date().toISOString(),
            modelRunId: res.run.id,
          })
          .run();
      }
    });
  } catch (e) {
    // 部分失败:保留旧总结(HLD §9.4)
    logger.warn(`summarize ${scope} failed: ${(e as Error).message}`);
  }
}
