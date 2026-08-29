import { gradeLabel, quoteStudentContent, truncateForBudget } from "./index.js";

export interface GenerateInput {
  subject: "chinese" | "math" | "english";
  currentGrade?: string | null;
  count: number;
  difficulty?: number;
  questionType?: string;
  /** 目标知识点名称 */
  concepts: string[];
  /** 原错题的抽象特征(题干摘要,禁止照抄) */
  referenceMistake?: { stemMd: string; note?: string } | null;
}

/**
 * generate_questions 的 user 消息组装。
 * system 文本(含三科硬性规则 {{SUBJECT_RULES_LIST}})与版本号维护在
 * llm_prompts/generate_questions.md(LLD §7.5);服务端还会做 Schema/学科规则/重复度/独立复核四道校验。
 */
export function buildGenerateUser(input: GenerateInput): string {
  const lines = [
    `学科:${input.subject}`,
    gradeLabel(input.currentGrade),
    `需要题数:${input.count}`,
    input.difficulty ? `难度:${input.difficulty}/5` : "",
    input.questionType ? `题型偏好:${input.questionType}` : "",
    `目标知识点:${input.concepts.join("、")}`,
    "",
  ];
  if (input.referenceMistake) {
    lines.push(
      "参考错题(只参考考查方向,禁止照抄):",
      quoteStudentContent(
        "student-content",
        truncateForBudget(input.referenceMistake.stemMd, 1500),
      ),
    );
    if (input.referenceMistake.note) {
      lines.push(`学生当时的问题:${input.referenceMistake.note}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}
