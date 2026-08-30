import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrator.js";
import { conceptCategories, concepts, generatedQuestions, mastery, practiceSets } from "../src/db/schema.js";
import {
  assignCategory,
  mergeCategories,
  mergeConcepts,
  renameConcept,
  resolveCategory,
  resolveOrCreateConcept,
} from "../src/services/concepts.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function freshDb(): Db {
  const { db } = createDb(":memory:");
  const sqlite = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
  runMigrations(sqlite, MIGRATIONS_DIR);
  return db;
}

describe("两级概念标签服务", () => {
  test("分类按用户+学科+规范名复用;空分类概念可补齐,已有分类不被模型抖动覆盖", () => {
    const db = freshDb();
    const categoryId = resolveCategory(db, "u_local", "english", "固定搭配");
    expect(resolveCategory(db, "u_local", "english", " 固定搭配 ")).toBe(categoryId);

    const conceptId = resolveOrCreateConcept(db, "u_local", "english", "keep cool");
    resolveOrCreateConcept(db, "u_local", "english", "keep cool", undefined, 0.8, "固定搭配");
    expect(db.select().from(concepts).where(eq(concepts.id, conceptId)).get()?.categoryId).toBe(categoryId);

    resolveOrCreateConcept(db, "u_local", "english", "keep cool", undefined, 0.8, "词汇辨析");
    expect(db.select().from(concepts).where(eq(concepts.id, conceptId)).get()?.categoryId).toBe(categoryId);
  });

  test("同名分类与未分类概念无论创建顺序如何都会自动归为一组", () => {
    const db = freshDb();

    const conceptFirst = resolveOrCreateConcept(db, "u_local", "math", "解一元一次方程");
    const categoryAfter = resolveCategory(db, "u_local", "math", "解一元一次方程");
    expect(db.select().from(concepts).where(eq(concepts.id, conceptFirst)).get()?.categoryId)
      .toBe(categoryAfter);

    const categoryFirst = resolveCategory(db, "u_local", "english", "固定搭配");
    const conceptAfter = resolveOrCreateConcept(db, "u_local", "english", "固定搭配");
    expect(db.select().from(concepts).where(eq(concepts.id, conceptAfter)).get()?.categoryId)
      .toBe(categoryFirst);

    // 没有同名分类时仍保持普通叶子概念,不能为每个概念创建自分类。
    const standalone = resolveOrCreateConcept(db, "u_local", "chinese", "病句辨析");
    expect(db.select().from(concepts).where(eq(concepts.id, standalone)).get()?.categoryId).toBeNull();
    expect(
      db.select().from(conceptCategories).all()
        .some((c) => c.subject === "chinese" && c.canonicalName === "病句辨析"),
    ).toBe(false);

    const renameCategory = resolveCategory(db, "u_local", "chinese", "古诗鉴赏");
    renameConcept(db, "u_local", standalone, "古诗鉴赏");
    expect(db.select().from(concepts).where(eq(concepts.id, standalone)).get()?.categoryId)
      .toBe(renameCategory);
  });

  test("分类合并整体改挂成员并保留 merged_into_id;拆分可逐条改挂", () => {
    const db = freshDb();
    const narrow = resolveCategory(db, "u_local", "english", "形容词辨析");
    const broad = resolveCategory(db, "u_local", "english", "词汇辨析");
    const conceptId = resolveOrCreateConcept(
      db,
      "u_local",
      "english",
      "unusual/complete",
      undefined,
      0.8,
      "形容词辨析",
    );
    mergeCategories(db, "u_local", narrow, broad);
    expect(db.select().from(concepts).where(eq(concepts.id, conceptId)).get()?.categoryId).toBe(broad);
    expect(db.select().from(conceptCategories).where(eq(conceptCategories.id, narrow)).get()).toMatchObject({
      status: "merged",
      mergedIntoId: broad,
    });

    assignCategory(db, "u_local", conceptId, "形容词用法");
    const moved = db.select().from(concepts).where(eq(concepts.id, conceptId)).get()!;
    expect(db.select().from(conceptCategories).where(eq(conceptCategories.id, moved.categoryId!)).get()?.canonicalName).toBe("形容词用法");
  });

  test("概念合并在两边都有 mastery 时不撞唯一键,而是从事实源重算", () => {
    const db = freshDb();
    const oldId = resolveOrCreateConcept(db, "u_local", "math", "解方程:去分母");
    const targetId = resolveOrCreateConcept(db, "u_local", "math", "去分母");
    const now = new Date().toISOString();
    db.insert(mastery).values([
      { id: crypto.randomUUID(), userId: "u_local", conceptId: oldId, score: 20, sampleCount: 2, freshness: 1, updatedAt: now },
      { id: crypto.randomUUID(), userId: "u_local", conceptId: targetId, score: 70, sampleCount: 4, freshness: 1, updatedAt: now },
    ]).run();
    const setId = crypto.randomUUID();
    db.insert(practiceSets).values({
      id: setId,
      userId: "u_local",
      subject: "math",
      origin: "smart",
      status: "ready",
      paramsJson: "{}",
      createdAt: now,
      completedAt: now,
    }).run();
    const questionId = crypto.randomUUID();
    db.insert(generatedQuestions).values({
      id: questionId,
      practiceSetId: setId,
      userId: "u_local",
      subject: "math",
      questionJson: "{}",
      status: "valid",
      conceptIdsJson: JSON.stringify([oldId, targetId]),
      createdAt: now,
    }).run();

    expect(() => mergeConcepts(db, "u_local", oldId, targetId)).not.toThrow();
    expect(db.select().from(concepts).where(eq(concepts.id, oldId)).get()).toMatchObject({
      status: "merged",
      mergedIntoId: targetId,
    });
    const masteryRows = db.select().from(mastery).all().filter((m) => m.userId === "u_local");
    expect(masteryRows).toHaveLength(1);
    expect(masteryRows[0]).toMatchObject({ conceptId: targetId, score: 50, sampleCount: 0 });
    expect(JSON.parse(db.select().from(generatedQuestions).where(eq(generatedQuestions.id, questionId)).get()!.conceptIdsJson!)).toEqual([targetId]);
  });

  test("跨学科概念不能合并", () => {
    const db = freshDb();
    const math = resolveOrCreateConcept(db, "u_local", "math", "函数");
    const english = resolveOrCreateConcept(db, "u_local", "english", "函数");
    expect(() => mergeConcepts(db, "u_local", math, english)).toThrow(/跨学科/);
  });
});
