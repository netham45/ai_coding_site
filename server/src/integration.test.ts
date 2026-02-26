import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, test } from "node:test";
import type Database from "better-sqlite3";
import { createApp } from "./app.js";
import { db as appDb } from "./db/index.js";
import {
  ProjectDbError,
  closeAllProjectDbs,
  detectProjectDbMetadata,
  ensureLocalUser,
  ensureProjectDb,
  getProjectConfig,
  getProjectDb,
  resolveProjectDatabase
} from "./db/index.js";
import { runProjectDataMigrationBackfill } from "./db/projectDataMigration.js";
import { resetProjectDbDiagnosticsForTests } from "./db/projectDbDiagnostics.js";
import { projectBaselineMigration } from "./db/migrations.js";
import { resetSplitPersistenceCachesForTests } from "./db/splitPersistence.js";
import { nowIso } from "./utils/time.js";

type ApiResponse = {
  status: number;
  json: any;
  text: string;
};

let server: http.Server;
let apiBaseUrl = "";
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const acsBinPath = path.join(serverRoot, "bin", "acs.js");

function randomPath(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ai-coding-site-${prefix}-`));
}

function tableExists(database: Database.Database, table: string): boolean {
  const row = database
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function resetAppDatabaseState(): void {
  closeAllProjectDbs();
  resetProjectDbDiagnosticsForTests();
  resetSplitPersistenceCachesForTests();

  const tables = appDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC"
    )
    .all() as Array<{ name: string }>;

  appDb.pragma("foreign_keys = OFF");
  for (const table of tables) {
    appDb.prepare(`DELETE FROM ${table.name}`).run();
  }
  appDb.pragma("foreign_keys = ON");
}

type CliRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  json: any;
};

function runCli(args: string[]): CliRunResult {
  return runCliFromCwd(args, serverRoot);
}

function runCliFromCwd(args: string[], cwd: string): CliRunResult {
  const result = spawnSync("npm", ["run", "-s", "cli", "--", ...args], {
    cwd,
    env: process.env,
    encoding: "utf8"
  });

  const stdout = result.stdout ?? "";
  let json: any = null;
  try {
    json = stdout.trim().length ? JSON.parse(stdout) : null;
  } catch {
    json = null;
  }

  return {
    code: result.status,
    stdout,
    stderr: result.stderr ?? "",
    json
  };
}

function runAcsFromCwd(args: string[], cwd: string): CliRunResult {
  const env = { ...process.env };
  if (env.AI_CODING_DATA_ROOT && !path.isAbsolute(env.AI_CODING_DATA_ROOT)) {
    env.AI_CODING_DATA_ROOT = path.resolve(serverRoot, env.AI_CODING_DATA_ROOT);
  }
  if (env.AI_CODING_REPOS_ROOT && !path.isAbsolute(env.AI_CODING_REPOS_ROOT)) {
    env.AI_CODING_REPOS_ROOT = path.resolve(serverRoot, env.AI_CODING_REPOS_ROOT);
  }

  const result = spawnSync("node", [acsBinPath, ...args], {
    cwd,
    env,
    encoding: "utf8"
  });

  const stdout = result.stdout ?? "";
  let json: any = null;
  try {
    json = stdout.trim().length ? JSON.parse(stdout) : null;
  } catch {
    json = null;
  }

  return {
    code: result.status,
    stdout,
    stderr: result.stderr ?? "",
    json
  };
}

function createUser(userId = randomUUID()): string {
  const now = nowIso();
  appDb
    .prepare("INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(userId, `${userId}@example.com`, `user-${userId.slice(0, 8)}`, now, now);
  appDb
    .prepare(
      `INSERT INTO user_settings (user_id, default_ai_command, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(userId, "codex --yolo {prompt}", now, now);
  return userId;
}

function createProject(params: {
  projectId?: string;
  userId: string;
  basePath: string;
  cloneStatus?: "pending" | "cloning" | "ready" | "failed";
}): string {
  const now = nowIso();
  const projectId = params.projectId ?? randomUUID();
  appDb
    .prepare(
      `INSERT INTO projects (
         id, name, slug, repo_url, default_branch, base_path,
         clone_status, clone_error, created_by_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
    )
    .run(
      projectId,
      `project-${projectId.slice(0, 8)}`,
      `project-${projectId.slice(0, 8)}`,
      "https://example.com/acme/repo.git",
      "main",
      params.basePath,
      params.cloneStatus ?? "ready",
      params.userId,
      now,
      now
    );
  appDb
    .prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
    .run(projectId, params.userId, now);
  return projectId;
}

function insertTask(params: {
  projectDb: Database.Database;
  projectId: string;
  userId: string;
  taskId?: string;
  title: string;
  mode?: "execution" | "plan";
  status: string;
  parentPlanTaskId?: string | null;
}): string {
  const taskId = params.taskId ?? randomUUID();
  const now = nowIso();
  const workspacePath = randomPath("cli-workspace");
  params.projectDb
    .prepare(
      `INSERT INTO tasks (
         id, project_id, title, task_prompt, result, effective_prompt, ai_command,
         auto_merge, mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
         status, workspace_path, base_commit_sha_at_create, head_commit_sha, cancel_reason,
         merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
    )
    .run(
      taskId,
      params.projectId,
      params.title,
      "test prompt",
      "",
      "effective prompt",
      "codex --yolo {prompt}",
      0,
      params.mode ?? "execution",
      params.parentPlanTaskId ?? null,
      params.status,
      workspacePath,
      "abc123",
      params.userId,
      now,
      now
    );
  return taskId;
}

async function callApi(pathname: string, options?: { method?: string; body?: unknown; userId?: string }): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options?.userId) {
    headers["x-user-id"] = options.userId;
  }
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: options?.method ?? "GET",
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

describe("integration: ownership, auth, migration, portability, diagnostics", () => {
  before(() => {
    ensureLocalUser();
    const app = createApp();
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to start test server");
    }
    apiBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    closeAllProjectDbs();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    resetAppDatabaseState();
  });

  test("reads/writes project config from project DB while project metadata stays in app DB", async () => {
    const userId = createUser();
    const basePath = randomPath("ownership");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });

    ensureProjectDb({
      projectId,
      basePath,
      initializeIfMissing: true,
      configDefaults: {
        project_prompt: "from-project-db",
        project_rules: "rules-v1",
        coding_standard: "",
        coding_standard_other: "",
        project_other: ""
      }
    });

    const read = await callApi(`/api/projects/${projectId}`, { userId });
    assert.equal(read.status, 200);
    assert.equal(read.json?.project?.projectPrompt, "from-project-db");
    assert.equal(read.json?.project?.projectRules, "rules-v1");

    // project.updated event currently writes to app DB events table.
    appDb.exec(projectBaselineMigration);

    const updated = await callApi(`/api/projects/${projectId}`, {
      method: "PATCH",
      userId,
      body: {
        name: "renamed-project",
        projectPrompt: "prompt-v2"
      }
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json?.project?.name, "renamed-project");
    assert.equal(updated.json?.project?.projectPrompt, "prompt-v2");

    const config = getProjectConfig({ projectId, basePath });
    assert.equal(config.project_prompt, "prompt-v2");

    const appProject = appDb.prepare("SELECT name, base_path FROM projects WHERE id = ?").get(projectId) as {
      name: string;
      base_path: string;
    };
    assert.equal(appProject.name, "renamed-project");
    assert.equal(appProject.base_path, basePath);
  });

  test("authorization gate is checked before project DB access", async () => {
    const ownerUserId = createUser();
    const intruderUserId = createUser();
    const basePath = randomPath("auth");
    const projectId = createProject({ userId: ownerUserId, basePath, cloneStatus: "ready" });
    fs.mkdirSync(path.join(basePath, ".ai-coding"), { recursive: true });
    fs.writeFileSync(path.join(basePath, ".ai-coding", "project.sqlite"), "not-a-sqlite-db");

    const denied = await callApi(`/api/projects/${projectId}`, { userId: intruderUserId });
    assert.equal(denied.status, 404);
    assert.equal(denied.json?.error, "Project not found");

    const ownerRead = await callApi(`/api/projects/${projectId}`, { userId: ownerUserId });
    assert.equal(ownerRead.status, 409);
    assert.equal(ownerRead.json?.code, "PROJECT_DB_CORRUPT");
  });

  test("project data migration copies legacy rows and marks project verified", () => {
    const userId = createUser();
    const basePath = randomPath("migration");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    appDb.exec(projectBaselineMigration);

    const taskId = randomUUID();
    const now = nowIso();
    appDb
      .prepare(
        `INSERT INTO tasks (
           id, project_id, title, task_prompt, result, effective_prompt, ai_command,
           auto_merge, mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
           status, workspace_path, base_commit_sha_at_create, head_commit_sha, cancel_reason,
           merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
      )
      .run(
        taskId,
        projectId,
        "Legacy Task",
        "legacy prompt",
        "",
        "legacy effective",
        "codex --yolo {prompt}",
        0,
        "execution",
        "queued",
        path.join(basePath, "tasks", taskId),
        "abc123",
        userId,
        now,
        now
      );

    runProjectDataMigrationBackfill(appDb);

    const projectTask = getProjectDb({ projectId, basePath })
      .prepare("SELECT id, title FROM tasks WHERE id = ?")
      .get(taskId) as { id: string; title: string } | undefined;
    assert.ok(projectTask);
    assert.equal(projectTask.title, "Legacy Task");

    const migrationStatus = appDb
      .prepare("SELECT status FROM project_data_migrations WHERE project_id = ?")
      .get(projectId) as { status: string } | undefined;
    assert.equal(migrationStatus?.status, "verified");

    const previousPhase = process.env.SPLIT_PERSISTENCE_PHASE;
    process.env.SPLIT_PERSISTENCE_PHASE = "write_cutover";
    resetSplitPersistenceCachesForTests();
    const resolved = resolveProjectDatabase({
      appDb,
      projectId,
      basePath,
      intent: "read"
    });
    assert.equal(resolved.backend, "project");
    process.env.SPLIT_PERSISTENCE_PHASE = previousPhase;
  });

  test("missing/corrupt project DB responses are surfaced and reflected in health diagnostics", async () => {
    const userId = createUser();

    const missingBasePath = randomPath("missing");
    const missingProjectId = createProject({ userId, basePath: missingBasePath, cloneStatus: "ready" });

    const corruptBasePath = randomPath("corrupt");
    const corruptProjectId = createProject({ userId, basePath: corruptBasePath, cloneStatus: "ready" });
    fs.mkdirSync(path.join(corruptBasePath, ".ai-coding"), { recursive: true });
    fs.writeFileSync(path.join(corruptBasePath, ".ai-coding", "project.sqlite"), "corrupt");

    const missing = await callApi(`/api/projects/${missingProjectId}`, { userId });
    assert.equal(missing.status, 503);
    assert.equal(missing.json?.code, "PROJECT_DB_UNAVAILABLE");

    const corrupt = await callApi(`/api/projects/${corruptProjectId}`, { userId });
    assert.equal(corrupt.status, 409);
    assert.equal(corrupt.json?.code, "PROJECT_DB_CORRUPT");

    const health = await callApi("/api/health", { userId });
    assert.equal(health.status, 200);
    assert.ok(health.json?.diagnostics?.projectDb?.failureCounts?.["open:PROJECT_DB_UNAVAILABLE"] >= 1);
    assert.ok(health.json?.diagnostics?.projectDb?.failureCounts?.["open:PROJECT_DB_CORRUPT"] >= 1);
  });

  test("write_cutover falls back to monolith without open failures when project DB file is absent", async () => {
    const userId = createUser();
    const missingBasePath = randomPath("missing-fallback");
    const projectId = createProject({ userId, basePath: missingBasePath, cloneStatus: "ready" });
    const previousPhase = process.env.SPLIT_PERSISTENCE_PHASE;
    process.env.SPLIT_PERSISTENCE_PHASE = "write_cutover";
    resetSplitPersistenceCachesForTests();

    try {
      const response = await callApi(`/api/projects/${projectId}/tasks`, { userId });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json?.tasks, []);

      const health = await callApi("/api/health", { userId });
      assert.equal(health.status, 200);
      assert.equal(health.json?.diagnostics?.projectDb?.failureCounts?.["open:PROJECT_DB_UNAVAILABLE"] ?? 0, 0);
    } finally {
      process.env.SPLIT_PERSISTENCE_PHASE = previousPhase;
      resetSplitPersistenceCachesForTests();
    }
  });

  test("portability metadata detection reads cloned project DB metadata and catches project-id mismatch", () => {
    const sourceProjectId = randomUUID();
    const sourceBasePath = randomPath("portable-source");
    ensureProjectDb({
      projectId: sourceProjectId,
      basePath: sourceBasePath,
      initializeIfMissing: true
    });

    const sourceMetadata = detectProjectDbMetadata({ basePath: sourceBasePath });
    assert.equal(sourceMetadata?.project_id, sourceProjectId);

    closeAllProjectDbs();

    const importedBasePath = randomPath("portable-import");
    fs.mkdirSync(path.join(importedBasePath, ".ai-coding"), { recursive: true });
    fs.copyFileSync(
      path.join(sourceBasePath, ".ai-coding", "project.sqlite"),
      path.join(importedBasePath, ".ai-coding", "project.sqlite")
    );

    const importedMetadata = detectProjectDbMetadata({ basePath: importedBasePath });
    assert.equal(importedMetadata?.project_id, sourceProjectId);

    assert.throws(
      () =>
        ensureProjectDb({
          projectId: randomUUID(),
          basePath: importedBasePath,
          initializeIfMissing: false
        }),
      (error: unknown) => error instanceof ProjectDbError && error.code === "PROJECT_DB_CORRUPT"
    );
  });

  test("health diagnostics include migration failure details", () => {
    const userId = createUser();
    const basePath = randomPath("migration-fail");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    appDb.exec(projectBaselineMigration);

    fs.mkdirSync(path.join(basePath, ".ai-coding"), { recursive: true });
    fs.writeFileSync(path.join(basePath, ".ai-coding", "project.sqlite"), "corrupt");

    runProjectDataMigrationBackfill(appDb);

    const migration = appDb
      .prepare("SELECT status, last_error FROM project_data_migrations WHERE project_id = ?")
      .get(projectId) as { status: string; last_error: string | null } | undefined;
    assert.equal(migration?.status, "failed");
    assert.ok((migration?.last_error ?? "").length > 0);

    assert.ok(tableExists(appDb, "project_data_migrations"));
  });

  test("cached project DB handle reuse does not rerun baseline migrations", () => {
    const projectId = randomUUID();
    const basePath = randomPath("cached-no-migrate");
    const handle = ensureProjectDb({
      projectId,
      basePath,
      initializeIfMissing: true
    });

    assert.equal(tableExists(handle.db, "tasks"), true);
    handle.db.exec("DROP TABLE tasks");
    assert.equal(tableExists(handle.db, "tasks"), false);

    const cached = ensureProjectDb({
      projectId,
      basePath,
      initializeIfMissing: false
    });
    assert.equal(tableExists(cached.db, "tasks"), false);
  });

  test("cached project DB handle reuse does not rerun metadata table migration", () => {
    const projectId = randomUUID();
    const basePath = randomPath("cached-no-metadata-migrate");
    const handle = ensureProjectDb({
      projectId,
      basePath,
      initializeIfMissing: true
    });

    assert.equal(tableExists(handle.db, "project_metadata"), true);
    handle.db.exec("DROP TABLE project_metadata");
    assert.equal(tableExists(handle.db, "project_metadata"), false);
    closeAllProjectDbs();

    assert.throws(
      () =>
        ensureProjectDb({
          projectId,
          basePath,
          initializeIfMissing: false
        }),
      (error: unknown) => error instanceof ProjectDbError && error.code === "PROJECT_DB_CORRUPT"
    );
  });
});

describe("integration: CLI subcommands", () => {
  beforeEach(() => {
    resetAppDatabaseState();
  });

  test("list/info commands support project and plan filters", () => {
    const userId = ensureLocalUser();
    const projectABasePath = randomPath("cli-project-a");
    const projectBBasePath = randomPath("cli-project-b");
    const projectA = createProject({ userId, basePath: projectABasePath, cloneStatus: "ready" });
    const projectB = createProject({ userId, basePath: projectBBasePath, cloneStatus: "ready" });
    const projectADb = ensureProjectDb({ projectId: projectA, basePath: projectABasePath, initializeIfMissing: true }).db;
    const projectBDb = ensureProjectDb({ projectId: projectB, basePath: projectBBasePath, initializeIfMissing: true }).db;

    const planA = insertTask({
      projectDb: projectADb,
      projectId: projectA,
      userId,
      title: "Plan A",
      mode: "plan",
      status: "in_progress"
    });
    const taskAChildQueued = insertTask({
      projectDb: projectADb,
      projectId: projectA,
      userId,
      title: "Task A Child Queued",
      status: "queued",
      parentPlanTaskId: planA
    });
    insertTask({
      projectDb: projectADb,
      projectId: projectA,
      userId,
      title: "Task A Child Merged",
      status: "merged",
      parentPlanTaskId: planA
    });
    const taskAStandalone = insertTask({
      projectDb: projectADb,
      projectId: projectA,
      userId,
      title: "Task A Standalone",
      status: "waiting_input"
    });
    const taskB = insertTask({
      projectDb: projectBDb,
      projectId: projectB,
      userId,
      title: "Task B",
      status: "queued"
    });

    const allTasks = runCli(["tasks", "all", "--json"]);
    assert.equal(allTasks.code, 0);
    assert.equal(Array.isArray(allTasks.json?.tasks), true);
    assert.equal(allTasks.json.tasks.length, 4);

    const listed = runCli(["tasks", "list", "--project-id", projectA, "--json"]);
    assert.equal(listed.code, 0);
    assert.equal(listed.json.tasks.length, 3);
    assert.equal(listed.json.tasks.every((task: { projectId: string }) => task.projectId === projectA), true);

    const activeFiltered = runCli(["tasks", "active", "--project-id", projectA, "--plan-id", planA, "--json"]);
    assert.equal(activeFiltered.code, 0);
    assert.equal(activeFiltered.json.tasks.length, 1);
    assert.equal(activeFiltered.json.tasks[0].id, taskAChildQueued);

    const plansFiltered = runCli(["plans", "list", "--project-id", projectA, "--plan-id", planA, "--json"]);
    assert.equal(plansFiltered.code, 0);
    assert.equal(plansFiltered.json.plans.length, 1);
    assert.equal(plansFiltered.json.plans[0].id, planA);

    const summaryOk = runCli(["tasks", "summary", taskAStandalone, "--project-id", projectA, "--json"]);
    assert.equal(summaryOk.code, 0);
    assert.equal(summaryOk.json?.task?.id, taskAStandalone);

    const detailsWrongPlan = runCli(["tasks", "details", taskAStandalone, "--plan-id", planA, "--json"]);
    assert.equal(detailsWrongPlan.code, 3);
    assert.match(detailsWrongPlan.stderr, /Task not found/);

    const getWrongProject = runCli(["tasks", "get", taskAStandalone, "--project-id", projectB, "--json"]);
    assert.equal(getWrongProject.code, 3);
    assert.match(getWrongProject.stderr, /Task not found/);

    const infoWrongProject = runCli(["info", taskB, "--project-id", projectA, "--json"]);
    assert.equal(infoWrongProject.code, 3);
    assert.match(infoWrongProject.stderr, /Task not found/);

    const infoWithFilters = runCli(["info", taskAChildQueued, "--project-id", projectA, "--plan-id", planA, "--json"]);
    assert.equal(infoWithFilters.code, 0);
    assert.equal(infoWithFilters.json?.task?.id, taskAChildQueued);
  });

  test("review command variants return expected task and plan payloads", () => {
    const userId = ensureLocalUser();
    const basePath = randomPath("cli-review-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Plan Review",
      mode: "plan",
      status: "queued"
    });
    const taskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Task Review",
      status: "queued",
      parentPlanTaskId: planId
    });

    const plansReview = runCli(["plans", "review", planId, "--json"]);
    assert.equal(plansReview.code, 0);
    assert.equal(plansReview.json?.plan?.id, planId);

    const reviewPlan = runCli(["review", "plan", planId, "--json"]);
    assert.equal(reviewPlan.code, 0);
    assert.equal(reviewPlan.json?.plan?.id, planId);

    const reviewTask = runCli(["review", "task", taskId, "--json"]);
    assert.equal(reviewTask.code, 0);
    assert.equal(Array.isArray(reviewTask.json?.mergeRecords), true);

    const reviewLegacy = runCli(["review", taskId, "--json"]);
    assert.equal(reviewLegacy.code, 0);
    assert.equal(Array.isArray(reviewLegacy.json?.mergeRecords), true);
  });

  test("ready_merge and merge commands enforce precondition edge cases for tasks and plans", () => {
    const userId = ensureLocalUser();
    const basePath = randomPath("cli-merge-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const taskQueued = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Task Queued",
      status: "queued"
    });
    const planInProgressBlocked = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Plan Blocked",
      mode: "plan",
      status: "in_progress"
    });
    insertTask({
      projectDb,
      projectId,
      userId,
      title: "Plan Blocked Child",
      status: "queued",
      parentPlanTaskId: planInProgressBlocked
    });

    const planMergeReadyBlocked = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Plan Merge Ready With Unmerged Child",
      mode: "plan",
      status: "merge_ready"
    });
    insertTask({
      projectDb,
      projectId,
      userId,
      title: "Plan Merge Ready Child",
      status: "waiting_input",
      parentPlanTaskId: planMergeReadyBlocked
    });

    const readyTaskAlias = runCli(["ready_merge", taskQueued, "--json"]);
    assert.equal(readyTaskAlias.code, 4);
    assert.match(readyTaskAlias.stderr, /Task cannot be marked merge-ready from status queued/);

    const mergeTaskEntity = runCli(["merge", "task", taskQueued, "--json"]);
    assert.equal(mergeTaskEntity.code, 4);
    assert.match(mergeTaskEntity.stderr, /Task must be merge_ready before merge/);

    const readyPlan = runCli(["ready_merge", "plan", planInProgressBlocked, "--json"]);
    assert.equal(readyPlan.code, 4);
    assert.match(readyPlan.stderr, /Plan has child tasks that are not merged/);

    const mergePlan = runCli(["merge", "plan", planMergeReadyBlocked, "--json"]);
    assert.equal(mergePlan.code, 4);
    assert.match(mergePlan.stderr, /Plan has child tasks that are not merged/);
  });

  test("help output includes command examples for new subcommands", () => {
    const help = runCli(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /tasks all \[--project-id <projectId>] \[--plan-id <planId>]/);
    assert.match(help.stdout, /tasks summary <taskId> \[--project-id <projectId>] \[--plan-id <planId>]/);
    assert.match(help.stdout, /plans review <planId>/);
    assert.match(help.stdout, /ready_merge plan <planId>/);
    assert.match(help.stdout, /merge plan <planId>/);
    assert.match(help.stdout, /Examples:/);
    assert.match(help.stdout, /acs tasks active --project-id <projectId> --json/);
  });

  test("cli commands work from nested server directories", () => {
    const userId = ensureLocalUser();
    const basePath = randomPath("cli-nested-cwd-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    insertTask({
      projectDb,
      projectId,
      userId,
      title: "Nested cwd task",
      status: "queued"
    });

    const nestedServerDir = path.join(serverRoot, "src", "cli");
    const allTasks = runCliFromCwd(["tasks", "all", "--json"], nestedServerDir);
    assert.equal(allTasks.code, 0);
    assert.equal(Array.isArray(allTasks.json?.tasks), true);
    assert.equal(allTasks.json.tasks.length, 1);
  });

  test("acs wrapper works from nested server directories", () => {
    const userId = ensureLocalUser();
    const basePath = randomPath("acs-nested-cwd-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    insertTask({
      projectDb,
      projectId,
      userId,
      title: "acs nested cwd task",
      status: "queued"
    });

    const nestedServerDir = path.join(serverRoot, "src", "cli");
    const allTasks = runAcsFromCwd(["tasks", "all", "--json"], nestedServerDir);
    assert.equal(allTasks.code, 0);
    assert.equal(Array.isArray(allTasks.json?.tasks), true);
    assert.equal(allTasks.json.tasks.length, 1);
  });

  test("acs wrapper fails clearly outside the workspace", () => {
    const outsideDir = randomPath("acs-outside-workspace");
    const result = runAcsFromCwd(["--help"], outsideDir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Could not locate the ai-coding-site workspace root/);
  });
});
