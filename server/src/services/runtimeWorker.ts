import type { RuntimeTaskContext } from "./runtime.js";
import { sendTaskRuntimeInput, startTaskRuntime } from "./runtime.js";
import { runInKeyedAsyncWorker } from "./asyncWorker.js";

function runtimeTaskWorkerKey(taskId: string): string {
  return `runtime-task:${taskId}`;
}

export function runRuntimeTaskWorker<T>(taskId: string, job: () => Promise<T>): Promise<T> {
  return runInKeyedAsyncWorker(runtimeTaskWorkerKey(taskId), job);
}

export function startTaskRuntimeWorker(taskId: string, actorUserId: string, context?: RuntimeTaskContext): Promise<void> {
  return runRuntimeTaskWorker(taskId, () => startTaskRuntime(taskId, actorUserId, context));
}

export function sendTaskRuntimeInputWorker(
  taskId: string,
  actorUserId: string,
  text: string,
  context?: RuntimeTaskContext
): Promise<void> {
  return runRuntimeTaskWorker(taskId, () => sendTaskRuntimeInput(taskId, actorUserId, text, context));
}
