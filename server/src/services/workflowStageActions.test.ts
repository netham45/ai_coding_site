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
  getWorkflowStageRunById,
  listWorkflowEventsByStageRun
} from "./workflowRepository.js";
import { executeWorkflowStageAction, type WorkflowStageActionType } from "./workflowStageActions.js";
import { nowIso } from "../utils/time.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(projectBaselineMigration);
  return db;
}

function setupWorkflow(db: Database.Database): { runId: string; stageId: string } {
  createWorkflowDefinition(db, {
    id: "wf-def-actions",
    projectId: "project-1",
    name: "workflow_actions",
    version: 1,
    definitionYaml: "version: 1\nstages:\n  - id: execute",
    createdByUserId: "user-1"
  });
  createWorkflowRun(db, {
    id: "wf-run-actions",
    workflowDefinitionId: "wf-def-actions",
    projectId: "project-1"
  });
  createWorkflowStageRun(db, {
    id: "wf-stage-actions",
    workflowRunId: "wf-run-actions",
    stageKey: "execute",
    ordinal: 1
  });
  return { runId: "wf-run-actions", stageId: "wf-stage-actions" };
}

function insertTaskRow(db: Database.Database, input: { id: string; projectId: string; userId: string; workspacePath: string }): TaskRow {
  const now = nowIso();
  db.prepare(
    `INSERT INTO tasks (
      id, project_id, title, task_prompt, result, effective_prompt, ai_command,
      auto_merge, auto_start, auto_merge_on_complete, metadata_json,
      mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
      status, workspace_path, base_commit_sha_at_create, head_commit_sha,
      cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', ?, ?, 0, 0, 0, ?, 'plan', NULL, NULL, NULL, 'in_progress', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
  ).run(
    input.id,
    input.projectId,
    "Parent Plan",
    "Plan prompt",
    "Plan prompt",
    "codex --yolo {prompt}",
    JSON.stringify({ schema_version: 1, tier: "plan" }),
    input.workspacePath,
    "base-sha",
    input.userId,
    now,
    now
  );
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(input.id) as TaskRow;
}

describe("workflowStageActions", () => {
  const actionTypes: WorkflowStageActionType[] = [
    "run_command",
    "task_runtime_prompt",
    "create_child_nodes_from_plan_yaml",
    "review_child_nodes",
    "no_op"
  ];

  for (const actionType of actionTypes) {
    test(`executes ${actionType} and records auditable events`, async () => {
      const db = createTestDb();
      const { runId, stageId } = setupWorkflow(db);
      let handlerCalls = 0;

      const result = await executeWorkflowStageAction({
        db,
        workflowRunId: runId,
        stageRunId: stageId,
        actionType,
        idempotencyKey: `idempotency:${actionType}`,
        actionInput: {
          command: "echo hello",
          taskId: "task-1",
          prompt: "continue",
          yaml: "tasks:\n  - id: task-1\n    title: One\n    prompt: first",
          childNodes: [{ id: "child-1", status: "merged" }],
          message: "noop"
        },
        handlers: {
          runCommand: async () => {
            handlerCalls += 1;
            return { ok: true, actionType };
          },
          taskRuntimePrompt: async () => {
            handlerCalls += 1;
            return { ok: true, actionType };
          },
          createChildNodesFromPlanYaml: async () => {
            handlerCalls += 1;
            return { ok: true, actionType };
          },
          reviewChildNodes: async () => {
            handlerCalls += 1;
            return { ok: true, actionType };
          },
          noOp: async () => {
            handlerCalls += 1;
            return { ok: true, actionType };
          }
        }
      });

      assert.equal(result.status, "succeeded");
      assert.equal(result.idempotent, false);
      assert.deepEqual(result.result, { ok: true, actionType });
      assert.equal(handlerCalls, 1);
      assert.equal(getWorkflowStageRunById(db, stageId)?.status, "succeeded");

      const events = listWorkflowEventsByStageRun(db, stageId);
      const started = events.find((event) => event.event_type === "workflow.stage.action.started");
      const completed = events.find((event) => event.event_type === "workflow.stage.action.completed");
      assert.ok(started);
      assert.ok(completed);
      assert.equal(JSON.parse(completed?.payload ?? "{}").actionType, actionType);

      const replay = await executeWorkflowStageAction({
        db,
        workflowRunId: runId,
        stageRunId: stageId,
        actionType,
        idempotencyKey: `idempotency:${actionType}`,
        actionInput: { command: "echo should-not-run" },
        handlers: {
          runCommand: async () => {
            handlerCalls += 1;
            return { shouldNotRun: true };
          }
        }
      });

      assert.equal(replay.status, "succeeded");
      assert.equal(replay.idempotent, true);
      assert.equal(handlerCalls, 1);
      db.close();
    });
  }

  test("action failures are captured with structured reason payload", async () => {
    const db = createTestDb();
    const { runId, stageId } = setupWorkflow(db);

    const failed = await executeWorkflowStageAction({
      db,
      workflowRunId: runId,
      stageRunId: stageId,
      actionType: "run_command",
      idempotencyKey: "idempotency:failure",
      actionInput: { command: "echo boom" },
      handlers: {
        runCommand: async () => {
          throw new Error("forced failure");
        }
      }
    });

    assert.equal(failed.status, "failed");
    assert.equal(failed.idempotent, false);
    assert.equal(failed.reason?.code, "unexpected_error");
    assert.equal(failed.reason?.message, "forced failure");
    assert.equal(typeof failed.reason?.retryable, "boolean");
    assert.equal(getWorkflowStageRunById(db, stageId)?.status, "failed");

    const failedEvent = listWorkflowEventsByStageRun(db, stageId).find((event) => event.event_type === "workflow.stage.action.failed");
    assert.ok(failedEvent);
    const payload = JSON.parse(failedEvent?.payload ?? "{}");
    assert.equal(payload.actionType, "run_command");
    assert.equal(payload.reason.code, "unexpected_error");
    assert.equal(payload.reason.message, "forced failure");
    assert.equal(typeof payload.reason.retryable, "boolean");
    db.close();
  });

  test("create_child_nodes_from_plan_yaml reads latest plan file and persists children/dependencies", async () => {
    const db = createTestDb();
    const { runId, stageId } = setupWorkflow(db);
    const workspacePath = path.join("/tmp", "workflow-stage-action-parent");
    fs.mkdirSync(path.join(workspacePath, ".ai-plan"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, ".ai-plan", "latest-plan.yaml"),
      [
        "tasks:",
        "  - id: child_a",
        "    title: Child A",
        "    prompt: Build A",
        "  - id: child_b",
        "    title: Child B",
        "    prompt: Build B",
        "    depends_on: [child_a]",
        ""
      ].join("\n"),
      "utf8"
    );
    const parent = insertTaskRow(db, { id: "parent-plan", projectId: "project-1", userId: "user-1", workspacePath });
    db.prepare("UPDATE workflow_runs SET task_id = ? WHERE id = ?").run(parent.id, runId);

    const result = await executeWorkflowStageAction({
      db,
      workflowRunId: runId,
      stageRunId: stageId,
      actionType: "create_child_nodes_from_plan_yaml",
      idempotencyKey: "idempotency:create-children"
    });
    assert.equal(result.status, "succeeded");
    assert.equal((result.result as { createdChildCount?: number }).createdChildCount, 2);

    const children = db.prepare("SELECT * FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC").all(parent.id) as TaskRow[];
    assert.equal(children.length, 2);
    const depRows = db
      .prepare("SELECT task_id, dependency_task_id FROM task_dependencies WHERE task_id IN (?, ?) ORDER BY task_id ASC")
      .all(children[0].id, children[1].id) as Array<{ task_id: string; dependency_task_id: string }>;
    assert.equal(depRows.length, 1);

    const artifact = listWorkflowEventsByStageRun(db, stageId).find((event) => event.event_type === "workflow.stage.action.child_nodes_created");
    assert.ok(artifact);
    assert.equal(JSON.parse(artifact?.payload ?? "{}").createdChildCount, 2);
    db.close();
  });
});
