import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { projectBaselineMigration } from "../db/migrations.js";
import type { TaskRow } from "../types.js";
import {
  createWorkflowDefinition,
  createWorkflowRun,
  getWorkflowRunById,
  listWorkflowEventsByStageRun,
  listWorkflowStageRunsByRun
} from "./workflowRepository.js";
import { handleEvent, startWorkflowRun, tickWorkflowRun } from "./workflowEngine.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

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

function insertTaskRow(db: Database.Database, input: Partial<TaskRow> & { id: string; projectId: string; userId: string }): TaskRow {
  const now = nowIso();
  const workspacePath = input.workspace_path ?? path.join("/tmp", `workflow-engine-test-${input.id}`);
  fs.mkdirSync(workspacePath, { recursive: true });
  db.prepare(
    `INSERT INTO tasks (
      id, project_id, title, task_prompt, result, effective_prompt, ai_command,
      auto_merge, auto_start, auto_merge_on_complete, metadata_json,
      mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
      status, workspace_path, base_commit_sha_at_create, head_commit_sha,
      cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
  ).run(
    input.id,
    input.projectId,
    input.title ?? "Task",
    input.task_prompt ?? "Prompt",
    input.effective_prompt ?? "Prompt",
    input.ai_command ?? "codex --yolo {prompt}",
    input.metadata_json ?? JSON.stringify({ schema_version: 1, tier: "plan" }),
    input.mode ?? "plan",
    input.parent_plan_task_id ?? null,
    input.source_plan_revision_id ?? null,
    input.source_plan_item_key ?? null,
    input.status ?? "queued",
    workspacePath,
    input.base_commit_sha_at_create ?? "base-sha",
    input.created_by_user_id ?? input.userId,
    now,
    now
  );
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(input.id) as TaskRow;
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

  test("ingest/wait stages are blocked by plan and child-completion rules", () => {
    const db = createTestDb();
    const workspace = path.join("/tmp", `wf-engine-stage-rules-${makeId()}`);
    const parent = insertTaskRow(db, {
      id: "parent-plan",
      projectId: "project-1",
      userId: "user-1",
      workspace_path: workspace,
      status: "in_progress"
    });
    const runId = seedDefinition(
      db,
      `version: 1
stages:
  - id: generate_plan_yaml
  - id: ingest_child_nodes
    depends_on: [generate_plan_yaml]
  - id: wait_for_child_completion
    depends_on: [ingest_child_nodes]
`
    );
    db.prepare("UPDATE workflow_runs SET task_id = ? WHERE id = ?").run(parent.id, runId);
    startWorkflowRun({ db, workflowRunId: runId });
    const stageRuns = listWorkflowStageRunsByRun(db, runId);
    const generate = stageRuns.find((row) => row.stage_key === "generate_plan_yaml")!;
    const ingest = stageRuns.find((row) => row.stage_key === "ingest_child_nodes")!;
    const wait = stageRuns.find((row) => row.stage_key === "wait_for_child_completion")!;
    handleEvent({
      db,
      workflowRunId: runId,
      stageRunId: generate.id,
      eventType: "workflow.stage.verify_succeeded"
    });
    const blockedIngest = listWorkflowEventsByStageRun(db, ingest.id)
      .filter((event) => event.event_type === "workflow.stage.lifecycle")
      .map((event) => JSON.parse(event.payload));
    assert.equal(blockedIngest.some((event) => event.state === "blocked" && event.unresolvedStageRules?.includes("missing_plan_yaml")), true);

    fs.mkdirSync(path.join(workspace, ".ai-plan"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".ai-plan", "latest-plan.yaml"), "tasks:\n  - id: child_a\n    title: Child A\n    prompt: A\n", "utf8");
    tickWorkflowRun({ db, workflowRunId: runId });
    const afterYaml = listWorkflowStageRunsByRun(db, runId);
    assert.equal(afterYaml.find((row) => row.id === ingest.id)?.status, "running");

    handleEvent({
      db,
      workflowRunId: runId,
      stageRunId: ingest.id,
      eventType: "workflow.stage.verify_succeeded"
    });

    insertTaskRow(db, {
      id: "child-1",
      projectId: "project-1",
      userId: "user-1",
      parent_plan_task_id: parent.id,
      mode: "execution",
      metadata_json: JSON.stringify({ schema_version: 1, tier: "exec" }),
      status: "in_progress"
    });
    tickWorkflowRun({ db, workflowRunId: runId });
    const blockedWait = listWorkflowEventsByStageRun(db, wait.id)
      .filter((event) => event.event_type === "workflow.stage.lifecycle")
      .map((event) => JSON.parse(event.payload));
    assert.equal(blockedWait.some((event) => event.state === "blocked"), true);

    db.prepare("UPDATE tasks SET status = 'merged', updated_at = ? WHERE id = 'child-1'").run(nowIso());
    tickWorkflowRun({ db, workflowRunId: runId });
    const afterMerged = listWorkflowStageRunsByRun(db, runId);
    assert.equal(afterMerged.find((row) => row.id === wait.id)?.status, "running");
    db.close();
  });
});
