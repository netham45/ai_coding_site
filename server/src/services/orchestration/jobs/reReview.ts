import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { TaskRow } from "../../../types.js";
import { recordEvent } from "../../events.js";
import { enqueueOrchestrationJob } from "../jobQueue.js";
import { registerOrchestrationJobHandler } from "../jobQueue.js";
import { runEvaluateReadinessForTask } from "./evaluateReadiness.js";

const RE_REVIEW_DELTA_DEBOUNCE_MS = 1_000;
const RE_REVIEW_DELTA_DEDUPE_MS = 5_000;

let reReviewHandlerRegistered = false;

function readTask(projectDb: Database.Database, taskId: string): TaskRow | undefined {
  return projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
}

function readDependentTaskIds(projectDb: Database.Database, taskId: string): string[] {
  return (
    projectDb
      .prepare("SELECT task_id FROM task_dependencies WHERE dependency_task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Array<{ task_id: string }>
  ).map((row) => row.task_id);
}

function impactedTaskIds(projectDb: Database.Database, anchorTaskId: string): string[] {
  const anchor = readTask(projectDb, anchorTaskId);
  if (!anchor) return [];
  const dependents = readDependentTaskIds(projectDb, anchorTaskId);
  const impacted = new Set<string>([...dependents]);
  if (anchor.parent_plan_task_id) {
    impacted.add(anchor.parent_plan_task_id);
  }
  return [...impacted];
}

function shouldRunDeltaPlan(task: TaskRow, reasonCodes: string[]): boolean {
  if (task.mode !== "plan") return false;
  if (reasonCodes.includes("CHILDREN_FAILED")) return true;
  if (reasonCodes.includes("DEPS_FAILED")) return true;
  if (reasonCodes.includes("DEPS_INCOMPLETE") || reasonCodes.includes("CHILDREN_INCOMPLETE")) return true;
  return false;
}

function deltaPlanKey(taskId: string, readinessIdempotencyKey: string): string {
  return createHash("sha256")
    .update(`re_review|delta_plan|${taskId}|${readinessIdempotencyKey}`)
    .digest("hex");
}

export async function runReReviewForTask(params: {
  projectDb: Database.Database;
  projectId: string;
  anchorTaskId: string;
  sourceEventId?: string | null;
}): Promise<{ anchorTaskId: string; impactedTaskIds: string[]; deltaPlanEnqueued: string[] }> {
  const impactedIds = impactedTaskIds(params.projectDb, params.anchorTaskId);
  const deltaPlanEnqueued: string[] = [];

  for (const taskId of impactedIds) {
    const decision = await runEvaluateReadinessForTask({
      projectDb: params.projectDb,
      taskId,
      sourceEventId: params.sourceEventId ?? null
    });
    const task = readTask(params.projectDb, taskId);
    if (!decision || !task) continue;
    if (!shouldRunDeltaPlan(task, decision.reasonCodes)) continue;

    enqueueOrchestrationJob({
      projectId: params.projectId,
      taskId,
      jobType: "delta_plan",
      idempotencyKey: deltaPlanKey(taskId, decision.idempotencyKey),
      debounceMs: RE_REVIEW_DELTA_DEBOUNCE_MS,
      dedupeWindowMs: RE_REVIEW_DELTA_DEDUPE_MS,
      metadata: {
        sourceEventId: params.sourceEventId ?? null,
        source: "orchestration.re_review"
      },
      database: params.projectDb
    });
    deltaPlanEnqueued.push(taskId);
  }

  recordEvent({
    projectId: params.projectId,
    taskId: params.anchorTaskId,
    eventType: "orchestration.re_review.completed",
    payload: {
      schema_version: 1,
      sourceEventId: params.sourceEventId ?? null,
      anchorTaskId: params.anchorTaskId,
      impactedTaskIds: impactedIds,
      deltaPlanEnqueued
    },
    database: params.projectDb
  });

  return {
    anchorTaskId: params.anchorTaskId,
    impactedTaskIds: impactedIds,
    deltaPlanEnqueued
  };
}

export function startReReviewJobWorker(): void {
  if (reReviewHandlerRegistered) return;
  registerOrchestrationJobHandler("re_review", async (context) => {
    const taskId = context.payload.hintTaskId ?? null;
    if (!taskId) return;
    await runReReviewForTask({
      projectDb: context.projectDb,
      projectId: context.projectId,
      anchorTaskId: taskId,
      sourceEventId: typeof context.payload.metadata?.sourceEventId === "string" ? context.payload.metadata.sourceEventId : null
    });
  });
  reReviewHandlerRegistered = true;
}

