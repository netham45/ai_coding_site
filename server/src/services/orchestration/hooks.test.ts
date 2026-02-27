import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { deriveOrchestrationJobsFromEvent } from "./hooks.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("orchestration hooks", () => {
  afterEach(() => {
    resetEnv();
  });

  test("node-created events default to workflow-engine ownership for plan orchestration", () => {
    delete process.env.ORCHESTRATION_LEGACY_PLAN_ORCHESTRATION_PASS_ENABLED;
    const jobs = deriveOrchestrationJobsFromEvent({
      eventType: "task.created",
      projectId: "project-1",
      taskId: "task-1",
      payload: { any: "value" }
    });

    assert.deepEqual(
      jobs.map((job) => job.jobType),
      ["task_queue_dispatch"]
    );
  });

  test("legacy rollback flag no longer adds plan_orchestration_pass ownership", () => {
    process.env.ORCHESTRATION_LEGACY_PLAN_ORCHESTRATION_PASS_ENABLED = "true";
    const jobs = deriveOrchestrationJobsFromEvent({
      eventType: "task.created",
      projectId: "project-1",
      taskId: "task-1",
      payload: { any: "value" }
    });

    assert.deepEqual(
      jobs.map((job) => job.jobType),
      ["task_queue_dispatch"]
    );
  });
});
