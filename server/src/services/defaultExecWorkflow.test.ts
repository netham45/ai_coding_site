import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Database from "better-sqlite3";
import { projectBaselineMigration } from "../db/migrations.js";
import { ensureDefaultExecWorkflowForTask } from "./defaultExecWorkflow.js";
import {
  listWorkflowDefinitionsByProject,
  listWorkflowRunsByProject,
  listWorkflowStageRunsByRun
} from "./workflowRepository.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(projectBaselineMigration);
  return db;
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
    "Exec Task",
    "Prompt",
    "",
    "Prompt",
    "codex --yolo {prompt}",
    0,
    0,
    0,
    JSON.stringify({ schema_version: 1, tier: "exec" }),
    "execution",
    "queued",
    "/tmp/workspace",
    "abc123",
    params.userId,
    now,
    now
  );
}

describe("defaultExecWorkflow", () => {
  test("creates and auto-progresses default workflow for exec task", async () => {
    const db = createTestDb();
    insertTaskRow(db, { id: "task-1", projectId: "project-1", userId: "user-1" });

    const run = await ensureDefaultExecWorkflowForTask({
      db,
      projectId: "project-1",
      taskId: "task-1",
      createdByUserId: "user-1"
    });

    assert.equal(run.status, "succeeded");
    const defs = listWorkflowDefinitionsByProject(db, "project-1");
    assert.equal(defs.length, 1);
    assert.equal(defs[0].name, "task_exec_default");
    const stageRuns = listWorkflowStageRunsByRun(db, run.id);
    assert.deepEqual(stageRuns.map((row) => row.stage_key), ["run_command", "review", "return_result"]);
    assert.equal(stageRuns.every((row) => row.status === "succeeded"), true);
    db.close();
  });

  test("is idempotent when workflow is already attached", async () => {
    const db = createTestDb();
    insertTaskRow(db, { id: "task-2", projectId: "project-1", userId: "user-1" });

    const first = await ensureDefaultExecWorkflowForTask({
      db,
      projectId: "project-1",
      taskId: "task-2",
      createdByUserId: "user-1"
    });
    const second = await ensureDefaultExecWorkflowForTask({
      db,
      projectId: "project-1",
      taskId: "task-2",
      createdByUserId: "user-1"
    });

    assert.equal(first.id, second.id);
    const runs = listWorkflowRunsByProject(db, "project-1");
    assert.equal(runs.length, 1);
    db.close();
  });
});
