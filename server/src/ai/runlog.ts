import { randomUUID } from "node:crypto";
import { modelRuns } from "../db/schema.js";
import type { Db } from "../db/client.js";
import type { ModelRunMeta } from "./client.js";

/** 每次模型调用写一条审计记录;不含题目全文/答案/文件 URL/密钥(AGENTS §4) */
export function recordRun(db: Db, run: ModelRunMeta, jobId?: string): void {
  db.insert(modelRuns)
    .values({
      id: run.id,
      jobId: jobId ?? null,
      taskType: run.taskType,
      provider: run.provider,
      model: run.model,
      promptVersion: run.promptVersion,
      status: run.status,
      durationMs: run.durationMs,
      usageJson: run.usageJson,
      error: null,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
}

/** 带一次 Schema 重试的调用编排:校验失败重试一次,仍失败抛错(AGENTS §7) */
export async function chatWithRetry<T>(opts: {
  chat: (attempt: number) => Promise<{ text: string; runId: string }>;
  parse: (text: string) => T;
  maxAttempts?: number;
  onAttempt?: (runId: string, ok: boolean) => void;
}): Promise<{ value: T; attempts: number }> {
  const maxAttempts = opts.maxAttempts ?? 2;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { text, runId } = await opts.chat(attempt);
    try {
      const value = opts.parse(text);
      opts.onAttempt?.(runId, true);
      return { value, attempts: attempt };
    } catch (e) {
      lastError = e as Error;
      opts.onAttempt?.(runId, false);
    }
  }
  throw lastError ?? new Error("模型输出校验失败");
}

export const newId = randomUUID;
