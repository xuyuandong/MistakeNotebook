import { gradeLabel, truncateForBudget } from "./index.js";

export interface SelectTopicsInput {
  subject: "chinese" | "math" | "english";
  currentGrade?: string | null;
  /** 掌握状态行:"概念名:掌握分 X,样本 N" */
  masteryLines: string[];
  /** 近 30 天错误类型计数行 */
  errorTypeLines: string[];
  /** 复习完成情况摘要 */
  reviewLine?: string;
  /** active 的学习方法/习惯画像 */
  habitLines?: string[];
}

/**
 * select_topics 的 user 消息组装。
 * system 文本与版本号维护在 llm_prompts/select_topics.md(LLD §7.5):
 * 智能出题前的选题分析(LLD §4.4),自动选择本次练习的目标知识点。
 */
export function buildSelectTopicsUser(input: SelectTopicsInput): string {
  return [
    `学科:${input.subject}`,
    gradeLabel(input.currentGrade),
    input.masteryLines.length ? "知识概念掌握状态:" : "知识概念掌握状态:(暂无数据)",
    ...input.masteryLines.map((l) => `- ${truncateForBudget(l, 200)}`),
    input.errorTypeLines.length ? "近 30 天错误类型分布:" : "",
    ...input.errorTypeLines.map((l) => `- ${truncateForBudget(l, 120)}`),
    input.reviewLine ? `复习完成情况:${input.reviewLine}` : "",
    ...(input.habitLines?.length
      ? ["学习方法画像:", ...input.habitLines.map((l) => `- ${truncateForBudget(l, 200)}`)]
      : []),
  ]
    .filter(Boolean)
    .join("\n");
}
