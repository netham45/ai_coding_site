import { projectDbForProject } from "../db/index.js";
import { allAppProjects } from "../db/ownership.js";
import { startTaskRuntime } from "./runtime.js";

const QUEUE_INTERVAL_MS = 1500;
const MAX_TASKS_PER_PASS = 8;
const startingTaskIds = new Set<string>();

type QueuedTaskRow = {
  id: string;
  created_by_user_id: string;
};

async function processQueuedTasksPass(): Promise<void> {
  const rows: QueuedTaskRow[] = [];
  for (const project of allAppProjects()) {
    if (rows.length >= MAX_TASKS_PER_PASS) {
      break;
    }
    try {
      const db = projectDbForProject({ projectId: project.id, basePath: project.base_path });
      const remaining = MAX_TASKS_PER_PASS - rows.length;
      const projectRows = db
        .prepare(
          `SELECT t.id, t.created_by_user_id
           FROM tasks t
           WHERE t.status = 'queued'
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
        .all(remaining) as QueuedTaskRow[];
      rows.push(...projectRows);
    } catch {
      // Ignore unavailable/corrupt project DBs for this queue pass.
    }
  }

  for (const row of rows) {
    if (startingTaskIds.has(row.id)) {
      continue;
    }
    startingTaskIds.add(row.id);
    try {
      await startTaskRuntime(row.id, row.created_by_user_id);
    } catch {
      // Best-effort queue dispatch. Task remains queued for retry.
    } finally {
      startingTaskIds.delete(row.id);
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
