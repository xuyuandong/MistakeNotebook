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
import { learningEvents, mistakes } from "../src/db/schema.js";
import { createMistake } from "../src/services/mistakes.js";
import type { JobRecord } from "../src/jobs/queue.js";

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
