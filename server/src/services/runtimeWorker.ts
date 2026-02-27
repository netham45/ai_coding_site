import type { RuntimeTaskContext } from "./runtime.js";
import { sendTaskRuntimeInput, startTaskRuntime } from "./runtime.js";
import { runInKeyedAsyncWorker } from "./asyncWorker.js";
import { db as appDb, resolveProjectDatabase } from "../db/index.js";
import { runOrchestrationWatchdog } from "./orchestration/watchdog.js";

function runtimeTaskWorkerKey(taskId: string): string {
  return `runtime-task:${taskId}`;
}

export function runRuntimeTaskWorker<T>(taskId: string, job: () => Promise<T>): Promise<T> {
  return runInKeyedAsyncWorker(runtimeTaskWorkerKey(taskId), job);
}

function enqueueRuntimeTaskWorker(taskId: string, job: () => Promise<void>): Promise<void> {
  void runRuntimeTaskWorker(taskId, job).catch((error: any) => {
    console.error("[runtimeWorker] async runtime task worker failed", {
      taskId,
      error: String(error?.message ?? error)
    });
  });
  return Promise.resolve();
}

function runWatchdogForContext(context?: RuntimeTaskContext): void {
  if (!context?.projectId) {
    return;
  }
  const project = appDb.prepare("SELECT id, base_path FROM projects WHERE id = ? LIMIT 1").get(context.projectId) as
    | { id: string; base_path: string }
    | undefined;
  if (!project) {
    return;
  }
  const scoped =
    context.projectDb
      ? {
          database: context.projectDb
        }
      : resolveProjectDatabase({
          appDb,
          projectId: project.id,
          basePath: context.basePath ?? project.base_path,
          intent: "write"
        });
  runOrchestrationWatchdog({
    projectId: project.id,
    projectDb: scoped.database,
    trigger: "runtime_worker"
  });
}

export function startTaskRuntimeWorker(taskId: string, actorUserId: string, context?: RuntimeTaskContext): Promise<void> {
  return enqueueRuntimeTaskWorker(taskId, async () => {
    await startTaskRuntime(taskId, actorUserId, context);
    runWatchdogForContext(context);
  });
}

export function sendTaskRuntimeInputWorker(
  taskId: string,
  actorUserId: string,
  text: string,
  context?: RuntimeTaskContext
): Promise<void> {
  return enqueueRuntimeTaskWorker(taskId, async () => {
    await sendTaskRuntimeInput(taskId, actorUserId, text, context);
    runWatchdogForContext(context);
  });
}
