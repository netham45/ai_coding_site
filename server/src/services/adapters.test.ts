import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildCommand, classifyTool, parseLifecycleSignals } from "./adapters.js";

describe("adapters", () => {
  test("classifyTool detects codex, claude, and custom commands", () => {
    assert.equal(classifyTool("codex --yolo {prompt}"), "codex");
    assert.equal(classifyTool("claude run {prompt}"), "claude");
    assert.equal(classifyTool("python script.py"), "custom");
  });

  test("buildCommand normalizes codex resume and strips prompt placeholder", () => {
    const built = buildCommand("codex resume abc123 {prompt}");
    assert.equal(built.detectedTool, "codex");
    assert.equal(built.command, "codex");
    assert.deepEqual(built.args, ["--yolo", "abc123"]);
    assert.equal(built.supportsInteractiveInput, true);
  });

  test("buildCommand rejects blocked shell metacharacters", () => {
    assert.throws(() => buildCommand("codex --yolo {prompt}; rm -rf /"), /blocked shell metacharacters/);
  });

  test("buildCommand rejects empty commands", () => {
    assert.throws(() => buildCommand("  "), /cannot be empty/);
  });

  test("parseLifecycleSignals detects waiting_input and merge readiness", () => {
    assert.deepEqual(parseLifecycleSignals("Need user input to continue"), {
      sessionStatus: "waiting_input",
      taskStatus: "waiting_input",
      reason: "adapter_waiting_input"
    });
    assert.deepEqual(parseLifecycleSignals("Task complete and ready to merge"), {
      taskStatus: "merge_ready",
      reason: "adapter_marked_complete"
    });
    assert.deepEqual(parseLifecycleSignals("still running"), {});
  });
});
