import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Database from "better-sqlite3";
import { projectBaselineMigration } from "../../db/migrations.js";
import { legacyJobSuppressedByWorkflowOwnership } from "./ownership.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(projectBaselineMigration);
  return db;
}

function insertTask(db: Database.Database, params: { id: string; mode: "plan" | "execution"; parentPlanTaskId?: string | null }): void {
  const now = new Date().toISOString();
  const metadataTier = params.mode === "plan" ? "plan" : "exec";
  db.prepare(
    `INSERT INTO tasks (
      id, project_id, title, task_prompt, result, effective_prompt, ai_command,
      auto_merge, auto_start, auto_merge_on_complete, metadata_json,
      mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
      status, workspace_path, base_commit_sha_at_create, head_commit_sha,
      cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
    ) VALUES (?, 'project-1', ?, 'Prompt', '', 'Prompt', 'codex --yolo {prompt}', 0, 0, 0, ?, ?, ?, NULL, NULL,
              'queued', ?, 'base-sha', NULL, NULL, NULL, NULL, 'user-1', ?, ?)`
  ).run(
    params.id,
    params.id,
    JSON.stringify({ schema_version: 1, tier: metadataTier }),
    params.mode,
    params.parentPlanTaskId ?? null,
    `/tmp/${params.id}`,
    now,
    now
  );
}

function insertActiveWorkflowRunForTask(db: Database.Database, taskId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workflow_definitions (
      id, project_id, name, version, definition_yaml, created_by_user_id, created_at, updated_at
    ) VALUES ('wf-def-1', 'project-1', 'builtin.plan.workflow', 1, 'stages: []', 'user-1', ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO workflow_runs (
      id, workflow_definition_id, project_id, task_id, status, started_at, completed_at, created_at, updated_at
    ) VALUES ('wf-run-1', 'wf-def-1', 'project-1', ?, 'running', ?, NULL, ?, ?)`
  ).run(taskId, now, now, now);
}

describe("workflow ownership for legacy orchestration jobs", () => {
  test("suppresses decompose for plan nodes owned by running workflow", () => {
    const db = createTestDb();
    insertTask(db, { id: "plan-1", mode: "plan" });
    insertActiveWorkflowRunForTask(db, "plan-1");

    assert.equal(
      legacyJobSuppressedByWorkflowOwnership({
        projectDb: db,
        jobType: "decompose",
        hintTaskId: "plan-1"
      }),
      true
    );
    db.close();
  });

  test("suppresses synthesize for execution child when parent plan has running workflow", () => {
    const db = createTestDb();
    insertTask(db, { id: "plan-1", mode: "plan" });
    insertTask(db, { id: "exec-1", mode: "execution", parentPlanTaskId: "plan-1" });
    insertActiveWorkflowRunForTask(db, "plan-1");

    assert.equal(
      legacyJobSuppressedByWorkflowOwnership({
        projectDb: db,
        jobType: "synthesize",
        hintTaskId: "exec-1"
      }),
      true
    );
    db.close();
  });

  test("does not suppress when no workflow run owns the plan node", () => {
    const db = createTestDb();
    insertTask(db, { id: "plan-1", mode: "plan" });

    assert.equal(
      legacyJobSuppressedByWorkflowOwnership({
        projectDb: db,
        jobType: "verify",
        hintTaskId: "plan-1"
      }),
      false
    );
    db.close();
  });
});
