import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Database from "better-sqlite3";
import { projectBaselineMigration } from "../db/migrations.js";
import {
  createWorkflowDefinition,
  createWorkflowRun,
  createWorkflowStageRun,
  getWorkflowStageRunById,
  listWorkflowEventsByStageRun
} from "./workflowRepository.js";
import { executeWorkflowStageAction, type WorkflowStageActionType } from "./workflowStageActions.js";

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
});
