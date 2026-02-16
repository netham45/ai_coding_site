import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { appBaselineMigration, projectBaselineMigration, PROJECT_DB_SCHEMA_VERSION } from "./migrations.js";
import type { AppProjectRow, ProjectConfigRow, ProjectRow } from "../types.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";
import { dataRoot } from "../utils/paths.js";

const DEFAULT_AI_COMMAND = "codex --yolo {prompt}";
const PROJECT_DB_DIR = ".ai-coding";
const PROJECT_DB_NAME = "project.sqlite";

fs.mkdirSync(dataRoot, { recursive: true });
const appDbPath = path.join(dataRoot, "app.sqlite");

export const appDb = new Database(appDbPath);
configureSqlite(appDb);
appDb.exec(appBaselineMigration);

// SQLite ownership invariants for app/project split:
// 1) Single source of truth per table: global tables live in app DB, project-local tables live in project DB.
// 2) No cross-file SQLite foreign keys are used between app DB and project DB.
// 3) Cross-DB linkage is by IDs only, with integrity enforced in application logic.

function configureSqlite(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
}

function ensureColumn(db: Database.Database, table: string, column: string, alterSql: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === column)) {
    db.exec(alterSql);
  }
}

function ensureProjectDbSchema(db: Database.Database): void {
  db.exec(projectBaselineMigration);
  ensureColumn(db, "tasks", "mode", "ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'execution'");
  ensureColumn(db, "tasks", "auto_merge", "ALTER TABLE tasks ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "result", "ALTER TABLE tasks ADD COLUMN result TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "tasks", "parent_plan_task_id", "ALTER TABLE tasks ADD COLUMN parent_plan_task_id TEXT");
  ensureColumn(db, "tasks", "source_plan_revision_id", "ALTER TABLE tasks ADD COLUMN source_plan_revision_id TEXT");
  ensureColumn(db, "tasks", "source_plan_item_key", "ALTER TABLE tasks ADD COLUMN source_plan_item_key TEXT");
  ensureColumn(db, "task_sessions", "last_output", "ALTER TABLE task_sessions ADD COLUMN last_output TEXT NOT NULL DEFAULT ''");
}

function projectDbPath(basePath: string): string {
  return path.join(basePath, PROJECT_DB_DIR, PROJECT_DB_NAME);
}

function normalizeError(error: unknown): string {
  return String((error as Error)?.message ?? error ?? "unknown");
}

type ProjectDbErrorCode = "PROJECT_DB_UNAVAILABLE" | "PROJECT_DB_CORRUPT";

export class ProjectDbError extends Error {
  code: ProjectDbErrorCode;

  constructor(code: ProjectDbErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function openProjectDb(params: { projectId: string; basePath: string; allowCreate: boolean }): Database.Database {
  const dbFile = projectDbPath(params.basePath);
  const dirPath = path.dirname(dbFile);
  const existedBefore = fs.existsSync(dbFile);

  if (!params.allowCreate && !existedBefore) {
    throw new ProjectDbError("PROJECT_DB_UNAVAILABLE", `Missing project DB: ${dbFile}`);
  }

  if (params.allowCreate) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  let db: Database.Database;
  try {
    db = new Database(dbFile);
  } catch (error) {
    throw new ProjectDbError("PROJECT_DB_CORRUPT", `Unable to open project DB: ${normalizeError(error)}`);
  }

  try {
    configureSqlite(db);
    ensureProjectDbSchema(db);
    validateOrSeedMetadata(db, params.projectId, params.allowCreate || !existedBefore);
    return db;
  } catch (error) {
    db.close();
    const message = normalizeError(error);
    if (error instanceof ProjectDbError) {
      throw error;
    }
    throw new ProjectDbError("PROJECT_DB_CORRUPT", `Invalid project DB (${dbFile}): ${message}`);
  }
}

function validateOrSeedMetadata(db: Database.Database, projectId: string, allowSeed: boolean): void {
  const meta = db.prepare("SELECT project_id, schema_version FROM project_metadata WHERE id = 1").get() as
    | { project_id: string; schema_version: number }
    | undefined;
  if (!meta) {
    if (!allowSeed) {
      throw new ProjectDbError("PROJECT_DB_CORRUPT", "Project DB metadata row is missing");
    }
    db.prepare("INSERT INTO project_metadata (id, project_id, schema_version, created_at) VALUES (1, ?, ?, ?)").run(
      projectId,
      PROJECT_DB_SCHEMA_VERSION,
      nowIso()
    );
    return;
  }
  if (meta.project_id !== projectId) {
    throw new ProjectDbError(
      "PROJECT_DB_CORRUPT",
      `Project DB metadata mismatch. Expected ${projectId}, found ${meta.project_id}`
    );
  }
}

type ProjectConfigInput = {
  projectPrompt?: string;
  projectRules?: string;
  codingStandard?: string;
  codingStandardOther?: string;
  projectOther?: string;
};

function seedProjectConfig(db: Database.Database, projectId: string, seed?: ProjectConfigInput): void {
  const now = nowIso();
  const current = db.prepare("SELECT id FROM project_config WHERE id = 1").get() as { id: number } | undefined;
  if (current) {
    return;
  }
  db.prepare(
    `INSERT INTO project_config (
      id, project_id, project_prompt, project_rules, coding_standard, coding_standard_other, project_other, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    projectId,
    seed?.projectPrompt ?? "",
    seed?.projectRules ?? "",
    seed?.codingStandard ?? "",
    seed?.codingStandardOther ?? "",
    seed?.projectOther ?? "",
    now,
    now
  );
}

type ProjectDbCacheValue = {
  projectId: string;
  db: Database.Database;
};

const projectDbCache = new Map<string, ProjectDbCacheValue>();

export function projectDbForProject(params: { projectId: string; basePath: string }): Database.Database {
  const cached = projectDbCache.get(params.basePath);
  if (cached) {
    if (cached.projectId !== params.projectId) {
      cached.db.close();
      projectDbCache.delete(params.basePath);
    } else {
      return cached.db;
    }
  }

  const db = openProjectDb({ projectId: params.projectId, basePath: params.basePath, allowCreate: false });
  projectDbCache.set(params.basePath, { projectId: params.projectId, db });
  return db;
}

export function initializeProjectDb(params: {
  projectId: string;
  basePath: string;
  config?: ProjectConfigInput;
}): Database.Database {
  const db = openProjectDb({ projectId: params.projectId, basePath: params.basePath, allowCreate: true });
  seedProjectConfig(db, params.projectId, params.config);
  projectDbCache.set(params.basePath, { projectId: params.projectId, db });
  return db;
}

function loadProjectConfig(db: Database.Database, projectId: string): ProjectConfigRow {
  const row = db.prepare("SELECT * FROM project_config WHERE id = 1").get() as ProjectConfigRow | undefined;
  if (row) {
    return row;
  }
  seedProjectConfig(db, projectId);
  const seeded = db.prepare("SELECT * FROM project_config WHERE id = 1").get() as ProjectConfigRow | undefined;
  if (!seeded) {
    throw new ProjectDbError("PROJECT_DB_CORRUPT", "Project config row is missing");
  }
  return seeded;
}

export function getProjectConfig(params: { projectId: string; basePath: string }): ProjectConfigRow {
  const projectDb = projectDbForProject(params);
  return loadProjectConfig(projectDb, params.projectId);
}

export function updateProjectConfig(
  params: { projectId: string; basePath: string },
  patch: ProjectConfigInput
): ProjectConfigRow {
  const projectDb = projectDbForProject(params);
  const current = loadProjectConfig(projectDb, params.projectId);
  const next = {
    project_prompt: patch.projectPrompt ?? current.project_prompt,
    project_rules: patch.projectRules ?? current.project_rules,
    coding_standard: patch.codingStandard ?? current.coding_standard,
    coding_standard_other: patch.codingStandardOther ?? current.coding_standard_other,
    project_other: patch.projectOther ?? current.project_other
  };

  projectDb.prepare(
    `UPDATE project_config
     SET project_prompt = ?, project_rules = ?, coding_standard = ?, coding_standard_other = ?, project_other = ?, updated_at = ?
     WHERE id = 1`
  ).run(
    next.project_prompt,
    next.project_rules,
    next.coding_standard,
    next.coding_standard_other,
    next.project_other,
    nowIso()
  );

  return loadProjectConfig(projectDb, params.projectId);
}

export function hydrateProjectWithConfig(project: AppProjectRow): ProjectRow {
  const config = getProjectConfig({ projectId: project.id, basePath: project.base_path });
  return {
    ...project,
    project_prompt: config.project_prompt,
    project_rules: config.project_rules,
    coding_standard: config.coding_standard,
    coding_standard_other: config.coding_standard_other,
    project_other: config.project_other
  };
}

export function ensureLocalUser(): string {
  const row = appDb.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  if (row?.id) {
    const settings = appDb.prepare("SELECT user_id FROM user_settings WHERE user_id = ?").get(row.id) as
      | { user_id: string }
      | undefined;
    if (!settings) {
      const now = nowIso();
      appDb.prepare(
        `INSERT INTO user_settings (user_id, default_ai_command, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      ).run(row.id, DEFAULT_AI_COMMAND, now, now);
    }
    appDb
      .prepare(
        "UPDATE user_settings SET default_ai_command = ?, updated_at = ? WHERE user_id = ? AND default_ai_command IN ('codex --yolo', 'codex --yolo --prompt {prompt}')"
      )
      .run(DEFAULT_AI_COMMAND, nowIso(), row.id);
    return row.id;
  }

  const id = makeId();
  const now = nowIso();
  appDb.prepare("INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    "local@example.com",
    "Local User",
    now,
    now
  );
  appDb
    .prepare(
      `INSERT INTO user_settings (user_id, default_ai_command, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(id, DEFAULT_AI_COMMAND, now, now);
  return id;
}
