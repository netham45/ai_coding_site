import { registerOrchestrationJobHandler } from "../jobQueue.js";
import { resolveParentTaskForCompletion, runVerifyForParent } from "../completion.js";

let verifyHandlerRegistered = false;

export function startVerifyJobWorker(): void {
  if (verifyHandlerRegistered) return;
  registerOrchestrationJobHandler("verify", async (context) => {
    const taskId = context.payload.hintTaskId ?? null;
    if (!taskId) return;
    const parent = resolveParentTaskForCompletion({
      projectDb: context.projectDb,
      anchorTaskId: taskId
    });
    if (!parent) return;
    await runVerifyForParent({
      projectDb: context.projectDb,
      projectId: context.projectId,
      parentTaskId: parent.id,
      sourceEventId: typeof context.payload.metadata?.sourceEventId === "string" ? context.payload.metadata.sourceEventId : null
    });
  });
  verifyHandlerRegistered = true;
}
