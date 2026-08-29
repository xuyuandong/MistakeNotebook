import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  concepts,
  generatedQuestions,
  mastery,
  mistakeConcepts,
  mistakes,
  mistakeVersions,
  modelRuns,
  practiceSets,
} from "../../db/schema.js";
import {
  GeneratedQuestion,
  GenerateQuestionsResult,
  SelectTopicsResult,
  isFigureDependent,
} from "@mistake-book/shared";
import { parseModelJson, normalizeGenerateQuestions } from "../../ai/parse.js";
import type { JobRecord } from "../queue.js";
import type { JobHandler } from "../loop.js";
import type { HandlerContext } from "./judge.js";
import type { RawRunStore } from "../../ai/rawlog.js";
import { promptFor, ERROR_TYPE_NAMES } from "../../prompts/registry.js";
import { resolveOrCreateConcept } from "../../services/concepts.js";
import type { Subject } from "@mistake-book/shared";

interface GeneratePayload {
  practiceSetId: string;
}

interface SetParams {
  mode: "past" | "new";
  difficulty?: number;
  questionType?: string;
  count: number;
}

interface SetSelection {
  targetConcepts: string[];
  rationale: string;
  /** past 模式选中的历史错题 */
  mistakeIds?: string[];
}

/**
 * generate_questions(LLD §4.4):
 * 1) select_topics 选题分析:输入掌握度/错题分布/复习情况 → 目标知识点与理由(存 selection_json);
 * 2) mode='past'(默认,出旧题):确定性检索历史错题组卷,LLM 不生成内容;
 *    mode='new'(编新题):LLM 生成变式题,走四道校验(PRD 5.3.4)。
 */
export function makeGenerateHandler(ctx: HandlerContext & { rawStore: RawRunStore }): JobHandler {
  return async (job: JobRecord) => {
    const { db, chat, logger, rawStore } = ctx;
    const payload = job.payload as GeneratePayload;
    const set = db
      .select()
      .from(practiceSets)
      .where(eq(practiceSets.id, payload.practiceSetId))
      .get();
    if (!set || set.userId !== job.userId) return;
    const params = JSON.parse(set.paramsJson) as SetParams;
    const subject = set.subject as Subject;

    // ---- 1. 选题分析(两种模式都需要,输出面向学生的选题理由)----
    const selection = await selectTopics(ctx, job, subject, params);
    if (selection === null) {
      finishSet(db, set.id, "failed", 0, "选题分析失败");
      return;
    }

    // ---- 2a. past 模式:确定性选题历史错题 ----
    if (params.mode === "past") {
      const mistakeIds = pickPastMistakes(db, job.userId, subject, selection.targetConcepts, params.count);
      if (mistakeIds.length === 0) {
        const anyMistake = db
          .select()
          .from(mistakes)
          .all()
          .some((m) => m.userId === job.userId && m.subject === subject && m.archived === 0);
        finishSet(
          db,
          set.id,
          "failed",
          0,
          anyMistake
            ? "可练习的历史错题不足:依赖图形、无法文字作答的题目已排除,可改用“编新题”模式"
            : "没有可用的历史错题,请改用“编新题”模式或先导入错题",
        );
        return;
      }
      selection.mistakeIds = mistakeIds;
      db.update(practiceSets)
        .set({
          selectionJson: JSON.stringify(selection),
          status: "ready",
          completedAt: new Date().toISOString(),
        })
        .where(eq(practiceSets.id, set.id))
        .run();
      return;
    }

    // ---- 2b. new 模式:生成变式题 + 四道校验 ----
    let conceptNames = selection.targetConcepts.filter(Boolean);
    let reference: { stemMd: string; note?: string } | null = null;
    if (set.origin === "mistake" && set.mistakeId) {
      const m = db
        .select()
        .from(mistakes)
        .where(and(eq(mistakes.id, set.mistakeId), eq(mistakes.userId, job.userId)))
        .get();
      if (m) {
        const ver = m.currentVersionId
          ? db
              .select({ contentJson: mistakeVersions.contentJson })
              .from(mistakeVersions)
              .where(eq(mistakeVersions.id, m.currentVersionId))
              .get()
          : undefined;
        const c = ver
          ? (JSON.parse(ver.contentJson) as { stemMd?: string; note?: string })
          : {};
        reference = { stemMd: c.stemMd ?? "", note: c.note };
        if (conceptNames.length === 0) {
          conceptNames = db
            .select()
            .from(mistakeConcepts)
            .all()
            .filter((r) => r.mistakeId === m.id)
            .map((r) => r.conceptId)
            .map((cid) =>
              db.select().from(concepts).all().find((c2) => c2.id === cid)?.canonicalName ?? "",
            )
            .filter(Boolean);
        }
      }
    }
    if (conceptNames.length === 0) {
      // 选题分析没有命中既有概念 → 由模型按学科/年级自主命题,生成题的 concepts 反哺概念库(自举)
      const conceptRows = db
        .select()
        .from(concepts)
        .all()
        .filter((c) => c.userId === job.userId && c.subject === subject && c.status === "active");
      const masteryRows = db.select().from(mastery).all().filter((m) => m.userId === job.userId);
      conceptNames = conceptRows
        .map((c) => ({
          name: c.canonicalName,
          score: masteryRows.find((m) => m.conceptId === c.id)?.score ?? 50,
        }))
        .sort((a, b) => a.score - b.score)
        .slice(0, 3)
        .map((o) => o.name);
    }

    const prompt = promptFor("generate_questions");
    const buildCall = () =>
      chat.chat("text", {
        taskType: "generate_questions",
        system: prompt.system,
        messages: [
          {
            role: "user",
            content: prompt.buildUser({
              subject,
              currentGrade: null,
              count: params.count,
              difficulty: params.difficulty,
              questionType: params.questionType,
              concepts: conceptNames,
              referenceMistake: reference,
            }),
          },
        ],
        jsonMode: true,
        jobId: job.id,
      });

    let candidates: GeneratedQuestion[] = [];
    let lastSchemaError: string | null = null;
    for (let attempt = 1; attempt <= 2 && candidates.length === 0; attempt++) {
      const res = await buildCall();
      rawStore.save("generate_questions", `set-${payload.practiceSetId}-try${attempt}`, {
        taskType: "generate_questions",
        provider: res.run.provider,
        model: res.run.model,
        promptVersion: prompt.version,
        createdAt: new Date().toISOString(),
        key: `set-${payload.practiceSetId}`,
        rawText: res.text,
        parsed: null,
        status: res.run.status === "ok" ? "ok" : "api_error",
      });
      insertModelRun(db, job.id, res.run, prompt.version);

      try {
        const parsed = GenerateQuestionsResult.parse(
          normalizeGenerateQuestions(parseModelJson(res.text)),
        );
        candidates = parsed.questions;
      } catch (e) {
        db.update(modelRuns)
          .set({ status: "schema_fail", error: (e as Error).message })
          .where(eq(modelRuns.id, res.run.id))
          .run();
        logger.warn(`generate schema fail (attempt ${attempt}): ${(e as Error).message}`);
        lastSchemaError = (e as Error).message;
      }
    }

    // 逐题校验与落库
    const existingStems = new Set(
      db
        .select()
        .from(generatedQuestions)
        .all()
        .filter((g) => g.userId === job.userId)
        .map((g) => (JSON.parse(g.questionJson) as GeneratedQuestion).stemMd.trim()),
    );
    if (reference) existingStems.add(reference.stemMd.trim());

    let valid = 0;
    const discard: string[] = [];
    for (const q of candidates) {
      // 依赖图形的题学生无法作答(系统不携带插图),程序化丢弃,不浪费复核调用(PRD 5.3)
      if (isFigureDependent(q.stemMd)) {
        discard.push("依赖图形");
        continue;
      }

      // 与原题/已有题完全重复 → 拒绝
      if (existingStems.has(q.stemMd.trim())) {
        discard.push("与已有题重复");
        continue;
      }

      // 数学客观题独立复核;主观题没有唯一答案,不走复核(评分要点已在 Schema 层要求)
      // 复核不通过 → 丢弃该题不凑数
      if (subject === "math" && q.type !== "subjective") {
        const vPrompt = promptFor("verify_question");
        const vRes = await chat.chat("text", {
          taskType: "verify_question",
          system: vPrompt.system,
          messages: [{ role: "user", content: vPrompt.buildUser({ question: q }) }],
          jsonMode: true,
          jobId: job.id,
        });
        rawStore.save("verify_question", `set-${payload.practiceSetId}-q${valid + 1}`, {
          taskType: "verify_question",
          provider: vRes.run.provider,
          model: vRes.run.model,
          promptVersion: vPrompt.version,
          createdAt: new Date().toISOString(),
          key: `set-${payload.practiceSetId}-q${valid + 1}`,
          rawText: vRes.text,
          parsed: null,
          status: vRes.run.status === "ok" ? "ok" : "api_error",
        });
        insertModelRun(db, job.id, vRes.run, vPrompt.version);
        try {
          const verdict = parseModelJson(vRes.text) as {
            answerCorrect: boolean;
            confidence: number;
          };
          if (!verdict.answerCorrect || verdict.confidence < 0.4) {
            discard.push("独立复核未通过");
            continue;
          }
        } catch {
          discard.push("独立复核输出异常");
          continue;
        }
      }

      // 概念名 → 概念 ID(无则创建,保证出题也能发现新概念)
      const conceptIds = q.concepts.map((name) =>
        resolveOrCreateConcept(db, job.userId, subject, name),
      );

      db.insert(generatedQuestions)
        .values({
          id: randomUUID(),
          practiceSetId: set.id,
          userId: job.userId,
          subject,
          questionJson: JSON.stringify(q),
          status: "valid",
          modelRunId: null,
          conceptIdsJson: JSON.stringify(conceptIds),
          createdAt: new Date().toISOString(),
        })
        .run();
      existingStems.add(q.stemMd.trim());
      valid++;
    }

    const status = valid === 0 ? "failed" : "ready";
    const summary = [
      ...(candidates.length === 0 && lastSchemaError
        ? [`模型输出连续不符合题目结构:${lastSchemaError.slice(0, 120)}(原始输出已落盘 data/ai-raw/)】`.replace("】", "")]
        : []),
      `生成 ${candidates.length} 道,合格 ${valid} 道`,
      ...(discard.length ? [`丢弃:${[...new Set(discard)].join("、")}`] : []),
    ].join("; ");
    db.update(practiceSets)
      .set({
        selectionJson: JSON.stringify(selection),
        status,
        error: status === "failed" ? summary || "未能生成合格题目" : null,
        completedAt: new Date().toISOString(),
      })
      .where(eq(practiceSets.id, set.id))
      .run();
  };
}

/** 选题分析:LLM 输入画像统计,输出目标知识点与理由;失败返回 null(任务失败) */
async function selectTopics(
  ctx: HandlerContext & { rawStore: RawRunStore },
  job: JobRecord,
  subject: Subject,
  params: SetParams,
): Promise<SetSelection | null> {
  const { db, chat, rawStore } = ctx;
  const prompt = promptFor("select_topics");

  const conceptRows = db
    .select()
    .from(concepts)
    .all()
    .filter((c) => c.userId === job.userId && c.subject === subject && c.status === "active");
  const masteryRows = db.select().from(mastery).all().filter((m) => m.userId === job.userId);
  const masteryLines = conceptRows
    .map((c) => {
      const m = masteryRows.find((x) => x.conceptId === c.id);
      return `${c.canonicalName}: 掌握分 ${m?.score ?? 50},样本 ${m?.sampleCount ?? 0}`;
    })
    .sort((a, b) => {
      const sa = Number(a.match(/掌握分 (\d+)/)?.[1] ?? 50);
      const sb = Number(b.match(/掌握分 (\d+)/)?.[1] ?? 50);
      return sa - sb;
    })
    .slice(0, 15);

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const counts = new Map<string, number>();
  for (const m of db
    .select()
    .from(mistakes)
    .all()
    .filter(
      (x) =>
        x.userId === job.userId &&
        x.subject === subject &&
        x.errorType &&
        x.createdAt >= since &&
        x.archived === 0,
    )) {
    counts.set(m.errorType!, (counts.get(m.errorType!) ?? 0) + 1);
  }
  const errorTypeLines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, n]) => `${ERROR_TYPE_NAMES[t as keyof typeof ERROR_TYPE_NAMES] ?? t}: ${n} 题`);

  const res = await chat.chat("text", {
    taskType: "select_topics",
    system: prompt.system,
    messages: [
      {
        role: "user",
        content: prompt.buildUser({
          subject,
          currentGrade: null,
          masteryLines,
          errorTypeLines,
          reviewLine: `本次请求 ${params.count} 题`,
        }),
      },
    ],
    jsonMode: true,
    jobId: job.id,
  });
  rawStore.save("select_topics", `job-${job.id}`, {
    taskType: "select_topics",
    provider: res.run.provider,
    model: res.run.model,
    promptVersion: prompt.version,
    createdAt: new Date().toISOString(),
    key: `job-${job.id}`,
    rawText: res.text,
    parsed: null,
    status: res.run.status === "ok" ? "ok" : "api_error",
  });
  insertModelRun(db, job.id, res.run, prompt.version);

  try {
    const parsed = SelectTopicsResult.parse(parseModelJson(res.text));
    return { targetConcepts: parsed.targetConcepts, rationale: parsed.rationale };
  } catch (e) {
    db.update(modelRuns)
      .set({ status: "schema_fail", error: (e as Error).message })
      .where(eq(modelRuns.id, res.run.id))
      .run();
    ctx.logger.warn(`select_topics schema fail: ${(e as Error).message}`);
    return null;
  }
}

/** past 模式确定性选题:命中目标概念的优先,其次已分析,再按最近录入;刚导入未分析的错题同样可练 */
function pickPastMistakes(
  db: HandlerContext["db"],
  userId: string,
  subject: Subject,
  targetConcepts: string[],
  count: number,
): string[] {
  const conceptIds = db
    .select()
    .from(concepts)
    .all()
    .filter(
      (c) =>
        c.userId === userId &&
        c.subject === subject &&
        c.status === "active" &&
        targetConcepts.includes(c.canonicalName),
    )
    .map((c) => c.id);

  const all = db
    .select()
    .from(mistakes)
    .all()
    .filter((m) => m.userId === userId && m.subject === subject && m.archived === 0);
  if (all.length === 0) return [];

  // 依赖图形的错题(题干含“如图”等表述或【依赖图形】标记)无法文字作答,不参与练习(PRD 5.3)
  const versionIds = all
    .map((m) => m.currentVersionId)
    .filter((v): v is string => Boolean(v));
  const figureVersionIds = new Set(
    versionIds.length
      ? db
          .select({ id: mistakeVersions.id, contentJson: mistakeVersions.contentJson })
          .from(mistakeVersions)
          .where(inArray(mistakeVersions.id, versionIds))
          .all()
          .filter((v) =>
            isFigureDependent((JSON.parse(v.contentJson) as { stemMd?: string }).stemMd ?? ""),
          )
          .map((v) => v.id)
      : [],
  );
  const candidates = all.filter(
    (m) => !m.currentVersionId || !figureVersionIds.has(m.currentVersionId),
  );
  if (candidates.length === 0) return [];

  const linked = new Map<string, number>(); // mistakeId → 命中目标概念数
  if (conceptIds.length > 0) {
    const rows = db
      .select()
      .from(mistakeConcepts)
      .all()
      .filter((r) => conceptIds.includes(r.conceptId));
    for (const r of rows) {
      linked.set(r.mistakeId, (linked.get(r.mistakeId) ?? 0) + 1);
    }
  }

  return candidates
    .map((m) => ({
      id: m.id,
      hits: linked.get(m.id) ?? 0,
      analyzed: m.status === "analyzed" ? 1 : 0,
      updatedAt: m.updatedAt,
    }))
    .sort(
      (a, b) => b.hits - a.hits || b.analyzed - a.analyzed || b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, count)
    .map((m) => m.id);
}

function insertModelRun(
  db: HandlerContext["db"],
  jobId: string,
  run: { id: string; taskType: string; provider: string; model: string; status: string; durationMs: number; usageJson: string | null },
  promptVersion: string,
): void {
  db.insert(modelRuns)
    .values({
      id: run.id,
      jobId,
      taskType: run.taskType as never,
      provider: run.provider as never,
      model: run.model,
      promptVersion,
      status: run.status as never,
      durationMs: run.durationMs,
      usageJson: run.usageJson,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
}

function finishSet(
  db: HandlerContext["db"],
  setId: string,
  forced: "failed" | null,
  validCount: number,
  error?: string,
): void {
  const status = forced ?? (validCount === 0 ? "failed" : "ready");
  db.update(practiceSets)
    .set({
      status,
      error: status === "failed" ? (error ?? "未能生成合格题目") : null,
      completedAt: new Date().toISOString(),
    })
    .where(eq(practiceSets.id, setId))
    .run();
}
