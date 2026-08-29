import { eq, sql } from "drizzle-orm";
import {
  aiJobs,
  attempts,
  concepts,
  learnerSummaries,
  learningEvents,
  mastery,
  mistakes,
  memoryFacts,
} from "../db/schema.js";
import type { Db } from "../db/client.js";
import type { Subject } from "@mistake-book/shared";
import { createJob } from "../jobs/queue.js";
import { localDate } from "./review.js";

/** 待分析数量(Dashboard 纯查询) */
export function pendingCount(db: Db, userId: string): number {
  return db
    .select()
    .from(mistakes)
    .all()
    .filter((m) => m.userId === userId && m.status === "pending_analysis").length;
}

/** 创建学生分析任务:用户点击与每日检查共用;重复点击返回现有任务 */
export function requestLearnerRefresh(db: Db, userId: string, opts?: { daily?: boolean }) {
  const latestEvent = db
    .select()
    .from(learningEvents)
    .where(eq(learningEvents.userId, userId))
    .all()
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
  const toEventId = latestEvent?.id ?? null;
  return createJob(db, {
    userId,
    jobType: "refresh_learner_analysis",
    payload: {},
    idempotencyKey: opts?.daily ? `refresh:${userId}:${localDate()}` : undefined,
    toEventId,
  });
}

/** 每日检查:只有存在待处理数据时才创建(AGENTS §5-6);幂等键保证每天最多一次 */
export function dailyCheck(db: Db, userId: string): { created: boolean } {
  if (pendingCount(db, userId) === 0) return { created: false };
  const res = requestLearnerRefresh(db, userId, { daily: true });
  return { created: !res.existing };
}

/** 学习者档案(Dashboard 纯查询,绝不调模型) */
export function learnerProfile(db: Db, userId: string) {
  const summaries = db
    .select()
    .from(learnerSummaries)
    .where(eq(learnerSummaries.userId, userId))
    .all()
    .map((s) => ({
      scope: s.scope as Subject,
      summaryMd: (JSON.parse(s.summaryJson) as { summaryMd?: string }).summaryMd ?? "",
      asOfEventId: s.asOfEventId,
      version: s.version,
      generatedAt: s.generatedAt,
    }));

  const lastJobRow = db
    .select()
    .from(aiJobs)
    .all()
    .filter((j) => j.userId === userId && j.jobType === "refresh_learner_analysis")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  return {
    summaries,
    pendingCount: pendingCount(db, userId),
    lastJob: lastJobRow
      ? {
          id: lastJobRow.id,
          status: lastJobRow.status,
          createdAt: lastJobRow.createdAt,
          finishedAt: lastJobRow.finishedAt,
          error: lastJobRow.error,
        }
      : null,
    facts: db
      .select()
      .from(memoryFacts)
      .all()
      .filter((f) => f.userId === userId && (f.status === "active" || f.status === "candidate"))
      .map((f) => ({
        id: f.id,
        scope: f.scope,
        kind: f.kind,
        statement: f.statement,
        confidence: f.confidence,
        status: f.status,
      })),
  };
}

/** 学习分析三视图(PRD 5.4,纯查询) */
export function analytics(db: Db, userId: string) {
  const rows = db
    .select()
    .from(concepts)
    .all()
    .filter((c) => c.userId === userId && c.status === "active");
  const masteryRows = db
    .select()
    .from(mastery)
    .where(eq(mastery.userId, userId))
    .all();
  const weaknessesFinal = rows
    .map((c) => {
      const m = masteryRows.find((x) => x.conceptId === c.id);
      return {
        conceptId: c.id,
        name: c.canonicalName,
        subject: c.subject,
        score: m?.score ?? 50,
        sampleCount: m?.sampleCount ?? 0,
        lastPracticedAt: m?.lastPracticedAt ?? null,
      };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 10)
    .map((w) => ({ ...w, insufficient: w.sampleCount < 3 }));

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const errorTypeCounts = new Map<string, number>();
  for (const m of db
    .select()
    .from(mistakes)
    .all()
    .filter(
      (m) =>
        m.userId === userId &&
        m.errorType &&
        m.createdAt >= since &&
        m.archived === 0,
    )) {
    errorTypeCounts.set(m.errorType!, (errorTypeCounts.get(m.errorType!) ?? 0) + 1);
  }

  return {
    weaknesses: weaknessesFinal,
    errorTypes: [...errorTypeCounts.entries()]
      .map(([errorType, count]) => ({ errorType, count }))
      .sort((a, b) => b.count - a.count),
    // 学习方法画像(PRD 5.4 视图 4):AI 画像推断,可被学生纠正
    habits: db
      .select()
      .from(memoryFacts)
      .all()
      .filter(
        (f) => f.userId === userId && f.kind === "habit_pattern" && f.status === "active",
      )
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10)
      .map((f) => ({ statement: f.statement, confidence: f.confidence, status: f.status })),
  };
}

/** 数据导出:JSON 全量事实源(PRD 5.5) */
export function exportJson(db: Db, userId: string) {
  return {
    exportedAt: new Date().toISOString(),
    mistakes: db.select().from(mistakes).all().filter((m) => m.userId === userId),
    attempts: db.select().from(attempts).all().filter((a) => a.userId === userId),
    concepts: db.select().from(concepts).all().filter((c) => c.userId === userId),
    learningEvents: db
      .select()
      .from(learningEvents)
      .all()
      .filter((e) => e.userId === userId),
    summaries: db.select().from(learnerSummaries).all().filter((s) => s.userId === userId),
  };
}

/** Markdown 导出 */
export function exportMarkdown(db: Db, userId: string): string {
  const rows = db
    .select()
    .from(mistakes)
    .all()
    .filter((m) => m.userId === userId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const parts: string[] = ["# 错题本导出\n"];
  for (const m of rows) {
    const ver = m.currentVersionId
      ? db.get<{ content_json: string }>(
          sql`SELECT content_json FROM mistake_versions WHERE id = ${m.currentVersionId}`,
        )
      : undefined;
    const c = ver ? (JSON.parse(ver.content_json) as { stemMd?: string; myAnswer?: string; note?: string }) : {};
    parts.push(`## ${m.subject} · ${m.createdAt.slice(0, 10)}\n`);
    parts.push(`${c.stemMd ?? "(无题干)"}\n`);
    if (c.myAnswer) parts.push(`**我的答案:** ${c.myAnswer}\n`);
    if (m.errorType) parts.push(`**错误类型:** ${m.errorType}\n`);
    if (c.note) parts.push(`**备注:** ${c.note}\n`);
  }
  return parts.join("\n");
}

/** 数据清空(免登录单机,PRD 5.5):清空业务数据,users 种子保留。
 *  子表(mistake_versions/mistake_concepts/concept_aliases/memory_evidence)
 *  通过外键 ON DELETE CASCADE 级联清理;model_runs 无 user_id,经 ai_jobs 关联删除。 */
export function deleteAllData(db: Db, userId: string): void {
  db.transaction((tx) => {
    tx.run(sql`DELETE FROM mistakes_fts`);
    tx.run(
      sql`DELETE FROM model_runs WHERE job_id IN (SELECT id FROM ai_jobs WHERE user_id = ${userId})`,
    );
    // 顺序:先子后父(级联兜底)
    for (const t of [
      "memory_facts",
      "learner_summaries",
      "generated_questions",
      "practice_sets",
      "mastery",
      "attempts",
      "review_schedules",
      "mistakes",
      "concepts",
      "ingestion_drafts",
      "import_batches",
      "learning_events",
      "ai_jobs",
    ]) {
      tx.run(sql`DELETE FROM ${sql.raw(t)} WHERE user_id = ${userId}`);
    }
  });
}
