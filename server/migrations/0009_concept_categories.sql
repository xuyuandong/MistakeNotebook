-- 两级知识标签(用户 2026-08-30 决策):概念分类作为元信息层独立建表。
-- 分类由分析提示词按"已有分类优先复用"维护,薄弱点按分类聚合展示;
-- 合并 = 成员概念整体改挂目标分类,旧分类置 merged + merged_into_id 可追溯,不物理删除。

CREATE TABLE concept_categories (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject        TEXT NOT NULL CHECK (subject IN ('chinese','math','english')),
  canonical_name TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged')),
  merged_into_id TEXT REFERENCES concept_categories(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (user_id, subject, canonical_name)
);

ALTER TABLE concepts ADD COLUMN category_id TEXT REFERENCES concept_categories(id) ON DELETE SET NULL;

-- 确定性回填:名称含全角/半角冒号的 active 概念,拆出首个冒号前的前缀作为分类。
-- 例:"固定搭配：keep cool" → 分类"固定搭配";分类不存在则创建(OR IGNORE + 唯一键去重)。
INSERT OR IGNORE INTO concept_categories (id, user_id, subject, canonical_name, status, created_at, updated_at)
SELECT DISTINCT
  'cat_' || hex(randomblob(16)),
  c.user_id,
  c.subject,
  trim(substr(
    c.canonical_name,
    1,
    CASE
      WHEN instr(c.canonical_name, '：') = 0 THEN instr(c.canonical_name, ':')
      WHEN instr(c.canonical_name, ':') = 0 THEN instr(c.canonical_name, '：')
      ELSE min(instr(c.canonical_name, '：'), instr(c.canonical_name, ':'))
    END - 1
  )),
  'active',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM concepts c
WHERE c.status = 'active'
  AND CASE
    WHEN instr(c.canonical_name, '：') = 0 THEN instr(c.canonical_name, ':')
    WHEN instr(c.canonical_name, ':') = 0 THEN instr(c.canonical_name, '：')
    ELSE min(instr(c.canonical_name, '：'), instr(c.canonical_name, ':'))
  END > 1
  AND trim(substr(
    c.canonical_name,
    1,
    CASE
      WHEN instr(c.canonical_name, '：') = 0 THEN instr(c.canonical_name, ':')
      WHEN instr(c.canonical_name, ':') = 0 THEN instr(c.canonical_name, '：')
      ELSE min(instr(c.canonical_name, '：'), instr(c.canonical_name, ':'))
    END - 1
  )) <> '';

UPDATE concepts
SET category_id = (
  SELECT k.id
  FROM concept_categories k
  WHERE k.user_id = concepts.user_id
    AND k.subject = concepts.subject
    AND k.canonical_name = trim(substr(
      concepts.canonical_name,
      1,
      CASE
        WHEN instr(concepts.canonical_name, '：') = 0 THEN instr(concepts.canonical_name, ':')
        WHEN instr(concepts.canonical_name, ':') = 0 THEN instr(concepts.canonical_name, '：')
        ELSE min(instr(concepts.canonical_name, '：'), instr(concepts.canonical_name, ':'))
      END - 1
    ))
    AND k.status = 'active'
)
WHERE concepts.status = 'active'
  AND concepts.category_id IS NULL
  AND CASE
    WHEN instr(concepts.canonical_name, '：') = 0 THEN instr(concepts.canonical_name, ':')
    WHEN instr(concepts.canonical_name, ':') = 0 THEN instr(concepts.canonical_name, '：')
    ELSE min(instr(concepts.canonical_name, '：'), instr(concepts.canonical_name, ':'))
  END > 1
  AND trim(substr(
    concepts.canonical_name,
    1,
    CASE
      WHEN instr(concepts.canonical_name, '：') = 0 THEN instr(concepts.canonical_name, ':')
      WHEN instr(concepts.canonical_name, ':') = 0 THEN instr(concepts.canonical_name, '：')
      ELSE min(instr(concepts.canonical_name, '：'), instr(concepts.canonical_name, ':'))
    END - 1
  )) <> '';
