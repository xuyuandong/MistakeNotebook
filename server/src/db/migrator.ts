import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

/**
 * 极简串行迁移执行器:
 * - migrations 目录下按文件名排序执行 *.sql;
 * - 已应用的迁移记录在 _migrations,不会重复执行;
 * - 迁移期间关闭 foreign_keys(表重建需要,如 0006),迁移后跑 foreign_key_check,
 *   有悬挂引用即抛错回滚(调用方应停止启动);
 * - 任一迁移失败即抛错,事务回滚,失败迁移不记录。
 */
export function runMigrations(sqlite: Database.Database, migrationsDir: string): string[] {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );

  const applied = new Set(
    (sqlite.prepare("SELECT id FROM _migrations").all() as { id: string }[]).map((r) => r.id),
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const appliedNow: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    sqlite.pragma("foreign_keys = OFF");
    try {
      const tx = sqlite.transaction(() => {
        sqlite.exec(sql);
        const violations = sqlite.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error(`迁移 ${file} 产生悬挂外键引用: ${JSON.stringify(violations.slice(0, 5))}`);
        }
        sqlite
          .prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)")
          .run(file, new Date().toISOString());
      });
      tx();
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }
    appliedNow.push(file);
  }
  return appliedNow;
}
