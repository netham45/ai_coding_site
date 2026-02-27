import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Database from "better-sqlite3";
import { projectBaselineMigration } from "../db/migrations.js";
import {
  createWorkflowDefinition,
  createWorkflowRun,
  getWorkflowRunById,
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
});
