-- 一次性概念整理工具也属于 text_model 调用,需要进入 model_runs 审计。
-- 独立于 0009,确保已提前应用分类迁移的本地库仍能向前升级。
-- SQLite 不能直接修改 CHECK,因此保留数据重建表。

CREATE TABLE model_runs_with_consolidate (
  id             TEXT PRIMARY KEY,
  job_id         TEXT,
  task_type      TEXT NOT NULL CHECK (task_type IN
                   ('analyze_mistake','generate_questions','verify_question','summarize_learner','judge_answer','select_topics','consolidate_concepts')),
  provider       TEXT NOT NULL CHECK (provider IN ('deepseek','glm','kimi','mock')),
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('ok','schema_fail','api_error','timeout')),
  duration_ms    INTEGER NOT NULL,
  usage_json     TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL
);
INSERT INTO model_runs_with_consolidate
SELECT id, job_id, task_type, provider, model, prompt_version, status, duration_ms, usage_json, error, created_at
FROM model_runs;
DROP TABLE model_runs;
ALTER TABLE model_runs_with_consolidate RENAME TO model_runs;
