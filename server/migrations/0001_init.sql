-- 迁移 0001:核心表(对应 LLD.md §2)
-- 回滚说明:删除 data/app.db 重建即可(首个迁移,无存量数据)。

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL DEFAULT '',
  current_grade TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE mistakes (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject            TEXT NOT NULL CHECK (subject IN ('chinese','math','english')),
  question_type      TEXT,
  status             TEXT NOT NULL DEFAULT 'pending_analysis'
                       CHECK (status IN ('waiting_input','pending_analysis','analyzed')),
  current_version_id TEXT,
  source             TEXT,
  grade_at_time      TEXT,
  favorite           INTEGER NOT NULL DEFAULT 0,
  archived           INTEGER NOT NULL DEFAULT 0,
  search_text        TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_mistakes_user_subject ON mistakes(user_id, subject, status);

CREATE TABLE mistake_versions (
  id           TEXT PRIMARY KEY,
  mistake_id   TEXT NOT NULL REFERENCES mistakes(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('ocr','user','ai')),
  content_json TEXT NOT NULL,
  is_confirmed INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  UNIQUE (mistake_id, version)
);

CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('image','pdf')),
  original_name TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  page_count    INTEGER,
  created_at    TEXT NOT NULL,
  UNIQUE (user_id, sha256)
);

CREATE TABLE attachment_links (
  id            TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  owner_type    TEXT NOT NULL CHECK (owner_type IN ('mistake','ingestion_draft')),
  owner_id      TEXT NOT NULL,
  page_number   INTEGER,
  crop_json     TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_attachment_links_owner ON attachment_links(owner_type, owner_id);

CREATE TABLE ingestion_drafts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'extracting'
                  CHECK (status IN ('extracting','ready','failed','confirmed','discarded')),
  result_json   TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE concepts (
  id                         TEXT PRIMARY KEY,
  user_id                    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject                    TEXT NOT NULL CHECK (subject IN ('chinese','math','english')),
  canonical_name             TEXT NOT NULL,
  parent_id                  TEXT REFERENCES concepts(id) ON DELETE SET NULL,
  status                     TEXT NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','merged','ignored')),
  discovered_from_mistake_id TEXT,
  merged_into_id             TEXT REFERENCES concepts(id) ON DELETE SET NULL,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  UNIQUE (user_id, subject, canonical_name)
);

CREATE TABLE concept_aliases (
  id         TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  alias      TEXT NOT NULL,
  source     TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (concept_id, alias)
);

CREATE TABLE mistake_concepts (
  id               TEXT PRIMARY KEY,
  mistake_id       TEXT NOT NULL REFERENCES mistakes(id) ON DELETE CASCADE,
  concept_id       TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  mistake_version  INTEGER NOT NULL,
  is_primary       INTEGER NOT NULL DEFAULT 0,
  evidence         TEXT,
  confidence       REAL,
  confirmed_at     TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (mistake_id, mistake_version, concept_id)
);

CREATE TABLE review_schedules (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mistake_id     TEXT NOT NULL REFERENCES mistakes(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled','done','skipped','canceled')),
  due_date       TEXT NOT NULL,
  interval_index INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  completed_at   TEXT
);
CREATE INDEX idx_review_due ON review_schedules(user_id, status, due_date);

CREATE TABLE attempts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL CHECK (source_type IN ('mistake_review','generated_question')),
  source_id     TEXT NOT NULL,
  answer        TEXT,
  result        TEXT NOT NULL CHECK (result IN ('correct','wrong','gave_up')),
  used_hint     INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  feedback_json TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_attempts_user_time ON attempts(user_id, created_at);

CREATE TABLE mastery (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept_id        TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  score             INTEGER NOT NULL DEFAULT 50 CHECK (score BETWEEN 0 AND 100),
  sample_count      INTEGER NOT NULL DEFAULT 0,
  last_practiced_at TEXT,
  freshness         REAL NOT NULL DEFAULT 1,
  updated_at        TEXT NOT NULL,
  UNIQUE (user_id, concept_id)
);

CREATE TABLE practice_sets (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject      TEXT NOT NULL CHECK (subject IN ('chinese','math','english')),
  origin       TEXT NOT NULL CHECK (origin IN ('weakness','mistake','custom')),
  mistake_id   TEXT REFERENCES mistakes(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'generating'
                 CHECK (status IN ('generating','ready','failed','partial')),
  params_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE generated_questions (
  id              TEXT PRIMARY KEY,
  practice_set_id TEXT NOT NULL REFERENCES practice_sets(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject         TEXT NOT NULL,
  question_json   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'valid'
                    CHECK (status IN ('valid','discarded','reported')),
  report_reason   TEXT,
  model_run_id    TEXT REFERENCES model_runs(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_gq_set ON generated_questions(practice_set_id);

CREATE TABLE model_runs (
  id             TEXT PRIMARY KEY,
  job_id         TEXT,
  task_type      TEXT NOT NULL CHECK (task_type IN
                   ('extract_question','analyze_mistake','generate_questions','verify_question','summarize_learner')),
  provider       TEXT NOT NULL CHECK (provider IN ('deepseek','glm','kimi','mock')),
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('ok','schema_fail','api_error','timeout')),
  duration_ms    INTEGER NOT NULL,
  usage_json     TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE ai_jobs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_type        TEXT NOT NULL CHECK (job_type IN
                    ('refresh_learner_analysis','generate_questions','extract_question')),
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
CREATE INDEX idx_jobs_pending ON ai_jobs(status, created_at);

CREATE TABLE learning_events (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL CHECK (event_type IN
                 ('mistake_recorded','mistake_updated','review_attempted','practice_attempted','hint_used')),
  subject      TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  payload_json TEXT,
  occurred_at  TEXT NOT NULL,
  UNIQUE (user_id, event_type, source_id)
);

CREATE TABLE memory_facts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('error_pattern','misconception','strategy','summary_note')),
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

CREATE TABLE memory_evidence (
  id             TEXT PRIMARY KEY,
  memory_fact_id TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
  source_type    TEXT NOT NULL CHECK (source_type IN ('mistake','attempt','learning_event')),
  source_id      TEXT NOT NULL,
  weight         REAL NOT NULL DEFAULT 1,
  UNIQUE (memory_fact_id, source_type, source_id)
);

CREATE TABLE learner_summaries (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL,
  summary_json   TEXT NOT NULL,
  as_of_event_id TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  generated_at   TEXT NOT NULL,
  model_run_id   TEXT REFERENCES model_runs(id) ON DELETE SET NULL,
  UNIQUE (user_id, scope)
);

CREATE VIRTUAL TABLE mistakes_fts USING fts5(
  mistake_id UNINDEXED,
  subject UNINDEXED,
  question_text,
  source,
  note
);

-- 单用户模式种子记录(升级多用户时保留该账号迁移)
INSERT INTO users (id, display_name, created_at)
VALUES ('u_local', '本地用户', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT (id) DO NOTHING;
