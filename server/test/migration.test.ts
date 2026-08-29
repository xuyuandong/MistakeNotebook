import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/db/migrator.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

describe("迁移", () => {
  test("首次执行创建全部核心表并写入种子用户", () => {
    const sqlite = freshDb();
    const applied = runMigrations(sqlite, MIGRATIONS_DIR);
    expect(applied).toContain("0001_init.sql");

    const tables = (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of [
      "users",
      "mistakes",
      "mistake_versions",
      "import_batches",
      "ingestion_drafts",
      "concepts",
      "concept_aliases",
      "mistake_concepts",
      "review_schedules",
      "attempts",
      "mastery",
      "practice_sets",
      "generated_questions",
      "model_runs",
      "ai_jobs",
      "learning_events",
      "memory_facts",
      "memory_evidence",
      "learner_summaries",
      "mistakes_fts",
      "_migrations",
    ]) {
      expect(tables).toContain(t);
    }

    const user = sqlite.prepare("SELECT id FROM users").get() as { id: string };
    expect(user.id).toBe("u_local");
  });

  test("重复执行不重复应用,幂等", () => {
    const sqlite = freshDb();
    expect(runMigrations(sqlite, MIGRATIONS_DIR).length).toBeGreaterThan(0);
    expect(runMigrations(sqlite, MIGRATIONS_DIR)).toHaveLength(0);
    expect((sqlite.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c).toBe(1);
  });

  test("learning_events 幂等唯一约束生效", () => {
    const sqlite = freshDb();
    runMigrations(sqlite, MIGRATIONS_DIR);
    const insert = sqlite.prepare(
      `INSERT INTO learning_events (id, user_id, event_type, subject, source_id, occurred_at)
       VALUES (?, 'u_local', 'mistake_recorded', 'math', ?, ?)`,
    );
    insert.run("e1", "m1", new Date().toISOString());
    expect(() => insert.run("e2", "m1", new Date().toISOString())).toThrow(/UNIQUE/);
  });

  test("v0.4:users 表含复习间隔配置列", () => {
    const sqlite = freshDb();
    runMigrations(sqlite, MIGRATIONS_DIR);
    const cols = (
      sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain("review_intervals_json");
  });

  test("v0.4:旧库(0006)升级只补列,不重复应用旧迁移", () => {
    const sqlite = freshDb();
    sqlite.pragma("foreign_keys = OFF");
    // 手工应用 0001~0006 并记录版本,模拟升级前的旧库
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const older = files.filter((f) => f < "0007_review_intervals.sql");
    sqlite.exec(
      "CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const f of older) {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      sqlite
        .prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)")
        .run(f, new Date().toISOString());
    }
    sqlite.pragma("foreign_keys = ON");

    const applied = runMigrations(sqlite, MIGRATIONS_DIR);
    expect(applied).toEqual(["0007_review_intervals.sql"]);
    const cols = (
      sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain("review_intervals_json");
  });

  test("v0.3 约束:attempts 接受 pending_judge,memory_facts 接受 habit_pattern,origin 只认 import/manual/ai", () => {
    const sqlite = freshDb();
    runMigrations(sqlite, MIGRATIONS_DIR);
    sqlite
      .prepare(
        `INSERT INTO mistakes (id, user_id, subject, status, created_at, updated_at)
         VALUES ('m1', 'u_local', 'math', 'pending_analysis', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO attempts (id, user_id, source_type, source_id, result, created_at)
         VALUES ('a1', 'u_local', 'mistake_review', 'm1', 'pending_judge', '2026-08-29T00:00:00Z')`,
      )
      .run();
    const attempt = sqlite.prepare("SELECT result, judged_by FROM attempts WHERE id='a1'").get() as {
      result: string;
      judged_by: string | null;
    };
    expect(attempt.result).toBe("pending_judge");
    expect(attempt.judged_by).toBeNull();

    sqlite
      .prepare(
        `INSERT INTO memory_facts (id, user_id, scope, kind, statement, valid_from, created_at, updated_at)
         VALUES ('f1', 'u_local', 'math', 'habit_pattern', '缺少检查习惯', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z')`,
      )
      .run();

    sqlite
      .prepare(
        `INSERT INTO mistake_versions (id, mistake_id, version, origin, content_json, created_at)
         VALUES ('v1', 'm1', 1, 'import', '{}', '2026-08-29T00:00:00Z')`,
      )
      .run();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO mistake_versions (id, mistake_id, version, origin, content_json, created_at)
           VALUES ('v2', 'm1', 2, 'ocr', '{}', '2026-08-29T00:00:00Z')`,
        )
        .run(),
    ).toThrow();
  });

  test("迁移失败时抛错且已提交的迁移保留、失败的未记录", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    for (const f of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    writeFileSync(join(dir, "9999_bad.sql"), "CREATE TABLE (invalid);");
    const sqlite = freshDb();
    expect(() => runMigrations(sqlite, dir)).toThrow();
    const appliedCount = (
      sqlite.prepare("SELECT COUNT(*) c FROM _migrations").get() as { c: number }
    ).c;
    expect(appliedCount).toBe(readdirSync(MIGRATIONS_DIR).length); // 合法迁移全部已提交
  });
});
