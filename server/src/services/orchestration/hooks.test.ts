import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deriveOrchestrationJobsFromEvent } from "./hooks.js";

describe("orchestration hooks", () => {
  test("task-created events enqueue workflow-engine dispatch job", () => {
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

  test("plan-created events enqueue workflow-engine dispatch job", () => {
    const jobs = deriveOrchestrationJobsFromEvent({
      eventType: "plan.created",
      projectId: "project-1",
      taskId: "plan-1",
      payload: { any: "value" }
    });

    assert.deepEqual(
      jobs.map((job) => job.jobType),
      ["task_queue_dispatch"]
    );
  });
});
