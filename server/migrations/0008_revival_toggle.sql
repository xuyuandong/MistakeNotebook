-- 概念重逢复活开关(PRD 6.3)。默认 0(关闭):复活机制处于观察期,
-- 毕业机制不受影响。已有备份恢复后重启服务会自动补上本列。纯加列,无损。
ALTER TABLE users ADD COLUMN revival_enabled INTEGER NOT NULL DEFAULT 0;
