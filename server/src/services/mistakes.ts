import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  ingestionDrafts,
  learningEvents,
  mistakeVersions,
  mistakes,
  users,
} from "../db/schema.js";
import type { Db } from "../db/client.js";
import { MistakeCreate, MistakePatch, type MistakeContent } from "@mistake-book/shared";
import { scheduleFirstReview } from "./review.js";

export class ServiceError extends Error {
  constructor(
    public code: "NOT_FOUND" | "VALIDATION_ERROR" | "CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

function buildSearchText(content: MistakeContent, source?: string): string {
  return [content.stemMd, source ?? "", content.note ?? ""].join("\n").slice(0, 10000);
}

/** 保存确认后的错题:短事务内写主记录+版本+关联+事件+FTS(LLD §4.2) */
export function createMistake(
  db: Db,
  userId: string,
  input: z.input<typeof MistakeCreate>,
): { id: string } {
  const id = randomUUID();
  const now = new Date().toISOString();
  const content: MistakeContent = {
    ...input.content,
    aiPendingFields: input.content.aiPendingFields ?? [],
  };
  // 导入与手动录入都进 pending_analysis;空白题按“完全不会”闭环,不置 waiting_input(2026-08-29 决策)
  const status = "pending_analysis";
  // 录入时年级快照(PRD 5.1.3):只影响难度与报告语境
  const gradeAtTime =
    db.select().from(users).where(eq(users.id, userId)).get()?.currentGrade ?? null;

  db.transaction((tx) => {
    const versionId = randomUUID();
    tx.insert(mistakes)
      .values({
        id,
        userId,
        subject: input.subject,
        questionType: input.questionType ?? null,
        status,
        currentVersionId: versionId,
        source: input.source ?? null,
        gradeAtTime,
        searchText: buildSearchText(content, input.source),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    tx.insert(mistakeVersions)
      .values({
        id: versionId,
        mistakeId: id,
        version: 1,
        origin: input.draftId ? "import" : "manual",
        contentJson: JSON.stringify(content),
        isConfirmed: 1,
        createdAt: now,
      })
      .run();

    if (input.draftId) {
      const draft = tx
        .select()
        .from(ingestionDrafts)
        .where(and(eq(ingestionDrafts.id, input.draftId), eq(ingestionDrafts.userId, userId)))
        .get();
      if (!draft) throw new ServiceError("NOT_FOUND", "导入草稿不存在");
      if (draft.status !== "ready") {
        throw new ServiceError("VALIDATION_ERROR", `草稿状态为 ${draft.status},不可保存`);
      }
      tx.update(ingestionDrafts)
        .set({ status: "confirmed", updatedAt: now })
        .where(eq(ingestionDrafts.id, input.draftId))
        .run();
    }

    // 事件幂等:UNIQUE(user_id, event_type, source_id);同一错题只记一次
    tx.insert(learningEvents)
      .values({
        id: randomUUID(),
        userId,
        eventType: "mistake_recorded",
        subject: input.subject,
        sourceId: id,
        payloadJson: null,
        occurredAt: now,
      })
      .onConflictDoNothing()
      .run();

    tx.run(
      sql`INSERT INTO mistakes_fts (mistake_id, subject, question_text, source, note)
          VALUES (${id}, ${input.subject}, ${content.stemMd}, ${input.source ?? ""}, ${content.note ?? ""})`,
    );
  });

  scheduleFirstReview(db, userId, id);
  return { id };
}

/**
 * 修改错题:追加新版本(不改旧版本);影响分析的字段变化时重置待分析(PRD 5.2.5)。
 */
export function patchMistake(
  db: Db,
  userId: string,
  id: string,
  patch: z.input<typeof MistakePatch>,
): void {
  db.transaction((tx) => {
    const row = tx
      .select()
      .from(mistakes)
      .where(and(eq(mistakes.id, id), eq(mistakes.userId, userId)))
      .get();
    if (!row) throw new ServiceError("NOT_FOUND", "错题不存在");

    const current = row.currentVersionId
      ? tx
          .select()
          .from(mistakeVersions)
          .where(eq(mistakeVersions.id, row.currentVersionId))
          .get()
      : undefined;
    const content: MistakeContent = current
      ? JSON.parse(current.contentJson)
      : { stemMd: "", aiPendingFields: [] };

    // 用户修正 AI 错误类型:直接更新(PRD:AI 建议可被学生纠正,旧版本保留)
    if (patch.errorType) {
      tx.update(mistakes)
        .set({ errorType: patch.errorType, updatedAt: new Date().toISOString() })
        .where(eq(mistakes.id, id))
        .run();
    }

    const affectsAnalysis = ["myAnswer", "correctAnswer", "note"] as const;
    let analysisAffected = false;
    if (patch.content) {
      for (const [k, v] of Object.entries(patch.content)) {
        if (v === undefined) continue;
        // 用户修改 AI 建议值:写入用户确认值,旧版本保留(PRD 5.2.7)
        (content as Record<string, unknown>)[k] = v;
        content.aiPendingFields = (content.aiPendingFields ?? []).filter((f) => f !== k);
        if ((affectsAnalysis as readonly string[]).includes(k)) analysisAffected = true;
      }
    }

    const searchText = buildSearchText(content, patch.source ?? row.source ?? undefined);
    tx.update(mistakes)
      .set({
        subject: patch.subject ?? row.subject,
        questionType: patch.questionType ?? row.questionType,
        source: patch.source ?? row.source,
        favorite: patch.favorite === undefined ? row.favorite : patch.favorite ? 1 : 0,
        archived: patch.archived === undefined ? row.archived : patch.archived ? 1 : 0,
        status: analysisAffected ? "pending_analysis" : row.status,
        searchText,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(mistakes.id, id))
      .run();

    if (patch.content) {
      const versionId = randomUUID();
      const prevVersion = current?.version ?? 0;
      tx.insert(mistakeVersions)
        .values({
          id: versionId,
          mistakeId: id,
          version: prevVersion + 1,
          origin: "user",
          contentJson: JSON.stringify(content),
          isConfirmed: 1,
          createdAt: new Date().toISOString(),
        })
        .run();
      tx.update(mistakes)
        .set({ currentVersionId: versionId })
        .where(eq(mistakes.id, id))
        .run();

      tx.run(
        sql`UPDATE mistakes_fts SET question_text = ${content.stemMd}, note = ${content.note ?? ""},
            source = ${patch.source ?? row.source ?? ""}
            WHERE mistake_id = ${id}`,
      );
    }

    if (analysisAffected) {
      tx.insert(learningEvents)
        .values({
          id: randomUUID(),
          userId,
          eventType: "mistake_updated",
          subject: row.subject,
          sourceId: id,
          payloadJson: null,
          occurredAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
    }
  });
}

export interface MistakeListItem {
  id: string;
  subject: string;
  status: string;
  questionType: string | null;
  excerpt: string;
  favorite: boolean;
  createdAt: string;
}

export function listMistakes(
  db: Db,
  userId: string,
  filters: { subject?: string; status?: string; q?: string; limit?: number; offset?: number },
): { items: MistakeListItem[]; total: number } {
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = filters.offset ?? 0;
  const conds = [sql`user_id = ${userId}`];
  if (filters.subject) conds.push(sql`subject = ${filters.subject}`);
  if (filters.status) conds.push(sql`status = ${filters.status}`);
  if (filters.q) {
    conds.push(
      sql`id IN (SELECT mistake_id FROM mistakes_fts WHERE mistakes_fts MATCH ${filters.q})`,
    );
  }
  const where = sql.join(conds, sql` AND `);

  const rows = db.all<{
    id: string;
    subject: string;
    status: string;
    question_type: string | null;
    search_text: string;
    favorite: number;
    created_at: string;
  }>(sql`
    SELECT id, subject, status, question_type, search_text, favorite, created_at
    FROM mistakes WHERE ${where}
    ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
  `);
  const totalRow = db.get<{ c: number }>(sql`
    SELECT COUNT(*) AS c FROM mistakes WHERE ${where}
  `);

  return {
    items: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      status: r.status,
      questionType: r.question_type,
      excerpt: r.search_text.slice(0, 80),
      favorite: r.favorite === 1,
      createdAt: r.created_at,
    })),
    total: totalRow?.c ?? 0,
  };
}

export function getMistake(
  db: Db,
  userId: string,
  id: string,
): {
  id: string;
  subject: string;
  status: string;
  content: MistakeContent;
  version: number;
  createdAt: string;
} {
  const row = db.get<{
    id: string;
    subject: string;
    status: string;
    current_version_id: string | null;
    created_at: string;
  }>(sql`SELECT id, subject, status, current_version_id, created_at
          FROM mistakes WHERE id = ${id} AND user_id = ${userId}`);
  if (!row) throw new ServiceError("NOT_FOUND", "错题不存在");
  const ver = row.current_version_id
    ? db.get<{ version: number; content_json: string }>(
        sql`SELECT version, content_json FROM mistake_versions WHERE id = ${row.current_version_id}`,
      )
    : undefined;
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    version: ver?.version ?? 0,
    content: ver ? JSON.parse(ver.content_json) : null,
    createdAt: row.created_at,
  };
}

/** 删除错题:级联清理版本/关联/复习计划,FTS 显式清理(LLD §9) */
export function deleteMistake(db: Db, userId: string, id: string): void {
  db.transaction((tx) => {
    const row = tx
      .select()
      .from(mistakes)
      .where(and(eq(mistakes.id, id), eq(mistakes.userId, userId)))
      .get();
    if (!row) throw new ServiceError("NOT_FOUND", "错题不存在");
    tx.run(sql`DELETE FROM mistakes_fts WHERE mistake_id = ${id}`);
    tx.run(sql`DELETE FROM review_schedules WHERE mistake_id = ${id}`);
    tx.run(sql`DELETE FROM mistake_concepts WHERE mistake_id = ${id}`);
    // learning_events 是事实史:保留事件但清空 payload(不再引用正文)
    tx.run(sql`UPDATE learning_events SET payload_json = NULL WHERE source_id = ${id}`);
    tx.delete(mistakes).where(eq(mistakes.id, id)).run();
  });
}
