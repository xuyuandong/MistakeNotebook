import { eq } from "drizzle-orm";
import { attempts, generatedQuestions, mistakes, mistakeVersions, modelRuns } from "../../db/schema.js";
import { JudgeAnswerResult } from "@mistake-book/shared";
import { parseModelJson } from "../../ai/parse.js";
import type { JobRecord } from "../queue.js";
import type { JobHandler } from "../loop.js";
import type { ChatClient } from "../../ai/client.js";
import type { RawRunStore } from "../../ai/rawlog.js";
import { promptFor } from "../../prompts/registry.js";
import type { Db } from "../../db/client.js";
import type { Logger } from "../../logger.js";
import type { AppConfig } from "../../config/index.js";
import { finalizePendingAttempt } from "../../services/review.js";

/** 任务处理器共享上下文(extract 移除后由 judge.ts 承接) */
export interface HandlerContext {
  db: Db;
  chat: ChatClient;
  filesDir: string;
  rawStore: RawRunStore;
  config: AppConfig;
  logger: Logger;
}

interface JudgePayload {
  attemptId: string;
}

/**
 * judge_answer(LLD §4.5):主观题 LLM 判分。
 * 输入题目/标准答案/参考解析/评分要点/学生作答 → verdict(correct|partial|wrong) + 依据 + 简评;
 * finalizePendingAttempt 幂等落库(事件/复习计划/掌握度),重试不重复计数。
 * 判分失败(模型/Schema)→ 任务 failed,attempt 保持 pending_judge,前端提供自判兜底。
 */
export function makeJudgeHandler(ctx: HandlerContext & { rawStore: RawRunStore }): JobHandler {
  return async (job: JobRecord) => {
    const { attemptId } = job.payload as JudgePayload;
    const { db, chat, rawStore, logger } = ctx;
    const attempt = db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
    if (!attempt || attempt.userId !== job.userId) return;
    if (attempt.result !== "pending_judge") return; // 已终态(幂等)

    // 组装判分输入
    let questionMd = "";
    let standardAnswer: string | null = null;
    let standardSolution: string | null = null;
    let rubric: string | null = null;
    let subject: "chinese" | "math" | "english" = "math";

    if (attempt.sourceType === "mistake_review") {
      const m = db.select().from(mistakes).where(eq(mistakes.id, attempt.sourceId)).get();
      if (!m) return;
      const ver = m.currentVersionId
        ? db
            .select({ contentJson: mistakeVersions.contentJson })
            .from(mistakeVersions)
            .where(eq(mistakeVersions.id, m.currentVersionId))
            .get()
        : undefined;
      const content = ver
        ? (JSON.parse(ver.contentJson) as {
            stemMd?: string;
            correctAnswer?: string;
            explanationMd?: string;
          })
        : {};
      questionMd = content.stemMd ?? "";
      standardAnswer = content.correctAnswer ?? null;
      standardSolution = content.explanationMd ?? null;
      subject = m.subject as "chinese" | "math" | "english";
    } else {
      const q = db
        .select()
        .from(generatedQuestions)
        .where(eq(generatedQuestions.id, attempt.sourceId))
        .get();
      if (!q) return;
      const gq = JSON.parse(q.questionJson) as {
        stemMd: string;
        answer: string;
        explanationMd: string;
        rubricMd?: string;
      };
      questionMd = gq.stemMd;
      standardAnswer = gq.answer;
      standardSolution = gq.explanationMd;
      rubric = gq.rubricMd ?? null;
      subject = q.subject as "chinese" | "math" | "english";
    }

    const prompt = promptFor("judge_answer");
    let verdict: { verdict: "correct" | "partial" | "wrong"; basis: string; comment: string } | null =
      null;
    let lastText = "";

    for (let attemptNo = 1; attemptNo <= 2 && !verdict; attemptNo++) {
      const res = await chat.chat("text", {
        taskType: "judge_answer",
        system: prompt.system,
        messages: [
          {
            role: "user",
            content: prompt.buildUser({
              subject,
              questionMd,
              standardAnswer,
              standardSolution,
              rubric,
              studentAnswer: attempt.answer ?? "",
              usedHint: attempt.usedHint === 1,
              currentGrade: null,
            }),
          },
        ],
        jsonMode: true,
        jobId: job.id,
      });
      lastText = res.text;
      insertModelRun(db, job.id, res.run, prompt.version);
      rawStore.save("judge_answer", `attempt-${attemptId}-try${attemptNo}`, {
        taskType: "judge_answer",
        provider: res.run.provider,
        model: res.run.model,
        promptVersion: prompt.version,
        createdAt: new Date().toISOString(),
        key: `attempt-${attemptId}`,
        rawText: res.text,
        parsed: null,
        status: res.run.status === "ok" ? "ok" : "api_error",
      });
      if (res.run.status !== "ok") continue;
      try {
        verdict = JudgeAnswerResult.parse(parseModelJson(res.text));
      } catch (e) {
        db.update(modelRuns)
          .set({ status: "schema_fail", error: (e as Error).message })
          .where(eq(modelRuns.id, res.run.id))
          .run();
        logger.warn(`judge schema fail (attempt ${attemptNo}): ${(e as Error).message}`);
      }
    }

    if (!verdict) {
      // 保持 pending_judge,前端提供自判兜底(PRD 5.3.5)
      throw new Error(`判分失败:模型输出不符合 Schema(原始响应已落盘 data/ai-raw/judge_answer/)`);
    }

    const finalized = finalizePendingAttempt(db, job.userId, attemptId, verdict.verdict, "llm", {
      basis: verdict.basis,
      comment: verdict.comment,
    });
    if (!finalized) {
      logger.info(`judge attempt ${attemptId}: already finalized, skip`);
    }
    void lastText;
  };
}

function insertModelRun(
  db: Db,
  jobId: string,
  run: {
    id: string;
    taskType: string;
    provider: string;
    model: string;
    status: string;
    durationMs: number;
    usageJson: string | null;
  },
  promptVersion: string,
): void {
  db.insert(modelRuns)
    .values({
      id: run.id,
      jobId,
      taskType: run.taskType as never,
      provider: run.provider as never,
      model: run.model,
      promptVersion,
      status: run.status as never,
      durationMs: run.durationMs,
      usageJson: run.usageJson,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
}
