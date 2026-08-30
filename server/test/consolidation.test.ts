import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { ChatClient } from "../src/ai/client.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrator.js";
import { concepts, modelRuns } from "../src/db/schema.js";
import { resolveOrCreateConcept } from "../src/services/concepts.js";
import {
  applyConsolidationProposal,
  flattenConsolidationProposals,
  parseConsolidationProposals,
  proposeConsolidation,
} from "../src/services/consolidation.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function freshDb(): Db {
  const { db } = createDb(":memory:");
  const sqlite = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
  runMigrations(sqlite, MIGRATIONS_DIR);
  return db;
}

describe("概念整理建议", () => {
  test("解析拒绝模型虚构 ID 与自身归并", () => {
    const ids = new Set(["c1", "c2"]);
    expect(() => parseConsolidationProposals(
      JSON.stringify({ assignments: [{ conceptId: "fake", category: "词汇", reason: "" }], merges: [] }),
      ids,
    )).toThrow(/未知概念/);
    expect(() => parseConsolidationProposals(
      JSON.stringify({ assignments: [], merges: [{ fromId: "c1", intoId: "c1", reason: "" }] }),
      ids,
    )).toThrow(/自身/);
  });

  test("mock chat 生成建议、记录 consolidate@1,逐条应用归类与归并", async () => {
    const db = freshDb();
    const c1 = resolveOrCreateConcept(db, "u_local", "english", "形容词辨析:unusual/complete");
    const c2 = resolveOrCreateConcept(db, "u_local", "english", "词汇辨析:unusual/complete");
    resolveOrCreateConcept(db, "u_local", "english", "固定搭配:keep cool");
    const chat: ChatClient = {
      async chat(_slot, request) {
        expect(request.messages[0].content).toContain(c1);
        return {
          text: JSON.stringify({
            assignments: [{ conceptId: c2, category: "词汇辨析", reason: "复用中粒度分类" }],
            merges: [{ fromId: c1, intoId: c2, reason: "同一词项的上下位写法" }],
          }),
          run: {
            id: crypto.randomUUID(),
            taskType: "consolidate_concepts",
            provider: "mock",
            model: "mock",
            promptVersion: "v0",
            status: "ok",
            durationMs: 1,
            usageJson: null,
          },
        };
      },
    };

    const proposals = await proposeConsolidation(db, chat, "u_local", "english");
    expect(db.select().from(modelRuns).all()).toEqual([
      expect.objectContaining({ taskType: "consolidate_concepts", promptVersion: "consolidate@1", status: "ok" }),
    ]);
    for (const proposal of flattenConsolidationProposals(proposals)) {
      applyConsolidationProposal(db, "u_local", "english", proposal);
    }
    expect(db.select().from(concepts).where(eq(concepts.id, c1)).get()).toMatchObject({
      status: "merged",
      mergedIntoId: c2,
    });
    expect(db.select().from(concepts).where(eq(concepts.id, c2)).get()?.categoryId).toBeTruthy();
  });

  test("少于 3 个概念不调用模型", async () => {
    const db = freshDb();
    resolveOrCreateConcept(db, "u_local", "math", "去分母");
    const chat: ChatClient = { chat: async () => { throw new Error("不应调用"); } };
    await expect(proposeConsolidation(db, chat, "u_local", "math")).resolves.toEqual({
      assignments: [],
      merges: [],
    });
  });
});
