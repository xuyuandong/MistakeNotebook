import { SUBJECT_NAMES, truncateForBudget } from "./index.js";

export interface SummarizeInput {
  scope: "chinese" | "math" | "english";
  previousSummary?: string | null;
  /** 本次新增分析(题目摘要 + 错误类型 + 概念) */
  newAnalyses: string[];
  /** 最新结构化统计(概念掌握/错误类型计数,确定性代码产出) */
  stats: string[];
}

/**
 * summarize_learner 的 user 消息组装。
 * system 文本与版本号维护在 llm_prompts/summarize_learner.md(LLD §7.5):
 * 只用上一版总结 + 本次新增 + 统计,不读取全部历史原题(HLD §9.4 C-4)。
 */
export function buildSummarizeUser({ scope, previousSummary, newAnalyses, stats }: SummarizeInput): string {
  return [
    `学科:${SUBJECT_NAMES[scope]}`,
    previousSummary ? `上一版总结:\n${truncateForBudget(previousSummary, 2500)}` : "上一版总结:(无,首次生成)",
    "本次新增分析:",
    ...newAnalyses.map((a) => `- ${truncateForBudget(a, 500)}`),
    "最新统计:",
    ...stats.map((s) => `- ${truncateForBudget(s, 300)}`),
  ].join("\n");
}
