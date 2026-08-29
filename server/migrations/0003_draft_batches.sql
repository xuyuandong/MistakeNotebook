-- 迁移 0003:识别草稿支持整页多题拆分(批次)
-- 回滚说明:SQLite 旧版本不支持 DROP COLUMN;回滚需重建表(备份后)。

ALTER TABLE ingestion_drafts ADD COLUMN batch_id TEXT;
ALTER TABLE ingestion_drafts ADD COLUMN question_index INTEGER;
CREATE INDEX idx_drafts_batch ON ingestion_drafts(batch_id);
