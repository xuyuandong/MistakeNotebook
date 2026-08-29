import { gradeLabel, quoteStudentContent, truncateForBudget } from "./index.js";

export interface AnalyzeBatchItem {
  index: number;
  questionMd: string;
  options?: string[];
  myAnswer?: string;
  correctAnswer?: string;
  note?: string;
  gradeAtTime?: string | null;
  /** 相关历史错题精简片段(检索结果,LLD §6.3) */
  relatedMistakes?: string[];
  /** 相关概念的掌握状态摘要 */
  relatedMastery?: string[];
  /** 学科长期记忆中 active 的事实(含学习方法/习惯画像) */
  relatedFacts?: string[];
  /** 画像统计摘要:错题分布 / 复习情况 */
  profileSummary?: string[];
}

export interface AnalyzeBatchInput {
  subject: "chinese" | "math" | "english";
  currentGrade?: string | null;
  items: AnalyzeBatchItem[];
}

/**
 * analyze_mistake 的 user 消息组装。
 * system 文本与版本号维护在 llm_prompts/analyze_mistake.md(LLD §7.5):
 * 主动归因,学生错误备注选填;画像推断必须置 profileInferred=true;完全无依据才输出 unconfirmed(AGENTS §7)。
 */
export function buildAnalyzeUser(input: AnalyzeBatchInput): string {
  const parts: string[] = [`学科:${input.subject}`, gradeLabel(input.currentGrade)];
  for (const item of input.items) {
    if (item.profileSummary?.length) {
      parts.push("学生画像摘要:", ...item.profileSummary.map((s) => `- ${truncateForBudget(s, 300)}`));
      break; // 画像按学科汇总,一批贴一次
    }
  }
  parts.push("");
  for (const item of input.items) {
    const lines = [
      `【第 ${item.index} 题】`,
      quoteStudentContent("student-content", truncateForBudget(item.questionMd, 3000)),
      item.options?.length ? `选项:${item.options.join(" | ")}` : "",
      item.myAnswer ? `学生答案:${item.myAnswer}` : "学生答案:(未提供,视为完全不会)",
      item.correctAnswer ? `正确答案:${item.correctAnswer}` : "正确答案:(未提供)",
      item.note ? `学生备注:${item.note}` : "",
      item.gradeAtTime ? `录入时年级:${item.gradeAtTime}` : "",
    ];
    if (item.relatedMastery?.length) {
      lines.push("相关概念掌握状态:", ...item.relatedMastery.map((m) => `- ${m}`));
    }
    if (item.relatedMistakes?.length) {
      lines.push(
        "相关历史错题片段:",
        ...item.relatedMistakes.map((m) => `- ${truncateForBudget(m, 400)}`),
      );
    }
    if (item.relatedFacts?.length) {
      lines.push("相关长期记忆:", ...item.relatedFacts.map((f) => `- ${truncateForBudget(f, 200)}`));
    }
    parts.push(lines.filter(Boolean).join("\n"), "");
  }
  return parts.join("\n");
}
