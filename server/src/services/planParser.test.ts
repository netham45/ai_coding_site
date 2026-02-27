import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extractYamlDocument, parsePlanOutput, parsePlanYaml } from "./planParser.js";

describe("planParser", () => {
  test("extractYamlDocument reads fenced yaml blocks", () => {
    const raw = "before\n```yaml\ntasks:\n  - id: a\n    prompt: do it\n```\nafter";
    assert.equal(extractYamlDocument(raw), "tasks:\n  - id: a\n    prompt: do it");
  });

  test("extractYamlDocument falls back to top-level tasks key", () => {
    const raw = "notes\n\nauto_start: true\ntasks:\n  - id: A\n    prompt: task";
    assert.equal(extractYamlDocument(raw), "tasks:\n  - id: A\n    prompt: task");
  });

  test("parsePlanYaml supports defaults, aliases, block prompts, and dependency normalization", () => {
    const parsed = parsePlanYaml([
      "auto_start: true",
      "auto_merge_on_complete: true",
      "auto_merge_item_keys: [task A]",
      "tasks:",
      "  - id: task A",
      "    title: First",
      "    prompt: |",
      "      line 1",
      "      line 2",
      "  - id: B",
      "    type: plan",
      "    prompt: build plan",
      "    depends_on:",
      "      - task A"
    ].join("\n"));

    assert.equal(parsed.autoStart, true);
    assert.equal(parsed.autoMergeOnComplete, true);
    assert.deepEqual(parsed.autoMergeItemKeys, ["A"]);
    assert.equal(parsed.tasks.length, 2);

    assert.deepEqual(parsed.tasks[0], {
      itemKey: "A",
      itemType: "execution_task",
      title: "First",
      prompt: "line 1\nline 2",
      dependsOnItemKeys: [],
      autoMerge: true,
      autoStart: false,
      autoMergeOnComplete: false
    });

    assert.deepEqual(parsed.tasks[1], {
      itemKey: "B",
      itemType: "sub_plan",
      title: "Task B",
      prompt: "build plan",
      dependsOnItemKeys: ["A"],
      autoMerge: false,
      autoStart: true,
      autoMergeOnComplete: true
    });
  });

  test("parsePlanOutput extracts yaml then parses", () => {
    const output = "```yml\ntasks:\n  - id: x\n    prompt: run\n```";
    const parsed = parsePlanOutput(output);
    assert.equal(parsed.tasks[0]?.itemKey, "x");
  });

  test("rejects invalid top-level booleans", () => {
    assert.throws(
      () => parsePlanYaml("auto_start: maybe\ntasks:\n  - id: a\n    prompt: p"),
      /Top-level `auto_start` must be true or false/
    );
  });

  test("rejects execution_task with sub-plan automation flags", () => {
    assert.throws(
      () => parsePlanYaml("tasks:\n  - id: a\n    prompt: p\n    auto_start: true"),
      /execution_task and cannot set auto_start/
    );
  });

  test("rejects sub_plan with auto_merge and catches dependency graph issues", () => {
    assert.throws(
      () => parsePlanYaml("tasks:\n  - id: a\n    type: sub_plan\n    prompt: p\n    auto_merge: true"),
      /sub_plan and cannot set auto_merge/
    );

    assert.throws(
      () => parsePlanYaml("tasks:\n  - id: a\n    prompt: p\n    depends_on: [a]"),
      /cannot depend on itself/
    );

    assert.throws(
      () => parsePlanYaml("tasks:\n  - id: a\n    prompt: p\n    depends_on: [b]"),
      /depends on missing task b/
    );

    assert.throws(
      () =>
        parsePlanYaml(
          "tasks:\n  - id: a\n    prompt: p\n    depends_on: [b]\n  - id: b\n    prompt: p\n    depends_on: [a]"
        ),
      /Cyclic dependency detected/
    );

    assert.throws(
      () => parsePlanYaml("tasks:\n  - id: a\n    prompt: p\n  - id: A\n    prompt: p"),
      /Duplicate task identifier/
    );
  });
});
