import type Database from "better-sqlite3";
import { recordEvent } from "../events.js";
import { enqueueOrchestrationJob, kickOrchestrationJobQueueProcessing } from "./jobQueue.js";

const WATCHDOG_BUCKET_MS = 60_000;
const STALE_BLOCKED_MS = 2 * 60_000;
const STALE_RUNNING_MS = 3 * 60_000;
const WATCHDOG_DEDUPE_MS = 60_000;

type WatchdogAction = "evaluate_readiness" | "re_review";

type WatchdogCandidate = {
  id: string;
  status: string;
  updated_at: string;
};

function enqueueWatchdogAction(params: {
  projectId: string;
  projectDb: Database.Database;
  task: WatchdogCandidate;
  trigger: string;
  action: WatchdogAction;
  bucket: number;
  staleMs: number;
}): void {
  if (params.action === "evaluate_readiness") {
    enqueueOrchestrationJob({
      projectId: params.projectId,
      taskId: params.task.id,
      jobType: "evaluate_readiness",
      idempotencyKey: `watchdog:evaluate_readiness:${params.task.id}:${params.bucket}`,
      debounceMs: 250,
      dedupeWindowMs: WATCHDOG_DEDUPE_MS,
      metadata: {
        watchdogAction: params.action,
        trigger: params.trigger,
        staleMs: params.staleMs
      },
      database: params.projectDb
    });
  } else {
    enqueueOrchestrationJob({
      projectId: params.projectId,
      taskId: params.task.id,
      jobType: "re_review",
      idempotencyKey: `watchdog:re_review:${params.task.id}:${params.bucket}`,
      debounceMs: 250,
      dedupeWindowMs: WATCHDOG_DEDUPE_MS,
      metadata: {
        watchdogAction: params.action,
        trigger: params.trigger,
        staleMs: params.staleMs
      },
      database: params.projectDb
    });
  }

  recordEvent({
    projectId: params.projectId,
    taskId: params.task.id,
    eventType: "orchestration.watchdog.action.enqueued",
    payload: {
      action: params.action,
      trigger: params.trigger,
      taskStatus: params.task.status,
      staleMs: params.staleMs
    },
    database: params.projectDb
  });
}

export function runOrchestrationWatchdog(params: {
  projectId: string;
  projectDb: Database.Database;
  trigger: string;
  nowMs?: number;
}): { readinessCount: number; reviewCount: number } {
  const nowMs = params.nowMs ?? Date.now();
  const blockedCutoffIso = new Date(nowMs - STALE_BLOCKED_MS).toISOString();
  const runningCutoffIso = new Date(nowMs - STALE_RUNNING_MS).toISOString();
  const bucket = Math.floor(nowMs / WATCHDOG_BUCKET_MS);

  const blockedCandidates = params.projectDb
    .prepare(
      `SELECT t.id, t.status, t.updated_at
       FROM tasks t
       WHERE t.status IN ('queued', 'awaiting_children')
         AND t.updated_at <= ?
         AND EXISTS (
           SELECT 1
           FROM task_dependencies td
           JOIN tasks dep ON dep.id = td.dependency_task_id
           WHERE td.task_id = t.id
             AND dep.status != 'merged'
         )
       ORDER BY t.updated_at ASC
       LIMIT 32`
    )
    .all(blockedCutoffIso) as WatchdogCandidate[];

  const runningCandidates = params.projectDb
    .prepare(
      `SELECT t.id, t.status, t.updated_at
       FROM tasks t
       WHERE t.status IN ('in_progress', 'waiting_input')
         AND t.updated_at <= ?
       ORDER BY t.updated_at ASC
       LIMIT 32`
    )
    .all(runningCutoffIso) as WatchdogCandidate[];

  for (const task of blockedCandidates) {
    enqueueWatchdogAction({
      projectId: params.projectId,
      projectDb: params.projectDb,
      task,
      trigger: params.trigger,
      action: "evaluate_readiness",
      bucket,
      staleMs: Math.max(0, nowMs - Date.parse(task.updated_at))
    });
  }

  for (const task of runningCandidates) {
    enqueueWatchdogAction({
      projectId: params.projectId,
      projectDb: params.projectDb,
      task,
      trigger: params.trigger,
      action: "re_review",
      bucket,
      staleMs: Math.max(0, nowMs - Date.parse(task.updated_at))
    });
  }

  if (blockedCandidates.length > 0 || runningCandidates.length > 0) {
    kickOrchestrationJobQueueProcessing();
  }

  return {
    readinessCount: blockedCandidates.length,
    reviewCount: runningCandidates.length
  };
}
