import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import {
  addDays,
  attemptDetail,
  finalizePendingAttempt,
  isGraduated,
  localDate,
  reviveGraduatedForConcept,
  submitAttempt,
  todayReviews,
  trailingCorrectStreak,
} from "../src/services/review.js";
import { createMistake, patchMistake } from "../src/services/mistakes.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrator.js";
import { reviewSchedules, users } from "../src/db/schema.js";
import { resolveOrCreateConcept } from "../src/services/concepts.js";
import { eq } from "drizzle-orm";
import { GRADUATION_STREAK } from "@mistake-book/shared";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function freshDb(): Db {
  const { db } = createDb(":memory:");
  const sqlite = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
  runMigrations(sqlite, MIGRATIONS_DIR);
  return db;
}

/** 创建带标准答案的数学填空题(作答走本地判定,便于连续提交) */
function mkMath(db: Db, correctAnswer: string) {
  return createMistake(db, "u_local", {
    subject: "math",
    manual: { stemMd: "题目" },
    questionType: "填空",
    content: { stemMd: "题目", correctAnswer },
  }).id;
}

function scheduledRows(db: Db, mistakeId: string) {
  return db
    .select()
    .from(reviewSchedules)
    .all()
    .filter((s) => s.mistakeId === mistakeId && s.status === "scheduled");
}

function linkConcept(db: Db, mistakeId: string, conceptId: string, version = 1) {
  db.run(
    sql`INSERT INTO mistake_concepts (id, mistake_id, concept_id, mistake_version, is_primary, created_at)
        VALUES (${crypto.randomUUID()}, ${mistakeId}, ${conceptId}, ${version}, 1, ${new Date().toISOString()})`,
  );
}

/** 连续答对 GRADUATION_STREAK 次,使错题毕业 */
function graduate(db: Db, mistakeId: string, answer: string) {
  for (let i = 0; i < GRADUATION_STREAK; i++) {
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: mistakeId, answer });
  }
}

/** 打开概念重逢复活开关(默认关闭) */
function enableRevival(db: Db) {
  db.update(users).set({ revivalEnabled: 1 }).where(eq(users.id, "u_local")).run();
}

describe("毕业机制(PRD 6.3)", () => {
  test(`连续 ${GRADUATION_STREAK} 次答对毕业:不再生成下一档,今日复习不再出现`, () => {
    const db = freshDb();
    const id = mkMath(db, "x=2");

    // 数学默认 [1,10,30]:两次答对后到顶档,仍未毕业
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: id, answer: "x=2" });
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: id, answer: "x=2" });
    expect(scheduledRows(db, id)).toHaveLength(1);
    expect(isGraduated(db, "u_local", id)).toBe(false);

    const res = submitAttempt(db, "u_local", {
      sourceType: "mistake_review",
      sourceId: id,
      answer: "x=2",
    });
    expect(res.graduated).toBe(true);
    expect(res.nextReviewDate).toBeNull();
    expect(scheduledRows(db, id)).toHaveLength(0);
    expect(isGraduated(db, "u_local", id)).toBe(true);
    expect(todayReviews(db, "u_local").items.filter((i) => i.mistakeId === id)).toHaveLength(0);
  });

  test("答错/放弃打断连续正确,不毕业", () => {
    const db = freshDb();
    const wrongBreak = mkMath(db, "a1");
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: wrongBreak, answer: "a1" });
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: wrongBreak, answer: "a1" });
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: wrongBreak, answer: "bad" });
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: wrongBreak, answer: "a1" });
    // 同毫秒作答由 rowid 决定性排序(review.ts streak 双键排序),无需额外处理
    expect(trailingCorrectStreak(db, "u_local", wrongBreak)).toBe(1);
    expect(scheduledRows(db, wrongBreak)).toHaveLength(1); // 继续常规节奏

    const gaveUpBreak = mkMath(db, "b1");
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: gaveUpBreak, answer: "b1" });
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: gaveUpBreak, answer: "b1" });
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: gaveUpBreak, gaveUp: true });
    expect(trailingCorrectStreak(db, "u_local", gaveUpBreak)).toBe(0);
    expect(isGraduated(db, "u_local", gaveUpBreak)).toBe(false);
  });

  test("毕业判定从作答事实源可重算:isGraduated 与 streak 推导一致", () => {
    const db = freshDb();
    const id = mkMath(db, "c1");
    graduate(db, id, "c1");
    expect(trailingCorrectStreak(db, "u_local", id)).toBe(GRADUATION_STREAK);
    expect(isGraduated(db, "u_local", id)).toBe(true);
    // 事实源仍在(attempts 未删),派生口径可随时重算
    expect(
      db.all<{ c: number }>(sql`SELECT COUNT(*) c FROM attempts WHERE source_id = ${id}`)[0].c,
    ).toBe(GRADUATION_STREAK);
  });
});

describe("概念重逢复活(PRD 6.3)", () => {
  test("复活开关默认关闭:满足复活条件也不复活;开启后恢复", () => {
    const db = freshDb();
    const conceptId = resolveOrCreateConcept(db, "u_local", "math", "一元一次方程", "seed");
    const graduatedId = mkMath(db, "x=1");
    graduate(db, graduatedId, "x=1");
    linkConcept(db, graduatedId, conceptId);

    // 默认关闭(users.revival_enabled = 0):不复活
    expect(reviveGraduatedForConcept(db, "u_local", conceptId)).toBe(0);
    expect(scheduledRows(db, graduatedId)).toHaveLength(0);

    // 开启后同一状态可复活
    enableRevival(db);
    expect(reviveGraduatedForConcept(db, "u_local", conceptId)).toBe(1);
    expect(scheduledRows(db, graduatedId)).toHaveLength(1);
  });

  test("新错题关联概念时,同概念已毕业旧题按第 2 档复活;重复触发幂等", () => {
    const db = freshDb();
    enableRevival(db);
    const conceptId = resolveOrCreateConcept(db, "u_local", "math", "一元一次方程", "seed");

    const graduatedId = mkMath(db, "x=1");
    graduate(db, graduatedId, "x=1");
    linkConcept(db, graduatedId, conceptId);

    // 未毕业且在队列中的题、已归档的毕业题都不应被复活
    const activeId = mkMath(db, "x=2");
    linkConcept(db, activeId, conceptId);
    const archivedId = mkMath(db, "x=3");
    graduate(db, archivedId, "x=3");
    linkConcept(db, archivedId, conceptId);
    patchMistake(db, "u_local", archivedId, { archived: true });

    const revivedCount = reviveGraduatedForConcept(db, "u_local", conceptId);
    expect(revivedCount).toBe(1);
    const rows = scheduledRows(db, graduatedId);
    expect(rows).toHaveLength(1);
    expect(rows[0].intervalIndex).toBe(1); // 第 2 档:数学默认 10 天
    expect(rows[0].dueDate).toBe(addDays(localDate(), 10));
    expect(scheduledRows(db, activeId)).toHaveLength(1); // 原排期不动
    expect(scheduledRows(db, archivedId)).toHaveLength(0);

    // 幂等:再次触发不重复排期
    expect(reviveGraduatedForConcept(db, "u_local", conceptId)).toBe(0);
    expect(scheduledRows(db, graduatedId)).toHaveLength(1);
  });

  test("复活后答对一次立即再毕业;答错回到常规节奏(原地不倒退)", () => {
    const db = freshDb();
    enableRevival(db);
    const conceptId = resolveOrCreateConcept(db, "u_local", "math", "有理数运算", "seed");

    const reGraduate = mkMath(db, "y=1");
    graduate(db, reGraduate, "y=1");
    linkConcept(db, reGraduate, conceptId);
    reviveGraduatedForConcept(db, "u_local", conceptId);

    // 复活后一次答对:旧连续正确仍在尾部 → 再次毕业
    const ok = submitAttempt(db, "u_local", {
      sourceType: "mistake_review",
      sourceId: reGraduate,
      answer: "y=1",
    });
    expect(ok.graduated).toBe(true);
    expect(scheduledRows(db, reGraduate)).toHaveLength(0);

    const stayInQueue = mkMath(db, "y=2");
    graduate(db, stayInQueue, "y=2");
    linkConcept(db, stayInQueue, conceptId);
    reviveGraduatedForConcept(db, "u_local", conceptId);
    const bad = submitAttempt(db, "u_local", {
      sourceType: "mistake_review",
      sourceId: stayInQueue,
      answer: "no",
    });
    expect(bad.graduated).toBeUndefined();
    const rows = scheduledRows(db, stayInQueue);
    expect(rows).toHaveLength(1);
    expect(rows[0].intervalIndex).toBe(1); // 答错原地不倒退
  });
});

describe("归档退出复习(PRD 6.3)", () => {
  test("归档取消未完成排期且不再出现在今日复习;恢复归档不自动恢复排期", () => {
    const db = freshDb();
    const id = mkMath(db, "z=1");
    expect(scheduledRows(db, id)).toHaveLength(1);

    patchMistake(db, "u_local", id, { archived: true });
    expect(scheduledRows(db, id)).toHaveLength(0);
    expect(todayReviews(db, "u_local").items.filter((i) => i.mistakeId === id)).toHaveLength(0);
    // canceled 历史保留供审计
    expect(
      db
        .select()
        .from(reviewSchedules)
        .all()
        .filter((s) => s.mistakeId === id && s.status === "canceled"),
    ).toHaveLength(1);

    patchMistake(db, "u_local", id, { archived: false });
    expect(scheduledRows(db, id)).toHaveLength(0);
  });
});

describe("主观题 LLM 判分路径的毕业(PRD 6.3)", () => {
  test("finalize 判正确达阈值 → 毕业;attemptDetail 返回 graduated 标记", () => {
    const db = freshDb();
    // 无 correctAnswer 的解答题 → 作答落 pending_judge,由判分任务 finalize
    const id = createMistake(db, "u_local", {
      subject: "chinese",
      manual: { stemMd: "题目" },
      questionType: "解答",
      content: { stemMd: "题目", myAnswer: "答" },
    }).id;

    let lastAttemptId = "";
    for (let i = 0; i < GRADUATION_STREAK; i++) {
      const res = submitAttempt(db, "u_local", {
        sourceType: "mistake_review",
        sourceId: id,
        answer: "答",
      });
      expect(res.judging).toBe("llm");
      expect(res.graduated).toBeUndefined(); // 判分未落地,不提前毕业
      const finalized = finalizePendingAttempt(db, "u_local", res.attemptId, "correct", "llm", null);
      expect(finalized?.result).toBe("correct");
      lastAttemptId = res.attemptId;
    }
    const detail = attemptDetail(db, "u_local", lastAttemptId);
    expect(detail?.graduated).toBe(true);
    expect(scheduledRows(db, id)).toHaveLength(0);
  });
});
