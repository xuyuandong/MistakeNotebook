-- 迁移 0002:AI 分析结果与生成题关联概念
-- 回滚说明:SQLite 不支持 DROP COLUMN(旧版本);回滚需重建表,见 LLD §10(备份后重建)。

ALTER TABLE mistakes ADD COLUMN error_type TEXT;
ALTER TABLE mistakes ADD COLUMN error_evidence TEXT;
ALTER TABLE mistakes ADD COLUMN improvements_json TEXT;
ALTER TABLE mistakes ADD COLUMN analysis_confidence REAL;
ALTER TABLE mistakes ADD COLUMN analysis_version INTEGER;
ALTER TABLE mistakes ADD COLUMN needs_follow_up INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mistakes ADD COLUMN follow_up_question TEXT;

ALTER TABLE generated_questions ADD COLUMN concept_ids_json TEXT;
