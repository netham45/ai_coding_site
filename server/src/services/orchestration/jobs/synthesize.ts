import { registerOrchestrationJobHandler } from "../jobQueue.js";
import { resolveParentTaskForCompletion, runSynthesizeForParent } from "../completion.js";

let synthesizeHandlerRegistered = false;

export function startSynthesizeJobWorker(): void {
  if (synthesizeHandlerRegistered) return;
  registerOrchestrationJobHandler("synthesize", async (context) => {
    const taskId = context.payload.hintTaskId ?? null;
    if (!taskId) return;
    const parent = resolveParentTaskForCompletion({
      projectDb: context.projectDb,
      anchorTaskId: taskId
    });
    if (!parent) return;
    await runSynthesizeForParent({
      projectDb: context.projectDb,
      projectId: context.projectId,
      parentTaskId: parent.id,
      sourceEventId: typeof context.payload.metadata?.sourceEventId === "string" ? context.payload.metadata.sourceEventId : null
    });
  });
  synthesizeHandlerRegistered = true;
}
