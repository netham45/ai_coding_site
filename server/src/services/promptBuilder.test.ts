import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProjectRow } from "../types.js";
import { buildEffectivePrompt, buildTierOrchestrationPrompt } from "./promptBuilder.js";

function project(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: "project-1",
    name: "Project",
    slug: "project",
    repo_url: "https://example.com/repo.git",
    default_branch: "main",
    base_path: "/tmp/base",
    project_prompt: "Ship fast",
    project_rules: "Write tests",
    coding_standard: "other",
    coding_standard_other: "Internal style guide",
    project_other: "No regressions",
    clone_status: "ready",
    clone_error: null,
    created_by_user_id: "user-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("promptBuilder", () => {
  test("buildEffectivePrompt composes project context, dependencies, task prompt, and CLI usage", () => {
    const output = buildEffectivePrompt(project(), "Implement feature", [
      { id: "dep-1", title: "Dependency 1", result: "Done" },
      { id: "dep-2", title: "Dependency 2", result: "   " }
    ]);

    assert.match(output, /Project Prompt:\nShip fast/);
    assert.match(output, /Rules:\nWrite tests/);
    assert.match(output, /Coding Standard:\nInternal style guide/);
    assert.match(output, /Other:\nNo regressions/);
    assert.match(output, /Dependency Summaries:\n- Dependency 1 \(dep-1\):\nDone/);
    assert.doesNotMatch(output, /dep-2/);
    assert.match(output, /Task Prompt:\nImplement feature/);
    assert.match(output, /CLI Usage:/);
    assert.match(output, /First run `npm run cli -- --help`/);
  });

  test("buildEffectivePrompt falls back to codingStandardOther and trims blank sections", () => {
    const output = buildEffectivePrompt(
      project({ project_prompt: "", project_rules: "", coding_standard: "", project_other: "" }),
      "  task  "
    );
    assert.match(output, /Coding Standard:\nInternal style guide/);
    assert.match(output, /Task Prompt:\ntask/);
    assert.doesNotMatch(output, /Project Prompt:/);
    assert.doesNotMatch(output, /Rules:/);
    assert.doesNotMatch(output, /Other:/);
  });

  test("buildTierOrchestrationPrompt includes all orchestration context fields", () => {
    const output = buildTierOrchestrationPrompt({
      tier: "plan",
      action: "verify",
      nodeId: "node-1",
      nodeTitle: "Plan Node",
      nodePrompt: "check output",
      autoMode: false,
      tierTemplatePath: "prompts/tier.md",
      tierTemplate: "tier template",
      coordinatorTemplatePath: "prompts/core.md",
      coordinatorTemplate: "coordinator template"
    });

    assert.match(output, /Orchestration Action:\nverify/);
    assert.match(output, /Node Context:\n- id: node-1\n- tier: plan\n- title: Plan Node\n- auto_mode: false/);
    assert.match(output, /Node Prompt:\ncheck output/);
    assert.match(output, /Coordinator Template \(prompts\/core.md\):\ncoordinator template/);
    assert.match(output, /Tier Template \(prompts\/tier.md\):\ntier template/);
  });
});
