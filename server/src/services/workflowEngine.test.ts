import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Database from "better-sqlite3";
import { projectBaselineMigration } from "../db/migrations.js";
import {
  createWorkflowDefinition,
  createWorkflowRun,
  createWorkflowStageRun,
  getWorkflowRunById,
  listWorkflowCheckResultsByStageRun,
  listWorkflowEventsByStageRun,
  listWorkflowStageRunsByRun
} from "./workflowRepository.js";
import { handleEvent, startWorkflowRun, tickWorkflowRun } from "./workflowEngine.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(projectBaselineMigration);
  return db;
}

function seedDefinition(db: Database.Database, definitionYaml: string): string {
  createWorkflowDefinition(db, {
    id: "wf-def-engine",
    projectId: "project-1",
    name: "engine",
    version: 1,
    definitionYaml,
    createdByUserId: "user-1"
  });
  const run = createWorkflowRun(db, {
    id: "wf-run-engine",
    workflowDefinitionId: "wf-def-engine",
    projectId: "project-1"
  });
  return run.id;
}

describe("workflowEngine", () => {
  test("stage progression works end-to-end with dependency gating", () => {
    const db = createTestDb();
    const runId = seedDefinition(
      db,
      `version: 1
stages:
  - id: build
    max_attempts: 2
  - id: verify
    depends_on: [build]
`
    );

    const started = startWorkflowRun({ db, workflowRunId: runId });
    assert.equal(started.status, "running");

    const stageRuns = listWorkflowStageRunsByRun(db, runId);
    assert.equal(stageRuns.length, 2);
    assert.equal(stageRuns[0].stage_key, "build");
    assert.equal(stageRuns[0].status, "running");
    assert.equal(stageRuns[1].status, "pending");

    const verifyBlockedEvents = listWorkflowEventsByStageRun(db, stageRuns[1].id).filter(
      (event) => event.event_type === "workflow.stage.lifecycle"
    );
    assert.equal(verifyBlockedEvents.length >= 1, true);
    assert.equal(JSON.parse(verifyBlockedEvents[0].payload).state, "blocked");

    handleEvent({
      db,
      workflowRunId: runId,
      stageRunId: stageRuns[0].id,
      eventType: "workflow.stage.verify_succeeded"
    });

    const afterBuild = listWorkflowStageRunsByRun(db, runId);
    assert.equal(afterBuild[0].status, "succeeded");
    assert.equal(afterBuild[1].status, "running");

    handleEvent({
      db,
      workflowRunId: runId,
      stageRunId: afterBuild[1].id,
      eventType: "workflow.stage.verify_succeeded"
    });

    const completeRun = getWorkflowRunById(db, runId)!;
    assert.equal(completeRun.status, "succeeded");
    db.close();
  });

  test("waiting_input and verifying transitions are tracked correctly", () => {
    const db = createTestDb();
    const runId = seedDefinition(
      db,
      `version: 1
stages:
  - id: execute
`
    );
    startWorkflowRun({ db, workflowRunId: runId });
    const stage = listWorkflowStageRunsByRun(db, runId)[0];
    assert.equal(stage.status, "running");

    handleEvent({
      db,
      workflowRunId: runId,
      stageRunId: stage.id,
      eventType: "workflow.stage.waiting_input"
    });
    handleEvent({
      db,
      workflowRunId: runId,
      stageRunId: stage.id,
      eventType: "workflow.stage.input_received"
    });
    handleEvent({
      db,
      workflowRunId: runId,
      stageRunId: stage.id,
      eventType: "workflow.stage.verifying"
    });

    const lifecycle = listWorkflowEventsByStageRun(db, stage.id)
      .filter((event) => event.event_type === "workflow.stage.lifecycle")
      .map((event) => JSON.parse(event.payload).state);
    assert.deepEqual(lifecycle.includes("waiting_input"), true);
    assert.deepEqual(lifecycle.includes("verifying"), true);
    db.close();
  });

  test("attempt limits and retry behavior fail stage when exhausted", () => {
    const db = createTestDb();
    const runId = seedDefinition(
      db,
      `version: 1
stages:
  - id: execute
    max_attempts: 2
`
    );
    startWorkflowRun({ db, workflowRunId: runId });
    const stage = listWorkflowStageRunsByRun(db, runId)[0];

    handleEvent({
      db,
      workflowRunId: runId,
      stageRunId: stage.id,
      eventType: "workflow.stage.verify_failed",
      payload: { retryable: true }
    });

    const attemptsAfterRetry = listWorkflowEventsByStageRun(db, stage.id).filter(
      (event) => event.event_type === "workflow.stage.attempt.started"
    );
    assert.equal(attemptsAfterRetry.length, 2);

    handleEvent({
      db,
      workflowRunId: runId,
      stageRunId: stage.id,
      eventType: "workflow.stage.verify_failed",
      payload: { retryable: true }
    });

    const exhaustedStage = listWorkflowStageRunsByRun(db, runId)[0];
    assert.equal(exhaustedStage.status, "failed");
    assert.equal(getWorkflowRunById(db, runId)?.status, "failed");
    db.close();
  });

  test("engine is idempotent under repeated ticks and duplicate events", () => {
    const db = createTestDb();
    const runId = seedDefinition(
      db,
      `version: 1
stages:
  - id: execute
`
    );
    startWorkflowRun({ db, workflowRunId: runId });
    const stage = listWorkflowStageRunsByRun(db, runId)[0];
    const attemptsBefore = listWorkflowEventsByStageRun(db, stage.id).filter(
      (event) => event.event_type === "workflow.stage.attempt.started"
    ).length;
    assert.equal(attemptsBefore, 1);

    const tickA = tickWorkflowRun({ db, workflowRunId: runId });
    const tickB = tickWorkflowRun({ db, workflowRunId: runId });
    assert.equal(tickA.progressed, false);
    assert.equal(tickB.progressed, false);
    const attemptsAfterTicks = listWorkflowEventsByStageRun(db, stage.id).filter(
      (event) => event.event_type === "workflow.stage.attempt.started"
    ).length;
    assert.equal(attemptsAfterTicks, 1);

    const first = handleEvent({
      db,
      workflowRunId: runId,
      stageRunId: stage.id,
      eventType: "workflow.stage.waiting_input",
      idempotencyKey: "evt-1"
    });
    const second = handleEvent({
      db,
      workflowRunId: runId,
      stageRunId: stage.id,
      eventType: "workflow.stage.waiting_input",
      idempotencyKey: "evt-1"
    });
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);

    const waitingEvents = listWorkflowEventsByStageRun(db, stage.id).filter(
      (event) => event.event_type === "workflow.stage.waiting_input"
    );
    assert.equal(waitingEvents.length, 1);
    db.close();
  });

  test("stage_complete and node_merged checks unblock via event-driven rechecks", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO tasks (
         id, project_id, title, task_prompt, result, effective_prompt, ai_command,
         auto_merge, auto_start, auto_merge_on_complete, metadata_json, mode,
         parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
         status, workspace_path, base_commit_sha_at_create, head_commit_sha,
         cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
       ) VALUES (
         'task-wf', 'project-1', 'task-wf', 'prompt', '', 'effective', 'codex --yolo {prompt}',
         0, 0, 0, '{}', 'execution',
         NULL, NULL, NULL,
         'in_progress', '/tmp/workspace', 'base-sha', NULL,
         NULL, NULL, NULL, 'user-1', datetime('now'), datetime('now')
       )`
    ).run();
    db.prepare(
      `INSERT INTO tasks (
         id, project_id, title, task_prompt, result, effective_prompt, ai_command,
         auto_merge, auto_start, auto_merge_on_complete, metadata_json, mode,
         parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
         status, workspace_path, base_commit_sha_at_create, head_commit_sha,
         cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
       ) VALUES (
         'node-target', 'project-1', 'node-target', 'prompt', '', 'effective', 'codex --yolo {prompt}',
         0, 0, 0, '{}', 'execution',
         NULL, NULL, NULL,
         'merge_ready', '/tmp/workspace', 'base-sha', NULL,
         NULL, NULL, NULL, 'user-1', datetime('now'), datetime('now')
       )`
    ).run();

    createWorkflowDefinition(db, {
      id: "wf-def-check-unblock",
      projectId: "project-1",
      name: "check-unblock",
      version: 1,
      definitionYaml: JSON.stringify({
        version: 1,
        stages: [
          { id: "build", max_attempts: 1 },
          {
            id: "gate",
            max_attempts: 1,
            deterministic_checks: [
              { type: "stage_complete", name: "wait-build", stageRunId: "wf-stage-build-check" },
              { type: "node_merged", name: "wait-node-merge", nodeId: "node-target" }
            ]
          }
        ]
      }),
      createdByUserId: "user-1"
    });
    const run = createWorkflowRun(db, {
      id: "wf-run-check-unblock",
      workflowDefinitionId: "wf-def-check-unblock",
      projectId: "project-1",
      taskId: "task-wf"
    });
    createWorkflowStageRun(db, {
      id: "wf-stage-build-check",
      workflowRunId: run.id,
      stageKey: "build",
      ordinal: 1,
      status: "pending"
    });
    createWorkflowStageRun(db, {
      id: "wf-stage-gate-check",
      workflowRunId: run.id,
      stageKey: "gate",
      ordinal: 2,
      status: "pending"
    });

    startWorkflowRun({ db, workflowRunId: run.id });
    const initialStages = listWorkflowStageRunsByRun(db, run.id);
    const build = initialStages.find((stage) => stage.stage_key === "build")!;
    const gate = initialStages.find((stage) => stage.stage_key === "gate")!;

    assert.equal(build.status, "running");
    assert.equal(gate.status, "pending");
    const initialGateChecks = listWorkflowCheckResultsByStageRun(db, gate.id);
    assert.equal(initialGateChecks.length > 0, true);
    assert.equal(initialGateChecks.some((row) => row.check_name === "wait-build" && row.status === "fail"), true);
    assert.equal(initialGateChecks.some((row) => row.check_name === "wait-node-merge" && row.status === "fail"), true);

    handleEvent({
      db,
      workflowRunId: run.id,
      stageRunId: build.id,
      eventType: "workflow.stage.verify_succeeded"
    });
    const afterBuild = listWorkflowStageRunsByRun(db, run.id);
    const gateAfterBuild = afterBuild.find((stage) => stage.id === gate.id)!;
    assert.equal(gateAfterBuild.status, "pending");
    const buildPassedChecks = listWorkflowCheckResultsByStageRun(db, gate.id);
    assert.equal(buildPassedChecks.some((row) => row.check_name === "wait-build" && row.status === "pass"), true);
    assert.equal(buildPassedChecks.some((row) => row.check_name === "wait-node-merge" && row.status === "fail"), true);

    db.prepare("UPDATE tasks SET status = 'merged' WHERE id = 'node-target'").run();
    handleEvent({
      db,
      workflowRunId: run.id,
      eventType: "workflow.node.merged",
      payload: { nodeId: "node-target" }
    });
    const afterNodeMerge = listWorkflowStageRunsByRun(db, run.id);
    const gateRunning = afterNodeMerge.find((stage) => stage.id === gate.id)!;
    assert.equal(gateRunning.status, "running");
    const mergedChecks = listWorkflowCheckResultsByStageRun(db, gate.id);
    assert.equal(mergedChecks.some((row) => row.check_name === "wait-build" && row.status === "pass"), true);
    assert.equal(mergedChecks.some((row) => row.check_name === "wait-node-merge" && row.status === "pass"), true);

    db.close();
  });
});
