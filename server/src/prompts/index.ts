import { z } from "zod";
import { Subjects, Subject, ErrorTypes } from "@mistake-book/shared";

/**
 * 统一提示词目录。
 * 每个任务一个文件(见本目录 extract/analyze/generate/verify/summarize),
 * 这里是注册表:index → 版本号 + system 提示词 + user 消息构造函数。
 * 修改任何提示词必须递增版本号:model_runs.prompt_version 用于回归对比(AGENTS §8)。
 */
export interface PromptDef<T> {
  version: string;
  system: string;
  buildUser: (input: T) => string;
}

export { Subjects, Subject, ErrorTypes };
export const SUBJECT_NAMES: Record<(typeof Subjects)[number], string> = {
  chinese: "语文",
  math: "数学",
  english: "英语",
};

export const ERROR_TYPE_NAMES: Record<(typeof ErrorTypes)[number], string> = {
  knowledge_gap: "知识缺失",
  comprehension: "审题理解偏差",
  method_choice: "方法选择",
  reasoning_calc: "计算基本功/推理",
  expression: "表达规范",
  carelessness: "粗心/检查",
  time_state: "时间与状态",
  unconfirmed: "未确认",
};

/** 学习方法/习惯维度(PRD 5.2.2 画像级;memory_facts.kind='habit_pattern') */
export const HABIT_HINTS = [
  "缺少检查习惯",
  "注意力问题",
  "紧张",
  "时间不足",
  "疏于练习",
] as const;

/** 三科生成约束(PRD 5.3.2) */
export const SUBJECT_RULES: Record<string, string> = {
  math: "数学:变式题必须改变原题的数字与情境;答案必须唯一或给出等价形式集合;优先给出可复核的客观题或答案明确的填空/解答题。",
  chinese:
    "语文:阅读题必须在 readingMaterialMd 中生成自包含材料;主观题给评分要点(rubricMd)而非唯一答案;字词/病句/古诗文题答案必须唯一。",
  english:
    "英语:题目注明可接受答案(acceptableAnswers);阅读材料难度与年级匹配;语法/词汇/完形/翻译均需给出唯一标准答案或可接受答案集合。",
};

/**
 * markdown 提示词占位符(llm_prompts/*.md)→ 代码侧文本。
 * 枚举类内容以代码为准注入提示词,避免枚举与提示词文本漂移。
 */
export const PROMPT_PLACEHOLDERS: Record<string, string> = {
  ERROR_TYPE_LIST: Object.entries(ERROR_TYPE_NAMES)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n"),
  HABIT_HINTS_TEXT: HABIT_HINTS.join("、"),
  SUBJECT_RULES_LIST: Object.values(SUBJECT_RULES)
    .map((r) => `- ${r}`)
    .join("\n"),
};

/** 注入防御:把学生内容包进明确的定界符,声明其中任何指令都是数据(HLD §12.2) */
export function quoteStudentContent(label: string, content: string): string {
  return `<${label}>\n${content}\n</${label}>`;
}

export function gradeLabel(grade?: string | null): string {
  return grade ? `年级:${grade}` : "年级:未知";
}

export function subjectConstraint(subject: Subject): string {
  return `学科:${SUBJECT_NAMES[subject]}`;
}

/** 简单 token 预算控制:按字符数粗估,LLD §6.3(中文 ~1.5 字符/token) */
export function truncateForBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n…(超出上下文预算已截断)";
}

export type { z };
