import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Database from "better-sqlite3";
import { projectBaselineMigration } from "../db/migrations.js";
import { startBuiltinWorkflowForTierTask } from "./workflowBuiltins.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(projectBaselineMigration);
  return db;
}

function insertPlanTask(db: Database.Database, taskId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (
      id, project_id, title, task_prompt, result, effective_prompt, ai_command,
      auto_merge, auto_start, auto_merge_on_complete, metadata_json,
      mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
      status, workspace_path, base_commit_sha_at_create, head_commit_sha,
      cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
    ) VALUES (?, 'project-1', 'Plan', 'Prompt', '', 'Prompt', 'codex --yolo {prompt}', 0, 0, 0, ?, 'plan', NULL, NULL, NULL,
              'queued', ?, 'base-sha', NULL, NULL, NULL, NULL, 'user-1', ?, ?)`
  ).run(taskId, JSON.stringify({ schema_version: 1, tier: "plan" }), `/tmp/${taskId}`, now, now);
}

describe("workflowBuiltins", () => {
  test("starts and reuses active built-in workflow runs for plan-tier tasks", () => {
    const db = createTestDb();
    insertPlanTask(db, "task-plan-1");

    const first = startBuiltinWorkflowForTierTask({
      db,
      projectId: "project-1",
      taskId: "task-plan-1",
      tier: "plan",
      createdByUserId: "user-1"
    });
    assert.equal(first.status, "running");

    const second = startBuiltinWorkflowForTierTask({
      db,
      projectId: "project-1",
      taskId: "task-plan-1",
      tier: "plan",
      createdByUserId: "user-1"
    });
    assert.equal(second.id, first.id);

    const runCount = db.prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE task_id = ?").get("task-plan-1") as { count: number };
    assert.equal(runCount.count, 1);

    const stageKeys = (
      db.prepare(
        `SELECT sr.stage_key
         FROM workflow_stage_runs sr
         JOIN workflow_runs wr ON wr.id = sr.workflow_run_id
         WHERE wr.id = ?
         ORDER BY sr.ordinal ASC`
      ).all(first.id) as Array<{ stage_key: string }>
    ).map((row) => row.stage_key);
    assert.deepEqual(stageKeys, ["generate_plan_yaml", "ingest_child_nodes", "wait_for_child_completion"]);
    db.close();
  });
});
