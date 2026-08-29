import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { attempts, generatedQuestions, mastery, mistakeConcepts } from "../db/schema.js";
import type { Db } from "../db/client.js";

/**
 * 掌握度算法(LLD §6.1):确定性、可重算。
 * 单次变化量:复习正确 +4 / 部分正确 +1 / 错误 -10;变式首次独立答对 +10 / 部分正确 +3 / 错误 -8;
 * 使用提示后答对 +2。最近 10 次权重 1.5,更早 1.0。初始 50,clamp 0~100。
 * pending_judge(未判分)不计入事件。
 */
export interface MasteryEvent {
  sourceType: "mistake_review" | "generated_question";
  result: "correct" | "partial" | "wrong" | "gave_up";
  usedHint: boolean;
  occurredAt: string;
}

export function deltaFor(ev: MasteryEvent): number {
  if (ev.result === "partial") {
    if (ev.usedHint) return 1;
    return ev.sourceType === "mistake_review" ? 1 : 3;
  }
  if (ev.usedHint) return ev.result === "correct" ? 2 : -4;
  if (ev.sourceType === "mistake_review") return ev.result === "correct" ? 4 : -10;
  return ev.result === "correct" ? 10 : -8;
}

export interface MasteryResult {
  score: number;
  sampleCount: number;
  freshness: number;
}

export function computeMastery(events: MasteryEvent[], now = new Date()): MasteryResult {
  const sorted = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  let score = 50;
  let sampleCount = 0;
  let lastAt: string | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.result === "gave_up") {
      // 放弃计为错误但样本数照常累计
    }
    const weight = i >= sorted.length - 10 ? 1.5 : 1.0;
    score += deltaFor(ev) * weight;
    if (ev.result !== "gave_up") sampleCount++;
    lastAt = ev.occurredAt;
  }
  // 新鲜度:14 天内为 1,之后线性衰减到 0 下限(仅影响展示权重,不判遗忘)
  let freshness = 1;
  if (lastAt) {
    const days = (now.getTime() - new Date(lastAt).getTime()) / 86_400_000;
    if (days > 14) freshness = Math.max(0, 1 - (days - 14) / 90);
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    sampleCount,
    freshness,
  };
}

/** 从事实源重算某概念的掌握度(增量与全量同路径,保证一致) */
export function recomputeMasteryForConcept(
  db: Db,
  userId: string,
  conceptId: string,
): MasteryResult {
  const conceptAttempts = db
    .select({
      sourceType: attempts.sourceType,
      sourceId: attempts.sourceId,
      result: attempts.result,
      usedHint: attempts.usedHint,
      occurredAt: attempts.createdAt,
    })
    .from(attempts)
    .where(and(eq(attempts.userId, userId)))
    .all()
    .filter((a) => a.result !== "pending_judge"); // 未判分的作答不计入掌握度

  // 该概念的作答 = 关联到此概念的错题复习 + 以此概念生成的变式题作答
  const mistakeIds = new Set(
    db
      .select()
      .from(mistakeConcepts)
      .all()
      .filter((r) => r.conceptId === conceptId)
      .map((r) => r.mistakeId),
  );
  const gqIds = new Set(
    db
      .select()
      .from(generatedQuestions)
      .all()
      .filter((r) =>
        (r.conceptIdsJson ? (JSON.parse(r.conceptIdsJson) as string[]) : []).includes(conceptId),
      )
      .map((r) => r.id),
  );

  const events = conceptAttempts
    .filter((a) =>
      a.sourceType === "mistake_review" ? mistakeIds.has(a.sourceId) : gqIds.has(a.sourceId),
    )
    .map((a) => ({
      sourceType: a.sourceType as MasteryEvent["sourceType"],
      result: a.result as MasteryEvent["result"],
      usedHint: a.usedHint === 1,
      occurredAt: a.occurredAt,
    }));

  const result = computeMastery(events);
  const now = new Date().toISOString();
  const existing = db
    .select()
    .from(mastery)
    .where(and(eq(mastery.userId, userId), eq(mastery.conceptId, conceptId)))
    .get();
  if (existing) {
    db.update(mastery)
      .set({
        score: result.score,
        sampleCount: result.sampleCount,
        freshness: result.freshness,
        lastPracticedAt: lastOf(events),
        updatedAt: now,
      })
      .where(eq(mastery.id, existing.id))
      .run();
  } else {
    db.insert(mastery)
      .values({
        id: crypto.randomUUID(),
        userId,
        conceptId,
        score: result.score,
        sampleCount: result.sampleCount,
        freshness: result.freshness,
        lastPracticedAt: lastOf(events),
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  }
  return result;
}

function lastOf(events: MasteryEvent[]): string | null {
  if (!events.length) return null;
  return events.reduce((a, b) => (a.occurredAt > b.occurredAt ? a : b)).occurredAt;
}
