import type { AppConfig } from "./config/index.js";
import type { Db } from "./db/client.js";
import type { ChatClient } from "./ai/client.js";
import type { RawRunStore } from "./ai/rawlog.js";
import type { Logger } from "./logger.js";

/** 应用运行时上下文:所有路由/任务的共享依赖 */
export interface AppContext {
  config: AppConfig;
  db: Db;
  /** data 目录;RawRunStore 的 ai-raw 挂在其下 */
  filesDir: string;
  chat: ChatClient;
  rawStore: RawRunStore;
  logger: Logger;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    /** 免登录:固定为内置单用户(单机家庭使用,LLD 决策表);公网部署前必须恢复鉴权 */
    user: { id: string };
  }
}
