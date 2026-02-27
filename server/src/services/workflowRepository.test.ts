import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Database from "better-sqlite3";
import { projectBaselineMigration } from "../db/migrations.js";
import {
  WorkflowTransitionError,
  createWorkflowCheckResult,
  createWorkflowDefinition,
  createWorkflowEvent,
  createWorkflowRun,
  createWorkflowStageRun,
  getWorkflowCheckResultById,
  getWorkflowDefinitionById,
  getWorkflowEventById,
  getWorkflowRunById,
  getWorkflowStageRunById,
  listWorkflowCheckResultsByStageRun,
  listWorkflowDefinitionsByProject,
  listWorkflowEventsByRun,
  listWorkflowRunsByProject,
  listWorkflowStageRunsByRun,
  transitionWorkflowRunStatus,
  transitionWorkflowStageRunStatus,
  updateWorkflowCheckResult,
  updateWorkflowDefinition,
  updateWorkflowRun,
  updateWorkflowStageRun
} from "./workflowRepository.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(projectBaselineMigration);
  return db;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function insertTaskRow(db: Database.Database, params: { id: string; projectId: string; userId: string }): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (
       id, project_id, title, task_prompt, result, effective_prompt, ai_command,
       auto_merge, auto_start, auto_merge_on_complete, metadata_json, mode,
       parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
       status, workspace_path, base_commit_sha_at_create, head_commit_sha,
       cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
  ).run(
    params.id,
    params.projectId,
    "Task",
    "Prompt",
    "",
    "Effective Prompt",
    "codex --yolo {prompt}",
    0,
    0,
    0,
    "{}",
    "execution",
    "queued",
    "/tmp/workspace",
    "abc123",
    params.userId,
    now,
    now
  );
}

describe("workflowRepository", () => {
  test("project baseline migration creates workflow tables", () => {
    const db = createTestDb();
    assert.equal(tableExists(db, "workflow_definitions"), true);
    assert.equal(tableExists(db, "workflow_runs"), true);
    assert.equal(tableExists(db, "workflow_stage_runs"), true);
    assert.equal(tableExists(db, "workflow_check_results"), true);
    assert.equal(tableExists(db, "workflow_events"), true);
    db.close();
  });

  test("CRUD round trips across workflow entities", () => {
    const db = createTestDb();
    insertTaskRow(db, { id: "task-123", projectId: "project-1", userId: "user-1" });

    const definition = createWorkflowDefinition(db, {
      id: "wf-def-1",
      projectId: "project-1",
      name: "release_pipeline",
      version: 1,
      definitionYaml: "version: 1\nstages: []",
      createdByUserId: "user-1"
    });
    assert.equal(definition.id, "wf-def-1");
    assert.equal(getWorkflowDefinitionById(db, definition.id)?.name, "release_pipeline");
    assert.equal(listWorkflowDefinitionsByProject(db, "project-1").length, 1);

    const updatedDefinition = updateWorkflowDefinition(db, {
      id: definition.id,
      name: "release_pipeline_v2",
      version: 2,
      definitionYaml: "version: 1\nstages:\n  - id: build"
    });
    assert.equal(updatedDefinition?.name, "release_pipeline_v2");
    assert.equal(updatedDefinition?.version, 2);

    const run = createWorkflowRun(db, {
      id: "wf-run-1",
      workflowDefinitionId: definition.id,
      projectId: "project-1",
      taskId: null
    });
    assert.equal(run.status, "queued");
    assert.equal(getWorkflowRunById(db, run.id)?.status, "queued");
    assert.equal(listWorkflowRunsByProject(db, "project-1").length, 1);

    const runWithTask = updateWorkflowRun(db, { id: run.id, taskId: "task-123" });
    assert.equal(runWithTask?.task_id, "task-123");

    const stageRun = createWorkflowStageRun(db, {
      id: "wf-stage-run-1",
      workflowRunId: run.id,
      stageKey: "build",
      ordinal: 1
    });
    assert.equal(stageRun.status, "pending");
    assert.equal(getWorkflowStageRunById(db, stageRun.id)?.stage_key, "build");
    assert.equal(listWorkflowStageRunsByRun(db, run.id).length, 1);

    const reorderedStage = updateWorkflowStageRun(db, { id: stageRun.id, ordinal: 2 });
    assert.equal(reorderedStage?.ordinal, 2);

    const check = createWorkflowCheckResult(db, {
      id: "wf-check-1",
      workflowStageRunId: stageRun.id,
      checkName: "unit_tests",
      status: "pass",
      details: { count: 25 }
    });
    assert.equal(check.status, "pass");
    assert.deepEqual(JSON.parse(getWorkflowCheckResultById(db, check.id)?.details_json ?? "{}"), { count: 25 });
    assert.equal(listWorkflowCheckResultsByStageRun(db, stageRun.id).length, 1);

    const updatedCheck = updateWorkflowCheckResult(db, {
      id: check.id,
      status: "fail",
      details: { failing: 2 }
    });
    assert.equal(updatedCheck?.status, "fail");
    assert.deepEqual(JSON.parse(updatedCheck?.details_json ?? "{}"), { failing: 2 });

    const event = createWorkflowEvent(db, {
      id: "wf-event-1",
      workflowRunId: run.id,
      workflowStageRunId: stageRun.id,
      eventType: "workflow.stage.completed",
      payload: { ok: true }
    });
    assert.equal(event.event_type, "workflow.stage.completed");
    assert.deepEqual(JSON.parse(getWorkflowEventById(db, event.id)?.payload ?? "{}"), { ok: true });
    assert.equal(listWorkflowEventsByRun(db, run.id).length, 1);

    db.close();
  });

  test("run and stage transitions persist status integrity", () => {
    const db = createTestDb();
    createWorkflowDefinition(db, {
      id: "wf-def-2",
      projectId: "project-2",
      name: "build_and_deploy",
      version: 1,
      definitionYaml: "version: 1\nstages:\n  - id: build",
      createdByUserId: "user-2"
    });
    createWorkflowRun(db, {
      id: "wf-run-2",
      workflowDefinitionId: "wf-def-2",
      projectId: "project-2"
    });
    createWorkflowStageRun(db, {
      id: "wf-stage-run-2",
      workflowRunId: "wf-run-2",
      stageKey: "build",
      ordinal: 1
    });

    const runningRun = transitionWorkflowRunStatus(db, {
      runId: "wf-run-2",
      toStatus: "running",
      reason: "worker_started"
    });
    assert.equal(runningRun.status, "running");
    assert.ok(runningRun.started_at);
    assert.equal(runningRun.completed_at, null);

    const succeededRun = transitionWorkflowRunStatus(db, {
      runId: "wf-run-2",
      toStatus: "succeeded",
      reason: "all_stages_complete"
    });
    assert.equal(succeededRun.status, "succeeded");
    assert.ok(succeededRun.started_at);
    assert.ok(succeededRun.completed_at);

    const runningStage = transitionWorkflowStageRunStatus(db, {
      stageRunId: "wf-stage-run-2",
      toStatus: "running",
      reason: "executor_started"
    });
    assert.equal(runningStage.status, "running");
    assert.ok(runningStage.started_at);
    assert.equal(runningStage.completed_at, null);

    const failedStage = transitionWorkflowStageRunStatus(db, {
      stageRunId: "wf-stage-run-2",
      toStatus: "failed",
      reason: "check_failure"
    });
    assert.equal(failedStage.status, "failed");
    assert.ok(failedStage.completed_at);

    assert.throws(
      () => transitionWorkflowRunStatus(db, { runId: "wf-run-2", toStatus: "running" }),
      WorkflowTransitionError
    );
    assert.throws(
      () => transitionWorkflowStageRunStatus(db, { stageRunId: "wf-stage-run-2", toStatus: "running" }),
      WorkflowTransitionError
    );

    assert.equal(getWorkflowRunById(db, "wf-run-2")?.status, "succeeded");
    assert.equal(getWorkflowStageRunById(db, "wf-stage-run-2")?.status, "failed");
    assert.equal(listWorkflowEventsByRun(db, "wf-run-2").length >= 4, true);
    db.close();
  });
});
