import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { analytics, subjectStats } from "../src/services/learner.js";
import { createMistake } from "../src/services/mistakes.js";
import { submitAttempt } from "../src/services/review.js";
import { resolveCategory, resolveOrCreateConcept } from "../src/services/concepts.js";
import { recomputeMasteryForConcept } from "../src/services/mastery.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrator.js";
import { conceptCategories, concepts, mastery, memoryFacts, mistakes } from "../src/db/schema.js";
import { GRADUATION_STREAK } from "@mistake-book/shared";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function freshDb(): Db {
  const { db } = createDb(":memory:");
  const sqlite = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
  runMigrations(sqlite, MIGRATIONS_DIR);
  return db;
}

function mkMistake(db: Db, subject: "math" | "chinese", correctAnswer?: string) {
  return createMistake(db, "u_local", {
    subject,
    manual: { stemMd: "题目" },
    // 填空 + 标准答案:作答走本地判定,避免 LLM 判分 pending
    questionType: correctAnswer ? "填空" : undefined,
    content: { stemMd: "题目", correctAnswer },
  }).id;
}

function linkConcept(db: Db, mistakeId: string, conceptId: string) {
  db.run(
    sql`INSERT INTO mistake_concepts (id, mistake_id, concept_id, mistake_version, is_primary, created_at)
        VALUES (${crypto.randomUUID()}, ${mistakeId}, ${conceptId}, 1, 1, ${new Date().toISOString()})`,
  );
}

describe("学习分析统计(薄弱点三列 + 分学科统计)", () => {
  test("薄弱点行返回错题总数/已毕业数/练习样本数;毕业一题后掌握列变化", () => {
    const db = freshDb();
    const m1 = mkMistake(db, "math", "a1");
    const m2 = mkMistake(db, "math", "b2");
    const c1 = resolveOrCreateConcept(db, "u_local", "math", "去分母", m1);
    linkConcept(db, m1, c1);
    linkConcept(db, m2, c1);
    recomputeMasteryForConcept(db, "u_local", c1);

    let weak = analytics(db, "u_local").weaknesses.find((w) => w.conceptId === c1)!;
    expect(weak.mistakeCount).toBe(2);
    expect(weak.pendingPracticeCount).toBe(2);
    expect(weak.graduatedCount).toBe(0);
    expect(weak.sampleCount).toBe(0);
    expect(weak.insufficient).toBe(true);

    // 连续答对 m1 达毕业阈值:毕业数 +1,练习样本 = 毕业题的作答数
    for (let i = 0; i < GRADUATION_STREAK; i++) {
      submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: m1, answer: "a1" });
    }
    weak = analytics(db, "u_local").weaknesses.find((w) => w.conceptId === c1)!;
    expect(weak.mistakeCount).toBe(2);
    expect(weak.pendingPracticeCount).toBe(1);
    expect(weak.graduatedCount).toBe(1);
    expect(weak.sampleCount).toBe(GRADUATION_STREAK);
    expect(weak.insufficient).toBe(false);
    // 待巩固(错题总数 - 毕业)= 1,前端由两列直接可读
    expect(weak.mistakeCount - weak.graduatedCount).toBe(1);
  });

  test("分学科统计:固定三科,错题状态/复习/毕业/练习/掌握分布正确", () => {
    const db = freshDb();
    const m1 = mkMistake(db, "math", "a1");
    const m2 = mkMistake(db, "math", "b2");
    const c1 = resolveOrCreateConcept(db, "u_local", "math", "去分母", m1);
    linkConcept(db, m1, c1);
    linkConcept(db, m2, c1);
    recomputeMasteryForConcept(db, "u_local", c1);
    const cN = mkMistake(db, "chinese");
    resolveOrCreateConcept(db, "u_local", "chinese", "病句辨析", cN);

    for (let i = 0; i < GRADUATION_STREAK; i++) {
      submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: m1, answer: "a1" });
    }

    const rows = subjectStats(db, "u_local");
    expect(rows.map((r) => r.subject)).toEqual(["chinese", "math", "english"]);

    const math = rows.find((r) => r.subject === "math")!;
    expect(math.mistakeTotal).toBe(2);
    expect(math.pendingAnalysis).toBe(2); // 都未分析
    expect(math.analyzed).toBe(0);
    expect(math.graduated).toBe(1);
    expect(math.attempts30d).toBe(GRADUATION_STREAK);
    expect(math.correct30d).toBe(GRADUATION_STREAK);
    expect(math.correctRate30d).toBe(100);
    expect(math.conceptCount).toBe(1);
    expect(math.reviewScheduled).toBe(1); // m2 仍有一档排期
    expect(math.avgMastery).not.toBeNull();

    const chinese = rows.find((r) => r.subject === "chinese")!;
    expect(chinese.mistakeTotal).toBe(1);
    expect(chinese.graduated).toBe(0);
    expect(chinese.attempts30d).toBe(0);
    expect(chinese.correctRate30d).toBeNull();

    const english = rows.find((r) => r.subject === "english")!;
    expect(english.mistakeTotal).toBe(0);
    expect(english.conceptCount).toBe(0);
    expect(english.avgMastery).toBeNull();
  });

  test("错误类型按学科分组;归档错题不计数", () => {
    const db = freshDb();
    const m1 = mkMistake(db, "math", "a1");
    const m2 = mkMistake(db, "math", "b2");
    const c1 = mkMistake(db, "chinese");
    const now = new Date().toISOString();
    for (const [id, errorType] of [
      [m1, "knowledge_gap"],
      [m2, "knowledge_gap"],
      [c1, "comprehension"],
    ] as const) {
      db.update(mistakes)
        .set({ status: "analyzed", errorType, updatedAt: now })
        .where(eq(mistakes.id, id))
        .run();
    }
    db.update(mistakes).set({ archived: 1 }).where(eq(mistakes.id, m2)).run();

    const a = analytics(db, "u_local");
    const mathGap = a.errorTypes.find((e) => e.subject === "math" && e.errorType === "knowledge_gap");
    expect(mathGap?.count).toBe(1); // m2 已归档,不计
    const chineseComp = a.errorTypes.find((e) => e.subject === "chinese" && e.errorType === "comprehension");
    expect(chineseComp?.count).toBe(1);

    const math = subjectStats(db, "u_local").find((r) => r.subject === "math")!;
    expect(math.mistakeTotal).toBe(1); // 归档后总数同步减少
    expect(math.analyzed).toBe(1);
    expect(math.pendingAnalysis).toBe(0);
  });

  test("概念重命名后弱点列表使用 canonicalName,三列随关联变化", () => {
    const db = freshDb();
    const m1 = mkMistake(db, "math", "a1");
    const c1 = resolveOrCreateConcept(db, "u_local", "math", "临时名", m1);
    linkConcept(db, m1, c1);
    db.update(concepts)
      .set({ canonicalName: "等量代换" })
      .where(eq(concepts.id, c1))
      .run();
    const weak = analytics(db, "u_local").weaknesses.find((w) => w.conceptId === c1)!;
    expect(weak.name).toBe("等量代换");
    expect(weak.mistakeCount).toBe(1);
  });

  test("同分类聚合成一行:错题取成员并集、样本求和、掌握分按样本加权,并保留成员明细", () => {
    const db = freshDb();
    const m1 = mkMistake(db, "math", "a1");
    const m2 = mkMistake(db, "math", "b2");
    const categoryId = resolveCategory(db, "u_local", "math", "一元一次方程");
    const c1 = resolveOrCreateConcept(db, "u_local", "math", "去分母", m1, 0.8, "一元一次方程");
    const c2 = resolveOrCreateConcept(db, "u_local", "math", "移项", m1, 0.8, "一元一次方程");
    linkConcept(db, m1, c1);
    linkConcept(db, m1, c2); // 同一错题关联两个成员,分类行只能计一次
    linkConcept(db, m2, c2);
    const now = new Date().toISOString();
    db.insert(mastery).values([
      { id: crypto.randomUUID(), userId: "u_local", conceptId: c1, score: 20, sampleCount: 1, freshness: 1, updatedAt: now },
      { id: crypto.randomUUID(), userId: "u_local", conceptId: c2, score: 80, sampleCount: 3, freshness: 1, updatedAt: now },
    ]).run();

    const rows = analytics(db, "u_local").weaknesses;
    expect(rows).toHaveLength(1);
    const group = rows[0];
    expect(group.conceptId).toBe(categoryId);
    expect(group.name).toBe("一元一次方程");
    expect(group.mistakeCount).toBe(2);
    expect(group.pendingPracticeCount).toBe(2);
    expect(group.sampleCount).toBe(4);
    expect(group.score).toBe(65); // (20×1 + 80×3) / 4
    expect(group.insufficient).toBe(false);
    expect(group.members.map((m) => m.name).sort()).toEqual(["去分母", "移项"].sort());
    expect(group.members.find((m) => m.conceptId === c1)?.pendingPracticeCount).toBe(1);
    expect(group.members.find((m) => m.conceptId === c2)?.pendingPracticeCount).toBe(2);
  });

  test("查询兜底:同名未分类概念与分类合为一行且不丢两侧证据", () => {
    const db = freshDb();
    const m1 = mkMistake(db, "math", "a1");
    const m2 = mkMistake(db, "math", "b2");
    const genericId = resolveOrCreateConcept(db, "u_local", "math", "解一元一次方程", m1);
    linkConcept(db, m1, genericId);

    // 直接写表模拟迁移前历史状态或绕过概念服务的异常写入。
    const categoryId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.insert(conceptCategories).values({
      id: categoryId,
      userId: "u_local",
      subject: "math",
      canonicalName: "解一元一次方程",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    const specificId = resolveOrCreateConcept(
      db,
      "u_local",
      "math",
      "解一元一次方程：去分母",
      m2,
      0.8,
      "解一元一次方程",
    );
    linkConcept(db, m2, specificId);
    // 服务层本会自动修复;重新构造异常状态以单独验证 analytics 的只读兜底。
    db.update(concepts).set({ categoryId: null }).where(eq(concepts.id, genericId)).run();

    const matching = analytics(db, "u_local").weaknesses
      .filter((w) => w.name === "解一元一次方程");
    expect(matching).toHaveLength(1);
    expect(matching[0].conceptId).toBe(categoryId);
    expect(matching[0].mistakeCount).toBe(2);
    expect(matching[0].pendingPracticeCount).toBe(2);
    expect(matching[0].members.map((m) => m.conceptId).sort())
      .toEqual([genericId, specificId].sort());
  });

  test("薄弱点返回全量并按待练习数降序;零证据概念被排除;习惯画像带学科", () => {
    const db = freshDb();
    // 12 个概念,验证超过 10 也全部返回;概念0额外关联一题,应排首位。
    let firstConceptId = "";
    for (let i = 0; i < 12; i++) {
      const m = mkMistake(db, "math", `ans${i}`);
      const c = resolveOrCreateConcept(db, "u_local", "math", `概念${i}`, m);
      if (i === 0) firstConceptId = c;
      linkConcept(db, m, c);
    }
    const extra = mkMistake(db, "math", "extra");
    linkConcept(db, extra, firstConceptId);
    // 孤立概念:无关联错题且无作答样本(如编新题建出的概念),不进薄弱点列表
    resolveOrCreateConcept(db, "u_local", "math", "孤立概念");
    db.insert(memoryFacts)
      .values({
        id: crypto.randomUUID(),
        userId: "u_local",
        scope: "math",
        kind: "habit_pattern",
        statement: "缺少检查习惯",
        confidence: 0.8,
        status: "active",
        validFrom: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    const a = analytics(db, "u_local");
    const activeConceptCount = db
      .select()
      .from(concepts)
      .all()
      .filter((c) => c.userId === "u_local" && c.status === "active").length;
    expect(activeConceptCount).toBe(13); // 12 + 孤立概念
    expect(a.weaknesses).toHaveLength(12); // 孤立概念被过滤
    expect(a.weaknesses.some((w) => w.name === "孤立概念")).toBe(false);
    expect(a.weaknesses[0]).toMatchObject({ conceptId: firstConceptId, pendingPracticeCount: 2 });
    const pendingCounts = a.weaknesses.map((w) => w.pendingPracticeCount);
    expect([...pendingCounts].sort((x, y) => y - x)).toEqual(pendingCounts);

    expect(a.habits).toHaveLength(1);
    expect(a.habits[0].scope).toBe("math");
  });
});
