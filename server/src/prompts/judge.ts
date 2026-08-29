import { gradeLabel, quoteStudentContent, truncateForBudget } from "./index.js";

export interface JudgeInput {
  subject: "chinese" | "math" | "english";
  questionMd: string;
  /** 标准答案;可能为空(此时依据评分要点或学科常识谨慎判定) */
  standardAnswer?: string | null;
  /** 卷面解析/参考解题过程(豆包 standard_solution 或 AI 生成) */
  standardSolution?: string | null;
  /** 评分要点(生成的主观题必有) */
  rubric?: string | null;
  studentAnswer: string;
  usedHint: boolean;
  currentGrade?: string | null;
}

/**
 * judge_answer 的 user 消息组装。
 * system 文本与版本号维护在 llm_prompts/judge_answer.md(LLD §7.5):
 * 主观题/解答题 LLM 判分(LLD §4.5);客观题由服务端本地比对,不经过本提示。
 */
export function buildJudgeUser(input: JudgeInput): string {
  const lines = [
    `学科:${input.subject}`,
    gradeLabel(input.currentGrade),
    "【题目】",
    quoteStudentContent("student-content", truncateForBudget(input.questionMd, 3000)),
    input.standardAnswer ? `标准答案:${input.standardAnswer}` : "标准答案:(未提供)",
    input.standardSolution ? `参考解析:${truncateForBudget(input.standardSolution, 2000)}` : "",
    input.rubric ? `评分要点:${truncateForBudget(input.rubric, 1000)}` : "",
    "【学生作答】",
    quoteStudentContent("student-content", truncateForBudget(input.studentAnswer, 3000)),
    input.usedHint ? "(学生使用了提示)" : "",
  ];
  return lines.filter(Boolean).join("\n");
}
