import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { aiJobs } from "../db/schema.js";
import type { Db } from "../db/client.js";
import { JobType, type JobStatus } from "@mistake-book/shared";

export interface JobRecord {
  id: string;
  userId: string;
  jobType: JobType;
  status: JobStatus;
  payload: unknown;
  toEventId: string | null;
  attempts: number;
}

export interface CreateJobInput {
  userId: string;
  jobType: JobType;
  payload: unknown;
  idempotencyKey?: string;
  toEventId?: string;
}

export interface CreateJobResult {
  id: string;
  existing: boolean;
}

/** 幂等创建:idempotency_key 直接去重;refresh_learner_analysis 额外限制同学生同时只允许一个。 */
export function createJob(db: Db, input: CreateJobInput): CreateJobResult {
  if (input.idempotencyKey) {
    const found = db
      .select()
      .from(aiJobs)
      .where(eq(aiJobs.idempotencyKey, input.idempotencyKey))
      .get();
    if (found) return { id: found.id, existing: true };
  }
  if (input.jobType === "refresh_learner_analysis") {
    const active = db
      .select()
      .from(aiJobs)
      .where(
        and(
          eq(aiJobs.userId, input.userId),
          eq(aiJobs.jobType, input.jobType),
          inArray(aiJobs.status, ["queued", "running"]),
        ),
      )
      .get();
    if (active) return { id: active.id, existing: true };
  }

  const id = randomUUID();
  db.insert(aiJobs)
    .values({
      id,
      userId: input.userId,
      jobType: input.jobType,
      payloadJson: JSON.stringify(input.payload),
      idempotencyKey: input.idempotencyKey,
      toEventId: input.toEventId,
      status: "queued",
      createdAt: new Date().toISOString(),
    })
    .run();
  return { id, existing: false };
}

const STALE_RUNNING_MS = 10 * 60_000;

/** 领取一个 queued 任务;超时遗留的 running 先回置 queued(由重试上限兜底)。 */
export function claimNextJob(db: Db): JobRecord | null {
  const staleBefore = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  db.run(
    sql`UPDATE ai_jobs SET status='queued', started_at=NULL WHERE status='running' AND started_at < ${staleBefore}`,
  );
  const job = db
    .select()
    .from(aiJobs)
    .where(eq(aiJobs.status, "queued"))
    .orderBy(aiJobs.createdAt)
    .limit(1)
    .get();
  if (!job) return null;
  db.update(aiJobs)
    .set({ status: "running", startedAt: new Date().toISOString(), attempts: job.attempts + 1 })
    .where(eq(aiJobs.id, job.id))
    .run();
  return {
    id: job.id,
    userId: job.userId,
    jobType: JobType.parse(job.jobType),
    status: "running",
    payload: JSON.parse(job.payloadJson),
    toEventId: job.toEventId,
    attempts: job.attempts + 1,
  };
}

/** 任务结束:失败且 attempts < 2 时回 queued(自动重试一次),否则进入终态。 */
export function finishJob(db: Db, jobId: string, error?: string): void {
  const job = db.select().from(aiJobs).where(eq(aiJobs.id, jobId)).get();
  if (!job) return;
  const failed = Boolean(error);
  const shouldRetry = failed && job.attempts < 2;
  db.update(aiJobs)
    .set({
      status: shouldRetry ? "queued" : failed ? "failed" : "succeeded",
      error: error ?? null,
      finishedAt: shouldRetry ? null : new Date().toISOString(),
      startedAt: null,
    })
    .where(eq(aiJobs.id, jobId))
    .run();
}
