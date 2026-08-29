-- 迁移 0006:豆包导入 + 免登录 + 主观题判分(设计 v0.3,LLD §12)
-- 说明:migrator 在执行本迁移期间关闭 foreign_keys,结束后跑 foreign_key_check,失败即停止启动。
-- 回滚说明:从 0006 之前的备份恢复 data/app.db;或删除 data/app.db 重建(单机开发数据)。
-- 本迁移丢弃:旧流程的识别草稿(ingestion_drafts 旧行)、attachments 附件表、
-- task_type='extract_question' 的 model_runs 与 job_type='extract_question' 的 ai_jobs(旧视觉识题流程)。

-- 1. 附件表移除:系统不再接收图片/PDF,只有 JSON 文本存档
DROP TABLE IF EXISTS attachment_links;
DROP TABLE IF EXISTS attachments;

-- 2. mistake_versions.origin 枚举:ocr → import(豆包导入);重建表以更新 CHECK
CREATE TABLE mistake_versions_new (
  id           TEXT PRIMARY KEY,
  mistake_id   TEXT NOT NULL REFERENCES mistakes(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('import','manual','ai')),
  content_json TEXT NOT NULL,
  is_confirmed INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  UNIQUE (mistake_id, version)
);
INSERT INTO mistake_versions_new (id, mistake_id, version, origin, content_json, is_confirmed, created_at)
SELECT id, mistake_id, version,
       CASE origin WHEN 'ocr' THEN 'import' ELSE origin END,
       content_json, is_confirmed, created_at
FROM mistake_versions;
DROP TABLE mistake_versions;
ALTER TABLE mistake_versions_new RENAME TO mistake_versions;

-- 3. ingestion_drafts 重建:导入批次草稿(旧识别草稿属已移除流程,不迁移)
DROP TABLE ingestion_drafts;
CREATE TABLE ingestion_drafts (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  import_batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'ready'
                    CHECK (status IN ('ready','confirmed','discarded')),
  result_json     TEXT,
  raw_json        TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_drafts_batch ON ingestion_drafts(import_batch_id, status);

-- 4. 导入批次(豆包 JSON 原文存档;sha256 供重复导入提醒)
CREATE TABLE import_batches (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source           TEXT,
  template_version TEXT NOT NULL,
  raw_json         TEXT NOT NULL,
  sha256           TEXT NOT NULL,
  question_count   INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_import_batches_dedup ON import_batches(user_id, sha256);

-- 5. attempts 重建:result 增加 pending_judge/partial,新增 judged_by
CREATE TABLE attempts_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL CHECK (source_type IN ('mistake_review','generated_question')),
  source_id     TEXT NOT NULL,
  answer        TEXT,
  result        TEXT NOT NULL DEFAULT 'pending_judge'
                  CHECK (result IN ('pending_judge','correct','partial','wrong','gave_up')),
  judged_by     TEXT CHECK (judged_by IN ('local','llm','user_appeal')),
  used_hint     INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  feedback_json TEXT,
  created_at    TEXT NOT NULL
);
INSERT INTO attempts_new (id, user_id, source_type, source_id, answer, result, used_hint, duration_ms, feedback_json, created_at)
SELECT id, user_id, source_type, source_id, answer, result, used_hint, duration_ms, feedback_json, created_at
FROM attempts;
DROP TABLE attempts;
ALTER TABLE attempts_new RENAME TO attempts;
CREATE INDEX idx_attempts_user_time ON attempts(user_id, created_at);

-- 6. practice_sets 重建:origin weakness→smart;新增 selection_json(选题分析)
CREATE TABLE practice_sets_new (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject        TEXT NOT NULL CHECK (subject IN ('chinese','math','english')),
  origin         TEXT NOT NULL CHECK (origin IN ('smart','mistake','custom')),
  mistake_id     TEXT REFERENCES mistakes(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'generating'
                   CHECK (status IN ('generating','ready','failed','partial')),
  error          TEXT,
  params_json    TEXT NOT NULL,
  selection_json TEXT,
  created_at     TEXT NOT NULL,
  completed_at   TEXT
);
INSERT INTO practice_sets_new (id, user_id, subject, origin, mistake_id, status, error, params_json, created_at, completed_at)
SELECT id, user_id, subject,
       CASE origin WHEN 'weakness' THEN 'smart' ELSE origin END,
       mistake_id, status, error, params_json, created_at, completed_at
FROM practice_sets;
DROP TABLE practice_sets;
ALTER TABLE practice_sets_new RENAME TO practice_sets;

-- 7. model_runs 重建:task_type 移除 extract_question,新增 judge_answer/select_topics
DELETE FROM model_runs WHERE task_type = 'extract_question';
CREATE TABLE model_runs_new (
  id             TEXT PRIMARY KEY,
  job_id         TEXT,
  task_type      TEXT NOT NULL CHECK (task_type IN
                   ('analyze_mistake','generate_questions','verify_question','summarize_learner','judge_answer','select_topics')),
  provider       TEXT NOT NULL CHECK (provider IN ('deepseek','glm','kimi','mock')),
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('ok','schema_fail','api_error','timeout')),
  duration_ms    INTEGER NOT NULL,
  usage_json     TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL
);
INSERT INTO model_runs_new SELECT id, job_id, task_type, provider, model, prompt_version, status, duration_ms, usage_json, error, created_at FROM model_runs;
DROP TABLE model_runs;
ALTER TABLE model_runs_new RENAME TO model_runs;

-- 8. ai_jobs 重建:job_type 移除 extract_question,新增 judge_answer
DELETE FROM ai_jobs WHERE job_type = 'extract_question';
CREATE TABLE ai_jobs_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_type        TEXT NOT NULL CHECK (job_type IN
                    ('refresh_learner_analysis','generate_questions','judge_answer')),
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','succeeded','failed','partial')),
  idempotency_key TEXT UNIQUE,
  payload_json    TEXT NOT NULL,
  to_event_id     TEXT,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT
);
INSERT INTO ai_jobs_new SELECT id, user_id, job_type, status, idempotency_key, payload_json, to_event_id, error, attempts, created_at, started_at, finished_at FROM ai_jobs;
DROP TABLE ai_jobs;
ALTER TABLE ai_jobs_new RENAME TO ai_jobs;
CREATE INDEX idx_jobs_pending ON ai_jobs(status, created_at);

-- 9. memory_facts 重建:kind 增加 habit_pattern(学习方法/习惯画像)
CREATE TABLE memory_facts_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('error_pattern','misconception','strategy','habit_pattern','summary_note')),
  statement     TEXT NOT NULL,
  confidence    REAL NOT NULL DEFAULT 0.5,
  status        TEXT NOT NULL DEFAULT 'candidate'
                  CHECK (status IN ('candidate','active','superseded','rejected')),
  valid_from    TEXT NOT NULL,
  superseded_by TEXT REFERENCES memory_facts(id) ON DELETE SET NULL,
  model_run_id  TEXT REFERENCES model_runs(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
INSERT INTO memory_facts_new SELECT id, user_id, scope, kind, statement, confidence, status, valid_from, superseded_by, model_run_id, created_at, updated_at FROM memory_facts;
DROP TABLE memory_facts;
ALTER TABLE memory_facts_new RENAME TO memory_facts;
