import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { makeId } from "../../../utils/id.js";
import { nowIso } from "../../../utils/time.js";
import type { TaskRow, TaskStatus } from "../../../types.js";
import { recordEvent } from "../../events.js";
import { readNodeMetadata, writeNodeMetadata } from "../metadata.js";
import { buildDependencyDiagnostics } from "../dependencyGraph.js";
import { assertTaskStatusTransition, evaluateParentCompletionGuards } from "../stateMachine.js";
import { registerOrchestrationJobHandler } from "../jobQueue.js";

type ReadinessReasonCode =
  | "NOOP_STATE_STABLE"
  | "DEPS_INCOMPLETE"
  | "DEPS_FAILED"
  | "CHILDREN_INCOMPLETE"
  | "CHILDREN_FAILED"
  | "MERGE_PREREQ_MISSING"
  | "VERIFICATION_PREREQ_MISSING"
  | "READY_TO_START"
  | "READY_TO_COMPLETE"
  | "EXECUTION_IN_PROGRESS"
  | "TERMINAL_COMPLETE"
  | "TERMINAL_FAILED"
  | "TERMINAL_CANCELED"
  | "MANUAL_INTERVENTION_REQUIRED";

type ReadinessDecision = {
  currentState: TaskStatus;
  recommendedState: TaskStatus;
  reasonCodes: ReadinessReasonCode[];
  blockers: Array<{ id: string; tier: string; reason: string | null; status: string | null }>;
  allowedTransition: boolean;
  idempotencyKey: string;
};

let readinessHandlerRegistered = false;

function readTask(projectDb: Database.Database, taskId: string): TaskRow | undefined {
  return projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
}

function hasPendingChildren(projectDb: Database.Database, taskId: string): boolean {
  const row = projectDb
    .prepare("SELECT id FROM tasks WHERE parent_plan_task_id = ? AND status != 'merged' LIMIT 1")
    .get(taskId) as { id: string } | undefined;
  return Boolean(row?.id);
}

function hasFailedChildren(projectDb: Database.Database, taskId: string): boolean {
  const row = projectDb
    .prepare("SELECT id FROM tasks WHERE parent_plan_task_id = ? AND status IN ('failed','merge_conflict','cancelled') LIMIT 1")
    .get(taskId) as { id: string } | undefined;
  return Boolean(row?.id);
}

function transitionTaskWithGuards(params: {
  projectDb: Database.Database;
  task: TaskRow;
  toStatus: TaskStatus;
  reasonCode: string;
}): { transitioned: boolean; lifecycle?: { fromLifecycle: string; toLifecycle: string } } {
  if (params.task.status === params.toStatus) {
    return { transitioned: false };
  }
  const hasBlockingDependencies = buildDependencyDiagnostics({
    projectDb: params.projectDb,
    task: params.task
  }).unresolved.length > 0;
  const pendingChildren = params.task.mode === "plan" ? hasPendingChildren(params.projectDb, params.task.id) : false;
  const parentGuards = evaluateParentCompletionGuards(params.projectDb, params.task);

  const lifecycle = assertTaskStatusTransition({
    mode: params.task.mode,
    fromStatus: params.task.status,
    toStatus: params.toStatus,
    hasBlockingDependencies,
    hasPendingChildren: pendingChildren,
    parentGuards
  });

  params.projectDb.transaction(() => {
    params.projectDb
      .prepare("UPDATE tasks SET status = ?, cancel_reason = NULL, merged_at = NULL, merged_by_user_id = NULL, updated_at = ? WHERE id = ?")
      .run(params.toStatus, nowIso(), params.task.id);
    params.projectDb.prepare(
      `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    ).run(
      makeId(),
      params.task.id,
      params.task.status,
      params.toStatus,
      `${params.reasonCode}: lifecycle ${lifecycle.fromLifecycle}->${lifecycle.toLifecycle}`,
      nowIso()
    );
    recordEvent({
      projectId: params.task.project_id,
      taskId: params.task.id,
      eventType: "task.status_changed",
      payload: {
        fromStatus: params.task.status,
        toStatus: params.toStatus,
        reasonCode: params.reasonCode,
        lifecycle
      },
      database: params.projectDb
    });
  })();

  return { transitioned: true, lifecycle };
}

function readinessDecision(projectDb: Database.Database, task: TaskRow): ReadinessDecision {
  const diagnostics = buildDependencyDiagnostics({ projectDb, task });
  const blockers = diagnostics.unresolved.map((entry) => ({
    id: entry.id,
    tier: entry.tier,
    reason: entry.reason ?? null,
    status: entry.status ?? null
  }));
  const failedDeps = blockers.some((entry) => entry.status === "failed" || entry.status === "merge_conflict" || entry.status === "cancelled");
  const pendingChildren = task.mode === "plan" ? hasPendingChildren(projectDb, task.id) : false;
  const failedChildren = task.mode === "plan" ? hasFailedChildren(projectDb, task.id) : false;

  const reasonCodes: ReadinessReasonCode[] = [];
  let recommendedState: TaskStatus = task.status;

  if (task.status === "merged") {
    reasonCodes.push("TERMINAL_COMPLETE");
  } else if (task.status === "cancelled") {
    reasonCodes.push("TERMINAL_CANCELED");
  } else if (task.status === "failed" || task.status === "merge_conflict") {
    reasonCodes.push("TERMINAL_FAILED");
  } else if (failedDeps) {
    reasonCodes.push("DEPS_FAILED", "MANUAL_INTERVENTION_REQUIRED");
    recommendedState = "queued";
  } else if (blockers.length > 0) {
    reasonCodes.push("DEPS_INCOMPLETE");
    recommendedState = "queued";
  } else if (failedChildren) {
    reasonCodes.push("CHILDREN_FAILED", "MANUAL_INTERVENTION_REQUIRED");
    recommendedState = "awaiting_children";
  } else if (pendingChildren) {
    reasonCodes.push("CHILDREN_INCOMPLETE");
    recommendedState = "awaiting_children";
  } else if (task.status === "in_progress") {
    reasonCodes.push("EXECUTION_IN_PROGRESS");
  } else if (task.status === "waiting_input") {
    reasonCodes.push("VERIFICATION_PREREQ_MISSING", "MANUAL_INTERVENTION_REQUIRED");
  } else if (task.status === "merge_ready") {
    reasonCodes.push("READY_TO_COMPLETE");
  } else {
    reasonCodes.push("READY_TO_START");
    recommendedState = "queued";
  }

  if (recommendedState === task.status) {
    reasonCodes.push("NOOP_STATE_STABLE");
  }

  const parentGuards = evaluateParentCompletionGuards(projectDb, task);
  let allowedTransition = true;
  if (recommendedState !== task.status) {
    try {
      assertTaskStatusTransition({
        mode: task.mode,
        fromStatus: task.status,
        toStatus: recommendedState,
        hasBlockingDependencies: blockers.length > 0,
        hasPendingChildren: pendingChildren,
        parentGuards
      });
    } catch {
      allowedTransition = false;
    }
  }

  const idempotencyKey = createHash("sha256")
    .update(
      JSON.stringify({
        taskId: task.id,
        status: task.status,
        recommendedState,
        blockers: blockers
          .map((blocker) => ({ id: blocker.id, status: blocker.status, reason: blocker.reason, tier: blocker.tier }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        reasonCodes: [...reasonCodes].sort()
      })
    )
    .digest("hex");

  return {
    currentState: task.status,
    recommendedState,
    reasonCodes,
    blockers,
    allowedTransition,
    idempotencyKey
  };
}

export async function runEvaluateReadinessForTask(params: {
  projectDb: Database.Database;
  taskId: string;
  sourceEventId?: string | null;
}): Promise<ReadinessDecision | null> {
  const task = readTask(params.projectDb, params.taskId);
  if (!task) return null;

  const decision = readinessDecision(params.projectDb, task);
  const metadataRead = readNodeMetadata({ projectDb: params.projectDb, task, dependencyTaskIds: [] });
  metadataRead.metadata.lifecycle = {
    synthesis_passed: metadataRead.metadata.lifecycle?.synthesis_passed,
    verification_passed: metadataRead.metadata.lifecycle?.verification_passed,
    last_transition_reason_code: decision.reasonCodes[0] ?? "NOOP_STATE_STABLE"
  };
  writeNodeMetadata({
    projectDb: params.projectDb,
    taskId: task.id,
    metadata: metadataRead.metadata
  });

  if (decision.allowedTransition && decision.recommendedState !== task.status) {
    try {
      transitionTaskWithGuards({
        projectDb: params.projectDb,
        task,
        toStatus: decision.recommendedState,
        reasonCode: `readiness:${decision.reasonCodes[0] ?? "NOOP_STATE_STABLE"}`
      });
    } catch {
      // Guard failure is captured in structured output below.
    }
  }

  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "orchestration.readiness.evaluated",
    payload: {
      schema_version: 1,
      sourceEventId: params.sourceEventId ?? null,
      readiness: {
        current_state: decision.currentState,
        recommended_state: decision.recommendedState,
        allowed_transition: decision.allowedTransition,
        reason_codes: decision.reasonCodes,
        blockers: decision.blockers,
        follow_up_jobs: decision.blockers.length > 0 ? ["evaluate_readiness"] : ["decompose"],
        idempotency_key: decision.idempotencyKey
      }
    },
    database: params.projectDb
  });

  return decision;
}

export function startEvaluateReadinessJobWorker(): void {
  if (readinessHandlerRegistered) return;
  registerOrchestrationJobHandler("evaluate_readiness", async (context) => {
    const taskId = context.payload.hintTaskId ?? null;
    if (!taskId) return;
    await runEvaluateReadinessForTask({
      projectDb: context.projectDb,
      taskId,
      sourceEventId: typeof context.payload.metadata?.sourceEventId === "string" ? context.payload.metadata.sourceEventId : null
    });
  });
  readinessHandlerRegistered = true;
}

