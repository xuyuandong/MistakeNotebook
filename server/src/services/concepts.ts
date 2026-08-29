import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { concepts, conceptAliases, mastery, mistakeConcepts } from "../db/schema.js";
import type { Db } from "../db/client.js";
import type { Subject } from "@mistake-book/shared";

/**
 * 数据驱动的知识概念(HLD §9.9):
 * 先精确匹配规范名/别名,高置信命中已有概念;否则创建新概念。
 * 只在真实错题/作答证据出现时建立,不预置知识树。
 */
export function resolveOrCreateConcept(
  db: Db,
  userId: string,
  subject: Subject,
  name: string,
  discoveredFromMistakeId?: string,
  confidence = 0.5,
): string {
  const normalized = name.trim().slice(0, 100);
  if (!normalized) throw new Error("概念名不能为空");

  const byName = db
    .select()
    .from(concepts)
    .where(
      and(
        eq(concepts.userId, userId),
        eq(concepts.subject, subject),
        eq(concepts.canonicalName, normalized),
      ),
    )
    .get();
  if (byName) return byName.id;

  const alias = db
    .select()
    .from(conceptAliases)
    .all()
    .find((a) => a.alias === normalized && a.conceptId);
  if (alias) {
    const target = db
      .select()
      .from(concepts)
      .where(and(eq(concepts.id, alias.conceptId), eq(concepts.userId, userId)))
      .get();
    if (target && target.status === "active") return target.id;
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(concepts)
    .values({
      id,
      userId,
      subject,
      canonicalName: normalized,
      status: "active",
      discoveredFromMistakeId: discoveredFromMistakeId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  // 并发/重复创建时取回已有行
  const created = db
    .select()
    .from(concepts)
    .where(
      and(
        eq(concepts.userId, userId),
        eq(concepts.subject, subject),
        eq(concepts.canonicalName, normalized),
      ),
    )
    .get();
  void confidence;
  if (!created) throw new Error("概念创建失败");
  return created.id;
}

/** 概念改名;同时把旧名记为别名,保留历史(PRD 5.2.3) */
export function renameConcept(db: Db, userId: string, conceptId: string, newName: string): void {
  db.transaction((tx) => {
    const c = tx
      .select()
      .from(concepts)
      .where(and(eq(concepts.id, conceptId), eq(concepts.userId, userId)))
      .get();
    if (!c) throw new Error("概念不存在");
    const old = c.canonicalName;
    tx.insert(conceptAliases)
      .values({
        id: randomUUID(),
        conceptId,
        alias: old,
        source: "user",
        confidence: 1,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
    tx.update(concepts)
      .set({ canonicalName: newName.trim().slice(0, 100), updatedAt: new Date().toISOString() })
      .where(eq(concepts.id, conceptId))
      .run();
  });
}

/**
 * 合并概念:old → target。旧 ID 通过 merged_into_id 保留可追溯;
 * 关联与掌握度迁移到目标概念(按唯一键去重,不重复计数)。
 */
export function mergeConcepts(db: Db, userId: string, oldId: string, targetId: string): void {
  if (oldId === targetId) throw new Error("不能合并到自身");
  db.transaction((tx) => {
    const old = tx
      .select()
      .from(concepts)
      .where(and(eq(concepts.id, oldId), eq(concepts.userId, userId)))
      .get();
    const target = tx
      .select()
      .from(concepts)
      .where(and(eq(concepts.id, targetId), eq(concepts.userId, userId)))
      .get();
    if (!old || !target) throw new Error("概念不存在");

    tx.insert(conceptAliases)
      .values({
        id: randomUUID(),
        conceptId: targetId,
        alias: old.canonicalName,
        source: "merge",
        confidence: 1,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();

    // 迁移错题关联:冲突(目标已有同错题同版本关联)时丢弃旧关联,不重复计数
    const rows = tx
      .select()
      .from(mistakeConcepts)
      .where(eq(mistakeConcepts.conceptId, oldId))
      .all();
    for (const row of rows) {
      const dup = tx
        .select()
        .from(mistakeConcepts)
        .where(
          and(
            eq(mistakeConcepts.mistakeId, row.mistakeId),
            eq(mistakeConcepts.mistakeVersion, row.mistakeVersion),
            eq(mistakeConcepts.conceptId, targetId),
          ),
        )
        .get();
      if (!dup) {
        tx.update(mistakeConcepts)
          .set({ conceptId: targetId })
          .where(eq(mistakeConcepts.id, row.id))
          .run();
      } else {
        tx.delete(mistakeConcepts).where(eq(mistakeConcepts.id, row.id)).run();
      }
    }

    tx.run(
      sql`UPDATE mastery SET concept_id = ${targetId} WHERE concept_id = ${oldId} AND user_id = ${userId}`,
    );
    // 同目标概念可能已有一行,去重合并
    tx.run(
      sql`DELETE FROM mastery WHERE concept_id = ${targetId} AND user_id = ${userId} AND id NOT IN (
            SELECT id FROM mastery WHERE concept_id = ${targetId} AND user_id = ${userId} ORDER BY updated_at DESC LIMIT 1
          )`,
    );

    tx.update(concepts)
      .set({ status: "merged", mergedIntoId: targetId, updatedAt: new Date().toISOString() })
      .where(eq(concepts.id, oldId))
      .run();
  });
}

/** 忽略概念:不再进入分析上下文与展示,保留历史 */
export function ignoreConcept(db: Db, userId: string, conceptId: string): void {
  db.update(concepts)
    .set({ status: "ignored", updatedAt: new Date().toISOString() })
    .where(and(eq(concepts.id, conceptId), eq(concepts.userId, userId)))
    .run();
}

/** 掌握度只在有真实证据的概念上计算(HLD §9.9-5) */
export function conceptsWithMastery(db: Db, userId: string) {
  return db
    .select({
      id: concepts.id,
      subject: concepts.subject,
      canonicalName: concepts.canonicalName,
      status: concepts.status,
      score: mastery.score,
      sampleCount: mastery.sampleCount,
      lastPracticedAt: mastery.lastPracticedAt,
    })
    .from(concepts)
    .leftJoin(mastery, and(eq(mastery.conceptId, concepts.id), eq(mastery.userId, userId)))
    .where(eq(concepts.userId, userId))
    .all();
}
