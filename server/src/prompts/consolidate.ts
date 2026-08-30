import { SUBJECT_NAMES, truncateForBudget } from "./index.js";

export interface ConsolidateConceptInfo {
  id: string;
  name: string;
  /** 概念当前所属分类(null = 未分类) */
  category: string | null;
  /** 关联未归档错题数 */
  mistakeCount: number;
  /** 作答样本数 */
  sampleCount: number;
}

export interface ConsolidateInput {
  subject: "chinese" | "math" | "english";
  /** 已有分类(提示词反馈闭环:优先复用) */
  knownCategories: string[];
  concepts: ConsolidateConceptInfo[];
}

/**
 * consolidate_concepts 的 user 消息组装(一次性整理工具)。
 * system 文本与版本号维护在 llm_prompts/consolidate_concepts.md:只输出
 * assignments(改挂/新建分类)与 merges(同义/上下位概念归并)两类建议。
 */
export function buildConsolidateUser({
  subject,
  knownCategories,
  concepts,
}: ConsolidateInput): string {
  const lines: string[] = [`学科:${SUBJECT_NAMES[subject]}`];
  lines.push(
    "已有概念分类(优先复用):",
    ...(knownCategories.length ? knownCategories.map((c) => `- ${c}`) : ["-(暂无)"]),
  );
  lines.push(
    "概念清单(ID | 名称 | 当前分类 | 错题数 | 样本数):",
    ...concepts.map(
      (c) =>
        `- ${c.id} | ${truncateForBudget(c.name, 100)} | ${c.category ?? "未分类"} | ${c.mistakeCount} | ${c.sampleCount}`,
    ),
  );
  return lines.join("\n");
}
