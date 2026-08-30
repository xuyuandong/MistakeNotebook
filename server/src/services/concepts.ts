import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  conceptAliases,
  conceptCategories,
  concepts,
  generatedQuestions,
  mastery,
  mistakeConcepts,
} from "../db/schema.js";
import type { Db } from "../db/client.js";
import type { Subject } from "@mistake-book/shared";
import { recomputeMasteryForConcept } from "./mastery.js";

/**
 * 数据驱动的知识概念(HLD §9.9):
 * 先精确匹配规范名/别名,高置信命中已有概念;否则创建新概念。
 * 只在真实错题/作答证据出现时建立,不预置知识树。
 */

const nowIso = () => new Date().toISOString();

/**
 * 分类名和未分类概念名完全相同时,二者在分类聚合视图中会显示成同名两行。
 * 将该叶子概念挂入分类即可保留概念 ID/证据,同时维持展示名称唯一。
 */
function attachSameNameConcept(
  db: Db,
  userId: string,
  subject: Subject,
  categoryName: string,
  categoryId: string,
): void {
  db.update(concepts)
    .set({ categoryId, updatedAt: nowIso() })
    .where(
      and(
        eq(concepts.userId, userId),
        eq(concepts.subject, subject),
        eq(concepts.canonicalName, categoryName),
        eq(concepts.status, "active"),
        isNull(concepts.categoryId),
      ),
    )
    .run();
}

/** 只解析已经存在的同名分类;不存在时返回 null,避免给每个叶子概念创建自分类。 */
function resolveMatchingCategory(
  db: Db,
  userId: string,
  subject: Subject,
  conceptName: string,
): string | null {
  const matching = db
    .select()
    .from(conceptCategories)
    .where(
      and(
        eq(conceptCategories.userId, userId),
        eq(conceptCategories.subject, subject),
        eq(conceptCategories.canonicalName, conceptName),
      ),
    )
    .get();
  return matching ? resolveCategory(db, userId, subject, conceptName) : null;
}

/**
 * 两级标签(用户 2026-08-30 决策):概念分类是元信息层,按学科维护受控词表。
 * 分析提示词会收到已有分类列表并要求优先复用;此处只做精确名匹配,无则创建。
 * 合并过的分类按 merged_into_id 追溯到目标,保证旧名称引用不悬空。
 */
export function resolveCategory(
  db: Db,
  userId: string,
  subject: Subject,
  name: string,
): string {
  const normalized = name.trim().slice(0, 50);
  if (!normalized) throw new Error("分类名不能为空");
  const existing = db
    .select()
    .from(conceptCategories)
    .where(
      and(
        eq(conceptCategories.userId, userId),
        eq(conceptCategories.subject, subject),
        eq(conceptCategories.canonicalName, normalized),
      ),
    )
    .get();
  if (existing) {
    if (existing.status === "merged" && existing.mergedIntoId) {
      let targetId = existing.mergedIntoId;
      const seen = new Set([existing.id]);
      while (!seen.has(targetId)) {
        seen.add(targetId);
        const target = db
          .select()
          .from(conceptCategories)
          .where(and(eq(conceptCategories.id, targetId), eq(conceptCategories.userId, userId)))
          .get();
        if (!target || target.status === "active" || !target.mergedIntoId) {
          attachSameNameConcept(db, userId, subject, normalized, targetId);
          return targetId;
        }
        targetId = target.mergedIntoId;
      }
      throw new Error("分类合并历史存在循环");
    }
    attachSameNameConcept(db, userId, subject, normalized, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  const now = nowIso();
  db.insert(conceptCategories)
    .values({ id, userId, subject, canonicalName: normalized, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
  const created = db
    .select()
    .from(conceptCategories)
    .where(
      and(
        eq(conceptCategories.userId, userId),
        eq(conceptCategories.subject, subject),
        eq(conceptCategories.canonicalName, normalized),
      ),
    )
    .get();
  if (!created) throw new Error("分类创建失败");
  attachSameNameConcept(db, userId, subject, normalized, created.id);
  return created.id;
}

/** 学科已有分类(active),提示词反馈闭环用;按名字排序保证输出稳定 */
export function listCategoriesForSubject(
  db: Db,
  userId: string,
  subject: Subject,
  limit = 80,
): string[] {
  return db
    .select()
    .from(conceptCategories)
    .all()
    .filter(
      (c) => c.userId === userId && c.subject === subject && c.status === "active",
    )
    .map((c) => c.canonicalName)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
    .slice(0, limit);
}

/**
 * 把概念改挂分类(拆分/重组用):直接覆盖。
 * categoryName 为空通常清除;若存在同学科同名 active 分类则仍归入该分类,避免同名聚合行。
 */
export function assignCategory(
  db: Db,
  userId: string,
  conceptId: string,
  categoryName: string | null,
): void {
  const concept = db
    .select()
    .from(concepts)
    .where(and(eq(concepts.id, conceptId), eq(concepts.userId, userId)))
    .get();
  if (!concept) throw new Error("概念不存在");
  const categoryId = categoryName?.trim()
    ? resolveCategory(db, userId, concept.subject as Subject, categoryName)
    : resolveMatchingCategory(db, userId, concept.subject as Subject, concept.canonicalName);
  db.update(concepts)
    .set({ categoryId, updatedAt: nowIso() })
    .where(eq(concepts.id, conceptId))
    .run();
}

/** 合并分类:成员概念整体改挂目标分类,旧分类置 merged(保留合并历史,不物理删除) */
export function mergeCategories(
  db: Db,
  userId: string,
  fromId: string,
  intoId: string,
): void {
  if (fromId === intoId) throw new Error("不能合并到自身");
  db.transaction((tx) => {
    const from = tx
      .select()
      .from(conceptCategories)
      .where(and(eq(conceptCategories.id, fromId), eq(conceptCategories.userId, userId)))
      .get();
    const target = tx
      .select()
      .from(conceptCategories)
      .where(and(eq(conceptCategories.id, intoId), eq(conceptCategories.userId, userId)))
      .get();
    if (!from || !target) throw new Error("分类不存在");
    if (from.subject !== target.subject) throw new Error("跨学科分类不能合并");
    if (from.status !== "active" || target.status !== "active") {
      throw new Error("只能合并 active 分类");
    }
    tx.update(concepts)
      .set({ categoryId: intoId, updatedAt: nowIso() })
      .where(and(eq(concepts.userId, userId), eq(concepts.categoryId, fromId)))
      .run();
    tx.update(conceptCategories)
      .set({ status: "merged", mergedIntoId: intoId, updatedAt: nowIso() })
      .where(eq(conceptCategories.id, fromId))
      .run();
  });
}

export function resolveOrCreateConcept(
  db: Db,
  userId: string,
  subject: Subject,
  name: string,
  discoveredFromMistakeId?: string,
  confidence = 0.5,
  /** 两级标签:模型建议的分类;已有分类的概念不被覆盖(防抖动) */
  category?: string | null,
): string {
  const normalized = name.trim().slice(0, 100);
  if (!normalized) throw new Error("概念名不能为空");

  /** 命中已有概念时:无分类才填入模型建议的分类,已有分类保持不变 */
  const fillCategory = (conceptId: string, currentCategoryId: string | null | undefined) => {
    if (currentCategoryId) return;
    const categoryId = category?.trim()
      ? resolveCategory(db, userId, subject, category)
      : resolveMatchingCategory(db, userId, subject, normalized);
    if (!categoryId) return;
    db.update(concepts)
      .set({ categoryId, updatedAt: nowIso() })
      .where(eq(concepts.id, conceptId))
      .run();
  };

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
  if (byName) {
    fillCategory(byName.id, byName.categoryId);
    return byName.id;
  }

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
    if (target && target.status === "active") {
      if (target.subject !== subject) return createConcept();
      fillCategory(target.id, target.categoryId);
      return target.id;
    }
  }

  function createConcept(): string {
    const id = randomUUID();
    const now = nowIso();
    const categoryId = category?.trim()
      ? resolveCategory(db, userId, subject, category)
      : resolveMatchingCategory(db, userId, subject, normalized);
    db.insert(concepts)
      .values({
        id,
        userId,
        subject,
        canonicalName: normalized,
        categoryId,
        status: "active",
        discoveredFromMistakeId: discoveredFromMistakeId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
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
    if (!created) throw new Error("概念创建失败");
    return created.id;
  }

  void confidence;
  return createConcept();
}

/** 概念改名;同时把旧名记为别名,保留历史(PRD 5.2.3) */
export function renameConcept(db: Db, userId: string, conceptId: string, newName: string): void {
  const normalized = newName.trim().slice(0, 100);
  if (!normalized) throw new Error("概念名不能为空");
  let subject: Subject | null = null;
  db.transaction((tx) => {
    const c = tx
      .select()
      .from(concepts)
      .where(and(eq(concepts.id, conceptId), eq(concepts.userId, userId)))
      .get();
    if (!c) throw new Error("概念不存在");
    subject = c.subject as Subject;
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
      .set({ canonicalName: normalized, updatedAt: new Date().toISOString() })
      .where(eq(concepts.id, conceptId))
      .run();
  });
  // 改名也可能与 active 分类同名;复用正常解析路径补齐分类,不改变概念 ID。
  if (subject) resolveOrCreateConcept(db, userId, subject, normalized);
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
    if (old.subject !== target.subject) throw new Error("跨学科概念不能合并");
    if (old.status !== "active" || target.status !== "active") {
      throw new Error("只能合并 active 概念");
    }

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

    // 生成题关联以 JSON 保存概念 ID;合并时同样替换并去重,否则后续掌握度重建会漏掉历史作答。
    const generated = tx
      .select()
      .from(generatedQuestions)
      .where(eq(generatedQuestions.userId, userId))
      .all();
    for (const question of generated) {
      const ids = question.conceptIdsJson
        ? (JSON.parse(question.conceptIdsJson) as string[])
        : [];
      if (!ids.includes(oldId)) continue;
      tx.update(generatedQuestions)
        .set({ conceptIdsJson: JSON.stringify([...new Set(ids.map((id) => id === oldId ? targetId : id))]) })
        .where(eq(generatedQuestions.id, question.id))
        .run();
    }

    // 掌握度是确定性派生数据:删掉 old/target 旧值,基于迁移后的事实关联重算,
    // 避免直接 UPDATE 触发 UNIQUE(user_id, concept_id) 冲突或错误合并样本。
    tx.delete(mastery)
      .where(
        and(
          eq(mastery.userId, userId),
          inArray(mastery.conceptId, [oldId, targetId]),
        ),
      )
      .run();
    recomputeMasteryForConcept(tx as unknown as Db, userId, targetId);

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
