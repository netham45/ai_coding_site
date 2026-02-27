import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import Database from "better-sqlite3";
import { projectBaselineMigration } from "../db/migrations.js";
import { nowIso } from "../utils/time.js";
import {
  createWorkflowDefinition,
  createWorkflowRun,
  createWorkflowStageRun,
  listWorkflowCheckResultsByStageRun,
  transitionWorkflowStageRunStatus
} from "./workflowRepository.js";
import { runDeterministicChecksForStageRun, type DeterministicWorkflowCheck } from "./workflowChecks.js";

const tempDirs: string[] = [];

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(projectBaselineMigration);
  return db;
}

function makeWorkspace(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function insertTaskRow(db: Database.Database, params: { id: string; projectId: string; userId: string; parentTaskId?: string | null; status?: string }): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO tasks (
       id, project_id, title, task_prompt, result, effective_prompt, ai_command,
       auto_merge, auto_start, auto_merge_on_complete, metadata_json, mode,
       parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
       status, workspace_path, base_commit_sha_at_create, head_commit_sha,
       cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
  ).run(
    params.id,
    params.projectId,
    params.id,
    "prompt",
    "",
    "effective",
    "codex --yolo {prompt}",
    0,
    0,
    0,
    "{}",
    "execution",
    params.parentTaskId ?? null,
    params.status ?? "queued",
    "/tmp/workspace",
    "base-sha",
    params.userId,
    now,
    now
  );
}

function seedWorkflow(db: Database.Database): { stageRunId: string; runId: string } {
  createWorkflowDefinition(db, {
    id: "wf-def",
    projectId: "project-1",
    name: "wf",
    version: 1,
    definitionYaml: "version: 1\nstages: []",
    createdByUserId: "user-1"
  });
  createWorkflowRun(db, {
    id: "wf-run",
    workflowDefinitionId: "wf-def",
    projectId: "project-1",
    taskId: null
  });
  createWorkflowStageRun(db, {
    id: "wf-stage",
    workflowRunId: "wf-run",
    stageKey: "verify",
    ordinal: 1,
    status: "running"
  });
  return { stageRunId: "wf-stage", runId: "wf-run" };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow deterministic checks", () => {
  test("persists pass/fail check results per stage run deterministically", () => {
    const db = createTestDb();
    const workspace = makeWorkspace("wf-checks");
    const { stageRunId } = seedWorkflow(db);

    const createdPath = path.join(workspace, "created.txt");
    fs.writeFileSync(createdPath, "created\n", "utf8");

    const existsPath = path.join(workspace, "exists.txt");
    fs.writeFileSync(existsPath, "line-a\nline-b\n", "utf8");

    const jsonPath = path.join(workspace, "config.json");
    fs.writeFileSync(jsonPath, JSON.stringify({ workflow: { retries: 2, labels: ["a", "b"] } }), "utf8");

    const now = nowIso();
    const checks: DeterministicWorkflowCheck[] = [
      { type: "file_created", name: "created-file", relativePath: "created.txt", baselineExists: false, since: "1970-01-01T00:00:00.000Z" },
      { type: "file_exists", name: "exists-file", relativePath: "exists.txt" },
      { type: "file_modified_within", name: "recent-mod", relativePath: "exists.txt", withinSeconds: 60, now },
      { type: "line_present_in_file", name: "line-match", relativePath: "exists.txt", line: "line-b" },
      { type: "json_path_equals", name: "json-path", relativePath: "config.json", jsonPath: "workflow.retries", expected: 2 },
      { type: "command_exit_code", name: "cmd-exit", command: ["node", "-e", "process.exit(0)"], expectedExitCode: 0 },
      { type: "stage_complete", name: "stage-not-done", stageRunId, expectedStatus: "succeeded" }
    ];

    const result = runDeterministicChecksForStageRun({
      db,
      workflowStageRunId: stageRunId,
      workspacePath: workspace,
      checks
    });

    assert.equal(result.checkResults.length, checks.length);
    assert.equal(result.allPassed, false);
    assert.equal(result.checkResults.filter((row) => row.status === "pass").length, checks.length - 1);
    assert.equal(result.checkResults.filter((row) => row.status === "fail").length, 1);

    const persisted = listWorkflowCheckResultsByStageRun(db, stageRunId);
    assert.equal(persisted.length, checks.length);
    assert.deepEqual(
      persisted.map((row) => row.check_name),
      checks.map((check) => check.name)
    );

    db.close();
  });

  test("evaluates stage_complete, node_merged, child_nodes_created_count and can fail stage", () => {
    const db = createTestDb();
    const workspace = makeWorkspace("wf-checks-stage");
    const { stageRunId } = seedWorkflow(db);

    insertTaskRow(db, { id: "parent-plan", projectId: "project-1", userId: "user-1", status: "awaiting_children" });
    insertTaskRow(db, { id: "child-a", projectId: "project-1", userId: "user-1", parentTaskId: "parent-plan", status: "queued" });
    insertTaskRow(db, { id: "child-b", projectId: "project-1", userId: "user-1", parentTaskId: "parent-plan", status: "queued" });
    insertTaskRow(db, { id: "merged-node", projectId: "project-1", userId: "user-1", status: "merged" });

    const secondaryStage = createWorkflowStageRun(db, {
      id: "wf-stage-2",
      workflowRunId: "wf-run",
      stageKey: "build",
      ordinal: 2,
      status: "running"
    });
    transitionWorkflowStageRunStatus(db, { stageRunId: secondaryStage.id, toStatus: "succeeded", reason: "done" });

    const checks: DeterministicWorkflowCheck[] = [
      { type: "stage_complete", name: "stage-complete", stageRunId: secondaryStage.id },
      { type: "node_merged", name: "node-merged", nodeId: "merged-node" },
      { type: "child_nodes_created_count", name: "child-count", parentNodeId: "parent-plan", expectedCount: 2, comparator: "eq" },
      { type: "child_nodes_created_count", name: "child-count-fail", parentNodeId: "parent-plan", expectedCount: 3, comparator: "gte" }
    ];

    const run = runDeterministicChecksForStageRun({
      db,
      workflowStageRunId: stageRunId,
      workspacePath: workspace,
      checks,
      failStageOnAnyFailure: true
    });

    assert.equal(run.allPassed, false);
    assert.equal(run.checkResults.some((row) => row.check_name === "stage-complete" && row.status === "pass"), true);
    assert.equal(run.checkResults.some((row) => row.check_name === "node-merged" && row.status === "pass"), true);
    assert.equal(run.checkResults.some((row) => row.check_name === "child-count-fail" && row.status === "fail"), true);
    assert.equal(run.stageRun.status, "failed");

    db.close();
  });
});
