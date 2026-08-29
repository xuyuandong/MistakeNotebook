-- v0.4:分学科可调复习间隔(PRD 6.3)。用户级 JSON 配置(三科各一档位数组),
-- NULL = 使用共享默认值(数学 1/10/30,语文/英语 1/3/7/14/30)。
-- 纯加列,无损;旧备份恢复后重启服务会自动补上本列。
ALTER TABLE users ADD COLUMN review_intervals_json TEXT;
