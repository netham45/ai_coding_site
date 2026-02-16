import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { makeId } from "../utils/id.js";
import { dataRoot } from "../utils/paths.js";
import { nowIso } from "../utils/time.js";
import { baselineMigration } from "./migrations.js";
import { openSqliteDatabase } from "./sqlite.js";

const DEFAULT_AI_COMMAND = "codex --yolo {prompt}";
const APP_DB_FILENAME = "app.sqlite";

let appDb: Database.Database | undefined;

export function getAppDbPath(): string {
  return path.join(dataRoot, APP_DB_FILENAME);
}

function ensureColumn(db: Database.Database, table: string, column: string, alterSql: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === column)) {
    db.exec(alterSql);
  }
}

function ensureIndex(db: Database.Database, indexSql: string): void {
  db.exec(indexSql);
}

function applyLegacyMigrations(db: Database.Database): void {
  ensureColumn(db, "task_sessions", "last_output", "ALTER TABLE task_sessions ADD COLUMN last_output TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "projects", "project_rules", "ALTER TABLE projects ADD COLUMN project_rules TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "projects", "coding_standard", "ALTER TABLE projects ADD COLUMN coding_standard TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    db,
    "projects",
    "coding_standard_other",
    "ALTER TABLE projects ADD COLUMN coding_standard_other TEXT NOT NULL DEFAULT ''"
  );
  ensureColumn(db, "projects", "project_other", "ALTER TABLE projects ADD COLUMN project_other TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "tasks", "mode", "ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'execution'");
  ensureColumn(db, "tasks", "auto_merge", "ALTER TABLE tasks ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "result", "ALTER TABLE tasks ADD COLUMN result TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "tasks", "parent_plan_task_id", "ALTER TABLE tasks ADD COLUMN parent_plan_task_id TEXT");
  ensureColumn(db, "tasks", "source_plan_revision_id", "ALTER TABLE tasks ADD COLUMN source_plan_revision_id TEXT");
  ensureColumn(db, "tasks", "source_plan_item_key", "ALTER TABLE tasks ADD COLUMN source_plan_item_key TEXT");
  ensureIndex(db, "CREATE INDEX IF NOT EXISTS idx_tasks_parent_plan_task_id ON tasks(parent_plan_task_id)");
  ensureIndex(db, "CREATE INDEX IF NOT EXISTS idx_tasks_mode ON tasks(mode)");
}

function initializeAppDb(): Database.Database {
  fs.mkdirSync(dataRoot, { recursive: true });
  const db = openSqliteDatabase(getAppDbPath());
  db.exec(baselineMigration);
  applyLegacyMigrations(db);
  return db;
}

export function getAppDb(): Database.Database {
  if (!appDb) {
    appDb = initializeAppDb();
  }
  return appDb;
}

export const db = getAppDb();

export function ensureLocalUser(): string {
  const app = getAppDb();
  const row = app.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  if (row?.id) {
    const settings = app.prepare("SELECT user_id FROM user_settings WHERE user_id = ?").get(row.id) as
      | { user_id: string }
      | undefined;
    if (!settings) {
      const now = nowIso();
      app.prepare(
        `INSERT INTO user_settings (user_id, default_ai_command, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      ).run(row.id, DEFAULT_AI_COMMAND, now, now);
    }
    app.prepare(
      "UPDATE user_settings SET default_ai_command = ?, updated_at = ? WHERE user_id = ? AND default_ai_command IN ('codex --yolo', 'codex --yolo --prompt {prompt}')"
    ).run(
      DEFAULT_AI_COMMAND,
      nowIso(),
      row.id
    );
    return row.id;
  }

  const id = makeId();
  const now = nowIso();
  app.prepare("INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    "local@example.com",
    "Local User",
    now,
    now
  );
  app.prepare(
    `INSERT INTO user_settings (user_id, default_ai_command, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, DEFAULT_AI_COMMAND, now, now);
  return id;
}
