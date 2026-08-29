import { z } from "zod";
import { ErrorType, Subject } from "./enums.js";

/**
 * analyze_mistake(analyze@4):文本模型输出。
 * AI 结合学生画像主动归因:技术性错误类型 + 学习方法/习惯 + 三层建议;
 * 完全无依据才输出 unconfirmed(AGENTS §7)。
 */
export const ConceptCandidate = z.object({
  name: z.string().min(1).max(100),
  isPrimary: z.boolean().default(false),
  evidence: z.string().max(1000).nullish(),
  /** 模型漏报时按中等置信度处理(统计字段宽容;名称/证据等内容字段仍严格) */
  confidence: z.number().min(0).max(1).default(0.5),
  /** 模型认为相似的既有概念 ID(服务端再做别名/FTS 匹配) */
  similarConceptIds: z.array(z.string()).max(5).default([]),
});
export type ConceptCandidate = z.infer<typeof ConceptCandidate>;

export const AnalyzeMistakeResult = z.object({
  primaryErrorType: ErrorType,
  secondaryErrorTypes: z.array(ErrorType).max(3).default([]),
  concepts: z.array(ConceptCandidate).min(1).max(5),
  evidence: z.string().max(2000).nullish(),
  /** 技术性建议(补救练习) */
  improvementSuggestions: z.array(z.string().max(500)).max(5).default([]),
  /** 方法性建议(练习策略、检查流程、时间分配) */
  methodAdvice: z.array(z.string().max(500)).max(3).default([]),
  /** 认知性建议(自我监控、归因习惯) */
  cognitiveAdvice: z.array(z.string().max(500)).max(3).default([]),
  /** 学习方法/习惯问题(画像级):检查习惯、注意力、紧张、时间不足、疏于练习等 */
  habitIssues: z.array(z.string().max(200)).max(5).default([]),
  /** 归因是否主要基于学生画像推断(而非本题作答证据);true 时前端标注“画像推断” */
  profileInferred: z.boolean().default(false),
  needsFollowUp: z.boolean().default(false),
  /** needsFollowUp=true 时向学生展示的追问 */
  followUpQuestion: z.string().max(500).nullish(),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type AnalyzeMistakeResult = z.infer<typeof AnalyzeMistakeResult>;

/**
 * generate_questions:单道生成题(仅编新题模式)。答案唯一性、学科规则由服务端二次校验。
 */
export const GeneratedQuestion = z
  .object({
    type: z.enum(["choice", "fill_blank", "subjective"]),
    stemMd: z.string().min(1).max(10000),
    options: z.array(z.string().max(2000)).max(26).optional(),
    answer: z.string().min(1).max(5000),
    /** 英语/主观题可接受答案列表 */
    acceptableAnswers: z.array(z.string().max(2000)).max(10).default([]),
    explanationMd: z.string().min(1).max(10000),
    concepts: z.array(z.string().min(1).max(100)).min(1).max(5),
    difficulty: z.number().int().min(1).max(5),
    /** 语文/英语阅读材料(自包含) */
    readingMaterialMd: z.string().max(20000).optional(),
    /** 主观题评分要点(判分输入) */
    rubricMd: z.string().max(5000).optional(),
    sourceMistakeId: z.string().uuid().optional(),
  })
  .refine((q) => q.type !== "choice" || (q.options && q.options.length >= 2), {
    message: "选择题必须提供至少 2 个选项",
  })
  .refine((q) => q.type !== "choice" || q.options!.includes(q.answer), {
    message: "选择题答案必须存在于选项中",
  })
  .refine((q) => q.type !== "subjective" || !!q.rubricMd, {
    message: "主观题必须提供评分要点",
  });
export type GeneratedQuestion = z.infer<typeof GeneratedQuestion>;

/** verify_question:独立复核提示的输出 */
export const VerifyQuestionResult = z.object({
  answerCorrect: z.boolean(),
  issues: z.array(z.string().max(500)).max(10).default([]),
  confidence: z.number().min(0).max(1),
});
export type VerifyQuestionResult = z.infer<typeof VerifyQuestionResult>;

/** select_topics:出题前的选题分析(输入画像统计,输出目标知识点与理由) */
export const SelectTopicsResult = z.object({
  targetConcepts: z.array(z.string().min(1).max(100)).max(5),
  rationale: z.string().min(1).max(1000),
});
export type SelectTopicsResult = z.infer<typeof SelectTopicsResult>;

/** judge_answer:主观题 LLM 判分输出(必须可解释) */
export const JudgeAnswerResult = z.object({
  verdict: z.enum(["correct", "partial", "wrong"]),
  /** 判定依据:对照标准答案/评分要点说明判定理由 */
  basis: z.string().min(1).max(2000),
  /** 给学生的简评(改进方向) */
  comment: z.string().max(2000).default(""),
});
export type JudgeAnswerResult = z.infer<typeof JudgeAnswerResult>;

/** summarize_learner:学科总结更新(版本化,带水位) */
export const LearnerSummaryUpdate = z.object({
  summaryMd: z.string().min(1).max(20000),
  recurringPatterns: z
    .array(
      z.object({
        statement: z.string().min(1).max(500),
        confidence: z.number().min(0).max(1),
        evidenceIds: z.array(z.string()).max(20).default([]),
      }),
    )
    .max(10)
    .default([]),
});
export type LearnerSummaryUpdate = z.infer<typeof LearnerSummaryUpdate>;

/** analyze_mistake 批量:一批最多 10 道,按 index 对应输入顺序 */
export const BatchAnalyzeMistakeResult = z.object({
  results: z
    .array(AnalyzeMistakeResult.extend({ index: z.number().int().min(0) }))
    .min(1)
    .max(10),
});
export type BatchAnalyzeMistakeResult = z.infer<typeof BatchAnalyzeMistakeResult>;

/** generate_questions 一次生成 1~10 道 */
export const GenerateQuestionsResult = z.object({
  questions: z.array(GeneratedQuestion).min(1).max(10),
});
export type GenerateQuestionsResult = z.infer<typeof GenerateQuestionsResult>;

/** AnalysisInput 的 subject 仅作约束提示(共享给服务层与评测) */
export const AnalysisSubject = Subject;
