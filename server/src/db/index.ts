import Database from "better-sqlite3";
import fs from "node:fs";
import { baselineMigration } from "./migrations.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";
import { dataRoot } from "../utils/paths.js";

const DEFAULT_AI_COMMAND = "codex --yolo {prompt}";

fs.mkdirSync(dataRoot, { recursive: true });

const dbPath = `${dataRoot}/app.sqlite`;
export const db = new Database(dbPath);

db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec(baselineMigration);

function ensureColumn(table: string, column: string, alterSql: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === column)) {
    db.exec(alterSql);
  }
}

function ensureIndex(indexSql: string): void {
  db.exec(indexSql);
}

ensureColumn("task_sessions", "last_output", "ALTER TABLE task_sessions ADD COLUMN last_output TEXT NOT NULL DEFAULT ''");
ensureColumn("projects", "project_rules", "ALTER TABLE projects ADD COLUMN project_rules TEXT NOT NULL DEFAULT ''");
ensureColumn("projects", "coding_standard", "ALTER TABLE projects ADD COLUMN coding_standard TEXT NOT NULL DEFAULT ''");
ensureColumn(
  "projects",
  "coding_standard_other",
  "ALTER TABLE projects ADD COLUMN coding_standard_other TEXT NOT NULL DEFAULT ''"
);
ensureColumn("projects", "project_other", "ALTER TABLE projects ADD COLUMN project_other TEXT NOT NULL DEFAULT ''");
ensureColumn("tasks", "mode", "ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'execution'");
ensureColumn("tasks", "auto_merge", "ALTER TABLE tasks ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0");
ensureColumn("tasks", "result", "ALTER TABLE tasks ADD COLUMN result TEXT NOT NULL DEFAULT ''");
ensureColumn("tasks", "parent_plan_task_id", "ALTER TABLE tasks ADD COLUMN parent_plan_task_id TEXT");
ensureColumn("tasks", "source_plan_revision_id", "ALTER TABLE tasks ADD COLUMN source_plan_revision_id TEXT");
ensureColumn("tasks", "source_plan_item_key", "ALTER TABLE tasks ADD COLUMN source_plan_item_key TEXT");

ensureIndex("CREATE INDEX IF NOT EXISTS idx_tasks_parent_plan_task_id ON tasks(parent_plan_task_id)");
ensureIndex("CREATE INDEX IF NOT EXISTS idx_tasks_mode ON tasks(mode)");

export function ensureLocalUser(): string {
  const row = db.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  if (row?.id) {
    const settings = db.prepare("SELECT user_id FROM user_settings WHERE user_id = ?").get(row.id) as { user_id: string } | undefined;
    if (!settings) {
      const now = nowIso();
      db.prepare(
        `INSERT INTO user_settings (user_id, default_ai_command, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      ).run(row.id, DEFAULT_AI_COMMAND, now, now);
    }
    db.prepare(
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
  db.prepare("INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    "local@example.com",
    "Local User",
    now,
    now
  );
  db.prepare(
    `INSERT INTO user_settings (user_id, default_ai_command, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, DEFAULT_AI_COMMAND, now, now);
  return id;
}
