import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { HealthResponse } from "@mistake-book/shared";
import type { AppContext } from "./context.js";
import { DEFAULT_USER_ID } from "./db/schema.js";
import { registerRoutes } from "./routes/index.js";
import { createLogger } from "./logger.js";

export interface AppDeps {
  ctx: AppContext;
  version: string;
  /** 测试时可注入额外路由 */
  registerRoutes?: (app: FastifyInstance) => void;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const logger = createLogger("http");
  const app = Fastify({ logger: false });
  app.decorate("ctx", deps.ctx);

  // multipart 仅用于导入 .json 文件;512KB 上限(LLD §3.1)
  await app.register(multipart, {
    limits: { fileSize: 512 * 1024, files: 1 },
  });

  app.get("/api/v1/health", async () => {
    const body: HealthResponse = { status: "ok", version: deps.version };
    return body;
  });

  // 免登录(单机家庭使用):所有业务路由归属内置单用户;公网部署前必须恢复鉴权(LLD 决策表)
  await app.register(async (scope) => {
    scope.addHook("preHandler", async (req) => {
      req.user = { id: DEFAULT_USER_ID };
    });
    registerRoutes(scope);
    deps.registerRoutes?.(scope);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) logger.error(`${req.method} ${req.url} -> ${err.message}`);
    void reply.status(status).send({
      error: {
        code: status >= 500 ? "INTERNAL" : "VALIDATION_ERROR",
        message: status >= 500 ? "内部错误" : err.message,
      },
    });
  });

  return app;
}
