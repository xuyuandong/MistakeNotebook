import type { AppContext } from "../context.js";
import { dailyCheck } from "../services/learner.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * 每日调度:进程内定时器,每小时检查一次但每天最多创建一个任务
 * (幂等键 refresh:{user}:{date});进程错过检查时启动补做(AGENTS §5-6)。
 * 没有待处理数据时不创建任务、不调模型。
 */
export function startDailyScheduler(ctx: AppContext): () => void {
  const run = () => {
    try {
      const res = dailyCheck(ctx.db, "u_local");
      if (res.created) ctx.logger.info("daily check created refresh_learner_analysis job");
    } catch (e) {
      ctx.logger.warn(`daily check failed: ${(e as Error).message}`);
    }
  };
  // 启动补做当日检查
  run();
  const timer = setInterval(run, HOUR_MS);
  return () => clearInterval(timer);
}
