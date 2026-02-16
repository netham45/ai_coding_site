import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "../utils/time.js";
import { openSqliteDatabase } from "./sqlite.js";

export const PROJECT_DB_DIRNAME = ".ai-coding";
export const PROJECT_DB_FILENAME = "project.sqlite";
export const PROJECT_DB_SCHEMA_VERSION = 1;

export type ProjectDbMetadata = {
  project_id: string;
  schema_version: number;
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

function readValidatedProjectMetadata(db: Database.Database, expectedProjectId: string): ProjectDbMetadata {
  db.exec(projectMetadataMigration);

  const rowCount = db.prepare("SELECT COUNT(*) AS count FROM project_metadata").get() as { count: number };
  if (rowCount.count > 1) {
    throw new Error("Project database metadata is invalid: expected exactly one metadata row");
  }

  const existing = db
    .prepare("SELECT project_id, schema_version, created_at, updated_at FROM project_metadata LIMIT 1")
    .get() as ProjectDbMetadata | undefined;

  if (!existing) {
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
    throw new Error(
      `Project database metadata mismatch: expected project_id=${expectedProjectId}, found project_id=${existing.project_id}`
    );
  }

  if (existing.schema_version !== PROJECT_DB_SCHEMA_VERSION) {
    throw new Error(
      `Project database schema version mismatch: expected ${PROJECT_DB_SCHEMA_VERSION}, found ${existing.schema_version}`
    );
  }

  if (!isValidIsoTimestamp(existing.created_at) || !isValidIsoTimestamp(existing.updated_at)) {
    throw new Error("Project database metadata timestamps are invalid");
  }

  if (Date.parse(existing.updated_at) < Date.parse(existing.created_at)) {
    throw new Error("Project database metadata timestamps are invalid: updated_at is older than created_at");
  }

  return existing;
}

export function ensureProjectDb(params: { projectId: string; basePath: string }): ProjectDbHandle {
  const projectId = params.projectId;
  const basePath = path.resolve(params.basePath);
  const dbPath = getProjectDbPath(basePath);
  const existingPath = projectPathById.get(projectId);

  if (existingPath && existingPath !== dbPath) {
    closeProjectDb({ dbPath: existingPath });
  }

  const cached = cacheByPath.get(dbPath);
  if (cached?.db.open) {
    const metadata = readValidatedProjectMetadata(cached.db, projectId);
    projectPathById.set(projectId, dbPath);
    return {
      projectId,
      basePath,
      dbPath,
      db: cached.db,
      metadata
    };
  }

  if (cached && !cached.db.open) {
    cacheByPath.delete(dbPath);
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openSqliteDatabase(dbPath);

  try {
    const metadata = readValidatedProjectMetadata(db, projectId);
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
    throw error;
  }
}

export function getProjectDb(params: { projectId: string; basePath: string }): Database.Database {
  return ensureProjectDb(params).db;
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
