-- 迁移 0005:分析幂等键加入提示词版本;提示词升级后自动重分析
ALTER TABLE mistakes ADD COLUMN analysis_prompt_version TEXT;
