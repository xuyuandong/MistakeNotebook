import type { Subject } from "@mistake-book/shared";
import { PROMPT_PLACEHOLDERS, type PromptDef } from "./index.js";
import { DEFAULT_PROMPTS_DIR, loadPromptTexts } from "./loader.js";
import { buildAnalyzeUser, type AnalyzeBatchInput } from "./analyze.js";
import { buildGenerateUser } from "./generate.js";
import { buildVerifyUser } from "./verify.js";
import { buildJudgeUser } from "./judge.js";
import { buildSelectTopicsUser } from "./select.js";
import { buildSummarizeUser, type SummarizeInput } from "./summarize.js";
import { buildConsolidateUser, type ConsolidateInput } from "./consolidate.js";

export * from "./index.js";

/**
 * 服务端提示词 id,与仓库根 llm_prompts/<id>.md 一一对应。
 * analyze_mistake 与 summarize_learner 按学科拆分为 3 份(数学/语文/英语),
 * 避免一份通用提示词无法针对性优化(LLD §7.5)。
 */
export const PROMPT_IDS = [
  "analyze_mistake_chinese",
  "analyze_mistake_math",
  "analyze_mistake_english",
  "generate_questions",
  "verify_question",
  "judge_answer",
  "select_topics",
  "summarize_learner_chinese",
  "summarize_learner_math",
  "summarize_learner_english",
  "consolidate_concepts",
] as const;

export type PromptId = (typeof PROMPT_IDS)[number];

/** 启动时一次性加载 system 文本与版本号;文件缺失/格式错误/占位符未识别都会抛错 */
const loaded = loadPromptTexts(DEFAULT_PROMPTS_DIR, PROMPT_IDS, PROMPT_PLACEHOLDERS);

function promptDef<I>(id: PromptId, buildUser: (input: I) => string): PromptDef<I> {
  return { version: loaded[id].version, system: loaded[id].system, buildUser };
}

/**
 * 提示词注册表:提示词 id → 提示词定义。
 * system 文本与版本号维护在 llm_prompts/(markdown,启动时加载);
 * 这里只保留 user 消息组装与注册。识题在豆包侧完成,系统内没有 extract 提示词(LLD §7.5)。
 */
export const prompts = {
  analyze_mistake_chinese: promptDef("analyze_mistake_chinese", buildAnalyzeUser),
  analyze_mistake_math: promptDef("analyze_mistake_math", buildAnalyzeUser),
  analyze_mistake_english: promptDef("analyze_mistake_english", buildAnalyzeUser),
  generate_questions: promptDef("generate_questions", buildGenerateUser),
  verify_question: promptDef("verify_question", buildVerifyUser),
  judge_answer: promptDef("judge_answer", buildJudgeUser),
  select_topics: promptDef("select_topics", buildSelectTopicsUser),
  summarize_learner_chinese: promptDef("summarize_learner_chinese", buildSummarizeUser),
  summarize_learner_math: promptDef("summarize_learner_math", buildSummarizeUser),
  summarize_learner_english: promptDef("summarize_learner_english", buildSummarizeUser),
  consolidate_concepts: promptDef("consolidate_concepts", buildConsolidateUser),
} as const;

export type PromptRegistry = typeof prompts;

/** 不分学科的任务按 taskType 直接取提示词 */
export type DirectPromptId = "generate_questions" | "verify_question" | "judge_answer" | "select_topics";

export function promptFor<T extends DirectPromptId>(taskType: T): PromptRegistry[T] {
  return prompts[taskType];
}

/** 按学科拆分的提示词:任务类型 + 学科 → 具体文件(LLD §7.5) */
const SUBJECT_PROMPT_IDS = {
  analyze_mistake: {
    chinese: "analyze_mistake_chinese",
    math: "analyze_mistake_math",
    english: "analyze_mistake_english",
  },
  summarize_learner: {
    chinese: "summarize_learner_chinese",
    math: "summarize_learner_math",
    english: "summarize_learner_english",
  },
} as const;

export function promptForAnalyze(subject: Subject): PromptDef<AnalyzeBatchInput> {
  return prompts[SUBJECT_PROMPT_IDS.analyze_mistake[subject]];
}

export function promptForSummarize(subject: Subject): PromptDef<SummarizeInput> {
  return prompts[SUBJECT_PROMPT_IDS.summarize_learner[subject]];
}

/** 概念归并建议(一次性整理工具,server/scripts/consolidate-concepts.ts 使用) */
export function promptForConsolidate(): PromptDef<ConsolidateInput> {
  return prompts.consolidate_concepts;
}
