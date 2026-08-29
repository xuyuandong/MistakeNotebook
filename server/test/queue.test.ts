import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { runMigrations } from "../src/db/migrator.js";
import { createDb, type Db } from "../src/db/client.js";
import { aiJobs } from "../src/db/schema.js";
import { claimNextJob, createJob, finishJob } from "../src/jobs/queue.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function freshDb(): { sqlite: BetterSqlite3.Database; db: Db } {
  const { sqlite, db } = createDb(":memory:");
  runMigrations(sqlite, MIGRATIONS_DIR);
  return { sqlite, db };
}

describe("ai_jobs 幂等与领取", () => {
  test("同 idempotency_key 不重复创建", () => {
    const { db } = freshDb();
    const first = createJob(db, {
      userId: "u_local",
      jobType: "refresh_learner_analysis",
      payload: {},
      idempotencyKey: "refresh:u_local:2026-08-28",
    });
    const second = createJob(db, {
      userId: "u_local",
      jobType: "refresh_learner_analysis",
      payload: {},
      idempotencyKey: "refresh:u_local:2026-08-28",
    });
    expect(first.existing).toBe(false);
    expect(second.existing).toBe(true);
    expect(second.id).toBe(first.id);
  });

  test("同学生同类型存在 queued/running 任务时,无 key 的创建也幂等", () => {
    const { db } = freshDb();
    const first = createJob(db, {
      userId: "u_local",
      jobType: "refresh_learner_analysis",
      payload: {},
    });
    const second = createJob(db, {
      userId: "u_local",
      jobType: "refresh_learner_analysis",
      payload: {},
    });
    expect(second.id).toBe(first.id);
  });

  test("不同 jobType 互不阻塞", () => {
    const { db } = freshDb();
    createJob(db, { userId: "u_local", jobType: "refresh_learner_analysis", payload: {} });
    const other = createJob(db, { userId: "u_local", jobType: "generate_questions", payload: {} });
    expect(other.existing).toBe(false);
  });

  test("claimNextJob 按 FIFO 领取并置 running、attempts+1", () => {
    const { db } = freshDb();
    createJob(db, { userId: "u_local", jobType: "generate_questions", payload: { n: 1 } });
    createJob(db, { userId: "u_local", jobType: "generate_questions", payload: { n: 2 } });
    const job = claimNextJob(db);
    expect(job).not.toBeNull();
    expect(job!.attempts).toBe(1);
    expect(job!.status).toBe("running");
  });

  test("失败任务重试一次后进入 failed 终态", () => {
    const { db } = freshDb();
    const { id } = createJob(db, {
      userId: "u_local",
      jobType: "generate_questions",
      payload: {},
    });
    const job = claimNextJob(db)!;
    finishJob(db, job.id, "boom");
    expect(db.select().from(aiJobs).all()[0].status).toBe("queued"); // 第一次失败回队列

    const retried = claimNextJob(db)!;
    expect(retried.id).toBe(id);
    expect(retried.attempts).toBe(2);
    finishJob(db, retried.id, "boom again");
    expect(db.select().from(aiJobs).all()[0].status).toBe("failed");
  });

  test("成功任务进入 succeeded", () => {
    const { db } = freshDb();
    createJob(db, { userId: "u_local", jobType: "generate_questions", payload: {} });
    const job = claimNextJob(db)!;
    finishJob(db, job.id);
    expect(db.select().from(aiJobs).all()[0].status).toBe("succeeded");
  });
});
