import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { ensureProjectDb, upsertProjectConfig } from "./projectDb.js";
import { recordProjectDbFailure } from "./projectDbDiagnostics.js";
import { invalidateMigrationStatusCache, isCleanupPhaseEnabled } from "./splitPersistence.js";
import { nowIso } from "../utils/time.js";
import { logInfo, logWarn } from "../utils/structuredLog.js";

const PROJECT_DATA_MIGRATION_VERSION = 1;
const PROJECT_DATA_MIGRATION_STATUS = ["pending", "in_progress", "verified", "cleaned", "failed"] as const;
type ProjectDataMigrationStatus = (typeof PROJECT_DATA_MIGRATION_STATUS)[number];

type ProjectScope = {
  id: string;
  base_path: string;
};

type TablePresence = Record<string, boolean>;

type VerificationTableResult = {
  source: number;
  target: number;
  checksumSource?: string;
  checksumTarget?: string;
};

type VerificationResult = {
  counts: Record<string, VerificationTableResult>;
};

type ProjectConfigLegacyValues = {
  project_prompt: string;
  project_rules: string;
  coding_standard: string;
  coding_standard_other: string;
  project_other: string;
};

const legacyProjectTables = [
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

const migrationTableSql = `
CREATE TABLE IF NOT EXISTS project_data_migrations (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  migration_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','in_progress','verified','cleaned','failed')),
  table_counts_json TEXT NOT NULL DEFAULT '{}',
  table_checksums_json TEXT,
  last_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  verified_at TEXT,
  cleaned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_data_migrations_status ON project_data_migrations(status);
`;

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) {
    return false;
  }
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function buildTablePresence(db: Database.Database): TablePresence {
  const presence: TablePresence = {};
  for (const table of legacyProjectTables) {
    presence[table] = tableExists(db, table);
  }
  return presence;
}

function canReadLegacyProjectConfig(db: Database.Database): boolean {
  return (
    tableHasColumn(db, "projects", "project_prompt") &&
    tableHasColumn(db, "projects", "project_rules") &&
    tableHasColumn(db, "projects", "coding_standard") &&
    tableHasColumn(db, "projects", "coding_standard_other") &&
    tableHasColumn(db, "projects", "project_other")
  );
}

function toSqlJson(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeSqlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return toSqlJson(value);
}

function checksumForQuery(db: Database.Database, sql: string, params: unknown[], orderedColumns: string[]): string {
  const hash = createHash("sha256");
  const stmt = db.prepare(sql);
  for (const row of stmt.iterate(...params) as Iterable<Record<string, unknown>>) {
    for (const column of orderedColumns) {
      hash.update(column);
      hash.update("=");
      hash.update(normalizeSqlValue(row[column]));
      hash.update("\u001f");
    }
    hash.update("\n");
  }
  return hash.digest("hex");
}

function upsertMigrationStatus(params: {
  db: Database.Database;
  projectId: string;
  status: ProjectDataMigrationStatus;
  counts?: Record<string, VerificationTableResult>;
  checksums?: Record<string, { source: string; target: string }>;
  error?: string | null;
  startedAt?: string;
  verifiedAt?: string;
  cleanedAt?: string;
  incrementAttempt?: boolean;
}): void {
  const now = nowIso();
  const existing = params.db
    .prepare("SELECT project_id, attempt_count, created_at FROM project_data_migrations WHERE project_id = ?")
    .get(params.projectId) as { project_id: string; attempt_count: number; created_at: string } | undefined;

  const attemptCount = existing ? existing.attempt_count + (params.incrementAttempt ? 1 : 0) : params.incrementAttempt ? 1 : 0;
  const createdAt = existing?.created_at ?? now;

  params.db.prepare(
    `INSERT INTO project_data_migrations (
       project_id,
       migration_version,
       status,
       table_counts_json,
       table_checksums_json,
       last_error,
       attempt_count,
       started_at,
       verified_at,
       cleaned_at,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       migration_version = excluded.migration_version,
       status = excluded.status,
       table_counts_json = excluded.table_counts_json,
       table_checksums_json = excluded.table_checksums_json,
       last_error = excluded.last_error,
       attempt_count = excluded.attempt_count,
       started_at = excluded.started_at,
       verified_at = excluded.verified_at,
       cleaned_at = excluded.cleaned_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`
  ).run(
    params.projectId,
    PROJECT_DATA_MIGRATION_VERSION,
    params.status,
    toSqlJson(params.counts ?? {}),
    params.checksums ? toSqlJson(params.checksums) : null,
    params.error ?? null,
    attemptCount,
    params.startedAt ?? null,
    params.verifiedAt ?? null,
    params.cleanedAt ?? null,
    createdAt,
    now
  );
  invalidateMigrationStatusCache(params.projectId);
}

function buildUpsertSql(table: string, columns: string[], conflictColumns: string[]): string {
  const placeholders = columns.map(() => "?").join(", ");
  const updatable = columns.filter((column) => !conflictColumns.includes(column));
  const updates = updatable.map((column) => `${column} = excluded.${column}`).join(",\n       ");
  if (!updates) {
    return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(${conflictColumns.join(", ")}) DO NOTHING`;
  }
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(${conflictColumns.join(", ")}) DO UPDATE SET\n       ${updates}`;
}

function runCopySelectIntoProjectDb(params: {
  appDb: Database.Database;
  projectDb: Database.Database;
  sql: string;
  sqlParams: unknown[];
  columns: string[];
  targetTable: string;
  conflictColumns: string[];
  targetValueOverrides?: Partial<Record<string, unknown>>;
}): void {
  const readStmt = params.appDb.prepare(params.sql);
  const writeStmt = params.projectDb.prepare(buildUpsertSql(params.targetTable, params.columns, params.conflictColumns));

  for (const row of readStmt.iterate(...params.sqlParams) as Iterable<Record<string, unknown>>) {
    const values = params.columns.map((column) => {
      if (params.targetValueOverrides && Object.prototype.hasOwnProperty.call(params.targetValueOverrides, column)) {
        return params.targetValueOverrides[column];
      }
      return row[column] ?? null;
    });
    writeStmt.run(...values);
  }
}

function copyLegacyDataForProject(params: {
  appDb: Database.Database;
  projectDb: Database.Database;
  projectId: string;
  presence: TablePresence;
}): void {
  const tx = params.projectDb.transaction(() => {
    if (params.presence.tasks) {
      runCopySelectIntoProjectDb({
        appDb: params.appDb,
        projectDb: params.projectDb,
        targetTable: "tasks",
        conflictColumns: ["id"],
        columns: [
          "id",
          "project_id",
          "title",
          "task_prompt",
          "result",
          "effective_prompt",
          "ai_command",
          "auto_merge",
          "auto_start",
          "auto_merge_on_complete",
          "mode",
          "parent_plan_task_id",
          "source_plan_revision_id",
          "source_plan_item_key",
          "status",
          "workspace_path",
          "base_commit_sha_at_create",
          "head_commit_sha",
          "cancel_reason",
          "merged_at",
          "merged_by_user_id",
          "created_by_user_id",
          "created_at",
          "updated_at"
        ],
        sql: `
          SELECT
            id,
            project_id,
            title,
            task_prompt,
            result,
            effective_prompt,
            ai_command,
            auto_merge,
            0 AS auto_start,
            0 AS auto_merge_on_complete,
            mode,
            parent_plan_task_id,
            source_plan_revision_id,
            source_plan_item_key,
            status,
            workspace_path,
            base_commit_sha_at_create,
            head_commit_sha,
            cancel_reason,
            merged_at,
            merged_by_user_id,
            created_by_user_id,
            created_at,
            updated_at
          FROM tasks
          WHERE project_id = ?
          ORDER BY created_at ASC, id ASC
        `,
        sqlParams: [params.projectId],
        targetValueOverrides: {
          parent_plan_task_id: null,
          source_plan_revision_id: null
        }
      });
    }

    if (params.presence.plan_revisions && params.presence.tasks) {
      runCopySelectIntoProjectDb({
        appDb: params.appDb,
        projectDb: params.projectDb,
        targetTable: "plan_revisions",
        conflictColumns: ["id"],
        columns: [
          "id",
          "plan_task_id",
          "revision_number",
          "status",
          "feedback",
          "raw_output",
          "parse_error",
          "created_by_user_id",
          "created_at",
          "approved_at"
        ],
        sql: `
          SELECT
            pr.id,
            pr.plan_task_id,
            pr.revision_number,
            pr.status,
            pr.feedback,
            pr.raw_output,
            pr.parse_error,
            pr.created_by_user_id,
            pr.created_at,
            pr.approved_at
          FROM plan_revisions pr
          INNER JOIN tasks t ON t.id = pr.plan_task_id
          WHERE t.project_id = ?
          ORDER BY pr.created_at ASC, pr.id ASC
        `,
        sqlParams: [params.projectId]
      });
    }

    if (params.presence.plan_revision_items && params.presence.plan_revisions && params.presence.tasks) {
      runCopySelectIntoProjectDb({
        appDb: params.appDb,
        projectDb: params.projectDb,
        targetTable: "plan_revision_items",
        conflictColumns: ["id"],
        columns: ["id", "revision_id", "item_key", "item_type", "title", "prompt", "ordinal", "created_at"],
        sql: `
          SELECT
            pri.id,
            pri.revision_id,
            pri.item_key,
            'execution_task' AS item_type,
            pri.title,
            pri.prompt,
            pri.ordinal,
            pri.created_at
          FROM plan_revision_items pri
          INNER JOIN plan_revisions pr ON pr.id = pri.revision_id
          INNER JOIN tasks t ON t.id = pr.plan_task_id
          WHERE t.project_id = ?
          ORDER BY pri.created_at ASC, pri.id ASC
        `,
        sqlParams: [params.projectId]
      });
    }

    if (
      params.presence.plan_revision_item_dependencies &&
      params.presence.plan_revision_items &&
      params.presence.plan_revisions &&
      params.presence.tasks
    ) {
      runCopySelectIntoProjectDb({
        appDb: params.appDb,
        projectDb: params.projectDb,
        targetTable: "plan_revision_item_dependencies",
        conflictColumns: ["revision_item_id", "depends_on_item_key"],
        columns: ["revision_item_id", "depends_on_item_key"],
        sql: `
          SELECT
            prid.revision_item_id,
            prid.depends_on_item_key
          FROM plan_revision_item_dependencies prid
          INNER JOIN plan_revision_items pri ON pri.id = prid.revision_item_id
          INNER JOIN plan_revisions pr ON pr.id = pri.revision_id
          INNER JOIN tasks t ON t.id = pr.plan_task_id
          WHERE t.project_id = ?
          ORDER BY prid.revision_item_id ASC, prid.depends_on_item_key ASC
        `,
        sqlParams: [params.projectId]
      });
    }

    if (params.presence.task_dependencies && params.presence.tasks) {
      runCopySelectIntoProjectDb({
        appDb: params.appDb,
        projectDb: params.projectDb,
        targetTable: "task_dependencies",
        conflictColumns: ["task_id", "dependency_task_id"],
        columns: ["task_id", "dependency_task_id", "created_at"],
        sql: `
          SELECT
            td.task_id,
            td.dependency_task_id,
            td.created_at
          FROM task_dependencies td
          INNER JOIN tasks t ON t.id = td.task_id
          INNER JOIN tasks dep ON dep.id = td.dependency_task_id
          WHERE t.project_id = ? AND dep.project_id = ?
          ORDER BY td.created_at ASC, td.task_id ASC, td.dependency_task_id ASC
        `,
        sqlParams: [params.projectId, params.projectId]
      });
    }

    if (params.presence.task_state_transitions && params.presence.tasks) {
      runCopySelectIntoProjectDb({
        appDb: params.appDb,
        projectDb: params.projectDb,
        targetTable: "task_state_transitions",
        conflictColumns: ["id"],
        columns: ["id", "task_id", "from_status", "to_status", "reason", "actor_user_id", "created_at"],
        sql: `
          SELECT
            tst.id,
            tst.task_id,
            tst.from_status,
            tst.to_status,
            tst.reason,
            tst.actor_user_id,
            tst.created_at
          FROM task_state_transitions tst
          INNER JOIN tasks t ON t.id = tst.task_id
          WHERE t.project_id = ?
          ORDER BY tst.created_at ASC, tst.id ASC
        `,
        sqlParams: [params.projectId]
      });
    }

    if (params.presence.task_sessions && params.presence.tasks) {
      runCopySelectIntoProjectDb({
        appDb: params.appDb,
        projectDb: params.projectDb,
        targetTable: "task_sessions",
        conflictColumns: ["id"],
        columns: [
          "id",
          "task_id",
          "tmux_session_name",
          "tmux_socket_path",
          "pane_id",
          "detected_tool",
          "backend_command",
          "status",
          "started_at",
          "ended_at",
          "last_heartbeat_at",
          "last_output",
          "exit_code",
          "failure_reason"
        ],
        sql: `
          SELECT
            ts.id,
            ts.task_id,
            ts.tmux_session_name,
            ts.tmux_socket_path,
            ts.pane_id,
            ts.detected_tool,
            ts.backend_command,
            ts.status,
            ts.started_at,
            ts.ended_at,
            ts.last_heartbeat_at,
            ts.last_output,
            ts.exit_code,
            ts.failure_reason
          FROM task_sessions ts
          INNER JOIN tasks t ON t.id = ts.task_id
          WHERE t.project_id = ?
          ORDER BY ts.started_at ASC, ts.id ASC
        `,
        sqlParams: [params.projectId]
      });
    }

    if (params.presence.ide_instances && params.presence.tasks) {
      runCopySelectIntoProjectDb({
        appDb: params.appDb,
        projectDb: params.projectDb,
        targetTable: "ide_instances",
        conflictColumns: ["id"],
        columns: [
          "id",
          "task_id",
          "provider",
          "url",
          "access_token_hash",
          "status",
          "started_at",
          "ended_at",
          "last_heartbeat_at"
        ],
        sql: `
          SELECT
            ii.id,
            ii.task_id,
            ii.provider,
            ii.url,
            ii.access_token_hash,
            ii.status,
            ii.started_at,
            ii.ended_at,
            ii.last_heartbeat_at
          FROM ide_instances ii
          INNER JOIN tasks t ON t.id = ii.task_id
          WHERE t.project_id = ?
          ORDER BY ii.id ASC
        `,
        sqlParams: [params.projectId]
      });
    }

    if (params.presence.merge_records) {
      runCopySelectIntoProjectDb({
        appDb: params.appDb,
        projectDb: params.projectDb,
        targetTable: "merge_records",
        conflictColumns: ["id"],
        columns: [
          "id",
          "task_id",
          "project_id",
          "source_commit_sha",
          "target_base_commit_sha",
          "merge_commit_sha",
          "status",
          "conflict_summary",
          "error_message",
          "created_by_user_id",
          "created_at",
          "completed_at"
        ],
        sql: `
          SELECT
            mr.id,
            mr.task_id,
            mr.project_id,
            mr.source_commit_sha,
            mr.target_base_commit_sha,
            mr.merge_commit_sha,
            mr.status,
            mr.conflict_summary,
            mr.error_message,
            mr.created_by_user_id,
            mr.created_at,
            mr.completed_at
          FROM merge_records mr
          WHERE mr.project_id = ?
          ORDER BY mr.created_at ASC, mr.id ASC
        `,
        sqlParams: [params.projectId]
      });
    }

    if (params.presence.events) {
      const eventScope = buildEventScopePredicate({
        eventAlias: "e",
        includeTasks: params.presence.tasks,
        includeSessions: params.presence.task_sessions && params.presence.tasks
      });
      runCopySelectIntoProjectDb({
        appDb: params.appDb,
        projectDb: params.projectDb,
        targetTable: "events",
        conflictColumns: ["id"],
        columns: ["id", "project_id", "task_id", "session_id", "event_type", "payload", "created_at"],
        sql: `
          SELECT
            e.id,
            e.project_id,
            e.task_id,
            e.session_id,
            e.event_type,
            e.payload,
            e.created_at
          FROM events e
          WHERE ${eventScope.predicate}
          ORDER BY e.created_at ASC, e.id ASC
        `,
        sqlParams: Array.from({ length: eventScope.paramCount }, () => params.projectId)
      });
    }

    if (params.presence.tasks) {
      const restoreRefs = params.projectDb.prepare(
        `UPDATE tasks
         SET parent_plan_task_id = ?,
             source_plan_revision_id = ?,
             source_plan_item_key = ?
         WHERE id = ? AND project_id = ?`
      );
      const sourceTaskRefs = params.appDb.prepare(
        `SELECT id, parent_plan_task_id, source_plan_revision_id, source_plan_item_key
         FROM tasks
         WHERE project_id = ?
         ORDER BY id ASC`
      );
      for (const row of sourceTaskRefs.iterate(params.projectId) as Iterable<Record<string, unknown>>) {
        restoreRefs.run(
          row.parent_plan_task_id ?? null,
          row.source_plan_revision_id ?? null,
          row.source_plan_item_key ?? null,
          row.id,
          params.projectId
        );
      }
    }
  });

  tx();
}

function buildEventScopePredicate(params: {
  eventAlias: string;
  includeTasks: boolean;
  includeSessions: boolean;
}): { predicate: string; paramCount: number } {
  const clauses = [`${params.eventAlias}.project_id = ?`];
  if (params.includeTasks) {
    clauses.push(
      `EXISTS (
         SELECT 1
         FROM tasks t
         WHERE t.id = ${params.eventAlias}.task_id AND t.project_id = ?
       )`
    );
  }
  if (params.includeSessions) {
    clauses.push(
      `EXISTS (
         SELECT 1
         FROM task_sessions ts
         INNER JOIN tasks t ON t.id = ts.task_id
         WHERE ts.id = ${params.eventAlias}.session_id AND t.project_id = ?
       )`
    );
  }
  return {
    predicate: clauses.join(" OR "),
    paramCount: clauses.length
  };
}

function verifyCountsAndChecksums(params: {
  appDb: Database.Database;
  projectDb: Database.Database;
  projectId: string;
  presence: TablePresence;
  includeChecksum: boolean;
  includeProjectConfigComparison: boolean;
}): { result: VerificationResult; checksums?: Record<string, { source: string; target: string }> } {
  const counts: Record<string, VerificationTableResult> = {};
  const checksums: Record<string, { source: string; target: string }> = {};

  const specs: Array<{
    key: string;
    enabled: boolean;
    sourceCountSql: string;
    targetCountSql: string;
    checksumColumns: string[];
    sourceChecksumSql: string;
    targetChecksumSql: string;
    sourceParams: unknown[];
    targetParams: unknown[];
    countPolicy?: "exact" | "target_at_least_source";
    skipChecksum?: boolean;
  }> = [
    {
      key: "tasks",
      enabled: params.presence.tasks,
      sourceCountSql: "SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?",
      targetCountSql: "SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?",
      checksumColumns: [
        "id",
        "project_id",
        "title",
        "task_prompt",
        "result",
        "effective_prompt",
        "ai_command",
        "auto_merge",
        "auto_start",
        "auto_merge_on_complete",
        "mode",
        "parent_plan_task_id",
        "source_plan_revision_id",
        "source_plan_item_key",
        "status",
        "workspace_path",
        "base_commit_sha_at_create",
        "head_commit_sha",
        "cancel_reason",
        "merged_at",
        "merged_by_user_id",
        "created_by_user_id",
        "created_at",
        "updated_at"
      ],
      sourceChecksumSql: `
        SELECT
          id,
          project_id,
          title,
          task_prompt,
          result,
          effective_prompt,
          ai_command,
          auto_merge,
          0 AS auto_start,
          0 AS auto_merge_on_complete,
          mode,
          parent_plan_task_id,
          source_plan_revision_id,
          source_plan_item_key,
          status,
          workspace_path,
          base_commit_sha_at_create,
          head_commit_sha,
          cancel_reason,
          merged_at,
          merged_by_user_id,
          created_by_user_id,
          created_at,
          updated_at
        FROM tasks
        WHERE project_id = ?
        ORDER BY id ASC
      `,
      targetChecksumSql: `
        SELECT
          id,
          project_id,
          title,
          task_prompt,
          result,
          effective_prompt,
          ai_command,
          auto_merge,
          auto_start,
          auto_merge_on_complete,
          mode,
          parent_plan_task_id,
          source_plan_revision_id,
          source_plan_item_key,
          status,
          workspace_path,
          base_commit_sha_at_create,
          head_commit_sha,
          cancel_reason,
          merged_at,
          merged_by_user_id,
          created_by_user_id,
          created_at,
          updated_at
        FROM tasks
        WHERE project_id = ?
        ORDER BY id ASC
      `,
      sourceParams: [params.projectId],
      targetParams: [params.projectId]
    },
    {
      key: "task_dependencies",
      enabled: params.presence.task_dependencies && params.presence.tasks,
      sourceCountSql: `
        SELECT COUNT(*) AS count
        FROM task_dependencies td
        INNER JOIN tasks t ON t.id = td.task_id
        INNER JOIN tasks dep ON dep.id = td.dependency_task_id
        WHERE t.project_id = ? AND dep.project_id = ?
      `,
      targetCountSql: `
        SELECT COUNT(*) AS count
        FROM task_dependencies td
        INNER JOIN tasks t ON t.id = td.task_id
        INNER JOIN tasks dep ON dep.id = td.dependency_task_id
        WHERE t.project_id = ? AND dep.project_id = ?
      `,
      checksumColumns: ["task_id", "dependency_task_id", "created_at"],
      sourceChecksumSql: `
        SELECT
          td.task_id,
          td.dependency_task_id,
          td.created_at
        FROM task_dependencies td
        INNER JOIN tasks t ON t.id = td.task_id
        INNER JOIN tasks dep ON dep.id = td.dependency_task_id
        WHERE t.project_id = ? AND dep.project_id = ?
        ORDER BY td.task_id ASC, td.dependency_task_id ASC
      `,
      targetChecksumSql: `
        SELECT
          td.task_id,
          td.dependency_task_id,
          td.created_at
        FROM task_dependencies td
        INNER JOIN tasks t ON t.id = td.task_id
        INNER JOIN tasks dep ON dep.id = td.dependency_task_id
        WHERE t.project_id = ? AND dep.project_id = ?
        ORDER BY td.task_id ASC, td.dependency_task_id ASC
      `,
      sourceParams: [params.projectId, params.projectId],
      targetParams: [params.projectId, params.projectId]
    },
    {
      key: "task_state_transitions",
      enabled: params.presence.task_state_transitions && params.presence.tasks,
      sourceCountSql: `
        SELECT COUNT(*) AS count
        FROM task_state_transitions tst
        INNER JOIN tasks t ON t.id = tst.task_id
        WHERE t.project_id = ?
      `,
      targetCountSql: `
        SELECT COUNT(*) AS count
        FROM task_state_transitions tst
        INNER JOIN tasks t ON t.id = tst.task_id
        WHERE t.project_id = ?
      `,
      checksumColumns: ["id", "task_id", "from_status", "to_status", "reason", "actor_user_id", "created_at"],
      sourceChecksumSql: `
        SELECT
          tst.id,
          tst.task_id,
          tst.from_status,
          tst.to_status,
          tst.reason,
          tst.actor_user_id,
          tst.created_at
        FROM task_state_transitions tst
        INNER JOIN tasks t ON t.id = tst.task_id
        WHERE t.project_id = ?
        ORDER BY tst.id ASC
      `,
      targetChecksumSql: `
        SELECT
          tst.id,
          tst.task_id,
          tst.from_status,
          tst.to_status,
          tst.reason,
          tst.actor_user_id,
          tst.created_at
        FROM task_state_transitions tst
        INNER JOIN tasks t ON t.id = tst.task_id
        WHERE t.project_id = ?
        ORDER BY tst.id ASC
      `,
      sourceParams: [params.projectId],
      targetParams: [params.projectId]
    },
    {
      key: "task_sessions",
      enabled: params.presence.task_sessions && params.presence.tasks,
      sourceCountSql: `
        SELECT COUNT(*) AS count
        FROM task_sessions ts
        INNER JOIN tasks t ON t.id = ts.task_id
        WHERE t.project_id = ?
      `,
      targetCountSql: `
        SELECT COUNT(*) AS count
        FROM task_sessions ts
        INNER JOIN tasks t ON t.id = ts.task_id
        WHERE t.project_id = ?
      `,
      checksumColumns: [
        "id",
        "task_id",
        "tmux_session_name",
        "tmux_socket_path",
        "pane_id",
        "detected_tool",
        "backend_command",
        "status",
        "started_at",
        "ended_at",
        "last_heartbeat_at",
        "last_output",
        "exit_code",
        "failure_reason"
      ],
      sourceChecksumSql: `
        SELECT
          ts.id,
          ts.task_id,
          ts.tmux_session_name,
          ts.tmux_socket_path,
          ts.pane_id,
          ts.detected_tool,
          ts.backend_command,
          ts.status,
          ts.started_at,
          ts.ended_at,
          ts.last_heartbeat_at,
          ts.last_output,
          ts.exit_code,
          ts.failure_reason
        FROM task_sessions ts
        INNER JOIN tasks t ON t.id = ts.task_id
        WHERE t.project_id = ?
        ORDER BY ts.id ASC
      `,
      targetChecksumSql: `
        SELECT
          ts.id,
          ts.task_id,
          ts.tmux_session_name,
          ts.tmux_socket_path,
          ts.pane_id,
          ts.detected_tool,
          ts.backend_command,
          ts.status,
          ts.started_at,
          ts.ended_at,
          ts.last_heartbeat_at,
          ts.last_output,
          ts.exit_code,
          ts.failure_reason
        FROM task_sessions ts
        INNER JOIN tasks t ON t.id = ts.task_id
        WHERE t.project_id = ?
        ORDER BY ts.id ASC
      `,
      sourceParams: [params.projectId],
      targetParams: [params.projectId]
    },
    {
      key: "plan_revisions",
      enabled: params.presence.plan_revisions && params.presence.tasks,
      sourceCountSql: `
        SELECT COUNT(*) AS count
        FROM plan_revisions pr
        INNER JOIN tasks t ON t.id = pr.plan_task_id
        WHERE t.project_id = ?
      `,
      targetCountSql: `
        SELECT COUNT(*) AS count
        FROM plan_revisions pr
        INNER JOIN tasks t ON t.id = pr.plan_task_id
        WHERE t.project_id = ?
      `,
      checksumColumns: [
        "id",
        "plan_task_id",
        "revision_number",
        "status",
        "feedback",
        "raw_output",
        "parse_error",
        "created_by_user_id",
        "created_at",
        "approved_at"
      ],
      sourceChecksumSql: `
        SELECT
          pr.id,
          pr.plan_task_id,
          pr.revision_number,
          pr.status,
          pr.feedback,
          pr.raw_output,
          pr.parse_error,
          pr.created_by_user_id,
          pr.created_at,
          pr.approved_at
        FROM plan_revisions pr
        INNER JOIN tasks t ON t.id = pr.plan_task_id
        WHERE t.project_id = ?
        ORDER BY pr.id ASC
      `,
      targetChecksumSql: `
        SELECT
          pr.id,
          pr.plan_task_id,
          pr.revision_number,
          pr.status,
          pr.feedback,
          pr.raw_output,
          pr.parse_error,
          pr.created_by_user_id,
          pr.created_at,
          pr.approved_at
        FROM plan_revisions pr
        INNER JOIN tasks t ON t.id = pr.plan_task_id
        WHERE t.project_id = ?
        ORDER BY pr.id ASC
      `,
      sourceParams: [params.projectId],
      targetParams: [params.projectId]
    },
    {
      key: "plan_revision_items",
      enabled: params.presence.plan_revision_items && params.presence.plan_revisions && params.presence.tasks,
      sourceCountSql: `
        SELECT COUNT(*) AS count
        FROM plan_revision_items pri
        INNER JOIN plan_revisions pr ON pr.id = pri.revision_id
        INNER JOIN tasks t ON t.id = pr.plan_task_id
        WHERE t.project_id = ?
      `,
      targetCountSql: `
        SELECT COUNT(*) AS count
        FROM plan_revision_items pri
        INNER JOIN plan_revisions pr ON pr.id = pri.revision_id
        INNER JOIN tasks t ON t.id = pr.plan_task_id
        WHERE t.project_id = ?
      `,
      checksumColumns: ["id", "revision_id", "item_key", "item_type", "title", "prompt", "ordinal", "created_at"],
      sourceChecksumSql: `
        SELECT
          pri.id,
          pri.revision_id,
          pri.item_key,
          'execution_task' AS item_type,
          pri.title,
          pri.prompt,
          pri.ordinal,
          pri.created_at
        FROM plan_revision_items pri
        INNER JOIN plan_revisions pr ON pr.id = pri.revision_id
        INNER JOIN tasks t ON t.id = pr.plan_task_id
        WHERE t.project_id = ?
        ORDER BY pri.id ASC
      `,
      targetChecksumSql: `
        SELECT
          pri.id,
          pri.revision_id,
          pri.item_key,
          pri.item_type,
          pri.title,
          pri.prompt,
          pri.ordinal,
          pri.created_at
        FROM plan_revision_items pri
        INNER JOIN plan_revisions pr ON pr.id = pri.revision_id
        INNER JOIN tasks t ON t.id = pr.plan_task_id
        WHERE t.project_id = ?
        ORDER BY pri.id ASC
      `,
      sourceParams: [params.projectId],
      targetParams: [params.projectId]
    },
    {
      key: "plan_revision_item_dependencies",
      enabled:
        params.presence.plan_revision_item_dependencies &&
        params.presence.plan_revision_items &&
        params.presence.plan_revisions &&
        params.presence.tasks,
      sourceCountSql: `
        SELECT COUNT(*) AS count
        FROM plan_revision_item_dependencies prid
        INNER JOIN plan_revision_items pri ON pri.id = prid.revision_item_id
        INNER JOIN plan_revisions pr ON pr.id = pri.revision_id
        INNER JOIN tasks t ON t.id = pr.plan_task_id
        WHERE t.project_id = ?
      `,
      targetCountSql: `
        SELECT COUNT(*) AS count
        FROM plan_revision_item_dependencies prid
        INNER JOIN plan_revision_items pri ON pri.id = prid.revision_item_id
        INNER JOIN plan_revisions pr ON pr.id = pri.revision_id
        INNER JOIN tasks t ON t.id = pr.plan_task_id
        WHERE t.project_id = ?
      `,
      checksumColumns: ["revision_item_id", "depends_on_item_key"],
      sourceChecksumSql: `
        SELECT
          prid.revision_item_id,
          prid.depends_on_item_key
        FROM plan_revision_item_dependencies prid
        INNER JOIN plan_revision_items pri ON pri.id = prid.revision_item_id
        INNER JOIN plan_revisions pr ON pr.id = pri.revision_id
        INNER JOIN tasks t ON t.id = pr.plan_task_id
        WHERE t.project_id = ?
        ORDER BY prid.revision_item_id ASC, prid.depends_on_item_key ASC
      `,
      targetChecksumSql: `
        SELECT
          prid.revision_item_id,
          prid.depends_on_item_key
        FROM plan_revision_item_dependencies prid
        INNER JOIN plan_revision_items pri ON pri.id = prid.revision_item_id
        INNER JOIN plan_revisions pr ON pr.id = pri.revision_id
        INNER JOIN tasks t ON t.id = pr.plan_task_id
        WHERE t.project_id = ?
        ORDER BY prid.revision_item_id ASC, prid.depends_on_item_key ASC
      `,
      sourceParams: [params.projectId],
      targetParams: [params.projectId]
    },
    {
      key: "ide_instances",
      enabled: params.presence.ide_instances && params.presence.tasks,
      countPolicy: "target_at_least_source",
      skipChecksum: true,
      sourceCountSql: `
        SELECT COUNT(*) AS count
        FROM ide_instances ii
        INNER JOIN tasks t ON t.id = ii.task_id
        WHERE t.project_id = ?
      `,
      targetCountSql: `
        SELECT COUNT(*) AS count
        FROM ide_instances ii
        INNER JOIN tasks t ON t.id = ii.task_id
        WHERE t.project_id = ?
      `,
      checksumColumns: ["id", "task_id", "provider", "url", "access_token_hash", "status", "started_at", "ended_at", "last_heartbeat_at"],
      sourceChecksumSql: `
        SELECT
          ii.id,
          ii.task_id,
          ii.provider,
          ii.url,
          ii.access_token_hash,
          ii.status,
          ii.started_at,
          ii.ended_at,
          ii.last_heartbeat_at
        FROM ide_instances ii
        INNER JOIN tasks t ON t.id = ii.task_id
        WHERE t.project_id = ?
        ORDER BY ii.id ASC
      `,
      targetChecksumSql: `
        SELECT
          ii.id,
          ii.task_id,
          ii.provider,
          ii.url,
          ii.access_token_hash,
          ii.status,
          ii.started_at,
          ii.ended_at,
          ii.last_heartbeat_at
        FROM ide_instances ii
        INNER JOIN tasks t ON t.id = ii.task_id
        WHERE t.project_id = ?
        ORDER BY ii.id ASC
      `,
      sourceParams: [params.projectId],
      targetParams: [params.projectId]
    },
    {
      key: "merge_records",
      enabled: params.presence.merge_records,
      sourceCountSql: "SELECT COUNT(*) AS count FROM merge_records WHERE project_id = ?",
      targetCountSql: "SELECT COUNT(*) AS count FROM merge_records WHERE project_id = ?",
      checksumColumns: [
        "id",
        "task_id",
        "project_id",
        "source_commit_sha",
        "target_base_commit_sha",
        "merge_commit_sha",
        "status",
        "conflict_summary",
        "error_message",
        "created_by_user_id",
        "created_at",
        "completed_at"
      ],
      sourceChecksumSql: `
        SELECT
          id,
          task_id,
          project_id,
          source_commit_sha,
          target_base_commit_sha,
          merge_commit_sha,
          status,
          conflict_summary,
          error_message,
          created_by_user_id,
          created_at,
          completed_at
        FROM merge_records
        WHERE project_id = ?
        ORDER BY id ASC
      `,
      targetChecksumSql: `
        SELECT
          id,
          task_id,
          project_id,
          source_commit_sha,
          target_base_commit_sha,
          merge_commit_sha,
          status,
          conflict_summary,
          error_message,
          created_by_user_id,
          created_at,
          completed_at
        FROM merge_records
        WHERE project_id = ?
        ORDER BY id ASC
      `,
      sourceParams: [params.projectId],
      targetParams: [params.projectId]
    }
  ];

  for (const spec of specs) {
    if (!spec.enabled) {
      continue;
    }

    const source = (params.appDb.prepare(spec.sourceCountSql).get(...spec.sourceParams) as { count: number }).count;
    const target = (params.projectDb.prepare(spec.targetCountSql).get(...spec.targetParams) as { count: number }).count;

    const countPolicy = spec.countPolicy ?? "target_at_least_source";
    const countMismatch =
      countPolicy === "target_at_least_source" ? target < source : source !== target;
    if (countMismatch) {
      throw new Error(`Row count mismatch for ${spec.key}: source=${source}, target=${target}`);
    }

    const entry: VerificationTableResult = { source, target };
    if (params.includeChecksum && !spec.skipChecksum && source === target) {
      const checksumSource = checksumForQuery(params.appDb, spec.sourceChecksumSql, spec.sourceParams, spec.checksumColumns);
      const checksumTarget = checksumForQuery(params.projectDb, spec.targetChecksumSql, spec.targetParams, spec.checksumColumns);
      if (checksumSource !== checksumTarget) {
        throw new Error(`Checksum mismatch for ${spec.key}: source=${checksumSource}, target=${checksumTarget}`);
      }
      entry.checksumSource = checksumSource;
      entry.checksumTarget = checksumTarget;
      checksums[spec.key] = { source: checksumSource, target: checksumTarget };
    }

    counts[spec.key] = entry;
  }

  if (params.presence.events) {
    const eventScope = buildEventScopePredicate({
      eventAlias: "e",
      includeTasks: params.presence.tasks,
      includeSessions: params.presence.task_sessions && params.presence.tasks
    });
    const eventScopeParams = Array.from({ length: eventScope.paramCount }, () => params.projectId);
    const sourceCountSql = `SELECT COUNT(*) AS count FROM events e WHERE ${eventScope.predicate}`;
    const targetCountSql = `SELECT COUNT(*) AS count FROM events e WHERE ${eventScope.predicate}`;
    const source = (params.appDb.prepare(sourceCountSql).get(...eventScopeParams) as { count: number }).count;
    const target = (params.projectDb.prepare(targetCountSql).get(...eventScopeParams) as { count: number }).count;
    if (target < source) {
      throw new Error(`Row count mismatch for events: source=${source}, target=${target}`);
    }

    const entry: VerificationTableResult = { source, target };
    if (params.includeChecksum && source === target) {
      const checksumColumns = ["id", "project_id", "task_id", "session_id", "event_type", "payload", "created_at"];
      const sourceChecksumSql = `
        SELECT
          e.id,
          e.project_id,
          e.task_id,
          e.session_id,
          e.event_type,
          e.payload,
          e.created_at
        FROM events e
        WHERE ${eventScope.predicate}
        ORDER BY e.id ASC
      `;
      const targetChecksumSql = `
        SELECT
          e.id,
          e.project_id,
          e.task_id,
          e.session_id,
          e.event_type,
          e.payload,
          e.created_at
        FROM events e
        WHERE ${eventScope.predicate}
        ORDER BY e.id ASC
      `;
      const checksumSource = checksumForQuery(params.appDb, sourceChecksumSql, eventScopeParams, checksumColumns);
      const checksumTarget = checksumForQuery(params.projectDb, targetChecksumSql, eventScopeParams, checksumColumns);
      if (checksumSource !== checksumTarget) {
        throw new Error(`Checksum mismatch for events: source=${checksumSource}, target=${checksumTarget}`);
      }
      entry.checksumSource = checksumSource;
      entry.checksumTarget = checksumTarget;
      checksums.events = { source: checksumSource, target: checksumTarget };
    }

    counts.events = entry;
  }

  if (params.includeProjectConfigComparison) {
    const sourceConfig = params.appDb
      .prepare(
        `SELECT project_prompt, project_rules, coding_standard, coding_standard_other, project_other
         FROM projects
         WHERE id = ?`
      )
      .get(params.projectId) as ProjectConfigLegacyValues | undefined;

    if (sourceConfig) {
      const targetConfig = params.projectDb
        .prepare(
          `SELECT project_prompt, project_rules, coding_standard, coding_standard_other, project_other
           FROM project_config
           WHERE project_id = ?`
        )
        .get(params.projectId) as ProjectConfigLegacyValues | undefined;

      if (!targetConfig) {
        throw new Error("Missing project_config row in project DB");
      }

      const same =
        sourceConfig.project_prompt === targetConfig.project_prompt &&
        sourceConfig.project_rules === targetConfig.project_rules &&
        sourceConfig.coding_standard === targetConfig.coding_standard &&
        sourceConfig.coding_standard_other === targetConfig.coding_standard_other &&
        sourceConfig.project_other === targetConfig.project_other;

      if (!same) {
        throw new Error("Project config mismatch between app DB projects row and project DB project_config row");
      }

      counts.project_config = { source: 1, target: 1 };
      if (params.includeChecksum) {
        const sourceChecksum = createHash("sha256").update(toSqlJson(sourceConfig)).digest("hex");
        const targetChecksum = createHash("sha256").update(toSqlJson(targetConfig)).digest("hex");
        if (sourceChecksum !== targetChecksum) {
          throw new Error(`Checksum mismatch for project_config: source=${sourceChecksum}, target=${targetChecksum}`);
        }
        counts.project_config.checksumSource = sourceChecksum;
        counts.project_config.checksumTarget = targetChecksum;
        checksums.project_config = { source: sourceChecksum, target: targetChecksum };
      }
    }
  }

  return {
    result: { counts },
    checksums: params.includeChecksum ? checksums : undefined
  };
}

function copyLegacyProjectConfigIntoProjectDb(params: {
  appDb: Database.Database;
  projectId: string;
  basePath: string;
  canReadProjectConfig: boolean;
}): void {
  if (!params.canReadProjectConfig) {
    return;
  }

  const config = params.appDb
    .prepare(
      `SELECT project_prompt, project_rules, coding_standard, coding_standard_other, project_other
       FROM projects
       WHERE id = ?`
    )
    .get(params.projectId) as ProjectConfigLegacyValues | undefined;

  if (!config) {
    return;
  }

  upsertProjectConfig({
    projectId: params.projectId,
    basePath: params.basePath,
    projectPrompt: config.project_prompt,
    projectRules: config.project_rules,
    codingStandard: config.coding_standard,
    codingStandardOther: config.coding_standard_other,
    projectOther: config.project_other
  });
}

function cleanupLegacyProjectData(params: {
  appDb: Database.Database;
  projectId: string;
  presence: TablePresence;
  clearProjectConfigColumns: boolean;
}): void {
  const tx = params.appDb.transaction(() => {
    if (
      params.presence.plan_revision_item_dependencies &&
      params.presence.plan_revision_items &&
      params.presence.plan_revisions &&
      params.presence.tasks
    ) {
      params.appDb.prepare(
        `DELETE FROM plan_revision_item_dependencies
         WHERE revision_item_id IN (
           SELECT pri.id
           FROM plan_revision_items pri
           INNER JOIN plan_revisions pr ON pr.id = pri.revision_id
           INNER JOIN tasks t ON t.id = pr.plan_task_id
           WHERE t.project_id = ?
         )`
      ).run(params.projectId);
    }

    if (params.presence.plan_revision_items && params.presence.plan_revisions && params.presence.tasks) {
      params.appDb.prepare(
        `DELETE FROM plan_revision_items
         WHERE revision_id IN (
           SELECT pr.id
           FROM plan_revisions pr
           INNER JOIN tasks t ON t.id = pr.plan_task_id
           WHERE t.project_id = ?
         )`
      ).run(params.projectId);
    }

    if (params.presence.plan_revisions && params.presence.tasks) {
      params.appDb.prepare(
        `DELETE FROM plan_revisions
         WHERE plan_task_id IN (
           SELECT id
           FROM tasks
           WHERE project_id = ?
         )`
      ).run(params.projectId);
    }

    if (params.presence.task_dependencies && params.presence.tasks) {
      params.appDb.prepare(
        `DELETE FROM task_dependencies
         WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)
            OR dependency_task_id IN (SELECT id FROM tasks WHERE project_id = ?)`
      ).run(params.projectId, params.projectId);
    }

    if (params.presence.task_state_transitions && params.presence.tasks) {
      params.appDb.prepare(
        `DELETE FROM task_state_transitions
         WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`
      ).run(params.projectId);
    }

    if (params.presence.ide_instances && params.presence.tasks) {
      params.appDb.prepare(
        `DELETE FROM ide_instances
         WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`
      ).run(params.projectId);
    }

    if (params.presence.events) {
      const eventScope = buildEventScopePredicate({
        eventAlias: "events",
        includeTasks: params.presence.tasks,
        includeSessions: params.presence.task_sessions && params.presence.tasks
      });
      const sql = `DELETE FROM events WHERE ${eventScope.predicate}`;
      params.appDb.prepare(sql).run(...Array.from({ length: eventScope.paramCount }, () => params.projectId));
    }

    if (params.presence.merge_records) {
      params.appDb.prepare("DELETE FROM merge_records WHERE project_id = ?").run(params.projectId);
    }

    if (params.presence.task_sessions && params.presence.tasks) {
      params.appDb.prepare(
        `DELETE FROM task_sessions
         WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`
      ).run(params.projectId);
    }

    if (params.presence.tasks) {
      params.appDb.prepare("DELETE FROM tasks WHERE project_id = ?").run(params.projectId);
    }

    if (params.clearProjectConfigColumns) {
      params.appDb.prepare(
        `UPDATE projects
         SET project_prompt = '',
             project_rules = '',
             coding_standard = '',
             coding_standard_other = '',
             project_other = ''
         WHERE id = ?`
      ).run(params.projectId);
    }
  });

  tx();
}

function verifyLegacyCleanup(params: {
  appDb: Database.Database;
  projectId: string;
  presence: TablePresence;
  clearProjectConfigColumns: boolean;
}): void {
  const checks: Array<{ enabled: boolean; sql: string; params: unknown[]; key: string }> = [
    {
      key: "tasks",
      enabled: params.presence.tasks,
      sql: "SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?",
      params: [params.projectId]
    },
    {
      key: "task_dependencies",
      enabled: params.presence.task_dependencies && params.presence.tasks,
      sql: `
        SELECT COUNT(*) AS count
        FROM task_dependencies
        WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)
           OR dependency_task_id IN (SELECT id FROM tasks WHERE project_id = ?)
      `,
      params: [params.projectId, params.projectId]
    },
    {
      key: "task_state_transitions",
      enabled: params.presence.task_state_transitions && params.presence.tasks,
      sql: "SELECT COUNT(*) AS count FROM task_state_transitions WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)",
      params: [params.projectId]
    },
    {
      key: "task_sessions",
      enabled: params.presence.task_sessions && params.presence.tasks,
      sql: "SELECT COUNT(*) AS count FROM task_sessions WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)",
      params: [params.projectId]
    },
    {
      key: "plan_revisions",
      enabled: params.presence.plan_revisions && params.presence.tasks,
      sql: "SELECT COUNT(*) AS count FROM plan_revisions WHERE plan_task_id IN (SELECT id FROM tasks WHERE project_id = ?)",
      params: [params.projectId]
    },
    {
      key: "plan_revision_items",
      enabled: params.presence.plan_revision_items && params.presence.plan_revisions && params.presence.tasks,
      sql: `
        SELECT COUNT(*) AS count
        FROM plan_revision_items
        WHERE revision_id IN (
          SELECT pr.id
          FROM plan_revisions pr
          INNER JOIN tasks t ON t.id = pr.plan_task_id
          WHERE t.project_id = ?
        )
      `,
      params: [params.projectId]
    },
    {
      key: "plan_revision_item_dependencies",
      enabled:
        params.presence.plan_revision_item_dependencies &&
        params.presence.plan_revision_items &&
        params.presence.plan_revisions &&
        params.presence.tasks,
      sql: `
        SELECT COUNT(*) AS count
        FROM plan_revision_item_dependencies
        WHERE revision_item_id IN (
          SELECT pri.id
          FROM plan_revision_items pri
          INNER JOIN plan_revisions pr ON pr.id = pri.revision_id
          INNER JOIN tasks t ON t.id = pr.plan_task_id
          WHERE t.project_id = ?
        )
      `,
      params: [params.projectId]
    },
    {
      key: "ide_instances",
      enabled: params.presence.ide_instances && params.presence.tasks,
      sql: "SELECT COUNT(*) AS count FROM ide_instances WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)",
      params: [params.projectId]
    },
    {
      key: "merge_records",
      enabled: params.presence.merge_records,
      sql: "SELECT COUNT(*) AS count FROM merge_records WHERE project_id = ?",
      params: [params.projectId]
    }
  ];

  for (const check of checks) {
    if (!check.enabled) {
      continue;
    }
    const count = (params.appDb.prepare(check.sql).get(...check.params) as { count: number }).count;
    if (count !== 0) {
      throw new Error(`Legacy cleanup validation failed for ${check.key}: expected 0 rows, found ${count}`);
    }
  }

  if (params.presence.events) {
    const eventScope = buildEventScopePredicate({
      eventAlias: "events",
      includeTasks: params.presence.tasks,
      includeSessions: params.presence.task_sessions && params.presence.tasks
    });
    const countSql = `SELECT COUNT(*) AS count FROM events WHERE ${eventScope.predicate}`;
    const count = (
      params.appDb
        .prepare(countSql)
        .get(...Array.from({ length: eventScope.paramCount }, () => params.projectId)) as { count: number }
    ).count;
    if (count !== 0) {
      throw new Error(`Legacy cleanup validation failed for events: expected 0 rows, found ${count}`);
    }
  }

  if (params.clearProjectConfigColumns) {
    const config = params.appDb
      .prepare(
        `SELECT project_prompt, project_rules, coding_standard, coding_standard_other, project_other
         FROM projects
         WHERE id = ?`
      )
      .get(params.projectId) as ProjectConfigLegacyValues | undefined;

    if (
      config &&
      (config.project_prompt !== "" ||
        config.project_rules !== "" ||
        config.coding_standard !== "" ||
        config.coding_standard_other !== "" ||
        config.project_other !== "")
    ) {
      throw new Error("Legacy project config columns were not cleared after cleanup");
    }
  }
}

function readMigrationStatus(db: Database.Database, projectId: string): ProjectDataMigrationStatus | undefined {
  const row = db
    .prepare("SELECT status FROM project_data_migrations WHERE project_id = ?")
    .get(projectId) as { status: ProjectDataMigrationStatus } | undefined;
  return row?.status;
}

function shouldEnableChecksums(): boolean {
  return process.env.PROJECT_DATA_MIGRATION_VERIFY_CHECKSUMS === "1";
}

function shouldEnableCleanup(): boolean {
  return process.env.PROJECT_DATA_MIGRATION_CLEANUP_LEGACY === "1" || isCleanupPhaseEnabled();
}

export function collectProjectMigrationHealth(db: Database.Database): {
  counts: Record<ProjectDataMigrationStatus, number>;
  byProject: Array<{ projectId: string; status: ProjectDataMigrationStatus; lastError: string | null; updatedAt: string }>;
} {
  if (!tableExists(db, "project_data_migrations")) {
    return {
      counts: {
        pending: 0,
        in_progress: 0,
        verified: 0,
        cleaned: 0,
        failed: 0
      },
      byProject: []
    };
  }
  const rows = db
    .prepare(
      `SELECT project_id, status, last_error, updated_at
       FROM project_data_migrations
       ORDER BY updated_at DESC, project_id ASC`
    )
    .all() as Array<{ project_id: string; status: ProjectDataMigrationStatus; last_error: string | null; updated_at: string }>;

  const counts: Record<ProjectDataMigrationStatus, number> = {
    pending: 0,
    in_progress: 0,
    verified: 0,
    cleaned: 0,
    failed: 0
  };
  for (const row of rows) {
    counts[row.status] += 1;
  }
  return {
    counts,
    byProject: rows.slice(0, 20).map((row) => ({
      projectId: row.project_id,
      status: row.status,
      lastError: row.last_error,
      updatedAt: row.updated_at
    }))
  };
}

export function runProjectDataMigrationBackfill(db: Database.Database): void {
  db.exec(migrationTableSql);

  const presence = buildTablePresence(db);
  const hasAnyLegacyTable = Object.values(presence).some(Boolean);
  const includeProjectConfigComparison = canReadLegacyProjectConfig(db);

  if (!hasAnyLegacyTable && !includeProjectConfigComparison) {
    return;
  }

  const includeChecksum = shouldEnableChecksums();
  const enableCleanup = shouldEnableCleanup();

  const projects = db
    .prepare("SELECT id, base_path FROM projects ORDER BY created_at ASC, id ASC")
    .all() as ProjectScope[];

  for (const project of projects) {
    const existingStatus = readMigrationStatus(db, project.id);
    if (existingStatus === "cleaned") {
      continue;
    }
    if (existingStatus === "verified" && !enableCleanup) {
      // Verified/failed projects may continue receiving writes in project DB during cutover.
      // Re-running source-vs-target count verification would create false mismatches.
      continue;
    }

    const startedAt = nowIso();
    upsertMigrationStatus({
      db,
      projectId: project.id,
      status: "in_progress",
      startedAt,
      incrementAttempt: true
    });

    try {
      ensureProjectDb({
        projectId: project.id,
        basePath: project.base_path,
        initializeIfMissing: true
      });

      copyLegacyProjectConfigIntoProjectDb({
        appDb: db,
        projectId: project.id,
        basePath: project.base_path,
        canReadProjectConfig: includeProjectConfigComparison
      });

      const projectDb = ensureProjectDb({
        projectId: project.id,
        basePath: project.base_path,
        initializeIfMissing: true
      }).db;

      copyLegacyDataForProject({
        appDb: db,
        projectDb,
        projectId: project.id,
        presence
      });

      const verification = verifyCountsAndChecksums({
        appDb: db,
        projectDb,
        projectId: project.id,
        presence,
        includeChecksum,
        includeProjectConfigComparison
      });

      const verifiedAt = nowIso();
      upsertMigrationStatus({
        db,
        projectId: project.id,
        status: "verified",
        counts: verification.result.counts,
        checksums: verification.checksums,
        error: null,
        startedAt,
        verifiedAt
      });

      if (enableCleanup) {
        cleanupLegacyProjectData({
          appDb: db,
          projectId: project.id,
          presence,
          clearProjectConfigColumns: includeProjectConfigComparison
        });
        verifyLegacyCleanup({
          appDb: db,
          projectId: project.id,
          presence,
          clearProjectConfigColumns: includeProjectConfigComparison
        });

        const cleanedAt = nowIso();
        upsertMigrationStatus({
          db,
          projectId: project.id,
          status: "cleaned",
          counts: verification.result.counts,
          checksums: verification.checksums,
          error: null,
          startedAt,
          verifiedAt,
          cleanedAt
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertMigrationStatus({
        db,
        projectId: project.id,
        status: "failed",
        error: message,
        startedAt
      });
      const diagnostic = recordProjectDbFailure({
        stage: "migration",
        code: "PROJECT_DATA_MIGRATION_FAILED",
        projectId: project.id,
        basePath: project.base_path,
        message
      });
      logWarn("project_data_migration.failed", diagnostic);
    }
  }

  if (enableCleanup) {
    logInfo("project_data_migration.cleanup_enabled", {
      reason: "PROJECT_DATA_MIGRATION_CLEANUP_LEGACY=1 or SPLIT_PERSISTENCE_PHASE=cleanup"
    });
  }
  if (includeChecksum) {
    logInfo("project_data_migration.checksum_enabled", {
      reason: "PROJECT_DATA_MIGRATION_VERIFY_CHECKSUMS=1"
    });
  }
}
