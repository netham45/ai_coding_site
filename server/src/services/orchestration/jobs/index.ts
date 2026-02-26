import { startDecomposeJobWorker } from "./decompose.js";
import { startDeltaPlanJobWorker } from "./deltaPlan.js";
import { startEvaluateReadinessJobWorker } from "./evaluateReadiness.js";
import { startReReviewJobWorker } from "./reReview.js";
import { startSynthesizeJobWorker } from "./synthesize.js";
import { startVerifyJobWorker } from "./verify.js";

export function startHierarchicalOrchestrationJobs(): void {
  startEvaluateReadinessJobWorker();
  startDecomposeJobWorker();
  startReReviewJobWorker();
  startDeltaPlanJobWorker();
  startSynthesizeJobWorker();
  startVerifyJobWorker();
}
