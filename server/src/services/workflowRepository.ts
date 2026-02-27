import type Database from "better-sqlite3";
import type {
  WorkflowCheckResultRow,
  WorkflowCheckStatus,
  WorkflowDefinitionRow,
  WorkflowEventRow,
  WorkflowRunRow,
  WorkflowRunStatus,
  WorkflowStageRunRow,
  WorkflowStageRunStatus
} from "../types.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

export class WorkflowTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowTransitionError";
  }
}

const RUN_TRANSITIONS: Record<WorkflowRunStatus, ReadonlySet<WorkflowRunStatus>> = {
  queued: new Set<WorkflowRunStatus>(["running", "cancelled"]),
  running: new Set<WorkflowRunStatus>(["succeeded", "failed", "cancelled"]),
  succeeded: new Set<WorkflowRunStatus>(["succeeded"]),
  failed: new Set<WorkflowRunStatus>(["failed"]),
  cancelled: new Set<WorkflowRunStatus>(["cancelled"])
};

const STAGE_TRANSITIONS: Record<WorkflowStageRunStatus, ReadonlySet<WorkflowStageRunStatus>> = {
  pending: new Set<WorkflowStageRunStatus>(["running", "skipped", "cancelled"]),
  running: new Set<WorkflowStageRunStatus>(["succeeded", "failed", "cancelled"]),
  succeeded: new Set<WorkflowStageRunStatus>(["succeeded"]),
  failed: new Set<WorkflowStageRunStatus>(["failed"]),
  skipped: new Set<WorkflowStageRunStatus>(["skipped"]),
  cancelled: new Set<WorkflowStageRunStatus>(["cancelled"])
};

function isRunTerminal(status: WorkflowRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isStageTerminal(status: WorkflowStageRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped" || status === "cancelled";
}

function assertRunTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void {
  const allowed = RUN_TRANSITIONS[from]?.has(to) ?? false;
  if (!allowed) {
    throw new WorkflowTransitionError(`invalid run transition: ${from} -> ${to}`);
  }
}

function assertStageTransition(from: WorkflowStageRunStatus, to: WorkflowStageRunStatus): void {
  const allowed = STAGE_TRANSITIONS[from]?.has(to) ?? false;
  if (!allowed) {
    throw new WorkflowTransitionError(`invalid stage transition: ${from} -> ${to}`);
  }
}

function asJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function createWorkflowDefinition(
  db: Database.Database,
  input: {
    id?: string;
    projectId: string;
    name: string;
    version: number;
    definitionYaml: string;
    createdByUserId: string;
  }
): WorkflowDefinitionRow {
  const id = input.id ?? makeId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, project_id, name, version, definition_yaml, created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.projectId, input.name, input.version, input.definitionYaml, input.createdByUserId, now, now);
  return getWorkflowDefinitionById(db, id)!;
}

export function getWorkflowDefinitionById(db: Database.Database, id: string): WorkflowDefinitionRow | undefined {
  return db.prepare("SELECT * FROM workflow_definitions WHERE id = ? LIMIT 1").get(id) as WorkflowDefinitionRow | undefined;
}

export function listWorkflowDefinitionsByProject(db: Database.Database, projectId: string): WorkflowDefinitionRow[] {
  return db
    .prepare("SELECT * FROM workflow_definitions WHERE project_id = ? ORDER BY created_at ASC")
    .all(projectId) as WorkflowDefinitionRow[];
}

export function updateWorkflowDefinition(
  db: Database.Database,
  input: {
    id: string;
    name: string;
    version: number;
    definitionYaml: string;
  }
): WorkflowDefinitionRow | undefined {
  db.prepare(
    `UPDATE workflow_definitions
     SET name = ?, version = ?, definition_yaml = ?, updated_at = ?
     WHERE id = ?`
  ).run(input.name, input.version, input.definitionYaml, nowIso(), input.id);
  return getWorkflowDefinitionById(db, input.id);
}

export function deleteWorkflowDefinition(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM workflow_definitions WHERE id = ?").run(id);
  return result.changes > 0;
}

export function createWorkflowRun(
  db: Database.Database,
  input: {
    id?: string;
    workflowDefinitionId: string;
    projectId: string;
    taskId?: string | null;
    status?: WorkflowRunStatus;
  }
): WorkflowRunRow {
  const id = input.id ?? makeId();
  const now = nowIso();
  const status = input.status ?? "queued";
  db.prepare(
    `INSERT INTO workflow_runs (
       id, workflow_definition_id, project_id, task_id, status, started_at, completed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
  ).run(id, input.workflowDefinitionId, input.projectId, input.taskId ?? null, status, now, now);
  return getWorkflowRunById(db, id)!;
}

export function getWorkflowRunById(db: Database.Database, id: string): WorkflowRunRow | undefined {
  return db.prepare("SELECT * FROM workflow_runs WHERE id = ? LIMIT 1").get(id) as WorkflowRunRow | undefined;
}

export function listWorkflowRunsByProject(db: Database.Database, projectId: string): WorkflowRunRow[] {
  return db.prepare("SELECT * FROM workflow_runs WHERE project_id = ? ORDER BY created_at ASC").all(projectId) as WorkflowRunRow[];
}

export function updateWorkflowRun(
  db: Database.Database,
  input: {
    id: string;
    taskId?: string | null;
  }
): WorkflowRunRow | undefined {
  db.prepare("UPDATE workflow_runs SET task_id = ?, updated_at = ? WHERE id = ?").run(input.taskId ?? null, nowIso(), input.id);
  return getWorkflowRunById(db, input.id);
}

export function deleteWorkflowRun(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(id);
  return result.changes > 0;
}

export function transitionWorkflowRunStatus(
  db: Database.Database,
  input: {
    runId: string;
    toStatus: WorkflowRunStatus;
    eventId?: string;
    reason?: string;
    payload?: Record<string, unknown>;
  }
): WorkflowRunRow {
  const tx = db.transaction(() => {
    const existing = getWorkflowRunById(db, input.runId);
    if (!existing) {
      throw new WorkflowTransitionError(`workflow run not found: ${input.runId}`);
    }
    assertRunTransition(existing.status, input.toStatus);
    const now = nowIso();
    const startedAt = existing.started_at ?? (input.toStatus === "running" ? now : null);
    const completedAt = isRunTerminal(input.toStatus) ? now : null;

    db.prepare(
      `UPDATE workflow_runs
       SET status = ?, started_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(input.toStatus, startedAt, completedAt, now, input.runId);

    db.prepare(
      `INSERT INTO workflow_events (id, workflow_run_id, workflow_stage_run_id, event_type, payload, created_at)
       VALUES (?, ?, NULL, ?, ?, ?)`
    ).run(
      input.eventId ?? makeId(),
      input.runId,
      "workflow.run.status_changed",
      asJson({
        fromStatus: existing.status,
        toStatus: input.toStatus,
        reason: input.reason ?? null,
        ...(input.payload ?? {})
      }),
      now
    );

    return getWorkflowRunById(db, input.runId)!;
  });
  return tx();
}

export function createWorkflowStageRun(
  db: Database.Database,
  input: {
    id?: string;
    workflowRunId: string;
    stageKey: string;
    ordinal: number;
    status?: WorkflowStageRunStatus;
  }
): WorkflowStageRunRow {
  const id = input.id ?? makeId();
  const now = nowIso();
  const status = input.status ?? "pending";
  db.prepare(
    `INSERT INTO workflow_stage_runs (
       id, workflow_run_id, stage_key, ordinal, status, started_at, completed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
  ).run(id, input.workflowRunId, input.stageKey, input.ordinal, status, now, now);
  return getWorkflowStageRunById(db, id)!;
}

export function getWorkflowStageRunById(db: Database.Database, id: string): WorkflowStageRunRow | undefined {
  return db.prepare("SELECT * FROM workflow_stage_runs WHERE id = ? LIMIT 1").get(id) as WorkflowStageRunRow | undefined;
}

export function listWorkflowStageRunsByRun(db: Database.Database, workflowRunId: string): WorkflowStageRunRow[] {
  return db
    .prepare("SELECT * FROM workflow_stage_runs WHERE workflow_run_id = ? ORDER BY ordinal ASC")
    .all(workflowRunId) as WorkflowStageRunRow[];
}

export function updateWorkflowStageRun(
  db: Database.Database,
  input: {
    id: string;
    ordinal: number;
  }
): WorkflowStageRunRow | undefined {
  db.prepare("UPDATE workflow_stage_runs SET ordinal = ?, updated_at = ? WHERE id = ?").run(input.ordinal, nowIso(), input.id);
  return getWorkflowStageRunById(db, input.id);
}

export function deleteWorkflowStageRun(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM workflow_stage_runs WHERE id = ?").run(id);
  return result.changes > 0;
}

export function transitionWorkflowStageRunStatus(
  db: Database.Database,
  input: {
    stageRunId: string;
    toStatus: WorkflowStageRunStatus;
    eventId?: string;
    reason?: string;
    payload?: Record<string, unknown>;
  }
): WorkflowStageRunRow {
  const tx = db.transaction(() => {
    const existing = getWorkflowStageRunById(db, input.stageRunId);
    if (!existing) {
      throw new WorkflowTransitionError(`workflow stage run not found: ${input.stageRunId}`);
    }
    assertStageTransition(existing.status, input.toStatus);
    const now = nowIso();
    const startedAt = existing.started_at ?? (input.toStatus === "running" ? now : null);
    const completedAt = isStageTerminal(input.toStatus) ? now : null;

    db.prepare(
      `UPDATE workflow_stage_runs
       SET status = ?, started_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(input.toStatus, startedAt, completedAt, now, input.stageRunId);

    db.prepare(
      `INSERT INTO workflow_events (id, workflow_run_id, workflow_stage_run_id, event_type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      input.eventId ?? makeId(),
      existing.workflow_run_id,
      input.stageRunId,
      "workflow.stage_run.status_changed",
      asJson({
        fromStatus: existing.status,
        toStatus: input.toStatus,
        reason: input.reason ?? null,
        ...(input.payload ?? {})
      }),
      now
    );

    return getWorkflowStageRunById(db, input.stageRunId)!;
  });
  return tx();
}

export function createWorkflowCheckResult(
  db: Database.Database,
  input: {
    id?: string;
    workflowStageRunId: string;
    checkName: string;
    status: WorkflowCheckStatus;
    details?: unknown;
  }
): WorkflowCheckResultRow {
  const id = input.id ?? makeId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO workflow_check_results (
       id, workflow_stage_run_id, check_name, status, details_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.workflowStageRunId, input.checkName, input.status, asJson(input.details), now, now);
  return getWorkflowCheckResultById(db, id)!;
}

export function getWorkflowCheckResultById(db: Database.Database, id: string): WorkflowCheckResultRow | undefined {
  return db.prepare("SELECT * FROM workflow_check_results WHERE id = ? LIMIT 1").get(id) as WorkflowCheckResultRow | undefined;
}

export function listWorkflowCheckResultsByStageRun(db: Database.Database, workflowStageRunId: string): WorkflowCheckResultRow[] {
  return db
    .prepare("SELECT * FROM workflow_check_results WHERE workflow_stage_run_id = ? ORDER BY created_at ASC")
    .all(workflowStageRunId) as WorkflowCheckResultRow[];
}

export function updateWorkflowCheckResult(
  db: Database.Database,
  input: {
    id: string;
    status: WorkflowCheckStatus;
    details?: unknown;
  }
): WorkflowCheckResultRow | undefined {
  db.prepare("UPDATE workflow_check_results SET status = ?, details_json = ?, updated_at = ? WHERE id = ?").run(
    input.status,
    asJson(input.details),
    nowIso(),
    input.id
  );
  return getWorkflowCheckResultById(db, input.id);
}

export function deleteWorkflowCheckResult(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM workflow_check_results WHERE id = ?").run(id);
  return result.changes > 0;
}

export function createWorkflowEvent(
  db: Database.Database,
  input: {
    id?: string;
    workflowRunId?: string | null;
    workflowStageRunId?: string | null;
    eventType: string;
    payload?: unknown;
  }
): WorkflowEventRow {
  const id = input.id ?? makeId();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO workflow_events (id, workflow_run_id, workflow_stage_run_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, input.workflowRunId ?? null, input.workflowStageRunId ?? null, input.eventType, asJson(input.payload), createdAt);
  return getWorkflowEventById(db, id)!;
}

export function getWorkflowEventById(db: Database.Database, id: string): WorkflowEventRow | undefined {
  return db.prepare("SELECT * FROM workflow_events WHERE id = ? LIMIT 1").get(id) as WorkflowEventRow | undefined;
}

export function listWorkflowEventsByRun(db: Database.Database, workflowRunId: string): WorkflowEventRow[] {
  return db
    .prepare("SELECT * FROM workflow_events WHERE workflow_run_id = ? ORDER BY created_at ASC")
    .all(workflowRunId) as WorkflowEventRow[];
}

export function deleteWorkflowEvent(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM workflow_events WHERE id = ?").run(id);
  return result.changes > 0;
}
