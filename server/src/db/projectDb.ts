import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "../utils/time.js";
import { projectBaselineMigration } from "./migrations.js";
import { openSqliteDatabase } from "./sqlite.js";

export const PROJECT_DB_DIRNAME = ".ai-coding";
export const PROJECT_DB_FILENAME = "project.sqlite";
export const PROJECT_DB_SCHEMA_VERSION = 1;

export type ProjectDbErrorCode = "PROJECT_DB_UNAVAILABLE" | "PROJECT_DB_CORRUPT";

export class ProjectDbError extends Error {
  readonly code: ProjectDbErrorCode;

  constructor(code: ProjectDbErrorCode, message: string) {
    super(message);
    this.name = "ProjectDbError";
    this.code = code;
  }
}

export function isProjectDbError(error: unknown): error is ProjectDbError {
  return error instanceof ProjectDbError;
}

export type ProjectDbMetadata = {
  project_id: string;
  schema_version: number;
  created_at: string;
  updated_at: string;
};

export type ProjectConfigRow = {
  project_id: string;
  project_prompt: string;
  project_rules: string;
  coding_standard: string;
  coding_standard_other: string;
  project_other: string;
  created_at: string;
  updated_at: string;
};

export type ProjectDbHandle = {
  projectId: string;
  basePath: string;
  dbPath: string;
  db: Database.Database;
  metadata: ProjectDbMetadata;
};

type CachedProjectDb = {
  projectId: string;
  basePath: string;
  dbPath: string;
  db: Database.Database;
};

const cacheByPath = new Map<string, CachedProjectDb>();
const projectPathById = new Map<string, string>();

type EnsureProjectDbParams = {
  projectId: string;
  basePath: string;
  initializeIfMissing?: boolean;
  configDefaults?: Partial<Omit<ProjectConfigRow, "project_id" | "created_at" | "updated_at">>;
};

const projectMetadataMigration = `
CREATE TABLE IF NOT EXISTS project_metadata (
  project_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function isValidIsoTimestamp(input: string): boolean {
  if (!input || typeof input !== "string") return false;
  return Number.isFinite(Date.parse(input));
}

function getProjectDbPath(basePath: string): string {
  return path.join(path.resolve(basePath), PROJECT_DB_DIRNAME, PROJECT_DB_FILENAME);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function readValidatedProjectMetadata(
  db: Database.Database,
  expectedProjectId: string,
  options?: { allowCreate: boolean }
): ProjectDbMetadata {
  db.exec(projectMetadataMigration);
  const allowCreate = options?.allowCreate === true;

  const rowCount = db.prepare("SELECT COUNT(*) AS count FROM project_metadata").get() as { count: number };
  if (rowCount.count > 1) {
    throw new ProjectDbError("PROJECT_DB_CORRUPT", "Project database metadata is invalid: expected exactly one metadata row");
  }

  const existing = db
    .prepare("SELECT project_id, schema_version, created_at, updated_at FROM project_metadata LIMIT 1")
    .get() as ProjectDbMetadata | undefined;

  if (!existing) {
    if (!allowCreate) {
      throw new ProjectDbError(
        "PROJECT_DB_CORRUPT",
        "Project database metadata is missing for an existing project database"
      );
    }
    const now = nowIso();
    db.prepare(
      `INSERT INTO project_metadata (project_id, schema_version, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    ).run(expectedProjectId, PROJECT_DB_SCHEMA_VERSION, now, now);
    return {
      project_id: expectedProjectId,
      schema_version: PROJECT_DB_SCHEMA_VERSION,
      created_at: now,
      updated_at: now
    };
  }

  if (existing.project_id !== expectedProjectId) {
    throw new ProjectDbError(
      "PROJECT_DB_CORRUPT",
      `Project database metadata mismatch: expected project_id=${expectedProjectId}, found project_id=${existing.project_id}`
    );
  }

  if (existing.schema_version !== PROJECT_DB_SCHEMA_VERSION) {
    throw new ProjectDbError(
      "PROJECT_DB_CORRUPT",
      `Project database schema version mismatch: expected ${PROJECT_DB_SCHEMA_VERSION}, found ${existing.schema_version}`
    );
  }

  if (!isValidIsoTimestamp(existing.created_at) || !isValidIsoTimestamp(existing.updated_at)) {
    throw new ProjectDbError("PROJECT_DB_CORRUPT", "Project database metadata timestamps are invalid");
  }

  if (Date.parse(existing.updated_at) < Date.parse(existing.created_at)) {
    throw new ProjectDbError("PROJECT_DB_CORRUPT", "Project database metadata timestamps are invalid: updated_at is older than created_at");
  }

  return existing;
}

function ensureProjectConfigRow(
  db: Database.Database,
  projectId: string,
  options?: {
    allowCreate: boolean;
    defaults?: Partial<Omit<ProjectConfigRow, "project_id" | "created_at" | "updated_at">>;
  }
): ProjectConfigRow {
  const allowCreate = options?.allowCreate === true;
  const defaults = options?.defaults;
  const existing = db
    .prepare(
      `SELECT
         project_id,
         project_prompt,
         project_rules,
         coding_standard,
         coding_standard_other,
         project_other,
         created_at,
         updated_at
       FROM project_config
       WHERE project_id = ?`
    )
    .get(projectId) as ProjectConfigRow | undefined;

  if (existing) {
    return existing;
  }

  if (!allowCreate) {
    throw new ProjectDbError("PROJECT_DB_CORRUPT", `Project database config row is missing for project ${projectId}`);
  }

  const now = nowIso();
  const inserted: ProjectConfigRow = {
    project_id: projectId,
    project_prompt: defaults?.project_prompt ?? "",
    project_rules: defaults?.project_rules ?? "",
    coding_standard: defaults?.coding_standard ?? "",
    coding_standard_other: defaults?.coding_standard_other ?? "",
    project_other: defaults?.project_other ?? "",
    created_at: now,
    updated_at: now
  };

  db.prepare(
    `INSERT INTO project_config (
       project_id,
       project_prompt,
       project_rules,
       coding_standard,
       coding_standard_other,
       project_other,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    inserted.project_id,
    inserted.project_prompt,
    inserted.project_rules,
    inserted.coding_standard,
    inserted.coding_standard_other,
    inserted.project_other,
    inserted.created_at,
    inserted.updated_at
  );

  return inserted;
}

function validateCachedHandle(params: {
  cached: CachedProjectDb;
  projectId: string;
  dbPath: string;
  allowCreate: boolean;
  configDefaults?: Partial<Omit<ProjectConfigRow, "project_id" | "created_at" | "updated_at">>;
}): ProjectDbHandle {
  try {
    params.cached.db.exec(projectBaselineMigration);
    const metadata = readValidatedProjectMetadata(params.cached.db, params.projectId, { allowCreate: params.allowCreate });
    ensureProjectConfigRow(params.cached.db, params.projectId, {
      allowCreate: params.allowCreate,
      defaults: params.configDefaults
    });
    projectPathById.set(params.projectId, params.dbPath);
    return {
      projectId: params.projectId,
      basePath: params.cached.basePath,
      dbPath: params.dbPath,
      db: params.cached.db,
      metadata
    };
  } catch (error) {
    closeProjectDb({ dbPath: params.dbPath });
    if (isProjectDbError(error)) {
      throw error;
    }
    throw new ProjectDbError("PROJECT_DB_CORRUPT", `Project database validation failed: ${errorMessage(error)}`);
  }
}

export function ensureProjectDb(params: EnsureProjectDbParams): ProjectDbHandle {
  const projectId = params.projectId;
  const basePath = path.resolve(params.basePath);
  const dbPath = getProjectDbPath(basePath);
  const allowCreate = params.initializeIfMissing === true;
  const existingPath = projectPathById.get(projectId);

  if (existingPath && existingPath !== dbPath) {
    closeProjectDb({ dbPath: existingPath });
  }

  const cached = cacheByPath.get(dbPath);
  if (cached?.db.open) {
    return validateCachedHandle({
      cached,
      projectId,
      dbPath,
      allowCreate,
      configDefaults: params.configDefaults
    });
  }

  if (cached && !cached.db.open) {
    cacheByPath.delete(dbPath);
  }

  const dbExists = fs.existsSync(dbPath);
  if (!dbExists && !allowCreate) {
    throw new ProjectDbError("PROJECT_DB_UNAVAILABLE", `Project database is unavailable at ${dbPath}`);
  }
  if (allowCreate) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  let db: Database.Database;
  try {
    db = openSqliteDatabase(dbPath);
  } catch (error) {
    if (!fs.existsSync(dbPath)) {
      throw new ProjectDbError("PROJECT_DB_UNAVAILABLE", `Project database is unavailable at ${dbPath}`);
    }
    throw new ProjectDbError("PROJECT_DB_CORRUPT", `Project database could not be opened: ${errorMessage(error)}`);
  }

  try {
    db.exec(projectBaselineMigration);
    const metadata = readValidatedProjectMetadata(db, projectId, { allowCreate });
    ensureProjectConfigRow(db, projectId, {
      allowCreate,
      defaults: params.configDefaults
    });
    cacheByPath.set(dbPath, { projectId, basePath, dbPath, db });
    projectPathById.set(projectId, dbPath);
    return {
      projectId,
      basePath,
      dbPath,
      db,
      metadata
    };
  } catch (error) {
    db.close();
    if (isProjectDbError(error)) {
      throw error;
    }
    throw new ProjectDbError("PROJECT_DB_CORRUPT", `Project database initialization failed: ${errorMessage(error)}`);
  }
}

export function getProjectDb(params: { projectId: string; basePath: string }): Database.Database {
  return ensureProjectDb({ ...params, initializeIfMissing: false }).db;
}

export function getProjectConfig(params: { projectId: string; basePath: string }): ProjectConfigRow {
  const db = getProjectDb(params);
  return ensureProjectConfigRow(db, params.projectId);
}

export function upsertProjectConfig(params: {
  projectId: string;
  basePath: string;
  projectPrompt: string;
  projectRules: string;
  codingStandard: string;
  codingStandardOther: string;
  projectOther: string;
}): ProjectConfigRow {
  const db = getProjectDb(params);
  const current = ensureProjectConfigRow(db, params.projectId);
  const updatedAt = nowIso();

  db.prepare(
    `UPDATE project_config
     SET project_prompt = ?,
         project_rules = ?,
         coding_standard = ?,
         coding_standard_other = ?,
         project_other = ?,
         updated_at = ?
     WHERE project_id = ?`
  ).run(
    params.projectPrompt,
    params.projectRules,
    params.codingStandard,
    params.codingStandardOther,
    params.projectOther,
    updatedAt,
    params.projectId
  );

  return {
    project_id: params.projectId,
    project_prompt: params.projectPrompt,
    project_rules: params.projectRules,
    coding_standard: params.codingStandard,
    coding_standard_other: params.codingStandardOther,
    project_other: params.projectOther,
    created_at: current.created_at,
    updated_at: updatedAt
  };
}

export function closeProjectDb(params: { projectId?: string; dbPath?: string }): void {
  const dbPath =
    params.dbPath ?? (params.projectId ? projectPathById.get(params.projectId) : undefined);
  if (!dbPath) {
    return;
  }

  const cached = cacheByPath.get(dbPath);
  if (cached?.db.open) {
    cached.db.close();
  }
  cacheByPath.delete(dbPath);

  for (const [projectId, knownPath] of projectPathById.entries()) {
    if (knownPath === dbPath) {
      projectPathById.delete(projectId);
    }
  }
}

export function closeAllProjectDbs(): void {
  for (const cached of cacheByPath.values()) {
    if (cached.db.open) {
      cached.db.close();
    }
  }
  cacheByPath.clear();
  projectPathById.clear();
}
