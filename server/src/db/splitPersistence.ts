import type Database from "better-sqlite3";
import { getProjectDb, isProjectDbError } from "./projectDb.js";
import { recordProjectDbFailure } from "./projectDbDiagnostics.js";
import { logWarn } from "../utils/structuredLog.js";

export const SPLIT_PERSISTENCE_PHASES = ["monolith", "read_validation", "write_cutover", "cleanup"] as const;
export type SplitPersistencePhase = (typeof SPLIT_PERSISTENCE_PHASES)[number];
export type SplitPersistenceIntent = "read" | "write";
export type SplitPersistenceBackend = "project" | "monolith";

type MigrationStatus = "pending" | "in_progress" | "verified" | "cleaned" | "failed";

type ResolveProjectDatabaseParams = {
  appDb: Database.Database;
  projectId: string;
  basePath: string;
  intent: SplitPersistenceIntent;
};

type ResolveProjectDatabaseResult = {
  backend: SplitPersistenceBackend;
  database: Database.Database;
  phase: SplitPersistencePhase;
  migrationStatus?: MigrationStatus;
};

const REQUIRED_MONOLITH_TABLES = [
  "tasks",
  "task_dependencies",
  "task_state_transitions",
  "task_sessions",
  "plan_revisions",
  "plan_revision_items",
  "plan_revision_item_dependencies",
  "ide_instances",
  "merge_records",
  "events"
] as const;

let monolithTableSupportCache: boolean | undefined;
let migrationTableSupportCache: boolean | undefined;

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function hasRequiredMonolithTables(db: Database.Database): boolean {
  if (monolithTableSupportCache !== undefined) {
    return monolithTableSupportCache;
  }
  monolithTableSupportCache = REQUIRED_MONOLITH_TABLES.every((table) => tableExists(db, table));
  return monolithTableSupportCache;
}

function hasMigrationTable(db: Database.Database): boolean {
  if (migrationTableSupportCache !== undefined) {
    return migrationTableSupportCache;
  }
  migrationTableSupportCache = tableExists(db, "project_data_migrations");
  return migrationTableSupportCache;
}

export function getSplitPersistencePhase(): SplitPersistencePhase {
  const raw = (process.env.SPLIT_PERSISTENCE_PHASE ?? "").trim().toLowerCase();
  if (raw === "monolith" || raw === "read_validation" || raw === "write_cutover" || raw === "cleanup") {
    return raw;
  }
  return "write_cutover";
}

export function isCleanupPhaseEnabled(): boolean {
  return getSplitPersistencePhase() === "cleanup";
}

function migrationStatusForProject(db: Database.Database, projectId: string): MigrationStatus | undefined {
  if (!hasMigrationTable(db)) {
    return undefined;
  }
  const row = db
    .prepare("SELECT status FROM project_data_migrations WHERE project_id = ?")
    .get(projectId) as { status: MigrationStatus } | undefined;
  return row?.status;
}

function shouldPreferProjectBackend(phase: SplitPersistencePhase, intent: SplitPersistenceIntent): boolean {
  void intent;
  if (phase === "monolith" || phase === "read_validation") {
    return false;
  }
  return phase === "write_cutover" || phase === "cleanup";
}

function isProjectBackendAllowedByMigration(status: MigrationStatus | undefined): boolean {
  if (!status) {
    return true;
  }
  return status === "verified" || status === "cleaned";
}

export function resolveProjectDatabase(params: ResolveProjectDatabaseParams): ResolveProjectDatabaseResult {
  const phase = getSplitPersistencePhase();
  const monolithSupported = hasRequiredMonolithTables(params.appDb);
  const preferProject = shouldPreferProjectBackend(phase, params.intent) || !monolithSupported;
  const migrationStatus = migrationStatusForProject(params.appDb, params.projectId);

  if (preferProject && isProjectBackendAllowedByMigration(migrationStatus)) {
    try {
      return {
        backend: "project",
        database: getProjectDb({ projectId: params.projectId, basePath: params.basePath }),
        phase,
        migrationStatus
      };
    } catch (error) {
      if (!isProjectDbError(error) || !monolithSupported) {
        throw error;
      }
      const diagnostic = recordProjectDbFailure({
        stage: "resolve",
        code: error.code,
        projectId: params.projectId,
        basePath: params.basePath,
        message: error.message
      });
      logWarn("split_persistence.fallback_to_monolith", {
        ...diagnostic,
        phase,
        migrationStatus
      });
    }
  }

  return {
    backend: "monolith",
    database: params.appDb,
    phase,
    migrationStatus
  };
}

export function resetSplitPersistenceCachesForTests(): void {
  monolithTableSupportCache = undefined;
  migrationTableSupportCache = undefined;
}
