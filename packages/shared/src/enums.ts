import { z } from "zod";

export const Subjects = ["chinese", "math", "english"] as const;
export const Subject = z.enum(Subjects);
export type Subject = z.infer<typeof Subject>;

/** 错题状态机:pending_analysis → analyzed(waiting_input 仅极端信息不足时保留) */
export const MistakeStatuses = ["waiting_input", "pending_analysis", "analyzed"] as const;
export const MistakeStatus = z.enum(MistakeStatuses);
export type MistakeStatus = z.infer<typeof MistakeStatus>;

/** 错题来源:豆包导入 / 手动录入 / AI 生成修订 */
export const MistakeOrigins = ["import", "manual", "ai"] as const;
export const MistakeOrigin = z.enum(MistakeOrigins);
export type MistakeOrigin = z.infer<typeof MistakeOrigin>;

/** 错误类型:有限枚举,见 PRD 5.2.2(技术性维度) */
export const ErrorTypes = [
  "knowledge_gap",      // 知识缺失
  "comprehension",      // 审题理解偏差
  "method_choice",      // 方法选择
  "reasoning_calc",     // 计算基本功/推理
  "expression",         // 表达规范
  "carelessness",       // 粗心/检查
  "time_state",         // 时间与状态
  "unconfirmed",        // 未确认
] as const;
export const ErrorType = z.enum(ErrorTypes);
export type ErrorType = z.infer<typeof ErrorType>;

/** 作答结果:pending_judge = 主观题等待 LLM 判分 */
export const AttemptResults = ["pending_judge", "correct", "partial", "wrong", "gave_up"] as const;
export const AttemptResult = z.enum(AttemptResults);
export type AttemptResult = z.infer<typeof AttemptResult>;

/** 判定来源:本地比对 / LLM 判分 / 用户申诉改判 */
export const JudgedBy = ["local", "llm", "user_appeal"] as const;
export const JudgedByEnum = z.enum(JudgedBy);
export type JudgedBy = z.infer<typeof JudgedByEnum>;

export const Providers = ["deepseek", "glm", "kimi", "mock"] as const;
export const Provider = z.enum(Providers);
export type Provider = z.infer<typeof Provider>;

/** text_model 上的任务(识题在豆包侧,系统内无 extract) */
export const TaskTypes = [
  "analyze_mistake",
  "generate_questions",
  "verify_question",
  "summarize_learner",
  "judge_answer",
  "select_topics",
] as const;
export const TaskType = z.enum(TaskTypes);
export type TaskType = z.infer<typeof TaskType>;

export const JobTypes = ["refresh_learner_analysis", "generate_questions", "judge_answer"] as const;
export const JobType = z.enum(JobTypes);
export type JobType = z.infer<typeof JobType>;

export const JobStatuses = ["queued", "running", "succeeded", "failed", "partial"] as const;
export const JobStatus = z.enum(JobStatuses);
export type JobStatus = z.infer<typeof JobStatus>;

/** 长期记忆事实类型;habit_pattern = 学习方法/习惯画像(PRD 5.2.2) */
export const MemoryFactKinds = [
  "error_pattern",
  "misconception",
  "strategy",
  "habit_pattern",
  "summary_note",
] as const;
export const MemoryFactKind = z.enum(MemoryFactKinds);
export type MemoryFactKind = z.infer<typeof MemoryFactKind>;

export const MemoryFactStatuses = ["candidate", "active", "superseded", "rejected"] as const;
export const MemoryFactStatus = z.enum(MemoryFactStatuses);
export type MemoryFactStatus = z.infer<typeof MemoryFactStatus>;

/** 智能出题来源:smart=画像智能选题 / mistake=单题变式 / custom=自定义 */
export const PracticeOrigins = ["smart", "mistake", "custom"] as const;
export const PracticeOrigin = z.enum(PracticeOrigins);
export type PracticeOrigin = z.infer<typeof PracticeOrigin>;

/** 出题模式:past=出历史错题(默认) / new=AI 编新题 */
export const PracticeModes = ["past", "new"] as const;
export const PracticeMode = z.enum(PracticeModes);
export type PracticeMode = z.infer<typeof PracticeMode>;

export const ErrorCodes = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "RATE_LIMITED",
  "AI_JOB_RUNNING",
  "INTERNAL",
] as const;
export const ErrorCode = z.enum(ErrorCodes);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * 记忆型内容的经典复习阶梯(天),作为语文/英语默认值与兜底配置。
 * 答对进入下一档;答错/部分正确/放弃原地不动,不倒退(PRD 6.3,避免挫败感)。
 */
export const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14, 30] as const;

/**
 * 分学科默认复习间隔(设置页可改,存 users.review_intervals_json):
 * 数学重思考轻记忆,重做同一题的价值衰减快,默认更疏(1→10→30);
 * 语文/英语的字词、语法、词汇偏记忆,用经典较密阶梯。
 */
export const DEFAULT_REVIEW_INTERVALS: Record<Subject, number[]> = {
  chinese: [1, 3, 7, 14, 30],
  english: [1, 3, 7, 14, 30],
  math: [1, 10, 30],
};
