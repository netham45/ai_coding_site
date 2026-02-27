import type Database from "better-sqlite3";
import type { NodeTier, TaskRow } from "../../../types.js";
import { recordEvent } from "../../events.js";
import { registerOrchestrationJobHandler } from "../jobQueue.js";
import { readNodeMetadata } from "../metadata.js";
import { runEvaluateReadinessForTask } from "./evaluateReadiness.js";

const nextTierByTier: Record<NodeTier, NodeTier | null> = {
  epoch: "phase",
  phase: "plan",
  plan: "task",
  task: "exec",
  exec: null
};

let decomposeHandlerRegistered = false;

function readTask(projectDb: Database.Database, taskId: string): TaskRow | undefined {
  return projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
}

function readDependencyIds(projectDb: Database.Database, taskId: string): string[] {
  return (
    projectDb
      .prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Array<{ dependency_task_id: string }>
  ).map((row) => row.dependency_task_id);
}

export async function runDecomposeForTask(params: {
  projectDb: Database.Database;
  projectId: string;
  taskId: string;
  autoMode: boolean;
  sourceEventId?: string | null;
}): Promise<{ parentId: string; parentTier: NodeTier; childIds: string[] } | null> {
  const task = readTask(params.projectDb, params.taskId);
  if (!task) return null;

  const metadata = readNodeMetadata({
    projectDb: params.projectDb,
    task,
    dependencyTaskIds: readDependencyIds(params.projectDb, task.id)
  }).metadata;
  const currentTier = metadata.tier;
  const nextTier = nextTierByTier[currentTier];

  recordEvent({
    projectId: params.projectId,
    taskId: task.id,
    eventType: "orchestration.decompose.completed",
    payload: {
      schema_version: 1,
      sourceEventId: params.sourceEventId ?? null,
      parent: { id: task.id, tier: currentTier },
      nextTier,
      children: [],
      autoMode: params.autoMode
    },
    database: params.projectDb
  });

  await runEvaluateReadinessForTask({
    projectDb: params.projectDb,
    taskId: task.id,
    sourceEventId: params.sourceEventId ?? null
  });

  return {
    parentId: task.id,
    parentTier: currentTier,
    childIds: []
  };
}

export function startDecomposeJobWorker(): void {
  if (decomposeHandlerRegistered) return;
  registerOrchestrationJobHandler("decompose", async (context) => {
    const taskId = context.payload.hintTaskId ?? null;
    if (!taskId) return;
    const autoMode = Boolean(context.payload.metadata?.autoMode ?? true);
    await runDecomposeForTask({
      projectDb: context.projectDb,
      projectId: context.projectId,
      taskId,
      autoMode,
      sourceEventId: typeof context.payload.metadata?.sourceEventId === "string" ? context.payload.metadata.sourceEventId : null
    });
  });
  decomposeHandlerRegistered = true;
}
