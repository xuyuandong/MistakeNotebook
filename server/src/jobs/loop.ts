import type { Db } from "../db/client.js";
import { claimNextJob, finishJob, type JobRecord } from "./queue.js";
import type { Logger } from "../logger.js";

export type JobHandler = (job: JobRecord) => Promise<void>;

/**
 * 进程内任务循环:并发 1,每 5s 轮询 ai_jobs。
 * handler 注册表按 jobType 扩展(阶段 1/2 补充具体实现);
 * 未注册类型的任务直接标记失败,避免空转。
 */
export function startJobLoop(db: Db, logger: Logger, handlers: Record<string, JobHandler>) {
  let running = false;
  const CONCURRENCY = 1;
  const POLL_MS = 5_000;

  async function tick() {
    if (running) return;
    running = true;
    try {
      for (let i = 0; i < CONCURRENCY; i++) {
        const job = claimNextJob(db);
        if (!job) break;
        const handler = handlers[job.jobType];
        try {
          if (!handler) {
            finishJob(db, job.id, `no handler for job type ${job.jobType}`);
            continue;
          }
          await handler(job);
          finishJob(db, job.id);
        } catch (e) {
          logger.warn(`job ${job.id} (${job.jobType}) failed: ${(e as Error).message}`);
          finishJob(db, job.id, (e as Error).message);
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, POLL_MS);
  // 启动即先跑一轮,处理进程重启遗留
  void tick();
  return () => clearInterval(timer);
}
