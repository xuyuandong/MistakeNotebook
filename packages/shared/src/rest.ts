import { z } from "zod";
import {
  AttemptResult,
  ErrorType,
  JobStatus,
  MemoryFactStatus,
  PracticeMode,
  PracticeOrigin,
  Subject,
} from "./enums.js";
import { GeneratedQuestion } from "./ai.js";
import { DoubaoQuestionTypes } from "./doubao.js";

export const ApiErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelope>;

export const HealthResponse = z.object({
  status: z.literal("ok"),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** 错题正文内容(mistake_versions.content_json 的 Schema) */
export const MistakeContent = z.object({
  stemMd: z.string().min(1).max(20000),
  options: z.array(z.string().max(2000)).max(26).optional(),
  myAnswer: z.string().max(10000).optional(),
  correctAnswer: z.string().max(10000).optional(),
  explanationMd: z.string().max(20000).optional(),
  note: z.string().max(5000).optional(),
  /** AI 建议且未经用户确认的字段名列表;用户确认后移除 */
  aiPendingFields: z.array(z.string()).default([]),
});
export type MistakeContent = z.infer<typeof MistakeContent>;

export const MistakeCreate = z
  .object({
    subject: Subject,
    draftId: z.string().uuid().optional(),
    manual: z.object({ stemMd: z.string().min(1) }).optional(),
    /** 题型(豆包 type 归一后:选择/填空/解答/阅读/其他);用于客观题本地判定 */
    questionType: z.string().max(50).optional(),
    content: MistakeContent,
    source: z.string().max(500).optional(),
  })
  .refine((v) => v.draftId || v.manual, {
    message: "需要 draftId(导入草稿)或 manual(手动录入)之一",
  });
export type MistakeCreate = z.infer<typeof MistakeCreate>;

export const MistakePatch = z.object({
  errorType: ErrorType.optional(),
  content: MistakeContent.partial().optional(),
  subject: Subject.optional(),
  questionType: z.string().max(50).optional(),
  source: z.string().max(500).optional(),
  favorite: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type MistakePatch = z.infer<typeof MistakePatch>;

export const MistakeListItem = z.object({
  id: z.string().uuid(),
  subject: Subject,
  status: z.string(),
  questionType: z.string().nullable(),
  excerpt: z.string(),
  favorite: z.boolean(),
  createdAt: z.string(),
});
export type MistakeListItem = z.infer<typeof MistakeListItem>;

// ---- 豆包导入 ----
export const ImportRequest = z.object({
  /** 豆包输出的 JSON 数组全文 */
  text: z.string().min(1).max(1024 * 1024),
});
export type ImportRequest = z.infer<typeof ImportRequest>;

export const ImportDraftItem = z.object({
  id: z.string(),
  index: z.number().int(),
  type: z.enum(DoubaoQuestionTypes),
  question: z.string(),
});
export type ImportDraftItem = z.infer<typeof ImportDraftItem>;

export const ImportResponse = z.object({
  importId: z.string(),
  questionCount: z.number().int(),
  duplicate: z.boolean(),
  drafts: z.array(ImportDraftItem),
});
export type ImportResponse = z.infer<typeof ImportResponse>;

export const ImportBatchItem = z.object({
  id: z.string(),
  source: z.string().nullable(),
  templateVersion: z.string(),
  questionCount: z.number().int(),
  createdAt: z.string(),
});
export type ImportBatchItem = z.infer<typeof ImportBatchItem>;

export const ImportBatchDetail = ImportBatchItem.extend({
  rawJson: z.string(),
  drafts: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["ready", "confirmed", "discarded"]),
      index: z.number().int().nullable(),
      result: z.unknown().nullable(),
      rawJson: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
});
export type ImportBatchDetail = z.infer<typeof ImportBatchDetail>;

export const DraftListItem = z.object({
  id: z.string(),
  status: z.string(),
  batchId: z.string().nullable(),
  index: z.number().int().nullable(),
  hasResult: z.boolean(),
  createdAt: z.string(),
});
export type DraftListItem = z.infer<typeof DraftListItem>;

export const DraftDetail = z.object({
  id: z.string(),
  status: z.string(),
  batchId: z.string().nullable(),
  index: z.number().int().nullable(),
  result: z.unknown().nullable(),
  rawJson: z.string().nullable(),
  error: z.string().nullable(),
});
export type DraftDetail = z.infer<typeof DraftDetail>;

// ---- 作答 ----
export const AttemptCreate = z.object({
  sourceType: z.enum(["mistake_review", "generated_question"]),
  sourceId: z.string().uuid(),
  answer: z.string().max(10000).optional(),
  /** 学生自认“不知道”→ 直接 gave_up,不走判分 */
  gaveUp: z.boolean().default(false),
  usedHint: z.boolean().default(false),
  durationMs: z.number().int().nonnegative().optional(),
});
export type AttemptCreate = z.infer<typeof AttemptCreate>;

export const AttemptResponse = z.object({
  attemptId: z.string(),
  /** local=已同步判定;llm=主观题判分任务已创建,请轮询 GET /attempts/{id} */
  judging: z.enum(["local", "llm"]),
  result: AttemptResult.optional(),
  masteryDelta: z.number().int().nullable().optional(),
  nextReviewDate: z.string().nullable().optional(),
  /** 本次作答使错题毕业(连续答对达阈值),不再安排复习 */
  graduated: z.boolean().optional(),
});
export type AttemptResponse = z.infer<typeof AttemptResponse>;

export const AttemptDetailResponse = z.object({
  attemptId: z.string(),
  result: AttemptResult,
  feedback: z
    .object({
      basis: z.string(),
      comment: z.string(),
    })
    .nullable()
    .optional(),
  /** 该作答对应的错题已毕业(无未完成排期且连续答对达阈值) */
  graduated: z.boolean().optional(),
});
export type AttemptDetailResponse = z.infer<typeof AttemptDetailResponse>;

/** 申诉/自判改判;改判记录 judged_by='user_appeal',事件不重复计数 */
export const AttemptAppeal = z.object({
  result: z.enum(["correct", "partial", "wrong"]),
});
export type AttemptAppeal = z.infer<typeof AttemptAppeal>;

// ---- 智能练习 ----
export const PracticeSetCreate = z
  .object({
    subject: Subject,
    /** past=出历史错题(默认) / new=AI 编新题 */
    mode: PracticeMode.default("past"),
    origin: PracticeOrigin.default("smart"),
    mistakeId: z.string().uuid().optional(),
    difficulty: z.number().int().min(1).max(5).optional(),
    questionType: z.string().max(50).optional(),
    count: z.number().int().min(1).max(10).default(5),
  })
  .refine((v) => v.origin !== "mistake" || !!v.mistakeId, {
    message: "基于错题出题必须提供 mistakeId",
  });
export type PracticeSetCreate = z.infer<typeof PracticeSetCreate>;

export const PracticeSelection = z.object({
  targetConcepts: z.array(z.string()).max(5),
  rationale: z.string(),
  /** past 模式选中的历史错题 ID */
  mistakeIds: z.array(z.string()).optional(),
});
export type PracticeSelection = z.infer<typeof PracticeSelection>;

export const PracticeSetQuestion = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("generated"),
    id: z.string(),
    status: z.enum(["valid", "discarded", "reported"]),
    question: GeneratedQuestion,
  }),
  z.object({
    kind: z.literal("mistake"),
    id: z.string(),
    mistakeId: z.string(),
    stemMd: z.string(),
    questionType: z.string().nullable(),
    correctAnswer: z.string().nullable(),
    explanation: z.string().nullable(),
    myAnswer: z.string().nullable(),
  }),
]);
export type PracticeSetQuestion = z.infer<typeof PracticeSetQuestion>;

export const PracticeSetDTO = z.object({
  id: z.string(),
  subject: Subject,
  origin: PracticeOrigin,
  mode: PracticeMode,
  status: z.enum(["generating", "ready", "failed", "partial"]),
  error: z.string().nullable().optional(),
  selection: PracticeSelection.nullable().optional(),
  questions: z.array(PracticeSetQuestion),
});
export type PracticeSetDTO = z.infer<typeof PracticeSetDTO>;

export const QuestionReport = z.object({
  reason: z.enum(["wrong_answer", "unclear", "out_of_scope", "other"]),
  detail: z.string().max(2000).optional(),
});
export type QuestionReport = z.infer<typeof QuestionReport>;

// ---- 学习分析(纯查询) ----
export const WeaknessItem = z.object({
  conceptId: z.string(),
  name: z.string(),
  subject: Subject,
  score: z.number().int(),
  sampleCount: z.number().int(),
  lastPracticedAt: z.string().nullable(),
  insufficient: z.boolean(),
});
export const ErrorTypeStats = z.object({
  errorType: ErrorType,
  count: z.number().int(),
});

// ---- 概念管理 ----
export const ConceptDTO = z.object({
  id: z.string(),
  subject: Subject,
  canonicalName: z.string(),
  status: z.enum(["active", "merged", "ignored"]),
  mergedIntoId: z.string().nullable().optional(),
  masteryScore: z.number().int().nullable().optional(),
  sampleCount: z.number().int().nullable().optional(),
});
export type ConceptDTO = z.infer<typeof ConceptDTO>;

export const ConceptPatch = z.object({
  canonicalName: z.string().min(1).max(100).optional(),
  mergedIntoId: z.string().uuid().optional(),
  status: z.enum(["active", "merged", "ignored"]).optional(),
});
export type ConceptPatch = z.infer<typeof ConceptPatch>;
export const HabitInsight = z.object({
  statement: z.string(),
  confidence: z.number(),
  status: MemoryFactStatus,
});
export const AnalyticsResponse = z.object({
  weaknesses: z.array(WeaknessItem).max(10),
  errorTypes: z.array(ErrorTypeStats),
  /** 学习方法画像(PRD 5.4 视图 4,画像推断) */
  habits: z.array(HabitInsight).max(10),
  reviewStats: z.object({
    planned: z.number().int(),
    completed: z.number().int(),
    correctRate: z.number().nullable(),
    overdue: z.number().int(),
  }),
});
export type AnalyticsResponse = z.infer<typeof AnalyticsResponse>;

// ---- 学习者档案(纯查询,不触发模型) ----
export const LearnerProfileResponse = z.object({
  summaries: z.array(
    z.object({
      scope: Subject,
      summaryMd: z.string(),
      asOfEventId: z.string(),
      version: z.number().int(),
      generatedAt: z.string(),
    }),
  ),
  pendingCount: z.number().int(),
  lastJob: z
    .object({
      id: z.string(),
      status: JobStatus,
      createdAt: z.string(),
      finishedAt: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
  facts: z.array(
    z.object({
      id: z.string(),
      scope: z.string(),
      kind: z.string(),
      statement: z.string(),
      confidence: z.number(),
      status: MemoryFactStatus,
    }),
  ),
});
export type LearnerProfileResponse = z.infer<typeof LearnerProfileResponse>;

// ---- 设置 ----
/** 单科复习间隔(天):1~6 档,每档 1~365 天,严格递增 */
export const ReviewIntervalList = z
  .array(z.number().int().min(1).max(365))
  .min(1)
  .max(6)
  .refine((arr) => arr.every((v, i) => i === 0 || v > arr[i - 1]), {
    message: "间隔天数必须为严格递增的正整数",
  });

export const ReviewIntervalsConfig = z.object({
  chinese: ReviewIntervalList,
  english: ReviewIntervalList,
  math: ReviewIntervalList,
});
export type ReviewIntervalsConfig = z.infer<typeof ReviewIntervalsConfig>;

export const MeResponse = z.object({
  userId: z.string(),
  displayName: z.string(),
  currentGrade: z.string().nullable(),
  reviewIntervals: ReviewIntervalsConfig.nullable(),
  /** 概念重逢复活开关(默认关闭):开启后新错题关联概念时,该概念下已毕业旧题重新排期 */
  revivalEnabled: z.boolean(),
});
export const MePatch = z.object({
  currentGrade: z.string().max(20).nullable().optional(),
  displayName: z.string().max(50).optional(),
  reviewIntervals: ReviewIntervalsConfig.optional(),
  revivalEnabled: z.boolean().optional(),
});

// ---- 复习 ----
export const TodayReviewItem = z.object({
  mistakeId: z.string(),
  dueDate: z.string(),
  overdue: z.boolean(),
});
export type TodayReviewItem = z.infer<typeof TodayReviewItem>;
