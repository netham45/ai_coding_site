import { startDecomposeJobWorker } from "./decompose.js";
import { startEvaluateReadinessJobWorker } from "./evaluateReadiness.js";

export function startHierarchicalOrchestrationJobs(): void {
  startEvaluateReadinessJobWorker();
  startDecomposeJobWorker();
}

