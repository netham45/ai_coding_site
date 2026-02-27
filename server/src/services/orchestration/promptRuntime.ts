import fs from "node:fs";
import path from "node:path";
import type { NodeTier } from "../../types.js";
import { workspaceRoot } from "../../utils/paths.js";

export type OrchestrationPromptJob = "decompose" | "evaluate_readiness" | "synthesize" | "verify";

const coordinatorTemplatePath = path.join(workspaceRoot, "prompts", "shared-input-output.md");

const decompositionTemplateByTier: Record<NodeTier, string> = {
  epoch: path.join(workspaceRoot, "prompts", "epoch-to-phases.md"),
  phase: path.join(workspaceRoot, "prompts", "phase-to-plans.md"),
  plan: path.join(workspaceRoot, "prompts", "plan-to-subplans-and-tasks.md"),
  task: path.join(workspaceRoot, "prompts", "task-to-exec-tasks.md"),
  exec: path.join(workspaceRoot, "prompts", "task-to-exec-tasks.md")
};

const readinessTemplatePath = path.join(workspaceRoot, "prompts", "readiness-evaluation.md");
const synthesisTemplatePath = path.join(workspaceRoot, "prompts", "synthesis.md");
const verificationTemplatePath = path.join(workspaceRoot, "prompts", "verification.md");

function readTemplate(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

export function selectPromptTemplateByTier(params: { tier: NodeTier; job: OrchestrationPromptJob }): {
  tierTemplatePath: string;
  tierTemplate: string;
  coordinatorTemplatePath: string;
  coordinatorTemplate: string;
} {
  const tierTemplatePath =
    params.job === "decompose"
      ? decompositionTemplateByTier[params.tier]
      : params.job === "evaluate_readiness"
        ? readinessTemplatePath
        : params.job === "synthesize"
          ? synthesisTemplatePath
          : verificationTemplatePath;
  return {
    tierTemplatePath,
    tierTemplate: readTemplate(tierTemplatePath),
    coordinatorTemplatePath,
    coordinatorTemplate: readTemplate(coordinatorTemplatePath)
  };
}
