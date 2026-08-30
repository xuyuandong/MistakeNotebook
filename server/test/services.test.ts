import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import {
  createMistake,
  deleteMistake,
  getMistake,
  listMistakes,
} from "../src/services/mistakes.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrator.js";
import { attempts, concepts, importBatches, ingestionDrafts, learningEvents, mistakeConcepts, mistakes } from "../src/db/schema.js";
import { resolveCategory, resolveOrCreateConcept } from "../src/services/concepts.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function freshDb(): Db {
  const { db } = createDb(":memory:");
  // createDb 内部已建立 better-sqlite3 连接,直接取 underlying client 应用迁移
  const sqlite = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
  runMigrations(sqlite, MIGRATIONS_DIR);
  return db;
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4,
]);

describe("错题服务", () => {
  const manualInput = {
    subject: "math" as const,
    manual: { stemMd: "解方程 $x-1=0$" },
    content: {
      stemMd: "解方程 $x-1=0$",
      myAnswer: "x=0",
      note: "忘了移项要变号",
    },
  };

  test("手工创建错题:写入版本、事件、FTS,状态为待分析", () => {
    const db = freshDb();
    const { id } = createMistake(db, "u_local", manualInput);

    const row = db.select().from(mistakes).where(eq(mistakes.id, id)).get();
    expect(row?.status).toBe("pending_analysis"); // 有学生答案 → 待分析

    const events = db
      .select()
      .from(learningEvents)
      .where(eq(learningEvents.sourceId, id))
      .all();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("mistake_recorded");

    const fts = db.all<{ mistake_id: string }>(
      sql`SELECT mistake_id FROM mistakes_fts`,
    );
    expect(fts.map((r) => r.mistake_id)).toContain(id);
  });

  test("列表筛选与 FTS 搜索", () => {
    const db = freshDb();
    createMistake(db, "u_local", manualInput);
    createMistake(db, "u_local", {
      subject: "english",
      manual: { stemMd: "Choose the correct verb form." },
      content: { stemMd: "Choose the correct verb form." },
    });

    expect(listMistakes(db, "u_local", {}).total).toBe(2);
    expect(listMistakes(db, "u_local", { subject: "math" }).total).toBe(1);
    const hits = listMistakes(db, "u_local", { q: "解方程" });
    expect(hits.total).toBe(1);
    expect(hits.items[0].excerpt).toContain("解方程");
  });

  test("列表可按分类/概念筛出从未提交错题复习的未归档题目", () => {
    const db = freshDb();
    const first = createMistake(db, "u_local", manualInput).id;
    const second = createMistake(db, "u_local", {
      ...manualInput,
      content: { ...manualInput.content, stemMd: "解方程 $2x=4$" },
    }).id;
    const categoryId = resolveCategory(db, "u_local", "math", "一元一次方程");
    const conceptId = resolveOrCreateConcept(
      db,
      "u_local",
      "math",
      "移项",
      first,
      0.9,
      "一元一次方程",
    );
    for (const mistakeId of [first, second]) {
      db.insert(mistakeConcepts).values({
        id: crypto.randomUUID(),
        mistakeId,
        conceptId,
        mistakeVersion: 1,
        isPrimary: 1,
        createdAt: new Date().toISOString(),
      }).run();
    }
    db.insert(attempts).values({
      id: crypto.randomUUID(),
      userId: "u_local",
      sourceType: "mistake_review",
      sourceId: first,
      result: "wrong",
      createdAt: new Date().toISOString(),
    }).run();

    const byCategory = listMistakes(db, "u_local", { categoryId, unpracticed: true });
    expect(byCategory.total).toBe(1);
    expect(byCategory.items.map((m) => m.id)).toEqual([second]);
    const byConcept = listMistakes(db, "u_local", { conceptId, unpracticed: true });
    expect(byConcept.items.map((m) => m.id)).toEqual([second]);

    // 已归档题不属于学习分析的待练习口径。
    db.update(mistakes).set({ archived: 1 }).where(eq(mistakes.id, second)).run();
    expect(listMistakes(db, "u_local", { categoryId, unpracticed: true }).total).toBe(0);
    expect(db.select().from(concepts).where(eq(concepts.id, conceptId)).get()?.categoryId)
      .toBe(categoryId);
  });

  test("waiting_input:无学生答案时不得臆测,进入待补充", () => {
    const db = freshDb();
    const { id } = createMistake(db, "u_local", {
      subject: "math",
      manual: { stemMd: "题目" },
      content: { stemMd: "题目" },
    });
    // 空白题也进 pending_analysis(“完全不会”闭环,2026-08-29 决策)
    expect(db.select().from(mistakes).where(eq(mistakes.id, id)).get()?.status).toBe(
      "pending_analysis",
    );
  });

  test("从导入草稿创建:草稿置 confirmed,版本来源为 import", () => {
    const db = freshDb();
    const batchId = crypto.randomUUID();
    const draftId = crypto.randomUUID();
    db.insert(importBatches)
      .values({
        id: batchId,
        userId: "u_local",
        templateVersion: "doubao-template@6",
        rawJson: "[]",
        sha256: "hash-" + batchId,
        questionCount: 1,
        createdAt: new Date().toISOString(),
      })
      .run();
    db.insert(ingestionDrafts)
      .values({
        id: draftId,
        userId: "u_local",
        importBatchId: batchId,
        status: "ready",
        resultJson: "{}",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    const { id } = createMistake(db, "u_local", {
      subject: "math",
      draftId,
      content: { stemMd: "题目", myAnswer: "B" },
    });
    expect(
      db.select().from(ingestionDrafts).where(eq(ingestionDrafts.id, draftId)).get()
        ?.status,
    ).toBe("confirmed");

    const ver = db.get<{ origin: string; version: number }>(
      sql`SELECT origin, version FROM mistake_versions WHERE mistake_id = ${id}`,
    );
    expect(ver?.origin).toBe("import");
    expect(ver?.version).toBe(1);
  });

  test("非 ready 状态的草稿不可保存", () => {
    const db = freshDb();
    const batchId = crypto.randomUUID();
    const draftId = crypto.randomUUID();
    db.insert(importBatches)
      .values({
        id: batchId,
        userId: "u_local",
        templateVersion: "doubao-template@6",
        rawJson: "[]",
        sha256: "hash-" + batchId,
        questionCount: 1,
        createdAt: new Date().toISOString(),
      })
      .run();
    db.insert(ingestionDrafts)
      .values({
        id: draftId,
        userId: "u_local",
        importBatchId: batchId,
        status: "discarded",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    expect(() =>
      createMistake(db, "u_local", {
        subject: "math",
        draftId,
        content: { stemMd: "题目" },
      }),
    ).toThrow(/不可保存/);
  });

  test("删除错题清理 FTS 与派生关联,保留事件", () => {
    const db = freshDb();
    const { id } = createMistake(db, "u_local", manualInput);
    deleteMistake(db, "u_local", id);
    expect(db.select().from(mistakes).where(eq(mistakes.id, id)).get()).toBeUndefined();
    expect(listMistakes(db, "u_local", { q: "解方程" }).total).toBe(0);
    // 事件保留(事实史,payload 已清空)
    expect(
      db.select().from(learningEvents).where(eq(learningEvents.sourceId, id)).all(),
    ).toHaveLength(1);
  });

  test("详情返回最新版本内容", () => {
    const db = freshDb();
    const { id } = createMistake(db, "u_local", manualInput);
    const detail = getMistake(db, "u_local", id);
    expect(detail.version).toBe(1);
    expect(detail.content.stemMd).toContain("解方程");
  });

  test("详情返回当前版本关联知识点与分类", () => {
    const db = freshDb();
    const { id } = createMistake(db, "u_local", manualInput);
    const conceptId = resolveOrCreateConcept(
      db,
      "u_local",
      "math",
      "去分母",
      id,
      0.9,
      "一元一次方程",
    );
    db.insert(mistakeConcepts)
      .values({
        id: crypto.randomUUID(),
        mistakeId: id,
        conceptId,
        mistakeVersion: 1,
        isPrimary: 1,
        evidence: "移项出错",
        confidence: 0.9,
        createdAt: new Date().toISOString(),
      })
      .run();

    expect(getMistake(db, "u_local", id).concepts).toEqual([
      expect.objectContaining({
        id: conceptId,
        name: "去分母",
        category: "一元一次方程",
        isPrimary: true,
      }),
    ]);
  });
});
