import type { FastifyReply, FastifyRequest } from "fastify";
import { MistakeCreate } from "@mistake-book/shared";
import {
  createMistake,
  deleteMistake,
  getMistake,
  listMistakes,
  ServiceError,
} from "../services/mistakes.js";
import { err } from "./http.js";

/** POST /api/v1/mistakes — 保存确认后的错题 */
export async function createMistakeHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = MistakeCreate.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send(err("VALIDATION_ERROR", parsed.error.issues[0].message));
  }
  try {
    const { id } = createMistake(req.server.ctx.db, req.user.id, parsed.data);
    return { mistakeId: id };
  } catch (e) {
    if (e instanceof ServiceError) {
      const status = e.code === "NOT_FOUND" ? 404 : 400;
      return reply.code(status).send(err(e.code, e.message));
    }
    throw e;
  }
}

/** GET /api/v1/mistakes — 搜索与筛选 */
export async function listMistakesHandler(req: FastifyRequest) {
  const q = req.query as {
    subject?: string;
    status?: string;
    q?: string;
    limit?: string;
    offset?: string;
  };
  return listMistakes(req.server.ctx.db, req.user.id, {
    subject: q.subject,
    status: q.status,
    q: q.q,
    limit: q.limit ? Number(q.limit) : undefined,
    offset: q.offset ? Number(q.offset) : undefined,
  });
}

/** GET /api/v1/mistakes/:id — 详情(最新版本内容) */
export async function getMistakeHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  try {
    return getMistake(req.server.ctx.db, req.user.id, id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === "NOT_FOUND") {
      return reply.code(404).send(err(e.code, e.message));
    }
    throw e;
  }
}

/** DELETE /api/v1/mistakes/:id — 级联清理派生数据 */
export async function deleteMistakeHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  try {
    deleteMistake(req.server.ctx.db, req.user.id, id);
    return reply.code(204).send();
  } catch (e) {
    if (e instanceof ServiceError && e.code === "NOT_FOUND") {
      return reply.code(404).send(err(e.code, e.message));
    }
    throw e;
  }
}
