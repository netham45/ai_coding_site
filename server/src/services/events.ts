import type Database from "better-sqlite3";
import { db } from "../db/index.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";
import { deriveOrchestrationJobsFromEvent } from "./orchestration/hooks.js";
import { enqueueOrchestrationJob, kickOrchestrationJobQueueProcessing } from "./orchestration/jobQueue.js";

const MERGE_COMPLETED_EVENTS = new Set(["task.merged", "plan.merged", "task.auto_merge.merged"]);
const MERGE_FAILED_EVENTS = new Set([
  "task.merge_conflict",
  "plan.merge_conflict",
  "task.auto_merge.failed",
  "plan.auto_merge_on_complete.failed",
  "task.merge_failed",
  "plan.merge_failed"
]);

export function recordEvent(params: {
  id?: string;
  projectId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  eventType: string;
  payload?: unknown;
  database?: Database.Database;
}): { eventId: string; inserted: boolean } {
  const targetDb = params.database ?? db;
  const eventId = params.id ?? makeId();
  const result = targetDb.prepare(
    `INSERT INTO events (id, project_id, task_id, session_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventId,
    params.projectId ?? null,
    params.taskId ?? null,
    params.sessionId ?? null,
    params.eventType,
    JSON.stringify(params.payload ?? {}),
    nowIso()
  );

  const inserted = result.changes > 0;
  if (!inserted) {
    return { eventId, inserted };
  }

  const hookType = MERGE_COMPLETED_EVENTS.has(params.eventType)
    ? "on_merge_completed"
    : MERGE_FAILED_EVENTS.has(params.eventType)
      ? "on_merge_failed"
      : null;
  if (hookType) {
    targetDb
      .prepare(
        `INSERT INTO events (id, project_id, task_id, session_id, event_type, payload, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(
        makeId(),
        params.projectId ?? null,
        params.taskId ?? null,
        `orchestration.hook.${hookType}`,
        JSON.stringify({ sourceEventId: eventId, sourceEventType: params.eventType }),
        nowIso()
      );
  }

  const jobs = deriveOrchestrationJobsFromEvent({
    eventType: params.eventType,
    projectId: params.projectId ?? null,
    taskId: params.taskId ?? null,
    payload: params.payload
  });
  for (const job of jobs) {
    enqueueOrchestrationJob({
      projectId: job.projectId ?? params.projectId ?? null,
      taskId: job.taskId ?? params.taskId ?? null,
      jobType: job.jobType,
      idempotencyKey: job.idempotencyKey,
      debounceMs: job.debounceMs,
      dedupeWindowMs: job.dedupeWindowMs,
      metadata: {
        sourceEventId: eventId,
        sourceEventType: params.eventType,
        ...(job.payload ?? {})
      },
      database: targetDb
    });
  }
  if (jobs.length > 0) {
    kickOrchestrationJobQueueProcessing();
  }

  return { eventId, inserted };
}
