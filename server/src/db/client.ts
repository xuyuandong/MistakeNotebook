import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

export type Db = BetterSQLite3Database<Record<string, never>>;

export function createDb(dbPath: string): { sqlite: Database.Database; db: Db } {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite);
  return { sqlite, db };
}
