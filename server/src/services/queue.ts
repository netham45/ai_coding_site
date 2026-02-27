import { db as appDb, resolveProjectDatabase } from "../db/index.js";
import { recordEvent } from "./events.js";
import {
  enqueueOrchestrationJob,
  kickOrchestrationJobQueueProcessing,
  registerOrchestrationJobHandler,
  type OrchestrationJobType
} from "./orchestration/jobQueue.js";
import { readNodeMetadata } from "./orchestration/metadata.js";
import { startTaskRuntimeWorker } from "./runtimeWorker.js";
import { startBuiltinWorkflowForTierTask, type BuiltinWorkflowTier } from "./workflowBuiltins.js";

const MAX_TASKS_PER_PASS = 8;
const startingTaskIds = new Set<string>();
const TASK_QUEUE_JOB_TYPE: OrchestrationJobType = "task_queue_dispatch";
const TASK_QUEUE_IDEMPOTENCY_KEY = "task-queue:global";
let queueJobRegistered = false;

type QueuedTaskRow = {
  id: string;
  project_id: string;
  parent_plan_task_id: string | null;
  mode: "execution" | "plan";
  metadata_json: string;
  auto_merge: number;
  auto_start: number;
  auto_merge_on_complete: number;
  source_plan_revision_id: string | null;
  source_plan_item_key: string | null;
  created_by_user_id: string;
  created_at: string;
};

async function processQueuedTasksPass(): Promise<void> {
  const projects = appDb
    .prepare("SELECT id, base_path FROM projects ORDER BY created_at ASC")
    .all() as Array<{ id: string; base_path: string }>;
  const candidates: Array<{ projectId: string; basePath: string; task: QueuedTaskRow }> = [];

  for (const project of projects) {
    const scoped = resolveProjectDatabase({
      appDb,
      projectId: project.id,
      basePath: project.base_path,
      intent: "write"
    });
    const rows = scoped.database
      .prepare(
        `SELECT t.id, t.project_id, t.parent_plan_task_id, t.mode, t.metadata_json, t.auto_merge, t.auto_start, t.auto_merge_on_complete,
                t.source_plan_revision_id, t.source_plan_item_key, t.created_by_user_id, t.created_at
         FROM tasks t
         WHERE t.project_id = ?
           AND t.status = 'queued'
           AND NOT EXISTS (
             SELECT 1
             FROM task_dependencies td
             JOIN tasks dep ON dep.id = td.dependency_task_id
             WHERE td.task_id = t.id
               AND dep.status != 'merged'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM task_sessions ts
             WHERE ts.task_id = t.id
               AND ts.status IN ('starting','running','waiting_input')
           )
         ORDER BY t.created_at ASC
         LIMIT ?`
      )
      .all(project.id, MAX_TASKS_PER_PASS) as QueuedTaskRow[];
    for (const row of rows) {
      candidates.push({
        projectId: project.id,
        basePath: project.base_path,
        task: row
      });
    }
  }

  candidates.sort((a, b) => Date.parse(a.task.created_at) - Date.parse(b.task.created_at));
  const rows = candidates.slice(0, MAX_TASKS_PER_PASS);

  await Promise.allSettled(
    rows.map(async (row) => {
      if (startingTaskIds.has(row.task.id)) {
        return;
      }
      startingTaskIds.add(row.task.id);
      const projectDb = resolveProjectDatabase({
        appDb,
        projectId: row.projectId,
        basePath: row.basePath,
        intent: "write"
      }).database;
      try {
        const dependencyTaskIds = (
          projectDb.prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ?").all(row.task.id) as Array<{
            dependency_task_id: string;
          }>
        ).map((entry) => entry.dependency_task_id);
        const tier = readNodeMetadata({
          projectDb,
          task: row.task,
          dependencyTaskIds
        }).metadata.tier;

        if (tier === "epoch" || tier === "phase" || tier === "plan") {
          startBuiltinWorkflowForTierTask({
            db: projectDb,
            projectId: row.projectId,
            taskId: row.task.id,
            tier: tier as BuiltinWorkflowTier,
            createdByUserId: row.task.created_by_user_id
          });
        } else {
          await startTaskRuntimeWorker(row.task.id, row.task.created_by_user_id, {
            projectId: row.projectId,
            basePath: row.basePath
          });
        }
        recordEvent({
          projectId: row.task.project_id,
          taskId: row.task.id,
          eventType: "task.queue.dispatch.succeeded",
          payload: {
            mode: row.task.mode,
            strategy: tier === "epoch" || tier === "phase" || tier === "plan" ? "workflow_engine" : "runtime_session",
            parentPlanTaskId: row.task.parent_plan_task_id
          },
          database: projectDb
        });
        if (row.task.parent_plan_task_id) {
          recordEvent({
            projectId: row.task.project_id,
            taskId: row.task.parent_plan_task_id,
            eventType: "plan.auto_start_child.started",
            payload: {
              childTaskId: row.task.id,
              childMode: row.task.mode
            },
            database: projectDb
          });
        }
      } catch (error: any) {
        const message = String(error?.message ?? "queue dispatch failed");
        recordEvent({
          projectId: row.task.project_id,
          taskId: row.task.id,
          eventType: "task.queue.dispatch.failed",
          payload: { retryScheduled: true, error: message },
          database: projectDb
        });
        if (row.task.parent_plan_task_id) {
          recordEvent({
            projectId: row.task.project_id,
            taskId: row.task.parent_plan_task_id,
            eventType: "plan.auto_start_child.failed",
            payload: {
              childTaskId: row.task.id,
              childMode: row.task.mode,
              error: message
            },
            database: projectDb
          });
        }
      } finally {
        startingTaskIds.delete(row.task.id);
      }
    })
  );
}

let running = false;
async function runQueuePass(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await processQueuedTasksPass();
  } finally {
    running = false;
  }
}

export function kickTaskQueueProcessing(): void {
  const projects = appDb
    .prepare("SELECT id, base_path FROM projects ORDER BY created_at ASC")
    .all() as Array<{ id: string; base_path: string }>;
  for (const project of projects) {
    const scoped = resolveProjectDatabase({
      appDb,
      projectId: project.id,
      basePath: project.base_path,
      intent: "write"
    });
    enqueueOrchestrationJob({
      projectId: project.id,
      jobType: TASK_QUEUE_JOB_TYPE,
      idempotencyKey: `${TASK_QUEUE_IDEMPOTENCY_KEY}:${project.id}`,
      debounceMs: 300,
      dedupeWindowMs: 2_000,
      database: scoped.database
    });
  }
  kickOrchestrationJobQueueProcessing();
}

export function startTaskQueueWorker(): void {
  if (!queueJobRegistered) {
    registerOrchestrationJobHandler(TASK_QUEUE_JOB_TYPE, async () => {
      await runQueuePass();
    });
    queueJobRegistered = true;
  }
  kickTaskQueueProcessing();
}

export async function runTaskQueuePassForTests(): Promise<void> {
  await runQueuePass();
}
