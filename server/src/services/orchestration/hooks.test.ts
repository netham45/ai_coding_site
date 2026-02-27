import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deriveOrchestrationJobsFromEvent } from "./hooks.js";

describe("orchestration hooks", () => {
  test("node-created events do not enqueue decomposition jobs", () => {
    const jobs = deriveOrchestrationJobsFromEvent({
      eventType: "task.created",
      projectId: "project-1",
      taskId: "task-1",
      payload: { any: "value" }
    });

    assert.deepEqual(
      jobs.map((job) => job.jobType),
      ["task_queue_dispatch", "plan_orchestration_pass"]
    );
  });
});
