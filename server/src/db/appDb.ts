import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { makeId } from "../utils/id.js";
import { dataRoot } from "../utils/paths.js";
import { nowIso } from "../utils/time.js";
import { appBaselineMigration } from "./migrations.js";
import { runProjectDataMigrationBackfill } from "./projectDataMigration.js";
import { openSqliteDatabase } from "./sqlite.js";

const DEFAULT_AI_COMMAND = "codex --yolo {prompt}";
const DEFAULT_AI_COMMANDS_JSON = JSON.stringify([DEFAULT_AI_COMMAND]);
const APP_DB_FILENAME = "app.sqlite";

let appDb: Database.Database | undefined;
let cachedLocalUserId: string | undefined;

export function getAppDbPath(): string {
  return path.join(dataRoot, APP_DB_FILENAME);
}

function ensureColumn(db: Database.Database, table: string, column: string, alterSql: string): void {
  const tableRow = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table) as { ok: number } | undefined;
  if (!tableRow?.ok) {
    return;
  }
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === column)) {
    db.exec(alterSql);
  }
}

function applyLegacyMigrations(db: Database.Database): void {
  ensureColumn(db, "user_settings", "default_ai_command", "ALTER TABLE user_settings ADD COLUMN default_ai_command TEXT NOT NULL DEFAULT 'codex --yolo {prompt}'");
  ensureColumn(
    db,
    "user_settings",
    "default_ai_commands",
    `ALTER TABLE user_settings ADD COLUMN default_ai_commands TEXT NOT NULL DEFAULT '${DEFAULT_AI_COMMANDS_JSON}'`
  );
  ensureColumn(
    db,
    "tasks",
    "auto_start",
    "ALTER TABLE tasks ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0 CHECK (auto_start IN (0,1))"
  );
  ensureColumn(
    db,
    "tasks",
    "auto_merge_on_complete",
    "ALTER TABLE tasks ADD COLUMN auto_merge_on_complete INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge_on_complete IN (0,1))"
  );
  ensureColumn(
    db,
    "plan_revision_items",
    "item_type",
    "ALTER TABLE plan_revision_items ADD COLUMN item_type TEXT NOT NULL DEFAULT 'execution_task' CHECK (item_type IN ('execution_task','sub_plan'))"
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS plan_orchestration_state (
      plan_task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      lock_token TEXT,
      lock_expires_at TEXT,
      last_output_sha256 TEXT,
      last_extracted_revision_id TEXT REFERENCES plan_revisions(id) ON DELETE SET NULL,
      last_approved_revision_id TEXT REFERENCES plan_revisions(id) ON DELETE SET NULL,
      last_approved_output_sha256 TEXT,
      last_failed_output_sha256 TEXT,
      last_error TEXT,
      last_error_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_plan_orchestration_state_lock_expires_at ON plan_orchestration_state(lock_expires_at)");
  db.exec(
    `CREATE TABLE IF NOT EXISTS workflow_definitions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition_yaml TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_definitions_project_id ON workflow_definitions(project_id)");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_definitions_project_name_version ON workflow_definitions(project_id, name, version)"
  );

  db.exec(
    `CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_definition_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_runs_definition_id ON workflow_runs(workflow_definition_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_runs_project_id ON workflow_runs(project_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)");

  db.exec(
    `CREATE TABLE IF NOT EXISTS workflow_stage_runs (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      stage_key TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped','cancelled')),
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workflow_run_id, stage_key)
    );`
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_stage_runs_workflow_run_id ON workflow_stage_runs(workflow_run_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_stage_runs_status ON workflow_stage_runs(status)");

  db.exec(
    `CREATE TABLE IF NOT EXISTS workflow_check_results (
      id TEXT PRIMARY KEY,
      workflow_stage_run_id TEXT NOT NULL REFERENCES workflow_stage_runs(id) ON DELETE CASCADE,
      check_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pass','fail','error')),
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_check_results_stage_run_id ON workflow_check_results(workflow_stage_run_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_check_results_status ON workflow_check_results(status)");

  db.exec(
    `CREATE TABLE IF NOT EXISTS workflow_events (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
      workflow_stage_run_id TEXT REFERENCES workflow_stage_runs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );`
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_events_workflow_run_id ON workflow_events(workflow_run_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_events_workflow_stage_run_id ON workflow_events(workflow_stage_run_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_events_event_type ON workflow_events(event_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_events_created_at ON workflow_events(created_at)");
}

function initializeAppDb(): Database.Database {
  fs.mkdirSync(dataRoot, { recursive: true });
  const db = openSqliteDatabase(getAppDbPath());
  db.exec(appBaselineMigration);
  applyLegacyMigrations(db);
  runProjectDataMigrationBackfill(db);
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
  if (cachedLocalUserId) {
    return cachedLocalUserId;
  }
  const app = getAppDb();
  const row = app.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  if (row?.id) {
    const settings = app.prepare("SELECT user_id FROM user_settings WHERE user_id = ?").get(row.id) as
      | { user_id: string }
      | undefined;
    if (!settings) {
      const now = nowIso();
      app.prepare(
        `INSERT INTO user_settings (user_id, default_ai_command, default_ai_commands, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(row.id, DEFAULT_AI_COMMAND, DEFAULT_AI_COMMANDS_JSON, now, now);
    }
    app.prepare(
      "UPDATE user_settings SET default_ai_command = ?, updated_at = ? WHERE user_id = ? AND default_ai_command IN ('codex --yolo', 'codex --yolo --prompt {prompt}')"
    ).run(
      DEFAULT_AI_COMMAND,
      nowIso(),
      row.id
    );
    app.prepare(
      "UPDATE user_settings SET default_ai_commands = ?, updated_at = ? WHERE user_id = ? AND (default_ai_commands IS NULL OR TRIM(default_ai_commands) = '')"
    ).run(DEFAULT_AI_COMMANDS_JSON, nowIso(), row.id);
    cachedLocalUserId = row.id;
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
    `INSERT INTO user_settings (user_id, default_ai_command, default_ai_commands, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, DEFAULT_AI_COMMAND, DEFAULT_AI_COMMANDS_JSON, now, now);
  cachedLocalUserId = id;
  return id;
}
