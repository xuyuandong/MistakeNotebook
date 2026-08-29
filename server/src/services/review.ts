import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  attempts,
  generatedQuestions,
  learningEvents,
  mastery,
  mistakes,
  mistakeConcepts,
  mistakeVersions,
  reviewSchedules,
  users,
} from "../db/schema.js";
import type { Db } from "../db/client.js";
import {
  DEFAULT_REVIEW_INTERVALS,
  isFigureDependent,
  REVIEW_INTERVAL_DAYS,
  type AttemptResult,
  type Subject,
} from "@mistake-book/shared";
import { recomputeMasteryForConcept } from "./mastery.js";
import { createJob } from "../jobs/queue.js";

export class ReviewError extends Error {
  constructor(
    public code: "NOT_FOUND" | "VALIDATION_ERROR",
    message: string,
  ) {
    super(message);
  }
}

function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDate(d);
}

/** 错题创建时安排首次复习(1 天后,服务 7 日内首次复习率) */
export function scheduleFirstReview(db: Db, userId: string, mistakeId: string): void {
  db.insert(reviewSchedules)
    .values({
      id: randomUUID(),
      userId,
      mistakeId,
      status: "scheduled",
      dueDate: addDays(localDate(), 1),
      intervalIndex: 0,
      createdAt: new Date().toISOString(),
    })
    .run();
}

/** 依赖图形作答的错题 id 集合(缺图无法重做,不进复习到期列表与复习统计,PRD 6.3) */
function figureDependentMistakeIds(db: Db, userId: string): Set<string> {
  const rows = db
    .select()
    .from(mistakes)
    .all()
    .filter((m) => m.userId === userId && m.archived === 0 && m.currentVersionId);
  if (rows.length === 0) return new Set();
  const figureVersionIds = new Set(
    db
      .select({ id: mistakeVersions.id, contentJson: mistakeVersions.contentJson })
      .from(mistakeVersions)
      .where(inArray(mistakeVersions.id, rows.map((r) => r.currentVersionId as string)))
      .all()
      .filter((v) =>
        isFigureDependent((JSON.parse(v.contentJson) as { stemMd?: string }).stemMd ?? ""),
      )
      .map((v) => v.id),
  );
  return new Set(
    rows.filter((r) => figureVersionIds.has(r.currentVersionId as string)).map((r) => r.id),
  );
}

export function todayReviews(
  db: Db,
  userId: string,
): { items: { mistakeId: string; dueDate: string; overdue: boolean }[] } {
  const today = localDate();
  const skip = figureDependentMistakeIds(db, userId);
  const rows = db
    .select()
    .from(reviewSchedules)
    .where(and(eq(reviewSchedules.userId, userId), eq(reviewSchedules.status, "scheduled")))
    .all()
    .filter((r) => r.dueDate <= today && !skip.has(r.mistakeId))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return {
    items: rows.map((r) => ({
      mistakeId: r.mistakeId,
      dueDate: r.dueDate,
      overdue: r.dueDate < today,
    })),
  };
}

interface AttemptTarget {
  subject: string;
  /** 客观题判定输入:标准答案与可接受答案 */
  correctAnswer: string | null;
  acceptableAnswers: string[];
  /** 选择/填空 = 本地可比对;解答/阅读 = LLM 判分 */
  objective: boolean;
  stemMd: string;
  explanation: string | null;
  rubric: string | null;
  note: string | null;
}

function resolveTarget(
  db: Db,
  userId: string,
  sourceType: "mistake_review" | "generated_question",
  sourceId: string,
): AttemptTarget {
  if (sourceType === "mistake_review") {
    const m = db
      .select()
      .from(mistakes)
      .where(and(eq(mistakes.id, sourceId), eq(mistakes.userId, userId)))
      .get();
    if (!m) throw new ReviewError("NOT_FOUND", "错题不存在");
    const ver = m.currentVersionId
      ? db
          .select({ content_json: mistakeVersions.contentJson })
          .from(mistakeVersions)
          .where(eq(mistakeVersions.id, m.currentVersionId))
          .get()
      : undefined;
    const content = ver
      ? (JSON.parse(ver.content_json) as {
          stemMd?: string;
          correctAnswer?: string;
          explanationMd?: string;
          note?: string;
        })
      : {};
    // 选择/填空且录入了标准答案 → 本地比对;其余交给 LLM 判分(LLD §4.5)
    const objective =
      (m.questionType === "选择" || m.questionType === "填空") && Boolean(content.correctAnswer);
    return {
      subject: m.subject,
      correctAnswer: content.correctAnswer ?? null,
      acceptableAnswers: [],
      objective,
      stemMd: content.stemMd ?? "",
      explanation: content.explanationMd ?? null,
      rubric: null,
      note: content.note ?? null,
    };
  }
  const q = db
    .select()
    .from(generatedQuestions)
    .where(and(eq(generatedQuestions.id, sourceId), eq(generatedQuestions.userId, userId)))
    .get();
  if (!q) throw new ReviewError("NOT_FOUND", "练习题不存在");
  const gq = JSON.parse(q.questionJson) as {
    type: "choice" | "fill_blank" | "subjective";
    stemMd: string;
    answer: string;
    acceptableAnswers?: string[];
    explanationMd: string;
    rubricMd?: string;
  };
  return {
    subject: q.subject,
    correctAnswer: gq.answer,
    acceptableAnswers: gq.acceptableAnswers ?? [],
    objective: gq.type === "choice" || gq.type === "fill_blank",
    stemMd: gq.stemMd,
    explanation: gq.explanationMd,
    rubric: gq.rubricMd ?? null,
    note: null,
  };
}

function normalizeAnswer(v: string): string {
  return v.trim().replace(/\s+/g, " ");
}

function localJudge(target: AttemptTarget, answer: string): "correct" | "wrong" {
  const a = normalizeAnswer(answer);
  if (target.acceptableAnswers.some((acc) => normalizeAnswer(acc) === a)) return "correct";
  return normalizeAnswer(target.correctAnswer ?? "") === a ? "correct" : "wrong";
}

/** 用户分科复习间隔(设置页可配);未配置/配置损坏时回退共享默认值 */
export function reviewIntervalsFor(db: Db, userId: string, subject: string): number[] {
  const raw = db
    .select({ v: users.reviewIntervalsJson })
    .from(users)
    .where(eq(users.id, userId))
    .get()?.v;
  if (raw) {
    try {
      const list = (JSON.parse(raw) as Record<string, unknown>)[subject];
      if (
        Array.isArray(list) &&
        list.length > 0 &&
        list.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 1)
      ) {
        return list;
      }
    } catch {
      // 落到默认配置
    }
  }
  return DEFAULT_REVIEW_INTERVALS[subject as Subject] ?? [...REVIEW_INTERVAL_DAYS];
}

/** 推进复习计划(PRD 6.3):答对进下一档(封顶);部分/错误/放弃原地不倒退,避免挫败感。
 *  下次到期 = 实际完成日 + 当前档间隔(晚复习只顺延,不丢题)。 */
function advanceReviewSchedule(
  db: Db,
  userId: string,
  mistakeId: string,
  result: AttemptResult,
): string | null {
  const current = db
    .select()
    .from(reviewSchedules)
    .where(
      and(
        eq(reviewSchedules.userId, userId),
        eq(reviewSchedules.mistakeId, mistakeId),
        eq(reviewSchedules.status, "scheduled"),
      ),
    )
    .all()
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  if (!current) return null;
  const subject =
    db.select({ subject: mistakes.subject }).from(mistakes).where(eq(mistakes.id, mistakeId)).get()
      ?.subject ?? "math";
  const intervals = reviewIntervalsFor(db, userId, subject);
  const nextIndex =
    result === "correct"
      ? Math.min(current.intervalIndex + 1, intervals.length - 1)
      : Math.min(current.intervalIndex, intervals.length - 1); // 旧排期档位可能超出新配置长度,钳制
  const now = new Date().toISOString();
  db.update(reviewSchedules)
    .set({ status: "done", completedAt: now })
    .where(eq(reviewSchedules.id, current.id))
    .run();
  const dueDate = addDays(localDate(), intervals[nextIndex]);
  db.insert(reviewSchedules)
    .values({
      id: randomUUID(),
      userId,
      mistakeId,
      status: "scheduled",
      dueDate,
      intervalIndex: nextIndex,
      createdAt: now,
    })
    .run();
  return dueDate;
}

function conceptIdsFor(db: Db, userId: string, sourceType: string, sourceId: string): string[] {
  if (sourceType === "mistake_review") {
    return db
      .select()
      .from(mistakeConcepts)
      .where(eq(mistakeConcepts.mistakeId, sourceId))
      .all()
      .map((r) => r.conceptId);
  }
  const q = db.select().from(generatedQuestions).where(eq(generatedQuestions.id, sourceId)).get();
  return q?.conceptIdsJson ? (JSON.parse(q.conceptIdsJson) as string[]) : [];
}

function recomputeMastery(db: Db, userId: string, sourceType: string, sourceId: string): number | null {
  let masteryDelta: number | null = null;
  for (const conceptId of conceptIdsFor(db, userId, sourceType, sourceId)) {
    const before = db
      .select()
      .from(mastery)
      .where(and(eq(mastery.userId, userId), eq(mastery.conceptId, conceptId)))
      .get();
    const after = recomputeMasteryForConcept(db, userId, conceptId);
    masteryDelta = after.score - (before?.score ?? 50);
  }
  return masteryDelta;
}

export interface SubmitAttemptResult {
  attemptId: string;
  judging: "local" | "llm";
  result?: AttemptResult;
  masteryDelta?: number | null;
  nextReviewDate?: string | null;
}

/**
 * 作答提交(LLD §4.5):
 * - gaveUp → gave_up,立即落事件/复习计划/掌握度;
 * - 客观题(选择/填空且录入了标准答案)→ 本地比对,同步判定;
 * - 其余 → result='pending_judge' + 创建 judge_answer 任务(幂等键 judge:{attemptId})。
 */
export function submitAttempt(
  db: Db,
  userId: string,
  input: {
    sourceType: "mistake_review" | "generated_question";
    sourceId: string;
    answer?: string;
    gaveUp?: boolean;
    usedHint?: boolean;
    durationMs?: number;
  },
): SubmitAttemptResult {
  const target = resolveTarget(db, userId, input.sourceType, input.sourceId);
  const now = new Date().toISOString();
  const attemptId = randomUUID();

  let result: AttemptResult;
  let judging: "local" | "llm";
  if (input.gaveUp) {
    result = "gave_up";
    judging = "local";
  } else if (target.objective && input.answer) {
    result = localJudge(target, input.answer);
    judging = "local";
  } else if (input.answer) {
    result = "pending_judge";
    judging = "llm";
  } else {
    // 没有作答也没有“不知道” → 按放弃处理
    result = "gave_up";
    judging = "local";
  }

  db.transaction((tx) => {
    tx.insert(attempts)
      .values({
        id: attemptId,
        userId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        answer: input.answer ?? null,
        result,
        judgedBy: result === "gave_up" ? null : "local",
        usedHint: input.usedHint ? 1 : 0,
        durationMs: input.durationMs ?? null,
        createdAt: now,
      })
      .run();

    tx.insert(learningEvents)
      .values({
        id: randomUUID(),
        userId,
        eventType: input.sourceType === "mistake_review" ? "review_attempted" : "practice_attempted",
        subject: target.subject,
        sourceId: attemptId,
        payloadJson: JSON.stringify({ sourceType: input.sourceType, sourceId: input.sourceId }),
        occurredAt: now,
      })
      .onConflictDoNothing()
      .run();
  });

  if (result === "pending_judge") {
    createJob(db, {
      userId,
      jobType: "judge_answer",
      payload: { attemptId },
      idempotencyKey: `judge:${attemptId}`,
    });
    return { attemptId, judging };
  }

  const nextReviewDate =
    input.sourceType === "mistake_review"
      ? advanceReviewSchedule(db, userId, input.sourceId, result)
      : null;
  const masteryDelta = recomputeMastery(db, userId, input.sourceType, input.sourceId);
  return { attemptId, judging, result, masteryDelta, nextReviewDate };
}

/**
 * 把 pending_judge 的作答落为最终判定(judge 任务与申诉共用)。
 * 幂等:仅当当前仍是 pending_judge 时生效;事件唯一约束兜底,重试不重复计数。
 */
export function finalizePendingAttempt(
  db: Db,
  userId: string,
  attemptId: string,
  result: Exclude<AttemptResult, "pending_judge">,
  judgedBy: "llm" | "user_appeal",
  feedback: { basis: string; comment: string } | null,
): { attemptId: string; result: AttemptResult; nextReviewDate: string | null; masteryDelta: number | null } | null {
  const attempt = db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
  if (!attempt || attempt.userId !== userId) return null;
  if (attempt.result !== "pending_judge") return null; // 已终态(重试/申诉竞态)

  const subject = resolveSubject(db, userId, attempt.sourceType, attempt.sourceId) ?? "math";
  const now = new Date().toISOString();
  db.transaction((tx) => {
    const res = tx
      .update(attempts)
      .set({
        result,
        judgedBy,
        feedbackJson: feedback ? JSON.stringify(feedback) : attempt.feedbackJson,
      })
      .where(and(eq(attempts.id, attemptId), eq(attempts.result, "pending_judge")))
      .run();
    if (res.changes === 0) return;

    tx.insert(learningEvents)
      .values({
        id: randomUUID(),
        userId,
        eventType: attempt.sourceType === "mistake_review" ? "review_attempted" : "practice_attempted",
        subject,
        sourceId: attemptId,
        payloadJson: JSON.stringify({
          sourceType: attempt.sourceType,
          sourceId: attempt.sourceId,
        }),
        occurredAt: now,
      })
      .onConflictDoNothing()
      .run();
  });

  const nextReviewDate =
    attempt.sourceType === "mistake_review"
      ? advanceReviewSchedule(db, userId, attempt.sourceId, result)
      : null;
  const masteryDelta = recomputeMastery(db, userId, attempt.sourceType, attempt.sourceId);
  return { attemptId, result, nextReviewDate, masteryDelta };
}

function resolveSubject(
  db: Db,
  userId: string,
  sourceType: string,
  sourceId: string,
): string | null {
  if (sourceType === "mistake_review") {
    return (
      db
        .select({ subject: mistakes.subject })
        .from(mistakes)
        .where(and(eq(mistakes.id, sourceId), eq(mistakes.userId, userId)))
        .get()?.subject ?? null
    );
  }
  return (
    db
      .select({ subject: generatedQuestions.subject })
      .from(generatedQuestions)
      .where(and(eq(generatedQuestions.id, sourceId), eq(generatedQuestions.userId, userId)))
      .get()?.subject ?? null
  );
}

/** 申诉/自判改判(LLD §4.5):
 * - pending_judge(判分失败的自判兜底)→ 直接终态,judged_by='user_appeal';
 * - 已终态 → 改判:事件不重复计数,掌握度从事实源重算(确定性)。 */
export function appealAttempt(
  db: Db,
  userId: string,
  attemptId: string,
  result: "correct" | "partial" | "wrong",
): { attemptId: string; result: AttemptResult; masteryDelta: number | null } | null {
  const attempt = db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
  if (!attempt || attempt.userId !== userId) return null;

  if (attempt.result === "pending_judge") {
    const finalized = finalizePendingAttempt(db, userId, attemptId, result, "user_appeal", null);
    return finalized
      ? { attemptId, result: finalized.result, masteryDelta: finalized.masteryDelta }
      : null;
  }

  db.update(attempts)
    .set({
      result,
      judgedBy: "user_appeal",
      feedbackJson: attempt.feedbackJson
        ? JSON.stringify({
            ...(JSON.parse(attempt.feedbackJson) as Record<string, unknown>),
            appeal: result,
          })
        : JSON.stringify({ appeal: result }),
    })
    .where(eq(attempts.id, attemptId))
    .run();

  const masteryDelta = recomputeMastery(db, userId, attempt.sourceType, attempt.sourceId);
  return { attemptId, result, masteryDelta };
}

/** 作答详情(轮询判分结果) */
export function attemptDetail(
  db: Db,
  userId: string,
  attemptId: string,
): {
  attemptId: string;
  result: AttemptResult;
  feedback: { basis: string; comment: string } | null;
} | null {
  const attempt = db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
  if (!attempt || attempt.userId !== userId) return null;
  let feedback: { basis: string; comment: string } | null = null;
  if (attempt.feedbackJson) {
    try {
      const f = JSON.parse(attempt.feedbackJson) as { basis?: string; comment?: string };
      if (f.basis || f.comment) {
        feedback = { basis: f.basis ?? "", comment: f.comment ?? "" };
      }
    } catch {
      feedback = null;
    }
  }
  return { attemptId: attempt.id, result: attempt.result as AttemptResult, feedback };
}

/** 本周复习统计(学习分析用,纯查询;依赖图形的错题不参与,与到期列表口径一致) */
export function weeklyReviewStats(db: Db, userId: string) {
  const today = localDate();
  const weekAgo = addDays(today, -7);
  const skip = figureDependentMistakeIds(db, userId);
  const scheduled = db
    .select()
    .from(reviewSchedules)
    .where(and(eq(reviewSchedules.userId, userId)))
    .all()
    .filter((r) => !skip.has(r.mistakeId));
  const dueThisWeek = scheduled.filter(
    (r) => r.createdAt.slice(0, 10) >= weekAgo && r.status !== "canceled",
  );
  const completed = scheduled.filter(
    (r) => r.status === "done" && (r.completedAt ?? "").slice(0, 10) >= weekAgo,
  );
  const overdue = scheduled.filter((r) => r.status === "scheduled" && r.dueDate < today);
  const attemptRows = db
    .select()
    .from(attempts)
    .where(and(eq(attempts.userId, userId)))
    .all()
    .filter(
      (a) =>
        a.sourceType === "mistake_review" &&
        a.createdAt.slice(0, 10) >= weekAgo &&
        (a.result === "correct" || a.result === "partial" || a.result === "wrong"),
    );
  const correct = attemptRows.filter((a) => a.result === "correct").length;
  return {
    planned: dueThisWeek.length,
    completed: completed.length,
    correctRate: attemptRows.length ? Math.round((correct / attemptRows.length) * 100) : null,
    overdue: overdue.length,
  };
}

export { localDate, addDays };
