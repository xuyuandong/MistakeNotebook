import { quoteStudentContent, truncateForBudget } from "./index.js";
import type { GeneratedQuestion } from "@mistake-book/shared";

export interface VerifyInput {
  question: GeneratedQuestion;
}

/**
 * verify_question 的 user 消息组装。
 * system 文本与版本号维护在 llm_prompts/verify_question.md(LLD §7.5):
 * 与生成使用不同的一次调用,不把生成时的自我评价当真(PRD 5.3.4 第 4 步,数学题优先)。
 */
export function buildVerifyUser({ question }: VerifyInput): string {
  return quoteStudentContent(
    "student-content",
    truncateForBudget(
      `${question.stemMd}\n参考答案:${question.answer}\n解析:${question.explanationMd}`,
      4000,
    ),
  );
}
