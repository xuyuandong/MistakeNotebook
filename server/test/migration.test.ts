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
      "concept_categories",
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
    expect(applied).toEqual([
      "0007_review_intervals.sql",
      "0008_revival_toggle.sql",
      "0009_concept_categories.sql",
      "0010_consolidate_model_runs.sql",
      "0011_reconcile_category_name_collisions.sql",
    ]);
    const cols = (
      sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain("review_intervals_json");
    expect(cols).toContain("revival_enabled");
  });

  test("v0.6:concept_categories 表与 category_id 列存在", () => {
    const sqlite = freshDb();
    runMigrations(sqlite, MIGRATIONS_DIR);
    const conceptCols = (
      sqlite.prepare("PRAGMA table_info(concepts)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(conceptCols).toContain("category_id");
    const catCols = (
      sqlite.prepare("PRAGMA table_info(concept_categories)").all() as { name: string }[]
    ).map((c) => c.name);
    for (const col of ["id", "user_id", "subject", "canonical_name", "status", "merged_into_id"]) {
      expect(catCols).toContain(col);
    }
  });

  test("v0.6:model_runs 接受 consolidate_concepts 并继续拒绝未知任务", () => {
    const sqlite = freshDb();
    runMigrations(sqlite, MIGRATIONS_DIR);
    const insert = sqlite.prepare(
      `INSERT INTO model_runs
       (id, task_type, provider, model, prompt_version, status, duration_ms, created_at)
       VALUES (?, ?, 'mock', 'mock', 'consolidate@1', 'ok', 1, '2026-08-30T00:00:00Z')`,
    );
    expect(() => insert.run("run-ok", "consolidate_concepts")).not.toThrow();
    expect(() => insert.run("run-bad", "unknown_task")).toThrow(/CHECK/);
  });

  test("v0.6 回填:冒号前缀概念自动拆出分类,无前缀概念保持未分类", () => {
    const sqlite = freshDb();
    // 模拟旧库:先应用 0001~0008,写入待回填的概念,再升级应用 0009
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const older = files.filter((f) => f < "0009_concept_categories.sql");
    sqlite.exec("CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const f of older) {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      sqlite
        .prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)")
        .run(f, new Date().toISOString());
    }
    const now = "2026-08-30T00:00:00Z";
    const insertConcept = sqlite.prepare(
      `INSERT INTO concepts (id, user_id, subject, canonical_name, status, created_at, updated_at)
       VALUES (?, 'u_local', 'english', ?, 'active', ?, ?)`,
    );
    insertConcept.run("c1", "固定搭配：keep cool", now, now);
    insertConcept.run("c2", "固定搭配：hunt other animals", now, now);
    insertConcept.run("c3", "词汇辨析:forest/woods", now, now); // 半角冒号同样拆分
    insertConcept.run("c4", "去分母", now, now); // 无前缀 → 未分类
    insertConcept.run("c5", "：开头是分隔符", now, now); // 前缀为空 → 不拆

    expect(runMigrations(sqlite, MIGRATIONS_DIR)).toEqual([
      "0009_concept_categories.sql",
      "0010_consolidate_model_runs.sql",
      "0011_reconcile_category_name_collisions.sql",
    ]);

    const cats = sqlite
      .prepare("SELECT id, canonical_name FROM concept_categories ORDER BY canonical_name")
      .all() as { id: string; canonical_name: string }[];
    expect(cats.map((c) => c.canonical_name)).toEqual(["固定搭配", "词汇辨析"]);

    const catOf = (id: string) =>
      (
        sqlite
          .prepare(
            `SELECT k.canonical_name AS name FROM concepts c
             JOIN concept_categories k ON k.id = c.category_id WHERE c.id = ?`,
          )
          .get(id) as { name: string } | undefined
      )?.name;
    expect(catOf("c1")).toBe("固定搭配");
    expect(catOf("c2")).toBe("固定搭配"); // 同分类只有一个条目(去重)
    expect(catOf("c3")).toBe("词汇辨析");
    expect(catOf("c4")).toBeUndefined();
    expect(catOf("c5")).toBeUndefined();
  });

  test("v0.6 修复:同名未分类概念改挂 active 分类且 ID 级错题关联不变", () => {
    const sqlite = freshDb();
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const older = files.filter((f) => f < "0011_reconcile_category_name_collisions.sql");
    sqlite.exec("CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const f of older) {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      sqlite.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)")
        .run(f, "2026-08-30T00:00:00Z");
    }

    const now = "2026-08-30T00:00:00Z";
    sqlite.prepare(
      `INSERT INTO concept_categories
       (id, user_id, subject, canonical_name, status, created_at, updated_at)
       VALUES ('cat-equation', 'u_local', 'math', '解一元一次方程', 'active', ?, ?)`,
    ).run(now, now);
    sqlite.prepare(
      `INSERT INTO concepts
       (id, user_id, subject, canonical_name, status, category_id, created_at, updated_at)
       VALUES
       ('c-generic', 'u_local', 'math', '解一元一次方程', 'active', NULL, ?, ?),
       ('c-specific', 'u_local', 'math', '解一元一次方程：去分母', 'active', 'cat-equation', ?, ?),
       ('c-other-subject', 'u_local', 'english', '解一元一次方程', 'active', NULL, ?, ?)`,
    ).run(now, now, now, now, now, now);
    sqlite.prepare(
      `INSERT INTO mistakes (id, user_id, subject, status, created_at, updated_at)
       VALUES ('m1', 'u_local', 'math', 'analyzed', ?, ?)`,
    ).run(now, now);
    sqlite.prepare(
      `INSERT INTO mistake_concepts
       (id, mistake_id, concept_id, mistake_version, is_primary, created_at)
       VALUES ('mc1', 'm1', 'c-generic', 1, 1, ?)`,
    ).run(now);

    expect(runMigrations(sqlite, MIGRATIONS_DIR))
      .toEqual(["0011_reconcile_category_name_collisions.sql"]);
    expect(
      sqlite.prepare("SELECT category_id FROM concepts WHERE id='c-generic'").get(),
    ).toMatchObject({ category_id: "cat-equation" });
    expect(
      sqlite.prepare("SELECT category_id FROM concepts WHERE id='c-other-subject'").get(),
    ).toMatchObject({ category_id: null });
    expect(
      sqlite.prepare("SELECT concept_id FROM mistake_concepts WHERE id='mc1'").get(),
    ).toMatchObject({ concept_id: "c-generic" });
  });

  test("v0.5:revival_enabled 默认 0(复活开关默认关闭)", () => {
    const sqlite = freshDb();
    runMigrations(sqlite, MIGRATIONS_DIR);
    sqlite
      .prepare(
        `INSERT INTO users (id, display_name, created_at) VALUES ('u_x', '', '2026-01-01T00:00:00Z')`,
      )
      .run();
    const u = sqlite.prepare("SELECT revival_enabled FROM users WHERE id='u_x'").get() as {
      revival_enabled: number;
    };
    expect(u.revival_enabled).toBe(0);
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
