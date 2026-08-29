import type { TaskType } from "@mistake-book/shared";
import { PROMPT_PLACEHOLDERS, type PromptDef } from "./index.js";
import { DEFAULT_PROMPTS_DIR, loadPromptTexts } from "./loader.js";
import { buildAnalyzeUser } from "./analyze.js";
import { buildGenerateUser } from "./generate.js";
import { buildVerifyUser } from "./verify.js";
import { buildJudgeUser } from "./judge.js";
import { buildSelectTopicsUser } from "./select.js";
import { buildSummarizeUser } from "./summarize.js";

export * from "./index.js";

/** 服务端提示词 id,与仓库根 llm_prompts/<id>.md 一一对应 */
export const PROMPT_IDS = [
  "analyze_mistake",
  "generate_questions",
  "verify_question",
  "judge_answer",
  "select_topics",
  "summarize_learner",
] as const;

export type PromptId = (typeof PROMPT_IDS)[number];

/** 启动时一次性加载 system 文本与版本号;文件缺失/格式错误/占位符未识别都会抛错 */
const loaded = loadPromptTexts(DEFAULT_PROMPTS_DIR, PROMPT_IDS, PROMPT_PLACEHOLDERS);

function promptDef<I>(id: PromptId, buildUser: (input: I) => string): PromptDef<I> {
  return { version: loaded[id].version, system: loaded[id].system, buildUser };
}

/**
 * 提示词注册表:任务类型 → 提示词定义。
 * system 文本与版本号维护在 llm_prompts/(markdown,启动时加载);
 * 这里只保留 user 消息组装与注册。识题在豆包侧完成,系统内没有 extract 提示词(LLD §7.5)。
 */
export const prompts = {
  analyze_mistake: promptDef("analyze_mistake", buildAnalyzeUser),
  generate_questions: promptDef("generate_questions", buildGenerateUser),
  verify_question: promptDef("verify_question", buildVerifyUser),
  judge_answer: promptDef("judge_answer", buildJudgeUser),
  select_topics: promptDef("select_topics", buildSelectTopicsUser),
  summarize_learner: promptDef("summarize_learner", buildSummarizeUser),
} as const;

export type PromptRegistry = typeof prompts;

export function promptFor<T extends TaskType>(taskType: T): PromptRegistry[T] {
  return prompts[taskType];
}
