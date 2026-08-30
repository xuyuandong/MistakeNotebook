import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import type { HandlerContext } from "../src/jobs/handlers/judge.js";
import { makeGenerateHandler } from "../src/jobs/handlers/generate.js";
import { makeJudgeHandler } from "../src/jobs/handlers/judge.js";
import type { ChatClient, ChatResult } from "../src/ai/client.js";
import { RawRunStore } from "../src/ai/rawlog.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrator.js";
import {
  attempts,
  generatedQuestions,
  learningEvents,
  mastery,
  practiceSets,
  reviewSchedules,
} from "../src/db/schema.js";
import { createMistake } from "../src/services/mistakes.js";
import { resolveOrCreateConcept } from "../src/services/concepts.js";
import {
  addDays,
  appealAttempt,
  finalizePendingAttempt,
  localDate,
  submitAttempt,
  todayReviews,
  weeklyReviewStats,
} from "../src/services/review.js";
import { createJob, claimNextJob, finishJob, type JobRecord } from "../src/jobs/queue.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function freshCtx() {
  const root = mkdtempSync(join(tmpdir(), "prac-"));
  const { db } = createDb(":memory:");
  runMigrations(
    (db as unknown as { $client: import("better-sqlite3").Database }).$client,
    MIGRATIONS_DIR,
  );
  const ctx: HandlerContext & { rawStore: RawRunStore } = {
    db,
    chat: {} as unknown as ChatClient,
    filesDir: join(root, "files"),
    rawStore: new RawRunStore(join(root, "files")),
    config: {
      textModel: { provider: "mock", protocol: "openai", baseUrl: "", apiKey: null, model: "mock" },
    } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return ctx;
}

function stubChat(responses: Record<string, string>): { client: ChatClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async chat(_slot, req) {
        calls.push(req.taskType);
        const text = responses[req.taskType] ?? "{}";
        const res: ChatResult = {
          text,
          run: {
            id: crypto.randomUUID(),
            taskType: req.taskType,
            provider: "mock",
            model: "mock",
            promptVersion: "test",
            status: "ok",
            durationMs: 1,
            usageJson: null,
          },
        };
        return res;
      },
    },
  };
}

function mkJob(db: Db, jobType: "generate_questions" | "judge_answer", payload: unknown): JobRecord {
  const { id } = createJob(db, { userId: "u_local", jobType, payload });
  const job = claimNextJob(db)!;
  void id;
  return job;
}

const SELECT_OUTPUT = JSON.stringify({
  targetConcepts: ["一元一次方程"],
  rationale: "掌握分最低,近 30 天反复出错",
});
const GENERATE_OUTPUT = JSON.stringify({
  questions: [
    {
      type: "fill_blank",
      stemMd: "(新题)解方程 $3x-9=0$,则 $x=$ ____。",
      answer: "3",
      explanationMd: "移项得 3x=9。",
      concepts: ["一元一次方程"],
      difficulty: 2,
      acceptableAnswers: [],
    },
  ],
});

describe("智能出题模式开关(LLD §4.4)", () => {
  test("past 模式:选题分析后确定性选历史错题,不调用生成模型", async () => {
    const ctx = freshCtx();
    const { id: mistakeId } = createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "解方程 $2x-4=0$" },
      questionType: "解答",
      content: { stemMd: "解方程 $2x-4=0$", correctAnswer: "x=2" },
    });
    const conceptId = resolveOrCreateConcept(ctx.db, "u_local", "math", "一元一次方程", mistakeId);
    ctx.db.run(
      sql`INSERT INTO mistake_concepts (id, mistake_id, concept_id, mistake_version, is_primary, created_at)
          VALUES (${crypto.randomUUID()}, ${mistakeId}, ${conceptId}, 1, 1, ${new Date().toISOString()})`,
    );

    const { client, calls } = stubChat({ select_topics: SELECT_OUTPUT });
    ctx.chat = client;

    const setId = crypto.randomUUID();
    ctx.db.insert(practiceSets).values({
      id: setId,
      userId: "u_local",
      subject: "math",
      origin: "smart",
      status: "generating",
      paramsJson: JSON.stringify({ mode: "past", count: 5 }),
      createdAt: new Date().toISOString(),
    }).run();

    const handler = makeGenerateHandler(ctx);
    await handler(mkJob(ctx.db, "generate_questions", { practiceSetId: setId }));

    expect(calls).toEqual(["select_topics"]); // 不调用 generate
    const set = ctx.db.select().from(practiceSets).where(eq(practiceSets.id, setId)).get()!;
    expect(set.status).toBe("ready");
    const selection = JSON.parse(set.selectionJson!) as { targetConcepts: string[]; mistakeIds: string[]; rationale: string };
    expect(selection.targetConcepts).toContain("一元一次方程");
    expect(selection.mistakeIds).toEqual([mistakeId]);
    expect(countRows(ctx.db, "generated_questions")).toBe(0);
  });

  test("模型输出显式 null 字段(options:null 等)不再整批失败;数学主观题免独立复核", async () => {
    const ctx = freshCtx();
    const { client, calls } = stubChat({
      select_topics: SELECT_OUTPUT,
      generate_questions: JSON.stringify({
        questions: [
          {
            type: "subjective",
            stemMd: "(新题)证明三角形内角和为 180°。",
            options: null, // 模型惯性输出显式 null
            answer: "过第三顶点作平行线,由同旁内角互补即证。",
            acceptableAnswers: null,
            explanationMd: "作平行线后三组同旁内角互补,内角和为 180°。",
            concepts: ["三角形内角和"],
            difficulty: 3,
            readingMaterialMd: null,
            rubricMd: "写出辅助线作法;给出平行线性质依据;得出结论。",
          },
        ],
      }),
      // 若误对主观题发起复核,这里会返回不通过,测试将失败
      verify_question: JSON.stringify({ answerCorrect: false, issues: [], confidence: 0 }),
    });
    ctx.chat = client;
    const setId = crypto.randomUUID();
    ctx.db.insert(practiceSets).values({
      id: setId,
      userId: "u_local",
      subject: "math",
      origin: "smart",
      status: "generating",
      paramsJson: JSON.stringify({ mode: "new", count: 3 }),
      createdAt: new Date().toISOString(),
    }).run();
    await makeGenerateHandler(ctx)(mkJob(ctx.db, "generate_questions", { practiceSetId: setId }));

    expect(calls).toEqual(["select_topics", "generate_questions"]); // 主观题未触发复核
    const set = ctx.db.select().from(practiceSets).where(eq(practiceSets.id, setId)).get()!;
    expect(set.status).toBe("ready");
    expect(countRows(ctx.db, "generated_questions")).toBe(1);
  });

  test("全部候选被丢弃时,失败原因透出到 practice_sets.error", async () => {
    const ctx = freshCtx();
    const { client } = stubChat({
      select_topics: SELECT_OUTPUT,
      generate_questions: GENERATE_OUTPUT,
      verify_question: JSON.stringify({ answerCorrect: false, issues: ["答案错误"], confidence: 0.9 }),
    });
    ctx.chat = client;
    const setId = crypto.randomUUID();
    ctx.db.insert(practiceSets).values({
      id: setId,
      userId: "u_local",
      subject: "math",
      origin: "smart",
      status: "generating",
      paramsJson: JSON.stringify({ mode: "new", count: 3 }),
      createdAt: new Date().toISOString(),
    }).run();
    await makeGenerateHandler(ctx)(mkJob(ctx.db, "generate_questions", { practiceSetId: setId }));
    const set = ctx.db.select().from(practiceSets).where(eq(practiceSets.id, setId)).get()!;
    expect(set.status).toBe("failed");
    expect(set.error).toContain("独立复核未通过");
  });

  test("past 模式没有任何历史错题 → failed 且提示改用编新题", async () => {
    const ctx = freshCtx();
    const { client } = stubChat({ select_topics: SELECT_OUTPUT });
    ctx.chat = client;
    const setId = crypto.randomUUID();
    ctx.db.insert(practiceSets).values({
      id: setId,
      userId: "u_local",
      subject: "math",
      origin: "smart",
      status: "generating",
      paramsJson: JSON.stringify({ mode: "past", count: 5 }),
      createdAt: new Date().toISOString(),
    }).run();
    await makeGenerateHandler(ctx)(mkJob(ctx.db, "generate_questions", { practiceSetId: setId }));
    const set = ctx.db.select().from(practiceSets).where(eq(practiceSets.id, setId)).get()!;
    expect(set.status).toBe("failed");
    expect(set.error).toMatch(/编新题/);
  });

  test("new 模式:选题分析 → 生成 + 校验入库;数学题走独立复核", async () => {
    const ctx = freshCtx();
    const { client, calls } = stubChat({
      select_topics: SELECT_OUTPUT,
      generate_questions: GENERATE_OUTPUT,
      verify_question: JSON.stringify({ answerCorrect: true, issues: [], confidence: 0.9 }),
    });
    ctx.chat = client;
    const setId = crypto.randomUUID();
    ctx.db.insert(practiceSets).values({
      id: setId,
      userId: "u_local",
      subject: "math",
      origin: "smart",
      status: "generating",
      paramsJson: JSON.stringify({ mode: "new", count: 5 }),
      createdAt: new Date().toISOString(),
    }).run();
    await makeGenerateHandler(ctx)(mkJob(ctx.db, "generate_questions", { practiceSetId: setId }));

    expect(calls).toEqual(["select_topics", "generate_questions", "verify_question"]);
    const set = ctx.db.select().from(practiceSets).where(eq(practiceSets.id, setId)).get()!;
    expect(set.status).toBe("ready");
    expect(countRows(ctx.db, "generated_questions")).toBe(1);
  });
});

describe("主观题 LLM 判分(LLD §4.5)", () => {
  function setupSubjectiveMistake(db: Db): string {
    return createMistake(db, "u_local", {
      subject: "math",
      manual: { stemMd: "证明三角形内角和为 180°" },
      questionType: "解答", // 主观 → LLM 判分
      content: { stemMd: "证明三角形内角和为 180°", correctAnswer: "略", myAnswer: "" },
    }).id;
  }

  test("解答题提交 → pending_judge + judge 任务;判分后写结果/事件/复习计划/掌握度", async () => {
    const ctx = freshCtx();
    const mistakeId = setupSubjectiveMistake(ctx.db);
    const conceptId = resolveOrCreateConcept(ctx.db, "u_local", "math", "三角形内角和", mistakeId);
    ctx.db.run(
      sql`INSERT INTO mistake_concepts (id, mistake_id, concept_id, mistake_version, is_primary, created_at)
          VALUES (${crypto.randomUUID()}, ${mistakeId}, ${conceptId}, 1, 1, ${new Date().toISOString()})`,
    );

    const res = submitAttempt(ctx.db, "u_local", {
      sourceType: "mistake_review",
      sourceId: mistakeId,
      answer: "因为同旁内角互补……",
    });
    expect(res.judging).toBe("llm");
    expect(res.result).toBeUndefined();

    const attempt = ctx.db.select().from(attempts).all()[0];
    expect(attempt.result).toBe("pending_judge");
    // 幂等键 judge:{attemptId};重复提交同 attempt 不重复建任务
    const again = createJob(ctx.db, {
      userId: "u_local",
      jobType: "judge_answer",
      payload: { attemptId: attempt.id },
      idempotencyKey: `judge:${attempt.id}`,
    });
    expect(again.existing).toBe(true);

    const { client } = stubChat({
      judge_answer: JSON.stringify({ verdict: "partial", basis: "思路正确但漏了第三步", comment: "补全证明步骤" }),
    });
    ctx.chat = client;
    await makeJudgeHandler(ctx)(mkJob(ctx.db, "judge_answer", { attemptId: attempt.id }));

    const judged = ctx.db.select().from(attempts).where(eq(attempts.id, attempt.id)).get()!;
    expect(judged.result).toBe("partial");
    expect(judged.judgedBy).toBe("llm");
    expect(JSON.parse(judged.feedbackJson!)).toMatchObject({ basis: "思路正确但漏了第三步" });
    expect(ctx.db.select().from(learningEvents).where(eq(learningEvents.sourceId, attempt.id)).all()).toHaveLength(1);
    // partial → 原档不变(第 0 档 1 天);掌握度重算(部分正确 +1×1.5)
    const schedule = ctx.db.select().from(reviewSchedules).all().find((s) => s.mistakeId === mistakeId && s.status === "scheduled")!;
    expect(schedule.intervalIndex).toBe(0);
    expect(ctx.db.select().from(mastery).where(eq(mastery.conceptId, conceptId)).get()?.score).toBe(52); // 50+1×1.5
  });

  test("judge 重试幂等:已终态的 attempt 直接跳过,事件不重复", async () => {
    const ctx = freshCtx();
    const mistakeId = setupSubjectiveMistake(ctx.db);
    const res = submitAttempt(ctx.db, "u_local", {
      sourceType: "mistake_review",
      sourceId: mistakeId,
      answer: "证明过程",
    });
    const attemptId = res.attemptId;

    const { client, calls } = stubChat({
      judge_answer: JSON.stringify({ verdict: "correct", basis: "证明完整", comment: "很好" }),
    });
    ctx.chat = client;
    const handler = makeJudgeHandler(ctx);
    await handler(mkJob(ctx.db, "judge_answer", { attemptId }));
    await handler(mkJob(ctx.db, "judge_answer", { attemptId })); // 第二次:attempt 已终态 → 跳过
    expect(calls).toEqual(["judge_answer"]);
    expect(ctx.db.select().from(learningEvents).where(eq(learningEvents.sourceId, attemptId)).all()).toHaveLength(1);
  });

  test("判分失败 → 任务重试后 failed,attempt 保持 pending_judge;自判兜底落 user_appeal", async () => {
    const ctx = freshCtx();
    const mistakeId = setupSubjectiveMistake(ctx.db);
    const res = submitAttempt(ctx.db, "u_local", {
      sourceType: "mistake_review",
      sourceId: mistakeId,
      answer: "证明过程",
    });
    const attemptId = res.attemptId;

    const { client } = stubChat({ judge_answer: "不是JSON" });
    ctx.chat = client;
    const job = mkJob(ctx.db, "judge_answer", { attemptId });
    await expect(makeJudgeHandler(ctx)(job)).rejects.toThrow(/判分失败/);
    finishJob(ctx.db, job.id, "判分失败");
    // attempts=1 → 第一次失败回 queued 再跑一次,再失败进 failed
    const retried = claimNextJob(ctx.db)!;
    await expect(makeJudgeHandler(ctx)(retried)).rejects.toThrow(/判分失败/);
    finishJob(ctx.db, retried.id, "判分失败");
    expect(ctx.db.select().from(attempts).where(eq(attempts.id, attemptId)).get()!.result).toBe(
      "pending_judge",
    );

    // 自判兜底:pending_judge 状态下申诉/自判直接终态,judged_by=user_appeal
    const appealed = appealAttempt(ctx.db, "u_local", attemptId, "wrong");
    expect(appealed).toMatchObject({ attemptId, result: "wrong" });
    const row = ctx.db.select().from(attempts).where(eq(attempts.id, attemptId)).get()!;
    expect(row.result).toBe("wrong");
    expect(row.judgedBy).toBe("user_appeal");
    // 事件只记一次(finalize 时写入)
    expect(ctx.db.select().from(learningEvents).where(eq(learningEvents.sourceId, attemptId)).all()).toHaveLength(1);
  });

  test("客观题(填空+标准答案)本地比对,不走模型", () => {
    const ctx = freshCtx();
    const { id } = createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "解方程 $x-1=0$" },
      questionType: "填空",
      content: { stemMd: "解方程 $x-1=0$", correctAnswer: "x=1" },
    });
    const res = submitAttempt(ctx.db, "u_local", {
      sourceType: "mistake_review",
      sourceId: id,
      answer: "x=1",
    });
    expect(res.judging).toBe("local");
    expect(res.result).toBe("correct");
    expect(ctx.db.select().from(attempts).all()[0].result).toBe("correct");
  });
});

describe("依赖图形的题目不参与练习与复习(PRD 5.3/6.3)", () => {
  function makeSet(db: Db, mode: "past" | "new"): string {
    const setId = crypto.randomUUID();
    db.insert(practiceSets).values({
      id: setId,
      userId: "u_local",
      subject: "math",
      origin: "smart",
      status: "generating",
      paramsJson: JSON.stringify({ mode, count: 5 }),
      createdAt: new Date().toISOString(),
    }).run();
    return setId;
  }

  test("past 模式:题干含“如图”的错题不参与选题", async () => {
    const ctx = freshCtx();
    const { id: normalId } = createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "解方程 $2x-4=0$" },
      questionType: "解答",
      content: { stemMd: "解方程 $2x-4=0$", correctAnswer: "x=2" },
    });
    createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "如图,在矩形 ABCD 中,求证对角线相等。" },
      questionType: "解答",
      content: { stemMd: "如图,在矩形 ABCD 中,求证对角线相等。" },
    });

    const { client } = stubChat({ select_topics: SELECT_OUTPUT });
    ctx.chat = client;
    const setId = makeSet(ctx.db, "past");
    await makeGenerateHandler(ctx)(mkJob(ctx.db, "generate_questions", { practiceSetId: setId }));

    const set = ctx.db.select().from(practiceSets).where(eq(practiceSets.id, setId)).get()!;
    expect(set.status).toBe("ready");
    const selection = JSON.parse(set.selectionJson!) as { mistakeIds: string[] };
    expect(selection.mistakeIds).toEqual([normalId]);
  });

  test("past 模式:错题全部依赖图形 → failed 且原因说明排除规则", async () => {
    const ctx = freshCtx();
    createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "【依赖图形】求阴影部分面积。" },
      questionType: "解答",
      content: { stemMd: "【依赖图形】求阴影部分面积。" },
    });

    const { client } = stubChat({ select_topics: SELECT_OUTPUT });
    ctx.chat = client;
    const setId = makeSet(ctx.db, "past");
    await makeGenerateHandler(ctx)(mkJob(ctx.db, "generate_questions", { practiceSetId: setId }));

    const set = ctx.db.select().from(practiceSets).where(eq(practiceSets.id, setId)).get()!;
    expect(set.status).toBe("failed");
    expect(set.error).toContain("依赖图形");
  });

  test("new 模式:生成的图形题直接丢弃,不调用独立复核", async () => {
    const ctx = freshCtx();
    const { client, calls } = stubChat({
      select_topics: SELECT_OUTPUT,
      generate_questions: JSON.stringify({
        questions: [
          {
            type: "fill_blank",
            stemMd: "如图,已知直角三角形两直角边为 3 和 4,则斜边长为 ____。",
            answer: "5",
            explanationMd: "勾股定理。",
            concepts: ["勾股定理"],
            difficulty: 2,
            acceptableAnswers: [],
          },
        ],
      }),
      verify_question: JSON.stringify({ answerCorrect: true, issues: [], confidence: 0.9 }),
    });
    ctx.chat = client;
    const setId = makeSet(ctx.db, "new");
    await makeGenerateHandler(ctx)(mkJob(ctx.db, "generate_questions", { practiceSetId: setId }));

    expect(calls).toEqual(["select_topics", "generate_questions"]); // 丢弃前不触发复核
    const set = ctx.db.select().from(practiceSets).where(eq(practiceSets.id, setId)).get()!;
    expect(set.status).toBe("failed");
    expect(set.error).toContain("依赖图形");
    expect(countRows(ctx.db, "generated_questions")).toBe(0);
  });

  test("复习到期列表与周统计都排除图形题", () => {
    const ctx = freshCtx();
    const { id: normalId } = createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "解方程 $x-1=0$" },
      questionType: "填空",
      content: { stemMd: "解方程 $x-1=0$", correctAnswer: "x=1" },
    });
    const { id: figureId } = createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "如图,在△ABC 中求证。" },
      questionType: "解答",
      content: { stemMd: "如图,在△ABC 中求证。" },
    });

    // 建错题时自动安排次日起复习:把图形题调到昨天(逾期)、普通题调到今天
    const today = localDate();
    ctx.db
      .update(reviewSchedules)
      .set({ dueDate: addDays(today, -1) })
      .where(eq(reviewSchedules.mistakeId, figureId))
      .run();
    ctx.db
      .update(reviewSchedules)
      .set({ dueDate: today })
      .where(eq(reviewSchedules.mistakeId, normalId))
      .run();

    expect(todayReviews(ctx.db, "u_local").items.map((i) => i.mistakeId)).toEqual([normalId]);
    const stats = weeklyReviewStats(ctx.db, "u_local");
    expect(stats.planned).toBe(1); // 图形题的排期不计入
    expect(stats.overdue).toBe(0); // 图形题逾期不制造永久红字
  });
});

/** 生成题作答不入错题库(用户 2026-08-30 决策):错题表唯一写入点是 createMistake(人工录入/豆包导入) */
describe("生成题答错不算错题(用户 2026-08-30 决策)", () => {
  function mkGeneratedQuestion(db: Db, type: "fill_blank" | "subjective") {
    const conceptId = resolveOrCreateConcept(
      db,
      "u_local",
      "math",
      type === "fill_blank" ? "一元一次方程" : "去分母",
    );
    const setId = crypto.randomUUID();
    db.insert(practiceSets)
      .values({
        id: setId,
        userId: "u_local",
        subject: "math",
        origin: "smart",
        paramsJson: "{}",
        createdAt: new Date().toISOString(),
      })
      .run();
    const id = crypto.randomUUID();
    db.insert(generatedQuestions)
      .values({
        id,
        practiceSetId: setId,
        userId: "u_local",
        subject: "math",
        questionJson: JSON.stringify(
          type === "fill_blank"
            ? {
                type: "fill_blank",
                stemMd: "(新题)解方程 $3x-9=0$,则 $x=$ ____。",
                answer: "3",
                explanationMd: "移项得 3x=9。",
                concepts: ["一元一次方程"],
                difficulty: 2,
                acceptableAnswers: [],
              }
            : {
                type: "subjective",
                stemMd: "(新题)说明去分母时为什么不能漏乘常数项。",
                answer: "漏乘会破坏等式性质。",
                explanationMd: "等式两边需同时乘同一数。",
                concepts: ["去分母"],
                difficulty: 2,
                rubricMd: "答出等式性质即可。",
              },
        ),
        conceptIdsJson: JSON.stringify([conceptId]),
        status: "valid",
        createdAt: new Date().toISOString(),
      })
      .run();
    return { id, conceptId };
  }

  function assertNoMistake(db: Db) {
    expect(countRows(db, "mistakes")).toBe(0);
    const eventTypes = db.select().from(learningEvents).all().map((e) => e.eventType);
    expect(eventTypes).toContain("practice_attempted");
    expect(eventTypes).not.toContain("mistake_recorded");
    expect(db.select().from(reviewSchedules).all()).toHaveLength(0); // 生成题不进复习排期
  }

  test("客观题答错:只写 attempts + practice_attempted,掌握度下降,不入错题库", () => {
    const ctx = freshCtx();
    const { id: qId, conceptId } = mkGeneratedQuestion(ctx.db, "fill_blank");

    const res = submitAttempt(ctx.db, "u_local", {
      sourceType: "generated_question",
      sourceId: qId,
      answer: "9",
    });
    expect(res.result).toBe("wrong");

    assertNoMistake(ctx.db);
    const attempt = ctx.db.select().from(attempts).all()[0];
    expect(attempt.sourceType).toBe("generated_question");
    expect(attempt.result).toBe("wrong");
    const m = ctx.db.select().from(mastery).all().find((x) => x.conceptId === conceptId);
    expect(m?.sampleCount).toBe(1);
    expect(m!.score).toBeLessThan(50); // 作答仍更新掌握度(核心闭环保留)
  });

  test("主观题答错走 LLM 判分,判为错误后同样不入错题库", async () => {
    const ctx = freshCtx();
    const { id: qId } = mkGeneratedQuestion(ctx.db, "subjective");

    const res = submitAttempt(ctx.db, "u_local", {
      sourceType: "generated_question",
      sourceId: qId,
      answer: "不知道,随便写的",
    });
    expect(res.judging).toBe("llm");

    // 判分落为错误(judge 任务与申诉共用的终态路径)
    const attempt = ctx.db.select().from(attempts).all()[0];
    expect(attempt.result).toBe("pending_judge");
    const finalized = finalizePendingAttempt(
      ctx.db,
      "u_local",
      attempt.id,
      "wrong",
      "llm",
      { basis: "未答出等式性质", comment: "再想想" },
    );
    expect(finalized?.result).toBe("wrong");

    assertNoMistake(ctx.db);
  });

  test("放弃作答同样只记 attempts,不入错题库", () => {
    const ctx = freshCtx();
    const { id: qId } = mkGeneratedQuestion(ctx.db, "fill_blank");
    const res = submitAttempt(ctx.db, "u_local", {
      sourceType: "generated_question",
      sourceId: qId,
      gaveUp: true,
    });
    expect(res.result).toBe("gave_up");
    assertNoMistake(ctx.db);
  });
});

function countRows(db: Db, table: string): number {
  const rows = db.all<{ c: number }>(sql`SELECT COUNT(*) AS c FROM ${sql.raw(table)}`);
  return rows[0]?.c ?? 0;
}
