import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import type { HandlerContext } from "../src/jobs/handlers/judge.js";
import { makeAnalyzeHandler } from "../src/jobs/handlers/analyze.js";
import type { ChatClient } from "../src/ai/client.js";
import { RawRunStore } from "../src/ai/rawlog.js";
import { loadConfig } from "../src/config/index.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrator.js";
import { learningEvents, mistakes, reviewSchedules, users } from "../src/db/schema.js";
import { createMistake } from "../src/services/mistakes.js";
import { submitAttempt } from "../src/services/review.js";
import type { JobRecord } from "../src/jobs/queue.js";
import { GRADUATION_STREAK } from "@mistake-book/shared";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "blank-"));
  const { db } = createDb(":memory:");
  runMigrations(
    (db as unknown as { $client: import("better-sqlite3").Database }).$client,
    MIGRATIONS_DIR,
  );
  const config = loadConfig({
    env: "development",
    configPath: fileURLToPath(new URL("../../config/models.yaml", import.meta.url)),
    envMap: { APP_AUTH_TOKEN: "t" },
  });
  const ctx: HandlerContext & { rawStore: RawRunStore } = {
    db,
    chat: {} as unknown as ChatClient,
    filesDir: join(root, "files"),
    rawStore: new RawRunStore(join(root, "files")),
    config,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return ctx;
}

function stubChat(text: string, calls: { n: number }): ChatClient {
  return {
    async chat(_slot, req) {
      if (req.taskType === "analyze_mistake") calls.n++; // 只统计归因调用(总结是独立任务)
      void req;
      return {
        text,
        run: {
          id: crypto.randomUUID(),
          taskType: "analyze_mistake",
          provider: "mock",
          model: "mock",
          promptVersion: "test",
          status: "ok",
          durationMs: 1,
          usageJson: null,
        },
      };
    },
  };
}

function batchResult(primaryErrorType: string, concept: string, needsFollowUp = false) {
  return JSON.stringify({
    results: [
      {
        index: 0,
        primaryErrorType,
        secondaryErrorTypes: [],
        concepts: [
          { name: concept, isPrimary: true, confidence: 0.9, similarConceptIds: [] },
        ],
        improvementSuggestions: [],
        needsFollowUp,
        confidence: 0.8,
      },
    ],
  });
}

async function runAnalyze(ctx: ReturnType<typeof setup>, toEventId: string) {
  const handler = makeAnalyzeHandler(ctx);
  await handler({
    id: crypto.randomUUID(),
    userId: "u_local",
    jobType: "refresh_learner_analysis",
    status: "running",
    payload: {},
    toEventId,
    attempts: 1,
  } as JobRecord);
}

describe("空白题按完全不会处理(用户 2026-08-29 决策)", () => {
  test("无学生答案:模型归因直接生效,不追问,状态 analyzed,概念提取", async () => {
    const ctx = setup();
    const { id } = createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "解方程 x-1=0" },
      content: { stemMd: "解方程 x-1=0" }, // 空白:无 myAnswer / note
    });
    const ev = ctx.db
      .select()
      .from(learningEvents)
      .where(eq(learningEvents.sourceId, id))
      .get();

    const calls = { n: 0 };
    ctx.chat = stubChat(batchResult("knowledge_gap", "一元一次方程"), calls);
    await runAnalyze(ctx, ev!.id);

    const row = ctx.db.select().from(mistakes).where(eq(mistakes.id, id)).get()!;
    expect(row.errorType).toBe("knowledge_gap"); // 完全不会 → 知识缺失
    expect(row.needsFollowUp).toBe(0); // 不追问
    expect(row.followUpQuestion).toBeNull();
    expect(row.status).toBe("analyzed"); // 不留在待补充
    expect(row.analysisPromptVersion).toBe("analyze@4");
    expect(ctx.db.all<{ c: number }>(sql`SELECT COUNT(*) c FROM concepts`)[0].c).toBe(1);
  });

  test("模型即使对空白题输出追问,也被强制关闭", async () => {
    const ctx = setup();
    const { id } = createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "题目" },
      content: { stemMd: "题目" },
    });
    const ev = ctx.db
      .select()
      .from(learningEvents)
      .where(eq(learningEvents.sourceId, id))
      .get();
    const calls = { n: 0 };
    ctx.chat = stubChat(batchResult("knowledge_gap", "概念A", true), calls); // needsFollowUp=true
    await runAnalyze(ctx, ev!.id);
    const row = ctx.db.select().from(mistakes).where(eq(mistakes.id, id)).get()!;
    expect(row.needsFollowUp).toBe(0);
    expect(row.status).toBe("analyzed");
  });

  test("有学生答案:模型输出照常生效;同版本同提示词幂等跳过", async () => {
    const ctx = setup();
    const { id } = createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "题目" },
      content: { stemMd: "题目", myAnswer: "B" },
    });
    const ev = ctx.db
      .select()
      .from(learningEvents)
      .where(eq(learningEvents.sourceId, id))
      .get();
    const calls = { n: 0 };
    ctx.chat = stubChat(batchResult("carelessness", "移项变号"), calls);
    const job = {
      id: crypto.randomUUID(),
      userId: "u_local",
      jobType: "refresh_learner_analysis",
      status: "running",
      payload: {},
      toEventId: ev!.id,
      attempts: 1,
    } as JobRecord;
    await runAnalyze(ctx, ev!.id);
    const row1 = ctx.db.select().from(mistakes).where(eq(mistakes.id, id)).get()!;
    expect(row1.errorType).toBe("carelessness");
    expect(row1.status).toBe("analyzed");

    await runAnalyze(ctx, ev!.id); // 同版本 + 同提示词 → 幂等,不重复调用
    expect(calls.n).toBe(1);
    expect(ctx.db.select().from(mistakes).where(eq(mistakes.id, id)).get()!.analysisVersion).toBe(
      row1.analysisVersion,
    );
  });
});

describe("概念重逢复活(分析落概念 → 已毕业旧题重排期,PRD 6.3)", () => {
  test("默认关闭:分析关联概念不触发复活", async () => {
    const ctx = setup();
    const oldId = createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "旧题" },
      questionType: "填空",
      content: { stemMd: "旧题", correctAnswer: "x=1" },
    }).id;
    for (let i = 0; i < GRADUATION_STREAK; i++) {
      submitAttempt(ctx.db, "u_local", { sourceType: "mistake_review", sourceId: oldId, answer: "x=1" });
    }
    ctx.db.run(
      sql`INSERT INTO mistake_concepts (id, mistake_id, concept_id, mistake_version, is_primary, created_at)
          SELECT ${crypto.randomUUID()}, ${oldId}, c.id, 1, 1, ${new Date().toISOString()}
          FROM concepts c WHERE c.canonical_name = '一元一次方程' AND c.subject = 'math'`,
    );

    const newId = createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "解方程 2x=4" },
      content: { stemMd: "解方程 2x=4" },
    }).id;
    const ev = ctx.db.select().from(learningEvents).where(eq(learningEvents.sourceId, newId)).get();
    ctx.chat = stubChat(batchResult("knowledge_gap", "一元一次方程"), { n: 0 });
    await runAnalyze(ctx, ev!.id);

    expect(
      ctx.db
        .select()
        .from(reviewSchedules)
        .all()
        .filter((s) => s.mistakeId === oldId && s.status === "scheduled"),
    ).toHaveLength(0); // 开关默认关:不复活
  });

  test("开关开启:新错题关联概念时复活同概念已毕业旧题;重复分析不重复复活", async () => {
    const ctx = setup();
    ctx.db
      .update(users)
      .set({ revivalEnabled: 1 })
      .where(eq(users.id, "u_local"))
      .run();

    // 已毕业旧题:数学填空,连续答对 3 次,提前关联概念「一元一次方程」
    const oldId = createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "旧题" },
      questionType: "填空",
      content: { stemMd: "旧题", correctAnswer: "x=1" },
    }).id;
    for (let i = 0; i < GRADUATION_STREAK; i++) {
      submitAttempt(ctx.db, "u_local", { sourceType: "mistake_review", sourceId: oldId, answer: "x=1" });
    }
    ctx.db.run(
      sql`INSERT INTO mistake_concepts (id, mistake_id, concept_id, mistake_version, is_primary, created_at)
          SELECT ${crypto.randomUUID()}, ${oldId}, c.id, 1, 1, ${new Date().toISOString()}
          FROM concepts c WHERE c.canonical_name = '一元一次方程' AND c.subject = 'math'`,
    );
    expect(
      ctx.db
        .select()
        .from(reviewSchedules)
        .all()
        .filter((s) => s.mistakeId === oldId && s.status === "scheduled"),
    ).toHaveLength(0); // 已毕业,不在队列

    // 新错题(空白题)进入待分析
    const newId = createMistake(ctx.db, "u_local", {
      subject: "math",
      manual: { stemMd: "解方程 2x=4" },
      content: { stemMd: "解方程 2x=4" },
    }).id;
    const ev = ctx.db.select().from(learningEvents).where(eq(learningEvents.sourceId, newId)).get();

    const calls = { n: 0 };
    ctx.chat = stubChat(batchResult("knowledge_gap", "一元一次方程"), calls);
    await runAnalyze(ctx, ev!.id);

    // 分析把新错题关联到同一概念 → 旧题复活,按第 2 档(数学默认 10 天)重排期
    const rows = ctx.db
      .select()
      .from(reviewSchedules)
      .all()
      .filter((s) => s.mistakeId === oldId && s.status === "scheduled");
    expect(rows).toHaveLength(1);
    expect(rows[0].intervalIndex).toBe(1);

    // 重跑分析(幂等跳过同版本)→ 不重复复活
    await runAnalyze(ctx, ev!.id);
    expect(
      ctx.db
        .select()
        .from(reviewSchedules)
        .all()
        .filter((s) => s.mistakeId === oldId && s.status === "scheduled"),
    ).toHaveLength(1);
  });
});
