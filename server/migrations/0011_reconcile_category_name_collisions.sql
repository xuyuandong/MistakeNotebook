-- 修复 0009 回填留下的同名冲突:
-- 旧的无冒号概念可能与由“前缀：具体点”生成的分类同名,从而在薄弱点聚合中显示两行。
-- 保留叶子概念及其全部 ID 级关联,仅把它改挂到同用户、同学科、同规范名的 active 分类。

UPDATE concepts
SET category_id = (
      SELECT k.id
      FROM concept_categories k
      WHERE k.user_id = concepts.user_id
        AND k.subject = concepts.subject
        AND k.canonical_name = concepts.canonical_name
        AND k.status = 'active'
    ),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE concepts.status = 'active'
  AND concepts.category_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM concept_categories k
    WHERE k.user_id = concepts.user_id
      AND k.subject = concepts.subject
      AND k.canonical_name = concepts.canonical_name
      AND k.status = 'active'
  );
