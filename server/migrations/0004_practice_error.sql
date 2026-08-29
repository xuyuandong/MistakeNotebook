-- 迁移 0004:练习集失败原因透出
ALTER TABLE practice_sets ADD COLUMN error TEXT;
