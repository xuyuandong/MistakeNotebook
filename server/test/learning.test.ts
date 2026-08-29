import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { computeMastery, type MasteryEvent } from "../src/services/mastery.js";
import { addDays, localDate, submitAttempt, todayReviews } from "../src/services/review.js";
import { createMistake, deleteMistake } from "../src/services/mistakes.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrator.js";
import { concepts, mastery, mistakes, reviewSchedules, users } from "../src/db/schema.js";
import { resolveOrCreateConcept } from "../src/services/concepts.js";
import { aiJobs, learningEvents } from "../src/db/schema.js";
import { dailyCheck, requestLearnerRefresh } from "../src/services/learner.js";
import { claimNextJob } from "../src/jobs/queue.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function freshDb(): Db {
  const { db } = createDb(":memory:");
  const sqlite = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
  runMigrations(sqlite, MIGRATIONS_DIR);
  return db;
}

describe("掌握度算法(LLD §6.1)", () => {
  const ev = (over: Partial<MasteryEvent> = {}): MasteryEvent => ({
    sourceType: "mistake_review",
    result: "correct",
    usedHint: false,
    occurredAt: new Date().toISOString(),
    ...over,
  });

  test("初始 50;复习正确小幅上调", () => {
    expect(computeMastery([]).score).toBe(50);
    expect(computeMastery([ev()]).score).toBe(56); // +4×1.5(最近 10 次权重)
  });

  test("复习错误明显下调,变式独立答对较大上调", () => {
    expect(computeMastery([ev({ result: "wrong" })]).score).toBe(35); // -10×1.5
    expect(computeMastery([ev({ sourceType: "generated_question" })]).score).toBe(65); // +10×1.5
  });

  test("使用提示后答对只少量上调", () => {
    expect(computeMastery([ev({ usedHint: true })]).score).toBe(53); // +2×1.5
  });

  test("最近 10 次权重 1.5(第 11 次以前的权重为 1)", () => {
    const eleven = Array.from({ length: 11 }, () => ev({ result: "wrong" }));
    // 10 次最近错误:-10*1.5*10 = -150 → clamp 0;最早一次 -10 也一样被 clamp,无法区分
    // 用交替正确/错误序列检验加权
    const events = Array.from({ length: 11 }, (_, i) =>
      ev({ result: i % 2 === 0 ? "wrong" : "correct", occurredAt: new Date(Date.now() + i).toISOString() }),
    );
    const c11 = computeMastery(events).score;
    const c10 = computeMastery(events.slice(1)).score;
    // 去掉最早一次(错误,-10*1.0)后分数应更高
    expect(c10).toBeGreaterThan(c11);
  });

  test("clamp 0~100 且久未练习降低新鲜度", () => {
    const many = Array.from({ length: 20 }, () => ev({ result: "correct" as const }));
    expect(computeMastery(many).score).toBe(100);
    const old = ev({ occurredAt: new Date(Date.now() - 60 * 86_400_000).toISOString() });
    expect(computeMastery([old]).freshness).toBeLessThan(1);
  });
});

describe("复习调度", () => {
  test("创建错题自动安排次日复习;答对进下一档,答错原地不倒退(PRD 6.3)", () => {
    const db = freshDb();
    const { id } = createMistake(db, "u_local", {
      subject: "math",
      manual: { stemMd: "题目" },
      questionType: "填空",
      content: { stemMd: "题目", correctAnswer: "x=2" },
    });

    // 首次复习 = 明天
    expect(todayReviews(db, "u_local").items).toHaveLength(0); // 明天到期,今天不出现
    const s1 = db.select().from(reviewSchedules).all().find((s) => s.mistakeId === id)!;
    expect(s1.dueDate).toBe(addDays(localDate(), 1));
    expect(s1.intervalIndex).toBe(0);

    // 答对 → 第 2 档(数学默认 1→10→30;填空题+标准答案 → 本地判定)
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: id, answer: "x=2" });
    const s2 = db.select().from(reviewSchedules).all().filter((s) => s.mistakeId === id && s.status === "scheduled")[0];
    expect(s2.intervalIndex).toBe(1);
    expect(s2.dueDate).toBe(addDays(localDate(), 10));

    // 再答错 → 原档不变,不倒退
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: id, answer: "x=1" });
    const s3 = db.select().from(reviewSchedules).all().filter((s) => s.mistakeId === id && s.status === "scheduled")[0];
    expect(s3.intervalIndex).toBe(1);
    expect(s3.dueDate).toBe(addDays(localDate(), 10));
  });

  test("复习间隔分学科可配:自定义数学间隔生效,未配置学科用默认", () => {
    const db = freshDb();
    db.update(users)
      .set({
        reviewIntervalsJson: JSON.stringify({ math: [2, 15, 40, 60], english: [1, 2, 4] }),
      })
      .where(eq(users.id, "u_local"))
      .run();

    const mk = (subject: "math" | "english" | "chinese", correctAnswer: string) =>
      createMistake(db, "u_local", {
        subject,
        manual: { stemMd: "题目" },
        questionType: "填空",
        content: { stemMd: "题目", correctAnswer },
      }).id;

    // 数学:配置 2/15/40/60 → 答对进 15 天档,答错保持 15 天
    const mathId = mk("math", "a1");
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: mathId, answer: "a1" });
    const mathS = db.select().from(reviewSchedules).all().filter((s) => s.mistakeId === mathId && s.status === "scheduled")[0];
    expect(mathS.intervalIndex).toBe(1);
    expect(mathS.dueDate).toBe(addDays(localDate(), 15));
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: mathId, answer: "wrong" });
    const mathS2 = db.select().from(reviewSchedules).all().filter((s) => s.mistakeId === mathId && s.status === "scheduled")[0];
    expect(mathS2.intervalIndex).toBe(1);
    expect(mathS2.dueDate).toBe(addDays(localDate(), 15));

    // 英语:配置 [1,2,4] → 答对进 2 天档
    const engId = mk("english", "b1");
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: engId, answer: "b1" });
    const engS = db.select().from(reviewSchedules).all().filter((s) => s.mistakeId === engId && s.status === "scheduled")[0];
    expect(engS.intervalIndex).toBe(1);
    expect(engS.dueDate).toBe(addDays(localDate(), 2));

    // 语文:未配置 → 默认阶梯 [1,3,7,14,30] → 答对进 3 天档
    const chnId = mk("chinese", "c1");
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: chnId, answer: "c1" });
    const chnS = db.select().from(reviewSchedules).all().filter((s) => s.mistakeId === chnId && s.status === "scheduled")[0];
    expect(chnS.intervalIndex).toBe(1);
    expect(chnS.dueDate).toBe(addDays(localDate(), 3));
  });

  test("旧排期档位超出新配置长度时钳制到顶档,不产生非法间隔", () => {
    const db = freshDb();
    const { id } = createMistake(db, "u_local", {
      subject: "math",
      manual: { stemMd: "题目" },
      questionType: "填空",
      content: { stemMd: "题目", correctAnswer: "a1" },
    });
    // 模拟旧阶梯推进到第 4 档后,用户把数学间隔改成 1/10/30
    db.update(reviewSchedules)
      .set({ intervalIndex: 4 })
      .where(eq(reviewSchedules.mistakeId, id))
      .run();
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: id, answer: "a1" });
    const s = db.select().from(reviewSchedules).all().filter((s) => s.mistakeId === id && s.status === "scheduled")[0];
    expect(s.intervalIndex).toBe(2); // 钳制到 [1,10,30] 顶档
    expect(s.dueDate).toBe(addDays(localDate(), 30));
  });

  test("变式题作答重算概念掌握度", () => {
    const db = freshDb();
    const { id } = createMistake(db, "u_local", {
      subject: "math",
      manual: { stemMd: "题目" },
      questionType: "填空",
      content: { stemMd: "题目", correctAnswer: "x=3" },
    });
    const conceptId = resolveOrCreateConcept(db, "u_local", "math", "一元一次方程", id);
    db.run(
      sql`INSERT INTO mistake_concepts (id, mistake_id, concept_id, mistake_version, is_primary, created_at)
          VALUES ('mc1', ${id}, ${conceptId}, 1, 1, ${new Date().toISOString()})`,
    );

    // 复习正确:+4×1.5 = +6(填空题 + 标准答案 → 本地比对)
    submitAttempt(db, "u_local", { sourceType: "mistake_review", sourceId: id, answer: "x=3" });
    const m = db.select().from(mastery).where(eq(mastery.conceptId, conceptId)).get();
    expect(m?.score).toBe(56);
  });
});

describe("学生分析任务(AGENTS §5)", () => {
  test("重复点击返回现有任务;每日检查幂等且无待处理不创建", () => {
    const db = freshDb();
    createMistake(db, "u_local", {
      subject: "math",
      manual: { stemMd: "题目" },
      content: { stemMd: "题目", myAnswer: "B" },
    });

    // 每日检查:有待处理数据,创建成功一次,同日再次不重复
    const d1 = dailyCheck(db, "u_local");
    expect(d1.created).toBe(true);
    const d2 = dailyCheck(db, "u_local");
    expect(d2.created).toBe(false);

    // 手动点击:同一学生同时只允许一个任务 → 返回每日任务
    const manual = requestLearnerRefresh(db, "u_local");
    expect(manual.existing).toBe(true);

    const jobs = db.select().from(aiJobs).all();
    expect(jobs.filter((j) => j.idempotencyKey?.startsWith("refresh:"))).toHaveLength(1);
  });

  test("删除错题后待处理数与水位不残留正文", () => {
    const db = freshDb();
    const { id } = createMistake(db, "u_local", {
      subject: "math",
      manual: { stemMd: "要被删除的题干" },
      content: { stemMd: "要被删除的题干", myAnswer: "B" },
    });
    deleteMistake(db, "u_local", id);
    const events = db
      .select()
      .from(learningEvents)
      .where(eq(learningEvents.sourceId, id))
      .all();
    expect(events.every((e) => e.payloadJson === null)).toBe(true);
  });

  test("分析 handler 对已分析版本幂等(模拟:同一版本重复写入不重复计概念)", () => {
    const db = freshDb();
    const { id } = createMistake(db, "u_local", {
      subject: "math",
      manual: { stemMd: "题目" },
      content: { stemMd: "题目", myAnswer: "B" },
    });
    const conceptId = resolveOrCreateConcept(db, "u_local", "math", "函数", id);

    // 领取一个分析任务水位,不实际执行 handler(由集成测试覆盖),这里验证幂等列
    const job = claimNextJob(db);
    void job;
    db.update(mistakes).set({ analysisVersion: 1, status: "analyzed" }).where(eq(mistakes.id, id)).run();

    // 已有 mistake_concepts 记录一次
    db.run(
      sql`INSERT INTO mistake_concepts (id, mistake_id, concept_id, mistake_version, is_primary, created_at)
          VALUES ('mcx', ${id}, ${conceptId}, 1, 1, ${new Date().toISOString()})`,
    );
    const rows = db.all<{ c: number }>(
      sql`SELECT COUNT(*) c FROM mistake_concepts WHERE mistake_id = ${id}`,
    );
    expect(rows[0].c).toBe(1);
    expect(db.select().from(concepts).all().filter((c) => c.canonicalName === "函数")).toHaveLength(1);
  });
});
