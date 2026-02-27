import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Database from "better-sqlite3";
import { projectBaselineMigration } from "../db/migrations.js";
import { backfillDefaultWorkflowsForExistingTasks } from "./workflowBackfill.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(projectBaselineMigration);
  return db;
}

function insertTask(
  db: Database.Database,
  params: {
    id: string;
    projectId: string;
    userId: string;
    tier: "exec" | "task" | "plan" | "phase";
    mode?: "execution" | "plan";
    status?: "queued" | "in_progress" | "waiting_input" | "awaiting_children" | "merge_ready" | "merged" | "cancelled" | "failed" | "merge_conflict";
  }
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (
      id, project_id, title, task_prompt, result, effective_prompt, ai_command,
      auto_merge, auto_start, auto_merge_on_complete, metadata_json,
      mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
      status, workspace_path, base_commit_sha_at_create, head_commit_sha,
      cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', ?, 'codex --yolo {prompt}', 0, 0, 0, ?, ?, NULL, NULL, NULL, ?, ?, 'base-sha', NULL, NULL, NULL, NULL, ?, ?, ?)`
  ).run(
    params.id,
    params.projectId,
    `Task ${params.id}`,
    "Prompt",
    "Prompt",
    JSON.stringify({ schema_version: 1, tier: params.tier }),
    params.mode ?? (params.tier === "plan" ? "plan" : "execution"),
    params.status ?? "queued",
    `/tmp/${params.id}`,
    params.userId,
    now,
    now
  );
}

describe("workflowBackfill", () => {
  test("attaches default workflows to legacy tasks and maps terminal statuses", () => {
    const db = createTestDb();
    insertTask(db, { id: "task-plan-1", projectId: "project-1", userId: "user-1", tier: "plan", mode: "plan", status: "merged" });
    insertTask(db, { id: "task-exec-1", projectId: "project-1", userId: "user-1", tier: "exec", status: "queued" });
    insertTask(db, { id: "task-phase-1", projectId: "project-1", userId: "user-1", tier: "phase", status: "cancelled" });

    const result = backfillDefaultWorkflowsForExistingTasks({ db, projectId: "project-1" });
    assert.deepEqual(result, { scanned: 3, attached: 3, skippedExistingRun: 0 });

    const runs = db
      .prepare(
        `SELECT wr.task_id, wr.status, wd.name
         FROM workflow_runs wr
         JOIN workflow_definitions wd ON wd.id = wr.workflow_definition_id
         ORDER BY wr.task_id ASC`
      )
      .all() as Array<{ task_id: string; status: string; name: string }>;
    assert.deepEqual(runs, [
      { task_id: "task-exec-1", status: "queued", name: "task_exec_default" },
      { task_id: "task-phase-1", status: "cancelled", name: "builtin.phase.workflow" },
      { task_id: "task-plan-1", status: "succeeded", name: "builtin.plan.workflow" }
    ]);
    db.close();
  });

  test("is idempotent and skips tasks that already have workflow runs", () => {
    const db = createTestDb();
    insertTask(db, { id: "task-1", projectId: "project-1", userId: "user-1", tier: "exec", status: "queued" });
    insertTask(db, { id: "task-2", projectId: "project-1", userId: "user-1", tier: "plan", mode: "plan", status: "queued" });

    const first = backfillDefaultWorkflowsForExistingTasks({ db, projectId: "project-1" });
    assert.deepEqual(first, { scanned: 2, attached: 2, skippedExistingRun: 0 });

    const second = backfillDefaultWorkflowsForExistingTasks({ db, projectId: "project-1" });
    assert.deepEqual(second, { scanned: 2, attached: 0, skippedExistingRun: 2 });

    const runCount = db.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get() as { count: number };
    assert.equal(runCount.count, 2);
    db.close();
  });

  test("runs in a transaction and rolls back on insertion failure", () => {
    const db = createTestDb();
    insertTask(db, { id: "task-ok", projectId: "project-1", userId: "user-1", tier: "exec", status: "queued" });
    insertTask(db, { id: "task-fail", projectId: "project-1", userId: "user-1", tier: "plan", mode: "plan", status: "queued" });

    db.exec(`
      CREATE TRIGGER workflow_runs_abort_before_insert
      BEFORE INSERT ON workflow_runs
      WHEN NEW.task_id = 'task-fail'
      BEGIN
        SELECT RAISE(ABORT, 'forced workflow run insert failure');
      END;
    `);

    assert.throws(
      () => backfillDefaultWorkflowsForExistingTasks({ db, projectId: "project-1" }),
      /forced workflow run insert failure/
    );

    const definitionCount = db.prepare("SELECT COUNT(*) AS count FROM workflow_definitions").get() as { count: number };
    const runCount = db.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get() as { count: number };
    assert.equal(definitionCount.count, 0);
    assert.equal(runCount.count, 0);
    db.close();
  });
});
