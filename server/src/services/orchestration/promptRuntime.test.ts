import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import type { NodeTier } from "../../types.js";
import { selectPromptTemplateByTier } from "./promptRuntime.js";

function expectPathSuffix(actualPath: string, expectedSuffix: string): void {
  assert.equal(path.normalize(actualPath).endsWith(path.normalize(expectedSuffix)), true);
}

describe("orchestration prompt runtime", () => {
  test("decompose jobs use decomposition templates by tier", () => {
    const expected: Record<NodeTier, string> = {
      epoch: "prompts/epoch-to-phases.md",
      phase: "prompts/phase-to-plans.md",
      plan: "prompts/plan-to-subplans-and-tasks.md",
      task: "prompts/task-to-exec-tasks.md",
      exec: "prompts/task-to-exec-tasks.md"
    };

    for (const tier of Object.keys(expected) as NodeTier[]) {
      const selected = selectPromptTemplateByTier({ tier, job: "decompose" });
      expectPathSuffix(selected.tierTemplatePath, expected[tier]);
      assert.equal(selected.tierTemplate.length > 0, true);
      expectPathSuffix(selected.coordinatorTemplatePath, "prompts/shared-input-output.md");
      assert.equal(selected.coordinatorTemplate.length > 0, true);
    }
  });

  test("non-decompose jobs remain on shared orchestration templates", () => {
    const tier: NodeTier = "task";

    const readiness = selectPromptTemplateByTier({ tier, job: "evaluate_readiness" });
    expectPathSuffix(readiness.tierTemplatePath, "prompts/readiness-evaluation.md");

    const synthesis = selectPromptTemplateByTier({ tier, job: "synthesize" });
    expectPathSuffix(synthesis.tierTemplatePath, "prompts/synthesis.md");

    const verify = selectPromptTemplateByTier({ tier, job: "verify" });
    expectPathSuffix(verify.tierTemplatePath, "prompts/verification.md");
  });
});
