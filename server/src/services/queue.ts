import { db as appDb, resolveProjectDatabase } from "../db/index.js";
import { startTaskRuntime } from "./runtime.js";

const QUEUE_INTERVAL_MS = 1500;
const MAX_TASKS_PER_PASS = 8;
const startingTaskIds = new Set<string>();

type QueuedTaskRow = {
  id: string;
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
        `SELECT t.id, t.created_by_user_id, t.created_at
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

  for (const row of rows) {
    if (startingTaskIds.has(row.task.id)) {
      continue;
    }
    startingTaskIds.add(row.task.id);
    try {
      await startTaskRuntime(row.task.id, row.task.created_by_user_id, {
        projectId: row.projectId,
        basePath: row.basePath
      });
    } catch {
      // Best-effort queue dispatch. Task remains queued for retry.
    } finally {
      startingTaskIds.delete(row.task.id);
    }
  }
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
  void runQueuePass();
}

export function startTaskQueueWorker(): void {
  void runQueuePass();
  setInterval(() => {
    void runQueuePass();
  }, QUEUE_INTERVAL_MS);
}
