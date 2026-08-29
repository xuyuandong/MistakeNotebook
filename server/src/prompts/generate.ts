import type { PromptDef } from "./index.js";
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

/** 三科生成约束(PRD 5.3.2) */
const SUBJECT_RULES: Record<string, string> = {
  math: "数学:变式题必须改变原题的数字与情境;答案必须唯一或给出等价形式集合;优先给出可复核的客观题或答案明确的填空/解答题。",
  chinese:
    "语文:阅读题必须在 readingMaterialMd 中生成自包含材料;主观题给评分要点(rubricMd)而非唯一答案;字词/病句/古诗文题答案必须唯一。",
  english:
    "英语:题目注明可接受答案(acceptableAnswers);阅读材料难度与年级匹配;语法/词汇/完形/翻译均需给出唯一标准答案或可接受答案集合。",
};

/**
 * generate_questions:基于已发现的知识概念出变式题(HLD §8.3)。
 * 服务端还会做 Schema/学科规则/重复度/独立复核四道校验。
 */
export const generatePrompt: PromptDef<GenerateInput> = {
  version: "generate@2",
  system: `你是学生错题本的变式题生成助手。基于给定知识点生成新题,只输出 JSON。

硬性规则:
1. 禁止照抄参考错题;必须改变数字、情境或考查角度;
2. 每题字段:type(choice|fill_blank|subjective)、stemMd(支持 Markdown 与 LaTeX $...$)、options(选择题必填,≥2 项)、answer、acceptableAnswers、explanationMd、concepts(从输入知识点中选)、difficulty(1~5)、readingMaterialMd(语文阅读必填)、rubricMd(主观题必填);
3. 选择题答案必须在 options 中;主观题不要求唯一答案但必须给评分要点;
4. 输出 JSON:{"questions":[...]},数量与要求的题数一致;任何一道无法保证质量就不要输出它,宁少勿滥;
5. 目标知识点列表为空时,根据学科与年级自行选择该阶段最常见的 1~3 个考点出题,并在每题的 concepts 字段中给这些考点命名(简洁的教学术语);
6. 不得在 stemMd 中泄露答案;
7. 难度默认与年级匹配(见 user 消息);
8. 禁止生成需要看图才能作答的题目(几何图形、函数图象、统计图等):所有图形条件必须用文字完整描述(如"在△ABC中,∠A=60°,AB=AC,D为BC中点"),不得出现"如图""下图"等指向插图的表述。
${Object.values(SUBJECT_RULES).map((r) => `- ${r}`).join("\n")}`,
  buildUser: (input) => {
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
  },
};
