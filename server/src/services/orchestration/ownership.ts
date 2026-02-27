import type Database from "better-sqlite3";
import { orchestrationLegacyJobOwnershipEnabled } from "../../config/featureFlags.js";
import type { OrchestrationJobType } from "./jobQueue.js";

type TaskOwnershipRow = {
  id: string;
  mode: string;
  parent_plan_task_id: string | null;
};

const LEGACY_JOB_TYPES = new Set<OrchestrationJobType>(["decompose", "re_review", "delta_plan", "synthesize", "verify"]);
const WORKFLOW_OWNED_PARENT_JOB_TYPES = new Set<OrchestrationJobType>(["re_review", "synthesize", "verify"]);

function activeWorkflowRunExists(projectDb: Database.Database, taskId: string): boolean {
  const row = projectDb
    .prepare(
      `SELECT id
       FROM workflow_runs
       WHERE task_id = ?
         AND status IN ('queued', 'running')
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(taskId) as { id: string } | undefined;
  return Boolean(row?.id);
}

function readTask(projectDb: Database.Database, taskId: string): TaskOwnershipRow | null {
  const task = projectDb
    .prepare("SELECT id, mode, parent_plan_task_id FROM tasks WHERE id = ? LIMIT 1")
    .get(taskId) as TaskOwnershipRow | undefined;
  return task ?? null;
}

function ownerTaskIdForLegacyJob(
  projectDb: Database.Database,
  jobType: OrchestrationJobType,
  hintTaskId: string
): string | null {
  const task = readTask(projectDb, hintTaskId);
  if (!task) return null;

  if (WORKFLOW_OWNED_PARENT_JOB_TYPES.has(jobType)) {
    if (task.parent_plan_task_id) {
      return task.parent_plan_task_id;
    }
    return task.mode === "plan" ? task.id : null;
  }

  return task.mode === "plan" ? task.id : null;
}

export function legacyJobSuppressedByWorkflowOwnership(params: {
  projectDb: Database.Database;
  jobType: OrchestrationJobType;
  hintTaskId: string | null;
}): boolean {
  if (orchestrationLegacyJobOwnershipEnabled()) {
    return false;
  }
  if (!LEGACY_JOB_TYPES.has(params.jobType)) {
    return false;
  }
  if (!params.hintTaskId) {
    return false;
  }
  const ownerTaskId = ownerTaskIdForLegacyJob(params.projectDb, params.jobType, params.hintTaskId);
  if (!ownerTaskId) {
    return false;
  }
  return activeWorkflowRunExists(params.projectDb, ownerTaskId);
}
