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
  createWorkflowStageRun,
  listWorkflowCheckResultsByStageRun,
  getWorkflowRunById,
  listWorkflowEventsByStageRun,
  listWorkflowStageRunsByRun
} from "./workflowRepository.js";
import { handleEvent, startWorkflowRun, tickWorkflowRun } from "./workflowEngine.js";
import { executeWorkflowStageAction } from "./workflowStageActions.js";
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

  test("waiting_input stages auto-verify on idle cadence and advance automatically", () => {
    const db = createTestDb();
    const runId = seedDefinition(
      db,
      JSON.stringify({
        version: 1,
        stages: [
          {
            id: "build",
            expected_results: [
              {
                type: "command_exit_code",
                name: "echo-ok",
                command: ["bash", "-lc", "exit 0"],
                expectedExitCode: 0
              }
            ]
          },
          {
            id: "verify",
            depends_on: ["build"]
          }
        ]
      })
    );

    startWorkflowRun({ db, workflowRunId: runId });
    const initial = listWorkflowStageRunsByRun(db, runId);
    const handled = handleEvent({
      db,
      workflowRunId: runId,
      stageRunId: initial[0].id,
      eventType: "workflow.stage.waiting_input"
    });
    assert.equal(handled.applied, true);

    const after = listWorkflowStageRunsByRun(db, runId);
    assert.equal(after[0].status, "succeeded");
    assert.equal(after[1].status, "running");
    db.close();
  });

  test("failed expected_results checks publish actionable feedback to runtime input", () => {
    const db = createTestDb();
    const runId = seedDefinition(
      db,
      JSON.stringify({
        version: 1,
        stages: [
          {
            id: "execute",
            expected_results: [
              {
                type: "command_exit_code",
                name: "must-pass",
                command: ["bash", "-lc", "exit 1"],
                expectedExitCode: 0
              }
            ]
          }
        ]
      })
    );

    startWorkflowRun({ db, workflowRunId: runId });
    const stage = listWorkflowStageRunsByRun(db, runId)[0];
    handleEvent({
      db,
      workflowRunId: runId,
      stageRunId: stage.id,
      eventType: "workflow.stage.waiting_input"
    });

    const ticked = tickWorkflowRun({ db, workflowRunId: runId });
    assert.equal(ticked.progressed, true);

    const sameStage = listWorkflowStageRunsByRun(db, runId)[0];
    assert.equal(sameStage.status, "running");
    const inputFeedbackEvents = listWorkflowEventsByStageRun(db, stage.id).filter(
      (event) => event.event_type === "workflow.stage.runtime_input.required"
    );
    assert.equal(inputFeedbackEvents.length >= 1, true);
    const payload = JSON.parse(inputFeedbackEvents[inputFeedbackEvents.length - 1].payload) as {
      feedback?: Array<{ check?: string; reason?: string }>;
    };
    assert.equal(Array.isArray(payload.feedback), true);
    assert.equal(payload.feedback?.[0]?.check, "must-pass");
    assert.equal(typeof payload.feedback?.[0]?.reason, "string");
    db.close();
  });

  test("remote desktop workflow e2e: generated children, deterministic gate, ai check gate, and unblock progression", async () => {
    const db = createTestDb();
    const workspace = path.join("/tmp", `wf-engine-rdp-${makeId()}`);
    const parent = insertTaskRow(db, {
      id: "parent-plan",
      projectId: "project-1",
      userId: "user-1",
      workspace_path: workspace,
      status: "in_progress"
    });
    insertTaskRow(db, {
      id: "tsk-toolkit-selection-adr-001",
      projectId: "project-1",
      userId: "user-1",
      parent_plan_task_id: parent.id,
      metadata_json: JSON.stringify({ schema_version: 1, tier: "task" }),
      mode: "execution",
      status: "queued"
    });

    createWorkflowDefinition(db, {
      id: "wf-def-remote-desktop",
      projectId: "project-1",
      name: "remote-desktop",
      version: 1,
      definitionYaml: JSON.stringify({
        version: 1,
        stages: [
          { id: "generate_plan_yaml" },
          { id: "ingest_child_nodes", depends_on: ["generate_plan_yaml"] },
          {
            id: "toolkit_decision",
            depends_on: ["ingest_child_nodes"],
            deterministic_checks: [
              {
                type: "stage_complete",
                name: "ingest-stage-complete",
                stageRunId: "sr-ingest",
                expectedStatus: "succeeded"
              },
              {
                type: "node_merged",
                name: "toolkit-adr-merged",
                nodeId: "tsk-toolkit-selection-adr-001"
              },
              {
                type: "child_nodes_created_count",
                name: "child-nodes-generated",
                parentNodeId: "parent-plan",
                expectedCount: 3,
                comparator: "gte"
              }
            ]
          },
          {
            id: "ai_checks",
            depends_on: ["toolkit_decision"],
            expected_results: [
              {
                type: "command_exit_code",
                name: "ai-check-contract",
                command: ["bash", "-lc", "test -f ai-check.ok"],
                expectedExitCode: 0
              }
            ]
          },
          { id: "finalize", depends_on: ["ai_checks"] }
        ]
      }),
      createdByUserId: "user-1"
    });
    const run = createWorkflowRun(db, {
      id: "wf-run-remote-desktop",
      workflowDefinitionId: "wf-def-remote-desktop",
      projectId: "project-1",
      taskId: parent.id
    });
    createWorkflowStageRun(db, { id: "sr-generate", workflowRunId: run.id, stageKey: "generate_plan_yaml", ordinal: 1 });
    createWorkflowStageRun(db, { id: "sr-ingest", workflowRunId: run.id, stageKey: "ingest_child_nodes", ordinal: 2 });
    createWorkflowStageRun(db, { id: "sr-toolkit", workflowRunId: run.id, stageKey: "toolkit_decision", ordinal: 3 });
    createWorkflowStageRun(db, { id: "sr-ai", workflowRunId: run.id, stageKey: "ai_checks", ordinal: 4 });
    createWorkflowStageRun(db, { id: "sr-finalize", workflowRunId: run.id, stageKey: "finalize", ordinal: 5 });

    startWorkflowRun({ db, workflowRunId: run.id });
    fs.mkdirSync(path.join(workspace, ".ai-plan"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".ai-plan", "latest-plan.yaml"),
      "tasks:\n  - id: exec-wgc-capture\n    title: Implement WGC capture\n    prompt: Build WGC capture path\n  - id: exec-wmf-convert\n    title: Implement WMF conversion\n    prompt: Add WMF conversion path\n",
      "utf8"
    );
    handleEvent({
      db,
      workflowRunId: run.id,
      stageRunId: "sr-generate",
      eventType: "workflow.stage.verify_succeeded"
    });
    assert.equal(listWorkflowStageRunsByRun(db, run.id).find((row) => row.id === "sr-ingest")?.status, "running");

    const createChildren = await executeWorkflowStageAction({
      db,
      workflowRunId: run.id,
      stageRunId: "sr-ingest",
      actionType: "create_child_nodes_from_plan_yaml",
      idempotencyKey: "create-children-rdp"
    });
    assert.equal(createChildren.status, "succeeded");
    assert.equal((createChildren.result as { createdChildCount?: number }).createdChildCount, 2);
    handleEvent({
      db,
      workflowRunId: run.id,
      stageRunId: "sr-ingest",
      eventType: "workflow.stage.verify_succeeded"
    });

    tickWorkflowRun({ db, workflowRunId: run.id });
    const toolkitBlocked = listWorkflowEventsByStageRun(db, "sr-toolkit")
      .filter((event) => event.event_type === "workflow.stage.lifecycle")
      .map((event) => JSON.parse(event.payload));
    assert.equal(toolkitBlocked.some((event) => event.state === "blocked"), true);
    const toolkitCheckResults = listWorkflowCheckResultsByStageRun(db, "sr-toolkit");
    assert.equal(toolkitCheckResults.some((row) => row.check_name === "toolkit-adr-merged" && row.status === "fail"), true);

    db.prepare("UPDATE tasks SET status = 'merged', updated_at = ? WHERE id = ?").run(nowIso(), "tsk-toolkit-selection-adr-001");
    const mergedEvent = handleEvent({
      db,
      workflowRunId: run.id,
      eventType: "workflow.node.merged",
      idempotencyKey: "node-merged-toolkit",
      payload: { nodeId: "tsk-toolkit-selection-adr-001" }
    });
    assert.equal(mergedEvent.applied, true);
    assert.equal(listWorkflowStageRunsByRun(db, run.id).find((row) => row.id === "sr-toolkit")?.status, "running");

    const mergedEventReplay = handleEvent({
      db,
      workflowRunId: run.id,
      eventType: "workflow.node.merged",
      idempotencyKey: "node-merged-toolkit",
      payload: { nodeId: "tsk-toolkit-selection-adr-001" }
    });
    assert.equal(mergedEventReplay.idempotent, true);

    handleEvent({
      db,
      workflowRunId: run.id,
      stageRunId: "sr-toolkit",
      eventType: "workflow.stage.verify_succeeded"
    });
    assert.equal(listWorkflowStageRunsByRun(db, run.id).find((row) => row.id === "sr-ai")?.status, "running");

    handleEvent({
      db,
      workflowRunId: run.id,
      stageRunId: "sr-ai",
      eventType: "workflow.stage.waiting_input"
    });
    tickWorkflowRun({ db, workflowRunId: run.id });
    const aiFeedback = listWorkflowEventsByStageRun(db, "sr-ai")
      .filter((event) => event.event_type === "workflow.stage.runtime_input.required")
      .map((event) => JSON.parse(event.payload));
    assert.equal(aiFeedback.length >= 1, true);
    assert.equal(aiFeedback[aiFeedback.length - 1].feedback?.[0]?.check, "ai-check-contract");

    fs.writeFileSync(path.join(workspace, "ai-check.ok"), "ok\n", "utf8");
    tickWorkflowRun({ db, workflowRunId: run.id });
    assert.equal(listWorkflowStageRunsByRun(db, run.id).find((row) => row.id === "sr-ai")?.status, "succeeded");
    assert.equal(listWorkflowStageRunsByRun(db, run.id).find((row) => row.id === "sr-finalize")?.status, "running");

    handleEvent({
      db,
      workflowRunId: run.id,
      stageRunId: "sr-finalize",
      eventType: "workflow.stage.verify_succeeded"
    });
    assert.equal(getWorkflowRunById(db, run.id)?.status, "succeeded");
    db.close();
  });
});
