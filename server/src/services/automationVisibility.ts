import type Database from "better-sqlite3";
import type { PlanOrchestrationStateRow, TaskMode, TaskRow, TaskStatus, TaskTransitionRow } from "../types.js";
import { buildDependencyDiagnostics } from "./orchestration/dependencyGraph.js";
import { evaluateParentCompletionGuards, legacyStatusToLifecycle } from "./orchestration/stateMachine.js";

type EventRow = {
  id: string;
  task_id: string | null;
  session_id: string | null;
  event_type: string;
  payload: string;
  created_at: string;
};

type BlockingTask = {
  id: string;
  title: string;
  status: string;
  mode: string;
};

type TaskLike = {
  id: string;
  status: TaskStatus;
  mode: TaskMode;
};

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function automationEvent(eventType: string, payload: unknown): boolean {
  if (eventType.startsWith("plan.orchestration.")) return true;
  if (eventType.startsWith("task.auto_merge.")) return true;
  if (eventType.startsWith("task.queue.dispatch.")) return true;
  if (eventType.startsWith("plan.auto_start_child.")) return true;
  if (eventType.startsWith("plan.auto_merge_on_complete.")) return true;
  if (eventType === "plan.awaiting_children") return true;
  if (eventType === "task.merge_conflict" || eventType === "plan.merge_conflict") return true;
  if (eventType !== "plan.mark_merge_ready") return false;
  return Boolean(payload && typeof payload === "object" && !Array.isArray(payload) && (payload as { auto?: unknown }).auto);
}

function blockingDependencies(projectDb: Database.Database, taskId: string): BlockingTask[] {
  return projectDb
    .prepare(
      `SELECT dep.id, dep.title, dep.status, dep.mode
       FROM task_dependencies td
       JOIN tasks dep ON dep.id = td.dependency_task_id
       WHERE td.task_id = ? AND dep.status != 'merged'
       ORDER BY dep.created_at ASC`
    )
    .all(taskId) as BlockingTask[];
}

function pendingChildren(projectDb: Database.Database, planTaskId: string): BlockingTask[] {
  return projectDb
    .prepare(
      `SELECT id, title, status, mode
       FROM tasks
       WHERE parent_plan_task_id = ? AND status != 'merged'
       ORDER BY created_at ASC`
    )
    .all(planTaskId) as BlockingTask[];
}

function latestTransition(projectDb: Database.Database, taskId: string): TaskTransitionRow | null {
  const row = projectDb
    .prepare("SELECT * FROM task_state_transitions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(taskId) as TaskTransitionRow | undefined;
  return row ?? null;
}

function waitingDiagnostics(
  projectDb: Database.Database,
  task: TaskLike,
  deps: BlockingTask[],
  children: BlockingTask[],
  latest: TaskTransitionRow | null,
  lastAutomationAction: unknown,
  dependencyDiagnostics: ReturnType<typeof buildDependencyDiagnostics>
) {
  const lifecycleState = legacyStatusToLifecycle(task.status, {
    hasBlockingDependencies: deps.length > 0,
    hasPendingChildren: children.length > 0
  });
  const parentGuards = evaluateParentCompletionGuards(projectDb, {
    id: task.id,
    mode: task.mode,
    metadata_json: (task as { metadata_json?: string | null }).metadata_json ?? null
  });
  const unresolved = dependencyDiagnostics.unresolved;
  const unresolvedIds = unresolved.map((dep) => dep.id);
  const unresolvedWithReasons = unresolved.map((dep) => ({
    id: dep.id,
    tier: dep.tier,
    reason: dep.reason,
    status: dep.status
  }));
  if (task.status === "queued" && deps.length > 0) {
    return {
      waiting: true,
      reasonCode: "blocked_dependencies",
      reason: "Task is queued but blocked by unmerged dependencies.",
      dependencyBlockerTaskId: deps[0]?.id ?? null,
      unresolvedDependencyIds: unresolvedIds,
      unresolvedDependencyDetails: unresolvedWithReasons,
      blockingDependencies: deps,
      pendingChildren: children,
      lifecycleState,
      parentCompletion: parentGuards,
      latestTransition: latest,
      lastAutomationAction
    };
  }
  if (task.status === "awaiting_children") {
    return {
      waiting: true,
      reasonCode: "awaiting_children",
      reason: "Plan is waiting for child tasks to merge.",
      dependencyBlockerTaskId: null,
      unresolvedDependencyIds: unresolvedIds,
      unresolvedDependencyDetails: unresolvedWithReasons,
      blockingDependencies: deps,
      pendingChildren: children,
      lifecycleState,
      parentCompletion: parentGuards,
      latestTransition: latest,
      lastAutomationAction
    };
  }
  if (task.status === "merge_conflict") {
    return {
      waiting: true,
      reasonCode: "merge_conflict",
      reason: "Task is waiting for merge conflict resolution.",
      dependencyBlockerTaskId: null,
      unresolvedDependencyIds: unresolvedIds,
      unresolvedDependencyDetails: unresolvedWithReasons,
      blockingDependencies: deps,
      pendingChildren: children,
      lifecycleState,
      parentCompletion: parentGuards,
      latestTransition: latest,
      lastAutomationAction
    };
  }
  if (task.status === "waiting_input") {
    return {
      waiting: true,
      reasonCode: "waiting_input",
      reason: "Task is waiting for runtime input or follow-up automation.",
      dependencyBlockerTaskId: deps[0]?.id ?? null,
      unresolvedDependencyIds: unresolvedIds,
      unresolvedDependencyDetails: unresolvedWithReasons,
      blockingDependencies: deps,
      pendingChildren: children,
      lifecycleState,
      parentCompletion: parentGuards,
      latestTransition: latest,
      lastAutomationAction
    };
  }
  return {
    waiting: ["queued", "in_progress"].includes(task.status),
    reasonCode: task.status,
    reason: `Task is currently ${task.status}.`,
    dependencyBlockerTaskId: deps[0]?.id ?? null,
    unresolvedDependencyIds: unresolvedIds,
    unresolvedDependencyDetails: unresolvedWithReasons,
    blockingDependencies: deps,
    pendingChildren: children,
    lifecycleState,
    parentCompletion: parentGuards,
    latestTransition: latest,
    lastAutomationAction
  };
}

function orchestrationState(projectDb: Database.Database, task: TaskLike) {
  if (task.mode !== "plan") {
    return null;
  }
  const state = projectDb
    .prepare("SELECT * FROM plan_orchestration_state WHERE plan_task_id = ?")
    .get(task.id) as PlanOrchestrationStateRow | undefined;
  if (!state) {
    return null;
  }
  return {
    planTaskId: state.plan_task_id,
    lockExpiresAt: state.lock_expires_at,
    lastOutputSha256: state.last_output_sha256,
    lastExtractedRevisionId: state.last_extracted_revision_id,
    lastApprovedRevisionId: state.last_approved_revision_id,
    lastApprovedOutputSha256: state.last_approved_output_sha256,
    lastFailedOutputSha256: state.last_failed_output_sha256,
    lastError: state.last_error,
    lastErrorAt: state.last_error_at,
    updatedAt: state.updated_at
  };
}

export function buildAutomationVisibility(projectDb: Database.Database, task: TaskLike, limit = 20) {
  const rows = projectDb
    .prepare(
      `SELECT id, task_id, session_id, event_type, payload, created_at
       FROM events
       WHERE task_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(task.id, Math.max(limit * 3, 60)) as EventRow[];

  const actions = rows
    .map((row) => ({
      id: row.id,
      taskId: row.task_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      payload: parsePayload(row.payload),
      createdAt: row.created_at
    }))
    .filter((row) => automationEvent(row.eventType, row.payload))
    .slice(0, limit);

  const deps = blockingDependencies(projectDb, task.id);
  const children = task.mode === "plan" ? pendingChildren(projectDb, task.id) : [];
  const latest = latestTransition(projectDb, task.id);
  const diagnosticTask = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow | undefined;
  const dependencyDiagnostics = diagnosticTask
    ? buildDependencyDiagnostics({ projectDb, task: diagnosticTask })
    : {
      node: { id: task.id, tier: "task" as const },
      unresolved: [],
      lineage: []
    };

  return {
    automation: {
      lastAction: actions[0] ?? null,
      recentActions: actions
    },
    waiting: waitingDiagnostics(projectDb, task, deps, children, latest, actions[0] ?? null, dependencyDiagnostics),
    dependencyDiagnostics,
    orchestration: orchestrationState(projectDb, task)
  };
}
