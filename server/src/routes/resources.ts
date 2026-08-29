import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  generatedQuestions,
  mistakes,
  mistakeVersions,
  practiceSets,
  users,
} from "../db/schema.js";
import { createJob } from "../jobs/queue.js";
import {
  analytics,
  exportJson,
  exportMarkdown,
  learnerProfile,
  requestLearnerRefresh,
  deleteAllData,
} from "../services/learner.js";
import {
  appealAttempt,
  attemptDetail,
  submitAttempt,
  todayReviews,
  weeklyReviewStats,
  ReviewError,
} from "../services/review.js";
import {
  conceptsWithMastery,
  ignoreConcept,
  mergeConcepts,
  renameConcept,
} from "../services/concepts.js";
import { patchMistake, ServiceError } from "../services/mistakes.js";
import {
  AttemptAppeal,
  AttemptCreate,
  ConceptPatch,
  MePatch,
  MistakePatch,
  ReviewIntervalsConfig,
  PracticeSetCreate,
  QuestionReport,
} from "@mistake-book/shared";
import { err } from "./http.js";

// ---- 错题 PATCH ----
export async function patchMistakeHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const parsed = MistakePatch.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send(err("VALIDATION_ERROR", parsed.error.issues[0].message));
  }
  try {
    patchMistake(req.server.ctx.db, req.user.id, id, parsed.data);
    return { ok: true };
  } catch (e) {
    if (e instanceof ServiceError && e.code === "NOT_FOUND") {
      return reply.code(404).send(err(e.code, e.message));
    }
    throw e;
  }
}

// ---- 概念 ----
export async function listConceptsHandler(req: FastifyRequest) {
  return { items: conceptsWithMastery(req.server.ctx.db, req.user.id) };
}

export async function patchConceptHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const parsed = ConceptPatch.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send(err("VALIDATION_ERROR", parsed.error.issues[0].message));
  }
  const db = req.server.ctx.db;
  try {
    if (parsed.data.canonicalName) renameConcept(db, req.user.id, id, parsed.data.canonicalName);
    if (parsed.data.mergedIntoId) mergeConcepts(db, req.user.id, id, parsed.data.mergedIntoId);
    if (parsed.data.status === "ignored") ignoreConcept(db, req.user.id, id);
    return { ok: true };
  } catch (e) {
    return reply.code(400).send(err("VALIDATION_ERROR", (e as Error).message));
  }
}

// ---- 复习 ----
export async function todayReviewsHandler(req: FastifyRequest) {
  return todayReviews(req.server.ctx.db, req.user.id);
}

export async function createAttemptHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = AttemptCreate.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send(err("VALIDATION_ERROR", parsed.error.issues[0].message));
  }
  try {
    return submitAttempt(req.server.ctx.db, req.user.id, parsed.data);
  } catch (e) {
    if (e instanceof ReviewError) {
      return reply
        .code(e.code === "NOT_FOUND" ? 404 : 400)
        .send(err(e.code, e.message));
    }
    throw e;
  }
}

/** GET /api/v1/attempts/:id — 轮询 LLM 判分结果(LLD §3.2) */
export async function getAttemptHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const detail = attemptDetail(req.server.ctx.db, req.user.id, id);
  if (!detail) return reply.code(404).send(err("NOT_FOUND", "作答记录不存在"));
  return detail;
}

/** PATCH /api/v1/attempts/:id — 申诉/自判改判(判分失败的自判兜底也走这里) */
export async function appealAttemptHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const parsed = AttemptAppeal.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send(err("VALIDATION_ERROR", parsed.error.issues[0].message));
  }
  try {
    const res = appealAttempt(req.server.ctx.db, req.user.id, id, parsed.data.result);
    if (!res) return reply.code(404).send(err("NOT_FOUND", "作答记录不存在或仍在判分中"));
    return res;
  } catch (e) {
    if (e instanceof ReviewError) {
      return reply.code(400).send(err(e.code, e.message));
    }
    throw e;
  }
}

// ---- 练习 ----
export async function createPracticeSetHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = PracticeSetCreate.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send(err("VALIDATION_ERROR", parsed.error.issues[0].message));
  }
  const db = req.server.ctx.db;
  const data = parsed.data;

  if (data.origin === "mistake") {
    const m = db
      .select()
      .from(mistakes)
      .where(and(eq(mistakes.id, data.mistakeId!), eq(mistakes.userId, req.user.id)))
      .get();
    if (!m) return reply.code(404).send(err("NOT_FOUND", "错题不存在"));
  }

  const id = randomUUID();
  db.insert(practiceSets)
    .values({
      id,
      userId: req.user.id,
      subject: data.subject,
      origin: data.origin,
      mistakeId: data.mistakeId ?? null,
      status: "generating",
      paramsJson: JSON.stringify({
        mode: data.mode,
        difficulty: data.difficulty,
        questionType: data.questionType,
        count: data.count,
      }),
      createdAt: new Date().toISOString(),
    })
    .run();

  const job = createJob(db, {
    userId: req.user.id,
    jobType: "generate_questions",
    payload: { practiceSetId: id },
  });
  return { practiceSetId: id, jobId: job.id };
}

export async function getPracticeSetHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const db = req.server.ctx.db;
  const set = db
    .select()
    .from(practiceSets)
    .where(and(eq(practiceSets.id, id), eq(practiceSets.userId, req.user.id)))
    .get();
  if (!set) return reply.code(404).send(err("NOT_FOUND", "练习集不存在"));

  const params = JSON.parse(set.paramsJson) as { mode?: "past" | "new"; count?: number };
  const mode = params.mode ?? "new";
  const selection = set.selectionJson ? (JSON.parse(set.selectionJson) as {
    targetConcepts: string[];
    rationale: string;
    mistakeIds?: string[];
  }) : null;

  const questions: unknown[] = [];
  if (mode === "past" && selection?.mistakeIds) {
    for (const mid of selection.mistakeIds) {
      const m = db.select().from(mistakes).where(eq(mistakes.id, mid)).get();
      if (!m) continue;
      const ver = m.currentVersionId
        ? db
            .select({ contentJson: mistakeVersions.contentJson })
            .from(mistakeVersions)
            .where(eq(mistakeVersions.id, m.currentVersionId))
            .get()
        : undefined;
      const c = ver
        ? (JSON.parse(ver.contentJson) as {
            stemMd?: string;
            correctAnswer?: string;
            explanationMd?: string;
            myAnswer?: string;
          })
        : {};
      questions.push({
        kind: "mistake",
        id: m.id,
        mistakeId: m.id,
        stemMd: c.stemMd ?? "",
        questionType: m.questionType,
        correctAnswer: c.correctAnswer ?? null,
        explanation: c.explanationMd ?? null,
        myAnswer: c.myAnswer ?? null,
      });
    }
  } else {
    for (const g of db
      .select()
      .from(generatedQuestions)
      .where(eq(generatedQuestions.practiceSetId, id))
      .all()
      .filter((g) => g.status !== "discarded")) {
      questions.push({
        kind: "generated",
        id: g.id,
        status: g.status,
        question: JSON.parse(g.questionJson),
      });
    }
  }

  return {
    id: set.id,
    subject: set.subject,
    origin: set.origin,
    mode,
    status: set.status,
    error: set.error,
    selection,
    questions,
  };
}

export async function reportQuestionHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const parsed = QuestionReport.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send(err("VALIDATION_ERROR", parsed.error.issues[0].message));
  }
  const db = req.server.ctx.db;
  const q = db
    .select()
    .from(generatedQuestions)
    .where(and(eq(generatedQuestions.id, id), eq(generatedQuestions.userId, req.user.id)))
    .get();
  if (!q) return reply.code(404).send(err("NOT_FOUND", "题目不存在"));
  db.update(generatedQuestions)
    .set({ status: "reported", reportReason: parsed.data.reason })
    .where(eq(generatedQuestions.id, id))
    .run();
  return reply.code(204).send();
}

// ---- 分析 / 档案 ----
export async function analyticsHandler(req: FastifyRequest) {
  const a = analytics(req.server.ctx.db, req.user.id);
  return { ...a, reviewStats: weeklyReviewStats(req.server.ctx.db, req.user.id) };
}

export async function learnerProfileHandler(req: FastifyRequest) {
  return learnerProfile(req.server.ctx.db, req.user.id);
}

export async function learnerRefreshHandler(req: FastifyRequest) {
  const res = requestLearnerRefresh(req.server.ctx.db, req.user.id);
  return { jobId: res.id, existing: res.existing };
}

// ---- 设置 / 导出 / 清空 ----
function reviewIntervalsOrNull(raw: string | null): unknown {
  if (!raw) return null;
  try {
    const parsed = ReviewIntervalsConfig.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function meHandler(req: FastifyRequest) {
  const u = dbUser(req);
  return {
    userId: u.id,
    displayName: u.displayName,
    currentGrade: u.currentGrade,
    reviewIntervals: reviewIntervalsOrNull(u.reviewIntervalsJson),
  };
}

export async function patchMeHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = MePatch.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send(err("VALIDATION_ERROR", parsed.error.issues[0].message));
  }
  const db = req.server.ctx.db;
  const u = dbUser(req);
  db.update(users)
    .set({
      displayName: parsed.data.displayName ?? u.displayName,
      currentGrade:
        parsed.data.currentGrade === undefined ? u.currentGrade : parsed.data.currentGrade,
      reviewIntervalsJson:
        parsed.data.reviewIntervals === undefined
          ? u.reviewIntervalsJson
          : JSON.stringify(parsed.data.reviewIntervals),
    })
    .where(eq(users.id, u.id))
    .run();
  return meHandler(req);
}

function dbUser(req: FastifyRequest) {
  const u = req.server.ctx.db
    .select()
    .from(users)
    .where(eq(users.id, req.user.id))
    .get();
  if (!u) throw new Error("用户不存在");
  return u;
}

export async function exportJsonHandler(req: FastifyRequest) {
  return exportJson(req.server.ctx.db, req.user.id);
}

export async function exportMarkdownHandler(req: FastifyRequest, reply: FastifyReply) {
  const md = exportMarkdown(req.server.ctx.db, req.user.id);
  return reply
    .header("content-type", "text/markdown; charset=utf-8")
    .header("content-disposition", "attachment; filename=mistakes.md")
    .send(md);
}

/** 解锁校验错误:口令未配置/不匹配(危险区) */
export class PurgeLockError extends Error {}

/**
 * 危险区解锁校验(PRD 5.5):一键清空需输入 .env 中配置的 APP_AUTH_TOKEN。
 * 未配置该变量 = 清空功能永久锁定(防误删优先);比对使用 timingSafeEqual。
 */
export function checkPurgeUnlock(appAuthToken: string | null, unlock: unknown): void {
  if (!appAuthToken) {
    throw new PurgeLockError(
      "危险操作已锁定:请先在 .env 中配置 APP_AUTH_TOKEN(危险区解锁口令)并重启服务",
    );
  }
  const input = typeof unlock === "string" ? unlock : "";
  const a = Buffer.from(input);
  const b = Buffer.from(appAuthToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PurgeLockError("解锁口令不正确");
  }
}

/** POST /api/v1/data/purge — 一键清空(免登录单机,PRD 5.5);users 种子保留;需口令解锁 */
export async function purgeDataHandler(req: FastifyRequest, reply: FastifyReply) {
  try {
    checkPurgeUnlock(
      req.server.ctx.config.appAuthToken,
      (req.body as { unlock?: string } | null)?.unlock,
    );
  } catch (e) {
    if (e instanceof PurgeLockError) {
      return reply.code(403).send(err("FORBIDDEN", e.message));
    }
    throw e;
  }
  deleteAllData(req.server.ctx.db, req.user.id);
  return reply.code(204).send();
}
