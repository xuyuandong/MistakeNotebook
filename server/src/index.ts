import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, ConfigError } from "./config/index.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrator.js";
import { buildApp } from "./app.js";
import { startJobLoop } from "./jobs/loop.js";
import { startDailyScheduler } from "./jobs/daily.js";
import { makeAnalyzeHandler } from "./jobs/handlers/analyze.js";
import { makeGenerateHandler } from "./jobs/handlers/generate.js";
import { makeJudgeHandler } from "./jobs/handlers/judge.js";
import { createChatClient } from "./ai/client.js";
import { RawRunStore } from "./ai/rawlog.js";
import type { AppContext } from "./context.js";
import { createLogger } from "./logger.js";

const VERSION = "0.2.0";

async function main() {
  const logger = createLogger("server");
  const config = loadConfig();
  for (const w of config.warnings) logger.warn(w);

  const dataDir = resolve(config.dataDir);
  const filesDir = resolve(dataDir, "files");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(filesDir, { recursive: true });

  const { sqlite, db } = createDb(resolve(dataDir, "app.db"));
  const applied = runMigrations(sqlite, resolve(import.meta.dirname, "../migrations"));
  for (const m of applied) logger.info(`migration applied: ${m}`);

  const ctx: AppContext = {
    config,
    db,
    filesDir,
    chat: createChatClient(config),
    rawStore: new RawRunStore(filesDir),
    logger,
  };

  const app = await buildApp({ ctx, version: VERSION });

  const stopLoop = startJobLoop(db, logger, {
    refresh_learner_analysis: makeAnalyzeHandler(ctx),
    generate_questions: makeGenerateHandler(ctx),
    judge_answer: makeJudgeHandler(ctx),
  });
  const stopDaily = startDailyScheduler(ctx);
  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    logger.info(`server listening on :${config.port} (env=${config.env})`);
  } catch (e) {
    stopLoop();
    stopDaily();
    await app.close();
    sqlite.close();
    throw e;
  }

  const shutdown = async () => {
    stopLoop();
    stopDaily();
    await app.close();
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  if (e instanceof ConfigError) {
    console.error(`配置错误: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
