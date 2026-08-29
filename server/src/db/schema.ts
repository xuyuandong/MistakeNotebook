/**
 * Drizzle 表定义,与 migrations/0001_init.sql 镜像(CHECK 约束以迁移 SQL 为准)。
 * 详细设计见 LLD.md §2。
 */
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull().default(""),
  currentGrade: text("current_grade"),
  reviewIntervalsJson: text("review_intervals_json"),
  createdAt: text("created_at").notNull(),
});

export const mistakes = sqliteTable(
  "mistakes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    subject: text("subject").notNull(),
    questionType: text("question_type"),
    status: text("status").notNull().default("pending_analysis"),
    currentVersionId: text("current_version_id"),
    source: text("source"),
    gradeAtTime: text("grade_at_time"),
    favorite: integer("favorite").notNull().default(0),
    archived: integer("archived").notNull().default(0),
    searchText: text("search_text").notNull().default(""),
    // AI 分析结果(0002;模型建议值,用户确认值另存于 mistake_concepts.confirmed_at)
    errorType: text("error_type"),
    errorEvidence: text("error_evidence"),
    improvementsJson: text("improvements_json"),
    analysisConfidence: real("analysis_confidence"),
    analysisVersion: integer("analysis_version"),
    analysisPromptVersion: text("analysis_prompt_version"),
    needsFollowUp: integer("needs_follow_up").notNull().default(0),
    followUpQuestion: text("follow_up_question"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_mistakes_user_subject").on(t.userId, t.subject, t.status)],
);

export const mistakeVersions = sqliteTable(
  "mistake_versions",
  {
    id: text("id").primaryKey(),
    mistakeId: text("mistake_id").notNull(),
    version: integer("version").notNull(),
    origin: text("origin").notNull(),
    contentJson: text("content_json").notNull(),
    isConfirmed: integer("is_confirmed").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_mistake_version").on(t.mistakeId, t.version)],
);

export const importBatches = sqliteTable(
  "import_batches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    source: text("source"),
    templateVersion: text("template_version").notNull(),
    rawJson: text("raw_json").notNull(),
    sha256: text("sha256").notNull(),
    questionCount: integer("question_count").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_import_batches_dedup").on(t.userId, t.sha256)],
);

export const ingestionDrafts = sqliteTable(
  "ingestion_drafts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    importBatchId: text("import_batch_id").notNull(),
    status: text("status").notNull().default("ready"),
    resultJson: text("result_json"),
    rawJson: text("raw_json"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_drafts_batch").on(t.importBatchId, t.status)],
);

export const concepts = sqliteTable(
  "concepts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    subject: text("subject").notNull(),
    canonicalName: text("canonical_name").notNull(),
    parentId: text("parent_id"),
    status: text("status").notNull().default("active"),
    discoveredFromMistakeId: text("discovered_from_mistake_id"),
    mergedIntoId: text("merged_into_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_concept_name").on(t.userId, t.subject, t.canonicalName)],
);

export const conceptAliases = sqliteTable(
  "concept_aliases",
  {
    id: text("id").primaryKey(),
    conceptId: text("concept_id").notNull(),
    alias: text("alias").notNull(),
    source: text("source").notNull(),
    confidence: real("confidence").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_concept_alias").on(t.conceptId, t.alias)],
);

export const mistakeConcepts = sqliteTable(
  "mistake_concepts",
  {
    id: text("id").primaryKey(),
    mistakeId: text("mistake_id").notNull(),
    conceptId: text("concept_id").notNull(),
    mistakeVersion: integer("mistake_version").notNull(),
    isPrimary: integer("is_primary").notNull().default(0),
    evidence: text("evidence"),
    confidence: real("confidence"),
    confirmedAt: text("confirmed_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_mistake_concept").on(t.mistakeId, t.mistakeVersion, t.conceptId),
  ],
);

export const reviewSchedules = sqliteTable(
  "review_schedules",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    mistakeId: text("mistake_id").notNull(),
    status: text("status").notNull().default("scheduled"),
    dueDate: text("due_date").notNull(),
    intervalIndex: integer("interval_index").notNull(),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => [index("idx_review_due").on(t.userId, t.status, t.dueDate)],
);

export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    answer: text("answer"),
    result: text("result").notNull().default("pending_judge"),
    judgedBy: text("judged_by"),
    usedHint: integer("used_hint").notNull().default(0),
    durationMs: integer("duration_ms"),
    feedbackJson: text("feedback_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_attempts_user_time").on(t.userId, t.createdAt)],
);

export const mastery = sqliteTable(
  "mastery",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    conceptId: text("concept_id").notNull(),
    score: integer("score").notNull().default(50),
    sampleCount: integer("sample_count").notNull().default(0),
    lastPracticedAt: text("last_practiced_at"),
    freshness: real("freshness").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_mastery").on(t.userId, t.conceptId)],
);

export const practiceSets = sqliteTable("practice_sets", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  subject: text("subject").notNull(),
  origin: text("origin").notNull(),
  mistakeId: text("mistake_id"),
  status: text("status").notNull().default("generating"),
  error: text("error"),
  paramsJson: text("params_json").notNull(),
  selectionJson: text("selection_json"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

export const generatedQuestions = sqliteTable(
  "generated_questions",
  {
    id: text("id").primaryKey(),
    practiceSetId: text("practice_set_id").notNull(),
    userId: text("user_id").notNull(),
    subject: text("subject").notNull(),
    questionJson: text("question_json").notNull(),
    status: text("status").notNull().default("valid"),
    reportReason: text("report_reason"),
    modelRunId: text("model_run_id"),
    conceptIdsJson: text("concept_ids_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_gq_set").on(t.practiceSetId)],
);

export const modelRuns = sqliteTable("model_runs", {
  id: text("id").primaryKey(),
  jobId: text("job_id"),
  taskType: text("task_type").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  status: text("status").notNull(),
  durationMs: integer("duration_ms").notNull(),
  usageJson: text("usage_json"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
});

export const aiJobs = sqliteTable(
  "ai_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    jobType: text("job_type").notNull(),
    status: text("status").notNull().default("queued"),
    idempotencyKey: text("idempotency_key"),
    payloadJson: text("payload_json").notNull(),
    toEventId: text("to_event_id"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [index("idx_jobs_pending").on(t.status, t.createdAt)],
);

export const learningEvents = sqliteTable(
  "learning_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    eventType: text("event_type").notNull(),
    subject: text("subject").notNull(),
    sourceId: text("source_id").notNull(),
    payloadJson: text("payload_json"),
    occurredAt: text("occurred_at").notNull(),
  },
  (t) => [uniqueIndex("uq_learning_event").on(t.userId, t.eventType, t.sourceId)],
);

export const memoryFacts = sqliteTable("memory_facts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  scope: text("scope").notNull(),
  kind: text("kind").notNull(),
  statement: text("statement").notNull(),
  confidence: real("confidence").notNull().default(0.5),
  status: text("status").notNull().default("candidate"),
  validFrom: text("valid_from").notNull(),
  supersededBy: text("superseded_by"),
  modelRunId: text("model_run_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const memoryEvidence = sqliteTable(
  "memory_evidence",
  {
    id: text("id").primaryKey(),
    memoryFactId: text("memory_fact_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    weight: real("weight").notNull().default(1),
  },
  (t) => [uniqueIndex("uq_memory_evidence").on(t.memoryFactId, t.sourceType, t.sourceId)],
);

export const learnerSummaries = sqliteTable(
  "learner_summaries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    scope: text("scope").notNull(),
    summaryJson: text("summary_json").notNull(),
    asOfEventId: text("as_of_event_id").notNull(),
    version: integer("version").notNull().default(1),
    generatedAt: text("generated_at").notNull(),
    modelRunId: text("model_run_id"),
  },
  (t) => [uniqueIndex("uq_learner_summary").on(t.userId, t.scope)],
);

export const DEFAULT_USER_ID = "u_local";
export const nowIso = () => new Date().toISOString();
