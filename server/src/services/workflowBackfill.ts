import type Database from "better-sqlite3";
import type { NodeTier, TaskStatus, WorkflowRunStatus } from "../types.js";
import { createWorkflowRun } from "./workflowRepository.js";
import { ensureDefaultExecWorkflowDefinition } from "./defaultExecWorkflow.js";
import { ensureBuiltinWorkflowDefinitionForTier, type BuiltinWorkflowTier } from "./workflowBuiltins.js";

type BackfillTaskRow = {
  id: string;
  project_id: string;
  created_by_user_id: string | null;
  mode: "execution" | "plan";
  source_plan_revision_id: string | null;
  metadata_json: string | null;
  status: TaskStatus;
  updated_at: string;
};

export type WorkflowBackfillResult = {
  scanned: number;
  attached: number;
  skippedExistingRun: number;
};

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function asTier(value: unknown): NodeTier | undefined {
  if (value === "epoch" || value === "phase" || value === "plan" || value === "task" || value === "exec") {
    return value;
  }
  return undefined;
}

function inferTier(task: BackfillTaskRow): NodeTier {
  if (task.metadata_json && task.metadata_json.trim()) {
    try {
      const parsed = JSON.parse(task.metadata_json) as { tier?: unknown };
      const fromMetadata = asTier(parsed?.tier);
      if (fromMetadata) return fromMetadata;
    } catch {
      // Ignore malformed legacy metadata and fall back to deterministic inference.
    }
  }
  if (task.mode === "plan") return "plan";
  if (task.source_plan_revision_id) return "exec";
  return "task";
}

function workflowRunStatusForTaskStatus(status: TaskStatus): WorkflowRunStatus {
  if (status === "merged") return "succeeded";
  if (status === "cancelled") return "cancelled";
  if (status === "failed" || status === "merge_conflict") return "failed";
  return "queued";
}

function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function hasAnyWorkflowRunForTask(db: Database.Database, taskId: string): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM workflow_runs WHERE task_id = ? LIMIT 1").get(taskId) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function attachDefaultWorkflowRunForTask(db: Database.Database, task: BackfillTaskRow, tier: NodeTier): void {
  const createdByUserId = (task.created_by_user_id ?? "").trim() || "system";
  let workflowDefinitionId: string;
  if (tier === "epoch" || tier === "phase" || tier === "plan") {
    workflowDefinitionId = ensureBuiltinWorkflowDefinitionForTier({
      db,
      projectId: task.project_id,
      tier: tier as BuiltinWorkflowTier,
      createdByUserId
    }).id;
  } else {
    workflowDefinitionId = ensureDefaultExecWorkflowDefinition({
      db,
      projectId: task.project_id,
      createdByUserId
    }).id;
  }

  const status = workflowRunStatusForTaskStatus(task.status);
  const run = createWorkflowRun(db, {
    workflowDefinitionId,
    projectId: task.project_id,
    taskId: task.id,
    status
  });
  if (isTerminalRunStatus(status)) {
    db.prepare("UPDATE workflow_runs SET started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(
      task.updated_at,
      task.updated_at,
      task.updated_at,
      run.id
    );
  }
}

export function backfillDefaultWorkflowsForExistingTasks(params: {
  db: Database.Database;
  projectId?: string;
}): WorkflowBackfillResult {
  if (!tableExists(params.db, "tasks") || !tableExists(params.db, "workflow_definitions") || !tableExists(params.db, "workflow_runs")) {
    return { scanned: 0, attached: 0, skippedExistingRun: 0 };
  }

  const tasks = (
    params.projectId
      ? params.db
          .prepare(
            `SELECT id, project_id, created_by_user_id, mode, source_plan_revision_id, metadata_json, status, updated_at
             FROM tasks
             WHERE project_id = ?
             ORDER BY created_at ASC, id ASC`
          )
          .all(params.projectId)
      : params.db
          .prepare(
            `SELECT id, project_id, created_by_user_id, mode, source_plan_revision_id, metadata_json, status, updated_at
             FROM tasks
             ORDER BY project_id ASC, created_at ASC, id ASC`
          )
          .all()
  ) as BackfillTaskRow[];

  const tx = params.db.transaction((rows: BackfillTaskRow[]): WorkflowBackfillResult => {
    let attached = 0;
    let skippedExistingRun = 0;
    for (const task of rows) {
      if (hasAnyWorkflowRunForTask(params.db, task.id)) {
        skippedExistingRun += 1;
        continue;
      }
      const tier = inferTier(task);
      attachDefaultWorkflowRunForTask(params.db, task, tier);
      attached += 1;
    }
    return { scanned: rows.length, attached, skippedExistingRun };
  });

  return tx(tasks);
}
