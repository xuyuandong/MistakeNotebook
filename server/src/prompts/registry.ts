import type { TaskType } from "@mistake-book/shared";
import { analyzePrompt } from "./analyze.js";
import { generatePrompt } from "./generate.js";
import { verifyPrompt } from "./verify.js";
import { judgePrompt } from "./judge.js";
import { selectTopicsPrompt } from "./select.js";
import { summarizePrompt } from "./summarize.js";

export * from "./index.js";

/**
 * 提示词注册表:任务类型 → 提示词定义(版本号 + system + user 构造)。
 * 识题在豆包侧完成,系统内没有 extract 提示词(LLD §7.5)。
 */
export const prompts = {
  analyze_mistake: analyzePrompt,
  generate_questions: generatePrompt,
  verify_question: verifyPrompt,
  judge_answer: judgePrompt,
  select_topics: selectTopicsPrompt,
  summarize_learner: summarizePrompt,
} as const;

export type PromptRegistry = typeof prompts;

export function promptFor<T extends TaskType>(taskType: T): PromptRegistry[T] {
  return prompts[taskType];
}
