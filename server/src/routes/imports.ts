import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { importBatches, ingestionDrafts } from "../db/schema.js";
import { importDoubaoJson, ImportError } from "../services/imports.js";
import type { Db } from "../db/client.js";
import { err } from "./http.js";

function toValidationError(e: unknown, reply: FastifyReply) {
  if (e instanceof ImportError) {
    return reply.code(400).send(err(e.code, e.message, e.details));
  }
  throw e;
}

/**
 * POST /api/v1/imports — 导入豆包 JSON(LLD §3.2)。
 * 接受 application/json {text} 或 multipart .json 文件;同步确定性解析,不创建 ai_job。
 */
export async function createImportHandler(req: FastifyRequest, reply: FastifyReply) {
  const { db } = req.server.ctx;
  let text: string | null = null;

  const contentType = req.headers["content-type"] ?? "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const file = await req.file();
      if (!file) {
        return reply.code(400).send(err("VALIDATION_ERROR", "缺少文件字段 file"));
      }
      text = (await file.toBuffer()).toString("utf8");
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode === 413 ? 413 : 400;
      return reply
        .code(status)
        .send(err(status === 413 ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR", (e as Error).message));
    }
  } else {
    const body = req.body as { text?: unknown } | null;
    if (typeof body?.text !== "string" || !body.text.trim()) {
      return reply.code(400).send(err("VALIDATION_ERROR", "缺少 text 字段(豆包 JSON 全文)"));
    }
    text = body.text;
  }

  try {
    const result = importDoubaoJson(db, req.user.id, text);
    return result;
  } catch (e) {
    return toValidationError(e, reply);
  }
}

/** GET /api/v1/imports — 导入批次历史 */
export async function listImportsHandler(req: FastifyRequest) {
  const { db } = req.server.ctx;
  const rows = db
    .select()
    .from(importBatches)
    .all()
    .filter((b) => b.userId === req.user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    items: rows.map((b) => ({
      id: b.id,
      source: b.source,
      templateVersion: b.templateVersion,
      questionCount: b.questionCount,
      createdAt: b.createdAt,
    })),
  };
}

/** GET /api/v1/imports/:id — 批次详情与全部草稿 */
export async function getImportHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const { db } = req.server.ctx;
  const batch = db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.id, id), eq(importBatches.userId, req.user.id)))
    .get();
  if (!batch) return reply.code(404).send(err("NOT_FOUND", "导入批次不存在"));
  const drafts = db
    .select()
    .from(ingestionDrafts)
    .where(eq(ingestionDrafts.importBatchId, id))
    .all()
    .filter((d) => d.userId === req.user.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    id: batch.id,
    source: batch.source,
    templateVersion: batch.templateVersion,
    questionCount: batch.questionCount,
    createdAt: batch.createdAt,
    rawJson: batch.rawJson,
    drafts: drafts.map((d) => ({
      id: d.id,
      status: d.status,
      index: null,
      result: d.resultJson ? JSON.parse(d.resultJson) : null,
      rawJson: d.rawJson,
      error: d.error,
    })),
  };
}

/** DELETE /api/v1/imports/:id — 级联删未确认草稿;已确认错题不受影响 */
export async function deleteImportHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const { db } = req.server.ctx;
  const batch = db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.id, id), eq(importBatches.userId, req.user.id)))
    .get();
  if (!batch) return reply.code(404).send(err("NOT_FOUND", "导入批次不存在"));
  db.delete(importBatches).where(eq(importBatches.id, id)).run();
  return reply.code(204).send();
}

/** GET /api/v1/ingestion-drafts — 草稿箱列表 */
export async function listDraftsHandler(req: FastifyRequest) {
  const { db } = req.server.ctx;
  const { status, batchId } = req.query as { status?: string; batchId?: string };
  const rows = db
    .select()
    .from(ingestionDrafts)
    .all()
    .filter(
      (d) =>
        d.userId === req.user.id &&
        (!status || d.status === status) &&
        (!batchId || d.importBatchId === batchId),
    );
  return {
    items: rows.map((d) => ({
      id: d.id,
      status: d.status,
      batchId: d.importBatchId,
      index: null,
      hasResult: Boolean(d.resultJson),
      createdAt: d.createdAt,
    })),
  };
}

function draftView(d: typeof ingestionDrafts.$inferSelect) {
  return {
    id: d.id,
    status: d.status,
    batchId: d.importBatchId,
    index: null,
    result: d.resultJson ? JSON.parse(d.resultJson) : null,
    rawJson: d.rawJson,
    error: d.error,
  };
}

/** GET /api/v1/ingestion-drafts/:id — 草稿详情 */
export async function getDraftHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const { db } = req.server.ctx;
  const draft = db
    .select()
    .from(ingestionDrafts)
    .where(and(eq(ingestionDrafts.id, id), eq(ingestionDrafts.userId, req.user.id)))
    .get();
  if (!draft) return reply.code(404).send(err("NOT_FOUND", "草稿不存在"));
  return draftView(draft);
}

/** GET /api/v1/debug/ai-raw?file= — 按文件名读取模型原始响应(调试用,analyze/generate/judge) */
export async function debugAiRawHandler(req: FastifyRequest, reply: FastifyReply) {
  const { file, task } = req.query as { file?: string; task?: string };
  const { rawStore } = req.server.ctx;
  if (!file) {
    return reply.code(400).send(err("VALIDATION_ERROR", "缺少 file 参数"));
  }
  const record = rawStore.read(task ?? "analyze_mistake", file);
  if (!record) return reply.code(404).send(err("NOT_FOUND", "没有落盘的原始响应"));
  return record;
}

