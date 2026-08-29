import type { FastifyInstance } from "fastify";
import {
  createImportHandler,
  deleteImportHandler,
  getDraftHandler,
  getImportHandler,
  listDraftsHandler,
  listImportsHandler,
  debugAiRawHandler,
} from "./imports.js";
import {
  createMistakeHandler,
  deleteMistakeHandler,
  getMistakeHandler,
  listMistakesHandler,
} from "./mistakes.js";
import {
  analyticsHandler,
  appealAttemptHandler,
  createAttemptHandler,
  createPracticeSetHandler,
  exportJsonHandler,
  exportMarkdownHandler,
  getAttemptHandler,
  getPracticeSetHandler,
  learnerProfileHandler,
  learnerRefreshHandler,
  listConceptsHandler,
  meHandler,
  patchConceptHandler,
  patchMeHandler,
  patchMistakeHandler,
  purgeDataHandler,
  reportQuestionHandler,
  todayReviewsHandler,
} from "./resources.js";

/** 业务路由注册(免登录,归属内置单用户),逻辑在 services */
export function registerRoutes(scope: FastifyInstance): void {
  // 豆包导入
  scope.post("/api/v1/imports", createImportHandler);
  scope.get("/api/v1/imports", listImportsHandler);
  scope.get("/api/v1/imports/:id", getImportHandler);
  scope.delete("/api/v1/imports/:id", deleteImportHandler);
  scope.get("/api/v1/ingestion-drafts", listDraftsHandler);
  scope.get("/api/v1/ingestion-drafts/:id", getDraftHandler);
  scope.get("/api/v1/debug/ai-raw", debugAiRawHandler);

  // 错题
  scope.post("/api/v1/mistakes", createMistakeHandler);
  scope.get("/api/v1/mistakes", listMistakesHandler);
  scope.get("/api/v1/mistakes/:id", getMistakeHandler);
  scope.patch("/api/v1/mistakes/:id", patchMistakeHandler);
  scope.delete("/api/v1/mistakes/:id", deleteMistakeHandler);

  // 概念
  scope.get("/api/v1/concepts", listConceptsHandler);
  scope.patch("/api/v1/concepts/:id", patchConceptHandler);

  // 复习与作答(客观题本地判定;主观题创建 judge_answer 任务)
  scope.get("/api/v1/reviews/today", todayReviewsHandler);
  scope.post("/api/v1/attempts", createAttemptHandler);
  scope.get("/api/v1/attempts/:id", getAttemptHandler);
  scope.patch("/api/v1/attempts/:id", appealAttemptHandler);

  // 智能练习(学科 + 旧题/新题开关)
  scope.post("/api/v1/practice-sets", createPracticeSetHandler);
  scope.get("/api/v1/practice-sets/:id", getPracticeSetHandler);
  scope.post("/api/v1/questions/:id/reports", reportQuestionHandler);

  // 学习分析与档案
  scope.get("/api/v1/analytics/weaknesses", analyticsHandler);
  scope.get("/api/v1/learner-profile", learnerProfileHandler);
  scope.post("/api/v1/learner-profile/refresh", learnerRefreshHandler);

  // 设置 / 导出 / 数据清空
  scope.get("/api/v1/me", meHandler);
  scope.patch("/api/v1/me", patchMeHandler);
  scope.get("/api/v1/export/json", exportJsonHandler);
  scope.get("/api/v1/export/markdown", exportMarkdownHandler);
  scope.post("/api/v1/data/purge", purgeDataHandler);
}
