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
import { projectBaselineMigration, projectTaskMetadataMigration } from "./db/migrations.js";
import { CliServiceError, approvePlan } from "./application/cliServices.js";
import { buildDependencyDiagnostics } from "./services/orchestration/dependencyGraph.js";
import { assertTaskStatusTransition, canTransitionLifecycle, evaluateParentCompletionGuards } from "./services/orchestration/stateMachine.js";
import {
  enqueueOrchestrationJob,
  registerOrchestrationJobHandler,
  resetOrchestrationJobQueueForTests,
  runOrchestrationJobQueuePassForTests
} from "./services/orchestration/jobQueue.js";
import { startHierarchicalOrchestrationJobs } from "./services/orchestration/jobs/index.js";
import { runDecomposeForTask } from "./services/orchestration/jobs/decompose.js";
import { runEvaluateReadinessForTask } from "./services/orchestration/jobs/evaluateReadiness.js";
import { observeNodeOutputMaterialChange } from "./services/orchestration/outputMonitor.js";
import { runOrchestrationWatchdog } from "./services/orchestration/watchdog.js";
import { parsePlanOutput } from "./services/planParser.js";
import { runPlanOrchestrationPassForTests } from "./services/planOrchestrator.js";
import { recordEvent } from "./services/events.js";
import { resetSplitPersistenceCachesForTests } from "./db/splitPersistence.js";
import type { TaskRow, TaskStatus } from "./types.js";
import { nowIso } from "./utils/time.js";

type ApiResponse = {
  status: number;
  json: any;
  text: string;
};

let server: http.Server;
let apiBaseUrl = "";
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function randomPath(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ai-coding-site-${prefix}-`));
}

function tableExists(database: Database.Database, table: string): boolean {
  const row = database
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function tableHasColumn(database: Database.Database, table: string, column: string): boolean {
  if (!tableExists(database, table)) return false;
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function resetAppDatabaseState(): void {
  closeAllProjectDbs();
  resetProjectDbDiagnosticsForTests();
  resetSplitPersistenceCachesForTests();
  resetOrchestrationJobQueueForTests();

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
  const result = spawnSync("npm", ["run", "-s", "cli", "--", ...args], {
    cwd: serverRoot,
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

function runGit(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
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

  test("project DB schema upgrade adds tasks.metadata_json and bumps metadata version", () => {
    const userId = createUser();
    const basePath = randomPath("schema-upgrade");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const dbDir = path.join(basePath, ".ai-coding");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "project.sqlite");

    const legacyDb = resolveProjectDatabase({
      appDb,
      projectId,
      basePath,
      intent: "write"
    }).database;
    legacyDb.exec(projectBaselineMigration);
    legacyDb.exec("ALTER TABLE tasks RENAME TO tasks_with_metadata");
    legacyDb.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        task_prompt TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT '',
        effective_prompt TEXT NOT NULL,
        ai_command TEXT NOT NULL DEFAULT 'codex --yolo {prompt}',
        auto_merge INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge IN (0,1)),
        auto_start INTEGER NOT NULL DEFAULT 0 CHECK (auto_start IN (0,1)),
        auto_merge_on_complete INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge_on_complete IN (0,1)),
        mode TEXT NOT NULL DEFAULT 'execution' CHECK (mode IN ('execution','plan')),
        parent_plan_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        source_plan_revision_id TEXT REFERENCES plan_revisions(id) ON DELETE SET NULL,
        source_plan_item_key TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued','in_progress','waiting_input','awaiting_children','merge_ready','merged','cancelled','failed','merge_conflict')),
        workspace_path TEXT NOT NULL,
        base_commit_sha_at_create TEXT NOT NULL,
        head_commit_sha TEXT,
        cancel_reason TEXT,
        merged_at TEXT,
        merged_by_user_id TEXT,
        created_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDb.exec("DROP TABLE tasks_with_metadata");
    legacyDb.pragma("user_version = 1");
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS project_metadata (
        project_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const now = nowIso();
    legacyDb
      .prepare(
        `INSERT OR REPLACE INTO project_metadata (project_id, schema_version, created_at, updated_at)
         VALUES (?, 1, ?, ?)`
      )
      .run(projectId, now, now);
    closeAllProjectDbs();

    const upgraded = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    assert.equal(tableHasColumn(upgraded, "tasks", "metadata_json"), true);
    assert.equal(Number(upgraded.pragma("user_version", { simple: true })), 2);
    const projectMetadata = upgraded
      .prepare("SELECT schema_version FROM project_metadata WHERE project_id = ?")
      .get(projectId) as { schema_version: number };
    assert.equal(projectMetadata.schema_version, 2);
  });

  test("tasks metadata migration rolls back cleanly on transaction failure", () => {
    const userId = createUser();
    const basePath = randomPath("schema-rollback");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const dbDir = path.join(basePath, ".ai-coding");
    fs.mkdirSync(dbDir, { recursive: true });
    const db = resolveProjectDatabase({
      appDb,
      projectId,
      basePath,
      intent: "write"
    }).database;
    db.exec(projectBaselineMigration);
    db.exec("ALTER TABLE tasks RENAME TO tasks_with_metadata");
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        task_prompt TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT '',
        effective_prompt TEXT NOT NULL,
        ai_command TEXT NOT NULL DEFAULT 'codex --yolo {prompt}',
        auto_merge INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge IN (0,1)),
        auto_start INTEGER NOT NULL DEFAULT 0 CHECK (auto_start IN (0,1)),
        auto_merge_on_complete INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge_on_complete IN (0,1)),
        mode TEXT NOT NULL DEFAULT 'execution' CHECK (mode IN ('execution','plan')),
        parent_plan_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        source_plan_revision_id TEXT REFERENCES plan_revisions(id) ON DELETE SET NULL,
        source_plan_item_key TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued','in_progress','waiting_input','awaiting_children','merge_ready','merged','cancelled','failed','merge_conflict')),
        workspace_path TEXT NOT NULL,
        base_commit_sha_at_create TEXT NOT NULL,
        head_commit_sha TEXT,
        cancel_reason TEXT,
        merged_at TEXT,
        merged_by_user_id TEXT,
        created_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec("DROP TABLE tasks_with_metadata");
    assert.equal(tableHasColumn(db, "tasks", "metadata_json"), false);

    assert.throws(() => {
      db.transaction(() => {
        db.exec(projectTaskMetadataMigration);
        throw new Error("force rollback");
      })();
    }, /force rollback/);
    assert.equal(tableHasColumn(db, "tasks", "metadata_json"), false);
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
    assert.equal(plansFiltered.json.plans[0].autoStart, false);
    assert.equal(plansFiltered.json.plans[0].autoMergeOnComplete, false);

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
    const blockerId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Plan Blocker",
      status: "in_progress"
    });
    const eventAt = nowIso();
    const laterAt = new Date(Date.parse(eventAt) + 1000).toISOString();
    projectDb.prepare("INSERT INTO task_dependencies (task_id, dependency_task_id, created_at) VALUES (?, ?, ?)").run(planId, blockerId, eventAt);
    projectDb
      .prepare("INSERT INTO events (id, project_id, task_id, session_id, event_type, payload, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)")
      .run(randomUUID(), projectId, planId, "plan.orchestration.auto_extract.succeeded", JSON.stringify({}), eventAt);
    projectDb
      .prepare("INSERT INTO events (id, project_id, task_id, session_id, event_type, payload, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)")
      .run(randomUUID(), projectId, planId, "plan.orchestration.auto_approve.succeeded", JSON.stringify({}), laterAt);

    const plansReview = runCli(["plans", "review", planId, "--json"]);
    assert.equal(plansReview.code, 0);
    assert.equal(plansReview.json?.plan?.id, planId);
    assert.equal(plansReview.json?.waiting?.reasonCode, "blocked_dependencies");
    assert.equal(plansReview.json?.waiting?.dependencyBlockerTaskId, blockerId);
    assert.equal(plansReview.json?.automation?.lastAction?.eventType, "plan.orchestration.auto_approve.succeeded");

    const reviewPlan = runCli(["review", "plan", planId, "--json"]);
    assert.equal(reviewPlan.code, 0);
    assert.equal(reviewPlan.json?.plan?.id, planId);
    assert.equal(Array.isArray(reviewPlan.json?.automation?.recentActions), true);
    assert.equal(reviewPlan.json?.waiting?.blockingDependencies?.[0]?.id, blockerId);

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
    assert.match(readyTaskAlias.stderr, /invalid_transition|Illegal transition|merge-ready/);

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

  test("state machine transition matrix enforces legal lifecycle edges", () => {
    const lifecycleStates = ["draft", "ready", "blocked", "running", "complete", "failed", "canceled"] as const;
    for (const from of lifecycleStates) {
      for (const to of lifecycleStates) {
        const allowed = canTransitionLifecycle(from, to);
        if (from === "complete" && to === "running") {
          assert.equal(allowed, false);
        }
      }
    }

    const allowedTransition = () =>
      assertTaskStatusTransition({
        mode: "execution",
        fromStatus: "in_progress",
        toStatus: "merge_ready",
        hasBlockingDependencies: false,
        hasPendingChildren: false,
        parentGuards: { synthesisPassed: true, verificationPassed: true }
      });
    assert.doesNotThrow(allowedTransition);

    const illegalTransition = () =>
      assertTaskStatusTransition({
        mode: "execution",
        fromStatus: "queued",
        toStatus: "merge_ready",
        hasBlockingDependencies: false,
        hasPendingChildren: false,
        parentGuards: { synthesisPassed: true, verificationPassed: true }
      });
    assert.throws(illegalTransition, /invalid_transition|Illegal transition/);

    const blockedTransition = () =>
      assertTaskStatusTransition({
        mode: "execution",
        fromStatus: "queued",
        toStatus: "in_progress",
        hasBlockingDependencies: true,
        hasPendingChildren: false,
        parentGuards: { synthesisPassed: true, verificationPassed: true }
      });
    assert.throws(blockedTransition, /blocked_dependencies/);
  });

  test("plan completion requires synthesis and verification passes", () => {
    const userId = ensureLocalUser();
    const basePath = randomPath("cli-plan-completion-guards");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    runGit(["init", "-b", "main"], basePath);
    runGit(["config", "user.email", "tests@example.com"], basePath);
    runGit(["config", "user.name", "Tests"], basePath);
    fs.writeFileSync(path.join(basePath, "README.md"), "base\n", "utf8");
    runGit(["add", "."], basePath);
    runGit(["commit", "-m", "init"], basePath);

    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Guarded Plan",
      mode: "plan",
      status: "waiting_input"
    });
    const planWorkspace = (projectDb.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(planId) as { workspace_path: string }).workspace_path;
    runGit(["clone", "--branch", "main", basePath, planWorkspace], serverRoot);
    runGit(["config", "user.email", "tests@example.com"], planWorkspace);
    runGit(["config", "user.name", "Tests"], planWorkspace);
    runGit(["switch", "-c", `task/${planId}`], planWorkspace);

    const noPasses = runCli(["ready_merge", "plan", planId, "--json"]);
    assert.equal(noPasses.code, 4);
    assert.match(noPasses.stderr, /parent_synthesis_required/);

    projectDb.prepare("UPDATE tasks SET metadata_json = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "plan", lifecycle: { synthesis_passed: true, verification_passed: false } }),
      planId
    );
    const missingVerify = runCli(["ready_merge", "plan", planId, "--json"]);
    assert.equal(missingVerify.code, 4);
    assert.match(missingVerify.stderr, /parent_verification_required/);

    projectDb.prepare("UPDATE tasks SET metadata_json = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "plan", lifecycle: { synthesis_passed: true, verification_passed: true } }),
      planId
    );
    const ready = runCli(["ready_merge", "plan", planId, "--json"]);
    assert.equal(ready.code, 0);
    assert.equal(ready.json?.plan?.status, "merge_ready");

    const guardState = evaluateParentCompletionGuards(
      projectDb,
      projectDb.prepare("SELECT id, mode, metadata_json FROM tasks WHERE id = ?").get(planId) as {
        id: string;
        mode: "plan" | "execution";
        metadata_json: string | null;
      }
    );
    assert.equal(guardState.synthesisPassed, true);
    assert.equal(guardState.verificationPassed, true);
  });

  test("merging the last child auto-marks parent plan merge-ready and auto-merges when enabled", () => {
    const userId = ensureLocalUser();
    const basePath = randomPath("cli-plan-auto-merge-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    runGit(["init", "-b", "main"], basePath);
    runGit(["config", "user.email", "tests@example.com"], basePath);
    runGit(["config", "user.name", "Tests"], basePath);
    fs.writeFileSync(path.join(basePath, "README.md"), "base\n", "utf8");
    runGit(["add", "."], basePath);
    runGit(["commit", "-m", "init"], basePath);

    const grandPlanId = insertTask({
      projectDb,
      projectId,
      userId,
      taskId: randomUUID(),
      title: "Grand Plan",
      mode: "plan",
      status: "waiting_input"
    });
    const parentPlanId = insertTask({
      projectDb,
      projectId,
      userId,
      taskId: randomUUID(),
      title: "Parent Plan",
      mode: "plan",
      status: "awaiting_children",
      parentPlanTaskId: grandPlanId
    });
    const childAId = insertTask({
      projectDb,
      projectId,
      userId,
      taskId: randomUUID(),
      title: "Child A",
      status: "merge_ready",
      parentPlanTaskId: parentPlanId
    });
    const childBId = insertTask({
      projectDb,
      projectId,
      userId,
      taskId: randomUUID(),
      title: "Child B",
      status: "merge_ready",
      parentPlanTaskId: parentPlanId
    });
    projectDb.prepare("UPDATE tasks SET auto_merge_on_complete = 1, updated_at = ? WHERE id = ?").run(nowIso(), parentPlanId);
    projectDb.prepare("UPDATE tasks SET metadata_json = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "plan", lifecycle: { synthesis_passed: true, verification_passed: true } }),
      parentPlanId
    );
    projectDb.prepare("UPDATE tasks SET metadata_json = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "plan", lifecycle: { synthesis_passed: true, verification_passed: true } }),
      grandPlanId
    );

    const grandPlanPath = (projectDb.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(grandPlanId) as { workspace_path: string }).workspace_path;
    const parentPlanPath = (projectDb.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(parentPlanId) as { workspace_path: string }).workspace_path;
    const childAPath = (projectDb.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(childAId) as { workspace_path: string }).workspace_path;
    const childBPath = (projectDb.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(childBId) as { workspace_path: string }).workspace_path;

    runGit(["clone", "--branch", "main", basePath, grandPlanPath], serverRoot);
    runGit(["config", "user.email", "tests@example.com"], grandPlanPath);
    runGit(["config", "user.name", "Tests"], grandPlanPath);
    runGit(["switch", "-c", `task/${grandPlanId}`], grandPlanPath);

    runGit(["clone", "--branch", `task/${grandPlanId}`, grandPlanPath, parentPlanPath], serverRoot);
    runGit(["config", "user.email", "tests@example.com"], parentPlanPath);
    runGit(["config", "user.name", "Tests"], parentPlanPath);
    runGit(["switch", "-c", `task/${parentPlanId}`], parentPlanPath);

    runGit(["clone", "--branch", `task/${parentPlanId}`, parentPlanPath, childAPath], serverRoot);
    runGit(["config", "user.email", "tests@example.com"], childAPath);
    runGit(["config", "user.name", "Tests"], childAPath);
    runGit(["switch", "-c", `task/${childAId}`], childAPath);
    fs.writeFileSync(path.join(childAPath, "child-a.txt"), "child a\n", "utf8");
    runGit(["add", "."], childAPath);
    runGit(["commit", "-m", "child a"], childAPath);

    runGit(["clone", "--branch", `task/${parentPlanId}`, parentPlanPath, childBPath], serverRoot);
    runGit(["config", "user.email", "tests@example.com"], childBPath);
    runGit(["config", "user.name", "Tests"], childBPath);
    runGit(["switch", "-c", `task/${childBId}`], childBPath);
    fs.writeFileSync(path.join(childBPath, "child-b.txt"), "child b\n", "utf8");
    runGit(["add", "."], childBPath);
    runGit(["commit", "-m", "child b"], childBPath);

    const mergeChildA = runCli(["merge", "task", childAId, "--json"]);
    assert.equal(mergeChildA.code, 0);
    const parentAfterFirst = projectDb.prepare("SELECT status FROM tasks WHERE id = ?").get(parentPlanId) as { status: string };
    assert.equal(parentAfterFirst.status, "awaiting_children");

    const mergeChildB = runCli(["merge", "task", childBId, "--json"]);
    assert.equal(mergeChildB.code, 0);
    const parentAutoMergeFailure = projectDb
      .prepare("SELECT payload FROM events WHERE task_id = ? AND event_type = 'plan.auto_merge_on_complete.failed' ORDER BY created_at DESC LIMIT 1")
      .get(parentPlanId) as { payload: string } | undefined;
    assert.equal(parentAutoMergeFailure, undefined, parentAutoMergeFailure?.payload ?? "");

    const parentAfterSecond = projectDb.prepare("SELECT status FROM tasks WHERE id = ?").get(parentPlanId) as { status: string };
    assert.equal(parentAfterSecond.status, "merged");

    const parentMergeRecord = projectDb
      .prepare("SELECT status FROM merge_records WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(parentPlanId) as { status: string };
    assert.equal(parentMergeRecord.status, "merged");

    const grandAfterParentMerged = projectDb.prepare("SELECT status FROM tasks WHERE id = ?").get(grandPlanId) as { status: string };
    assert.equal(grandAfterParentMerged.status, "merge_ready");
  });

  test("plan auto-merge on completion records conflict and supports merge-ready recovery", () => {
    const userId = ensureLocalUser();
    const basePath = randomPath("cli-plan-auto-merge-conflict-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    runGit(["init", "-b", "main"], basePath);
    runGit(["config", "user.email", "tests@example.com"], basePath);
    runGit(["config", "user.name", "Tests"], basePath);
    fs.writeFileSync(path.join(basePath, "shared.txt"), "base\n", "utf8");
    runGit(["add", "."], basePath);
    runGit(["commit", "-m", "init"], basePath);

    const grandPlanId = insertTask({
      projectDb,
      projectId,
      userId,
      taskId: randomUUID(),
      title: "Grand Plan Conflict",
      mode: "plan",
      status: "waiting_input"
    });
    const parentPlanId = insertTask({
      projectDb,
      projectId,
      userId,
      taskId: randomUUID(),
      title: "Parent Plan Conflict",
      mode: "plan",
      status: "awaiting_children",
      parentPlanTaskId: grandPlanId
    });
    const childId = insertTask({
      projectDb,
      projectId,
      userId,
      taskId: randomUUID(),
      title: "Child Conflict",
      status: "merge_ready",
      parentPlanTaskId: parentPlanId
    });
    projectDb.prepare("UPDATE tasks SET auto_merge_on_complete = 1, updated_at = ? WHERE id = ?").run(nowIso(), parentPlanId);
    projectDb.prepare("UPDATE tasks SET metadata_json = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "plan", lifecycle: { synthesis_passed: true, verification_passed: true } }),
      parentPlanId
    );

    const grandPlanPath = (projectDb.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(grandPlanId) as { workspace_path: string }).workspace_path;
    const parentPlanPath = (projectDb.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(parentPlanId) as { workspace_path: string }).workspace_path;
    const childPath = (projectDb.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(childId) as { workspace_path: string }).workspace_path;

    runGit(["clone", "--branch", "main", basePath, grandPlanPath], serverRoot);
    runGit(["config", "user.email", "tests@example.com"], grandPlanPath);
    runGit(["config", "user.name", "Tests"], grandPlanPath);
    runGit(["switch", "-c", `task/${grandPlanId}`], grandPlanPath);

    runGit(["clone", "--branch", `task/${grandPlanId}`, grandPlanPath, parentPlanPath], serverRoot);
    runGit(["config", "user.email", "tests@example.com"], parentPlanPath);
    runGit(["config", "user.name", "Tests"], parentPlanPath);
    runGit(["switch", "-c", `task/${parentPlanId}`], parentPlanPath);

    fs.writeFileSync(path.join(grandPlanPath, "shared.txt"), "grand version\n", "utf8");
    runGit(["add", "shared.txt"], grandPlanPath);
    runGit(["commit", "-m", "grand conflict change"], grandPlanPath);

    runGit(["clone", "--branch", `task/${parentPlanId}`, parentPlanPath, childPath], serverRoot);
    runGit(["config", "user.email", "tests@example.com"], childPath);
    runGit(["config", "user.name", "Tests"], childPath);
    runGit(["switch", "-c", `task/${childId}`], childPath);
    fs.writeFileSync(path.join(childPath, "shared.txt"), "parent version\n", "utf8");
    runGit(["add", "shared.txt"], childPath);
    runGit(["commit", "-m", "child conflict change"], childPath);

    const mergeChild = runCli(["merge", "task", childId, "--json"]);
    assert.equal(mergeChild.code, 0);
    const parentAutoMergeFailure = projectDb
      .prepare("SELECT payload FROM events WHERE task_id = ? AND event_type = 'plan.auto_merge_on_complete.failed' ORDER BY created_at DESC LIMIT 1")
      .get(parentPlanId) as { payload: string } | undefined;
    assert.equal(parentAutoMergeFailure, undefined, parentAutoMergeFailure?.payload ?? "");

    const parentAfterAutoMerge = projectDb.prepare("SELECT status FROM tasks WHERE id = ?").get(parentPlanId) as { status: string };
    assert.equal(parentAfterAutoMerge.status, "merge_conflict");

    const parentMergeRecord = projectDb
      .prepare("SELECT status FROM merge_records WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(parentPlanId) as { status: string };
    assert.equal(parentMergeRecord.status, "conflict");

    const recoverReady = runCli(["ready_merge", "plan", parentPlanId, "--json"]);
    assert.equal(recoverReady.code, 0);
    assert.equal(recoverReady.json?.plan?.status, "merge_ready");
  });

  test("help output includes command examples for new subcommands", () => {
    const help = runCli(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /tasks all \[--project-id <projectId>] \[--plan-id <planId>]/);
    assert.match(help.stdout, /tasks summary <taskId> \[--project-id <projectId>] \[--plan-id <planId>]/);
    assert.match(help.stdout, /plans create --project <projectId> --title <title> --prompt <prompt> \[--ai-command <cmd>] \[--auto-start] \[--auto-merge-on-complete] \[--parent-plan-id <planId>]/);
    assert.match(help.stdout, /plans approve <planId> \[--auto-merge-item-keys a,b] \[--auto-start] \[--auto-merge-on-complete] \[--parent-plan-id <planId>] \[--task-edits-file path.json]/);
    assert.match(help.stdout, /plans review <planId>/);
    assert.match(help.stdout, /ready_merge plan <planId>/);
    assert.match(help.stdout, /merge plan <planId>/);
    assert.match(help.stdout, /Examples:/);
    assert.match(help.stdout, /acs tasks active --project-id <projectId> --json/);
  });

  test("plan parser accepts mixed item types and automation defaults", () => {
    const parsed = parsePlanOutput(`
\`\`\`yaml
auto_start: true
auto_merge_on_complete: true
auto_merge_item_keys: [task_1]
tasks:
  - id: task_1
    title: Implement API
    item_type: execution_task
    auto_merge: true
    prompt: Build API endpoint
  - id: plan_2
    title: Integration Plan
    item_type: sub_plan
    depends_on: [task_1]
    prompt: Build integration plan
\`\`\`
`);

    assert.equal(parsed.tasks.length, 2);
    assert.equal(parsed.tasks[0]?.itemType, "execution_task");
    assert.equal(parsed.tasks[0]?.autoMerge, true);
    assert.equal(parsed.tasks[1]?.itemType, "sub_plan");
    assert.deepEqual(parsed.tasks[1]?.dependsOnItemKeys, ["task_1"]);
    assert.equal(parsed.tasks[1]?.autoStart, true);
    assert.equal(parsed.tasks[1]?.autoMergeOnComplete, true);
  });

  test("plan parser remains backward-compatible with legacy task-only YAML", () => {
    const parsed = parsePlanOutput(`
\`\`\`yaml
tasks:
  - id: task_a
    title: A
    prompt: Do A
  - id: task_b
    title: B
    prompt: Do B
    depends_on: [task_a]
\`\`\`
`);
    assert.equal(parsed.tasks.length, 2);
    assert.equal(parsed.tasks[0]?.itemType, "execution_task");
    assert.equal(parsed.tasks[0]?.autoMerge, false);
    assert.deepEqual(parsed.tasks[1]?.dependsOnItemKeys, ["task_a"]);
  });

  test("plan parser rejects cross-item cycles across mixed item types", () => {
    assert.throws(
      () =>
        parsePlanOutput(`
\`\`\`yaml
tasks:
  - id: task_a
    title: A
    item_type: execution_task
    prompt: Do A
    depends_on: [plan_b]
  - id: plan_b
    title: B
    item_type: sub_plan
    prompt: Do B
    depends_on: [task_a]
\`\`\`
`),
      /Cyclic dependency/
    );
  });

  test("approvePlan defaults execution children to auto-merge when plan auto-start is enabled", async () => {
    const userId = createUser();
    const basePath = randomPath("plan-auto-start-default-merge-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Auto-start defaults",
      mode: "plan",
      status: "waiting_input"
    });
    const plan = projectDb.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(planId) as { workspace_path: string };
    projectDb.prepare("UPDATE tasks SET auto_start = 1, updated_at = ? WHERE id = ?").run(nowIso(), planId);

    fs.mkdirSync(plan.workspace_path, { recursive: true });
    runGit(["init", "-b", "main"], plan.workspace_path);
    runGit(["config", "user.email", "tests@example.com"], plan.workspace_path);
    runGit(["config", "user.name", "Tests"], plan.workspace_path);
    fs.writeFileSync(path.join(plan.workspace_path, "README.md"), "auto-start plan workspace\n", "utf8");
    runGit(["add", "."], plan.workspace_path);
    runGit(["commit", "-m", "init"], plan.workspace_path);
    runGit(["checkout", "-b", `task/${planId}`], plan.workspace_path);

    const revisionId = randomUUID();
    const now = nowIso();
    projectDb
      .prepare(
        `INSERT INTO plan_revisions (
           id, plan_task_id, revision_number, status, feedback, raw_output, parse_error, created_by_user_id, created_at, approved_at
         ) VALUES (?, ?, 1, 'proposed', NULL, ?, NULL, ?, ?, NULL)`
      )
      .run(
        revisionId,
        planId,
        [
          "tasks:",
          "  - id: build_a",
          "    title: Build A",
          "    prompt: Build A prompt",
          "  - id: build_b",
          "    title: Build B",
          "    prompt: Build B prompt",
          "    depends_on: [build_a]",
          ""
        ].join("\n"),
        userId,
        now
      );
    const itemAId = randomUUID();
    const itemBId = randomUUID();
    projectDb
      .prepare(
        `INSERT INTO plan_revision_items (id, revision_id, item_key, item_type, title, prompt, ordinal, created_at)
         VALUES (?, ?, ?, 'execution_task', ?, ?, ?, ?)`
      )
      .run(itemAId, revisionId, "build_a", "Build A", "Build A prompt", 1, now);
    projectDb
      .prepare(
        `INSERT INTO plan_revision_items (id, revision_id, item_key, item_type, title, prompt, ordinal, created_at)
         VALUES (?, ?, ?, 'execution_task', ?, ?, ?, ?)`
      )
      .run(itemBId, revisionId, "build_b", "Build B", "Build B prompt", 2, now);
    projectDb
      .prepare("INSERT INTO plan_revision_item_dependencies (revision_item_id, depends_on_item_key) VALUES (?, ?)")
      .run(itemBId, "build_a");

    await approvePlan({ userId, planId });

    const children = projectDb
      .prepare("SELECT source_plan_item_key, auto_merge, status FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
      .all(planId) as Array<{ source_plan_item_key: string; auto_merge: number; status: string }>;
    assert.equal(children.length, 2);
    assert.deepEqual(children.map((row) => row.source_plan_item_key), ["build_a", "build_b"]);
    assert.deepEqual(children.map((row) => row.auto_merge), [1, 1]);
    assert.deepEqual(children.map((row) => row.status), ["queued", "queued"]);

    const taskDependencies = projectDb
      .prepare("SELECT td.task_id, dep.source_plan_item_key AS dependency_key FROM task_dependencies td JOIN tasks dep ON dep.id = td.dependency_task_id")
      .all() as Array<{ task_id: string; dependency_key: string }>;
    assert.equal(taskDependencies.length, 1);
    assert.equal(taskDependencies[0]?.dependency_key, "build_a");
  });

  test("plan orchestration only auto-starts plans that are waiting_input", async () => {
    const userId = createUser();
    const basePath = randomPath("plan-orchestrator-waiting-input-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Queued Plan",
      mode: "plan",
      status: "queued"
    });
    const plan = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(planId) as { workspace_path: string };
    projectDb.prepare("UPDATE tasks SET auto_start = 1, updated_at = ? WHERE id = ?").run(nowIso(), planId);

    fs.mkdirSync(plan.workspace_path, { recursive: true });
    runGit(["init", "-b", "main"], plan.workspace_path);
    runGit(["config", "user.email", "tests@example.com"], plan.workspace_path);
    runGit(["config", "user.name", "Tests"], plan.workspace_path);
    fs.writeFileSync(path.join(plan.workspace_path, "README.md"), "queued plan workspace\n", "utf8");
    runGit(["add", "."], plan.workspace_path);
    runGit(["commit", "-m", "init"], plan.workspace_path);
    runGit(["checkout", "-b", `task/${planId}`], plan.workspace_path);

    const planDir = path.join(plan.workspace_path, ".ai-plan");
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, "latest-plan.yaml"),
      [
        "tasks:",
        "  - id: task_a",
        "    title: Build A",
        "    prompt: Build A prompt",
        ""
      ].join("\n"),
      "utf8"
    );

    await runPlanOrchestrationPassForTests();
    const noRevisionWhileQueued = projectDb
      .prepare("SELECT COUNT(*) AS count FROM plan_revisions WHERE plan_task_id = ?")
      .get(planId) as { count: number };
    assert.equal(noRevisionWhileQueued.count, 0);

    projectDb.prepare("UPDATE tasks SET status = 'waiting_input', updated_at = ? WHERE id = ?").run(nowIso(), planId);
    await runPlanOrchestrationPassForTests();
    await runPlanOrchestrationPassForTests();

    const approvedRevision = projectDb
      .prepare("SELECT status FROM plan_revisions WHERE plan_task_id = ? ORDER BY revision_number DESC LIMIT 1")
      .get(planId) as { status: string } | undefined;
    assert.equal(approvedRevision?.status, "approved");
  });

  test("plan orchestration retries after parse failure when plan output changes", async () => {
    const userId = createUser();
    const basePath = randomPath("plan-orchestrator-retry-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Retry Plan",
      mode: "plan",
      status: "waiting_input"
    });
    const plan = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(planId) as { workspace_path: string };
    projectDb.prepare("UPDATE tasks SET auto_start = 1, updated_at = ? WHERE id = ?").run(nowIso(), planId);

    fs.mkdirSync(plan.workspace_path, { recursive: true });
    runGit(["init", "-b", "main"], plan.workspace_path);
    runGit(["config", "user.email", "tests@example.com"], plan.workspace_path);
    runGit(["config", "user.name", "Tests"], plan.workspace_path);
    fs.writeFileSync(path.join(plan.workspace_path, "README.md"), "retry plan workspace\n", "utf8");
    runGit(["add", "."], plan.workspace_path);
    runGit(["commit", "-m", "init"], plan.workspace_path);
    runGit(["checkout", "-b", `task/${planId}`], plan.workspace_path);

    const planDir = path.join(plan.workspace_path, ".ai-plan");
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, "latest-plan.yaml"), "tasks\n", "utf8");

    await runPlanOrchestrationPassForTests();
    const failedEvent = projectDb
      .prepare("SELECT event_type FROM events WHERE task_id = ? AND event_type = 'plan.orchestration.auto_extract.failed' LIMIT 1")
      .get(planId) as { event_type: string } | undefined;
    assert.equal(failedEvent?.event_type, "plan.orchestration.auto_extract.failed");

    fs.writeFileSync(
      path.join(planDir, "latest-plan.yaml"),
      [
        "tasks:",
        "  - id: task_a",
        "    title: Retry A",
        "    prompt: Retry A prompt",
        ""
      ].join("\n"),
      "utf8"
    );

    await runPlanOrchestrationPassForTests();
    await runPlanOrchestrationPassForTests();

    const retryEvent = projectDb
      .prepare("SELECT event_type FROM events WHERE task_id = ? AND event_type = 'plan.orchestration.retry.started' LIMIT 1")
      .get(planId) as { event_type: string } | undefined;
    assert.equal(retryEvent?.event_type, "plan.orchestration.retry.started");

    const approvedEvent = projectDb
      .prepare("SELECT event_type FROM events WHERE task_id = ? AND event_type = 'plan.orchestration.auto_approve.succeeded' LIMIT 1")
      .get(planId) as { event_type: string } | undefined;
    assert.equal(approvedEvent?.event_type, "plan.orchestration.auto_approve.succeeded");
  });

  test("plan orchestration auto-extracts and auto-approves once per output hash", async () => {
    const userId = createUser();
    const basePath = randomPath("plan-orchestrator-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Auto Plan",
      mode: "plan",
      status: "waiting_input"
    });
    const plan = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(planId) as { workspace_path: string };
    projectDb.prepare("UPDATE tasks SET auto_start = 1, updated_at = ? WHERE id = ?").run(nowIso(), planId);

    fs.mkdirSync(plan.workspace_path, { recursive: true });
    runGit(["init", "-b", "main"], plan.workspace_path);
    runGit(["config", "user.email", "tests@example.com"], plan.workspace_path);
    runGit(["config", "user.name", "Tests"], plan.workspace_path);
    fs.writeFileSync(path.join(plan.workspace_path, "README.md"), "plan workspace\n", "utf8");
    runGit(["add", "."], plan.workspace_path);
    runGit(["commit", "-m", "init"], plan.workspace_path);
    runGit(["checkout", "-b", `task/${planId}`], plan.workspace_path);

    const planDir = path.join(plan.workspace_path, ".ai-plan");
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, "latest-plan.yaml"),
      [
        "tasks:",
        "  - id: task_a",
        "    title: Build A",
        "    prompt: Build A prompt",
        "  - id: plan_b",
        "    item_type: sub_plan",
        "    title: Build B Plan",
        "    prompt: Build B prompt",
        "    depends_on: [task_a]",
        ""
      ].join("\n"),
      "utf8"
    );

    await runPlanOrchestrationPassForTests();
    await runPlanOrchestrationPassForTests();

    const revisions = projectDb
      .prepare("SELECT * FROM plan_revisions WHERE plan_task_id = ? ORDER BY revision_number ASC")
      .all(planId) as Array<{ status: string }>;
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]?.status, "approved");

    const childTasks = projectDb
      .prepare("SELECT * FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
      .all(planId) as Array<{ id: string; source_plan_item_key: string; mode: string; status: string }>;
    assert.equal(childTasks.length, 2);
    assert.equal(childTasks[0]?.source_plan_item_key, "task_a");
    assert.equal(childTasks[0]?.mode, "execution");
    assert.equal(childTasks[1]?.source_plan_item_key, "plan_b");
    assert.equal(childTasks[1]?.mode, "plan");

    const depRows = projectDb.prepare("SELECT * FROM task_dependencies").all() as Array<{ task_id: string; dependency_task_id: string }>;
    assert.equal(depRows.length, 1);
    const taskA = projectDb
      .prepare("SELECT id FROM tasks WHERE parent_plan_task_id = ? AND source_plan_item_key = ?")
      .get(planId, "task_a") as { id: string };
    const planB = projectDb
      .prepare("SELECT id FROM tasks WHERE parent_plan_task_id = ? AND source_plan_item_key = ?")
      .get(planId, "plan_b") as { id: string };
    assert.equal(depRows[0]?.task_id, planB.id);
    assert.equal(depRows[0]?.dependency_task_id, taskA.id);

    const orchestration = projectDb
      .prepare("SELECT * FROM plan_orchestration_state WHERE plan_task_id = ?")
      .get(planId) as { last_approved_output_sha256: string | null; lock_token: string | null };
    assert.equal(typeof orchestration.last_approved_output_sha256, "string");
    assert.equal(orchestration.lock_token, null);

    const orchestrationEvents = projectDb
      .prepare("SELECT event_type FROM events WHERE task_id = ? AND event_type LIKE 'plan.orchestration.%' ORDER BY created_at ASC")
      .all(planId) as Array<{ event_type: string }>;
    assert.equal(orchestrationEvents.some((row) => row.event_type === "plan.orchestration.auto_extract.succeeded"), true);
    assert.equal(orchestrationEvents.some((row) => row.event_type === "plan.orchestration.auto_approve.succeeded"), true);
  });

  test("plan-created sub-plans are recursively orchestrated with duplicate-safe approvals", async () => {
    const userId = createUser();
    const basePath = randomPath("plan-orchestrator-recursive-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const rootPlanId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Root Auto Plan",
      mode: "plan",
      status: "waiting_input"
    });
    const rootPlan = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(rootPlanId) as { workspace_path: string };
    projectDb.prepare("UPDATE tasks SET auto_start = 1, updated_at = ? WHERE id = ?").run(nowIso(), rootPlanId);

    fs.mkdirSync(rootPlan.workspace_path, { recursive: true });
    runGit(["init", "-b", "main"], rootPlan.workspace_path);
    runGit(["config", "user.email", "tests@example.com"], rootPlan.workspace_path);
    runGit(["config", "user.name", "Tests"], rootPlan.workspace_path);
    fs.writeFileSync(path.join(rootPlan.workspace_path, "README.md"), "root plan workspace\n", "utf8");
    runGit(["add", "."], rootPlan.workspace_path);
    runGit(["commit", "-m", "init"], rootPlan.workspace_path);
    runGit(["checkout", "-b", `task/${rootPlanId}`], rootPlan.workspace_path);

    const rootPlanDir = path.join(rootPlan.workspace_path, ".ai-plan");
    fs.mkdirSync(rootPlanDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootPlanDir, "latest-plan.yaml"),
      [
        "tasks:",
        "  - id: sub_plan_a",
        "    item_type: sub_plan",
        "    title: Build nested plan",
        "    prompt: Create nested plan output",
        "    auto_start: true",
        ""
      ].join("\n"),
      "utf8"
    );

    await runPlanOrchestrationPassForTests();
    await runPlanOrchestrationPassForTests();

    const subPlan = projectDb
      .prepare("SELECT * FROM tasks WHERE parent_plan_task_id = ? AND source_plan_item_key = 'sub_plan_a'")
      .get(rootPlanId) as { id: string; mode: string; auto_start: number; status: string; workspace_path: string } | undefined;
    assert.ok(subPlan);
    assert.equal(subPlan.mode, "plan");
    assert.equal(subPlan.auto_start, 1);

    projectDb.prepare("UPDATE tasks SET status = 'waiting_input', updated_at = ? WHERE id = ?").run(nowIso(), subPlan.id);
    const subPlanDir = path.join(subPlan.workspace_path, ".ai-plan");
    fs.mkdirSync(subPlanDir, { recursive: true });
    fs.writeFileSync(
      path.join(subPlanDir, "latest-plan.yaml"),
      [
        "tasks:",
        "  - id: child_exec",
        "    title: Child execution item",
        "    prompt: Implement child execution item",
        "  - id: child_sub_plan",
        "    item_type: sub_plan",
        "    title: Child sub plan",
        "    prompt: Implement child sub plan",
        "    depends_on: [child_exec]",
        ""
      ].join("\n"),
      "utf8"
    );

    await runPlanOrchestrationPassForTests();
    await runPlanOrchestrationPassForTests();

    const subPlanRevisions = projectDb
      .prepare("SELECT status FROM plan_revisions WHERE plan_task_id = ? ORDER BY revision_number ASC")
      .all(subPlan.id) as Array<{ status: string }>;
    assert.equal(subPlanRevisions.length, 1);
    assert.equal(subPlanRevisions[0]?.status, "approved");

    const subPlanChildren = projectDb
      .prepare("SELECT source_plan_item_key, mode FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
      .all(subPlan.id) as Array<{ source_plan_item_key: string; mode: string }>;
    assert.equal(subPlanChildren.length, 2);
    assert.equal(subPlanChildren[0]?.source_plan_item_key, "child_exec");
    assert.equal(subPlanChildren[0]?.mode, "execution");
    assert.equal(subPlanChildren[1]?.source_plan_item_key, "child_sub_plan");
    assert.equal(subPlanChildren[1]?.mode, "plan");

    await runPlanOrchestrationPassForTests();
    await runPlanOrchestrationPassForTests();
    const subPlanChildrenAfterExtraPasses = projectDb
      .prepare("SELECT COUNT(*) AS count FROM tasks WHERE parent_plan_task_id = ?")
      .get(subPlan.id) as { count: number };
    assert.equal(subPlanChildrenAfterExtraPasses.count, 2);
  });

  test("approvePlan rejects sub-plan recursion beyond depth limit", async () => {
    const userId = createUser();
    const basePath = randomPath("plan-recursion-depth-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const rootPlanId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Root",
      mode: "plan",
      status: "waiting_input"
    });
    let parentPlanId = rootPlanId;
    for (let i = 1; i <= 6; i += 1) {
      parentPlanId = insertTask({
        projectDb,
        projectId,
        userId,
        title: `Nested ${i}`,
        mode: "plan",
        status: "waiting_input",
        parentPlanTaskId: parentPlanId
      });
    }

    const revisionId = randomUUID();
    const now = nowIso();
    projectDb
      .prepare(
        `INSERT INTO plan_revisions (
           id, plan_task_id, revision_number, status, feedback, raw_output, parse_error, created_by_user_id, created_at, approved_at
         ) VALUES (?, ?, 1, 'proposed', NULL, ?, NULL, ?, ?, NULL)`
      )
      .run(revisionId, parentPlanId, "tasks:\n  - id: too_deep\n    item_type: sub_plan\n    title: Too Deep\n    prompt: Too Deep\n", userId, now);
    projectDb
      .prepare(
        `INSERT INTO plan_revision_items (id, revision_id, item_key, item_type, title, prompt, ordinal, created_at)
         VALUES (?, ?, 'too_deep', 'sub_plan', 'Too Deep', 'Too Deep', 1, ?)`
      )
      .run(randomUUID(), revisionId, now);

    await assert.rejects(
      async () => approvePlan({ userId, planId: parentPlanId }),
      (error: unknown) =>
        error instanceof CliServiceError
        && error.code === "VALIDATION"
        && /recursion depth/i.test(error.message)
    );

    const created = projectDb
      .prepare("SELECT id FROM tasks WHERE source_plan_revision_id = ?")
      .all(revisionId) as Array<{ id: string }>;
    assert.equal(created.length, 0);
  });

  test("approvePlan allows cross-tier dependencies and persists dependency reasons", async () => {
    const userId = createUser();
    const basePath = randomPath("plan-topology-guard-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    fs.mkdirSync(basePath, { recursive: true });
    runGit(["init", "-b", "main"], basePath);
    runGit(["config", "user.email", "tests@example.com"], basePath);
    runGit(["config", "user.name", "Tests"], basePath);
    fs.writeFileSync(path.join(basePath, "README.md"), "topology test\n", "utf8");
    runGit(["add", "."], basePath);
    runGit(["commit", "-m", "init"], basePath);

    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Topology Plan",
      mode: "plan",
      status: "waiting_input"
    });
    const planRow = projectDb.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(planId) as { workspace_path: string };
    fs.mkdirSync(planRow.workspace_path, { recursive: true });
    runGit(["init", "-b", "main"], planRow.workspace_path);
    runGit(["config", "user.email", "tests@example.com"], planRow.workspace_path);
    runGit(["config", "user.name", "Tests"], planRow.workspace_path);
    fs.writeFileSync(path.join(planRow.workspace_path, "README.md"), "plan workspace\n", "utf8");
    runGit(["add", "."], planRow.workspace_path);
    runGit(["commit", "-m", "init"], planRow.workspace_path);
    runGit(["checkout", "-b", `task/${planId}`], planRow.workspace_path);
    const revisionId = randomUUID();
    const now = nowIso();
    projectDb
      .prepare(
        `INSERT INTO plan_revisions (
           id, plan_task_id, revision_number, status, feedback, raw_output, parse_error, created_by_user_id, created_at, approved_at
         ) VALUES (?, ?, 1, 'proposed', NULL, ?, NULL, ?, ?, NULL)`
      )
      .run(
        revisionId,
        planId,
        [
          "tasks:",
          "  - id: root_target",
          "    item_type: sub_plan",
          "    title: Root Target",
          "    prompt: Root Target",
          "  - id: parent_target",
          "    item_type: sub_plan",
          "    title: Parent Target",
          "    prompt: Parent Target",
          "    depends_on: [root_target]",
          ""
        ].join("\n"),
        userId,
        now
      );
    const itemAId = randomUUID();
    const itemBId = randomUUID();
    projectDb
      .prepare(
        `INSERT INTO plan_revision_items (id, revision_id, item_key, item_type, title, prompt, ordinal, created_at)
         VALUES (?, ?, ?, 'sub_plan', ?, ?, ?, ?)`
      )
      .run(itemAId, revisionId, "root_target", "Root Target", "Root Target", 1, now);
    projectDb
      .prepare(
        `INSERT INTO plan_revision_items (id, revision_id, item_key, item_type, title, prompt, ordinal, created_at)
         VALUES (?, ?, ?, 'sub_plan', ?, ?, ?, ?)`
      )
      .run(itemBId, revisionId, "parent_target", "Parent Target", "Parent Target", 2, now);
    projectDb
      .prepare("INSERT INTO plan_revision_item_dependencies (revision_item_id, depends_on_item_key) VALUES (?, ?)")
      .run(itemBId, "root_target");

    const result = await approvePlan({
      userId,
      planId,
      taskEdits: [
        {
          itemKey: "root_target",
          title: "Root Target",
          description: "Root Target",
          parentPlanTaskId: null
        },
        {
          itemKey: "parent_target",
          title: "Parent Target",
          description: "Parent Target"
        }
      ]
    });

    assert.equal(result.approvedTasks.length, 2);
    const parentTarget = result.approvedTasks.find((task) => task.sourcePlanItemKey === "parent_target");
    const sameTier = parentTarget?.nodeMetadata?.dependencies?.same_tier ?? [];
    assert.equal(
      sameTier.some((dep: any) => dep.reason === "plan_item:root_target"),
      true
    );
  });

  test("approvePlan rejects cycles with actionable dependency path", async () => {
    const userId = createUser();
    const basePath = randomPath("plan-cycle-validation-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Cycle Plan",
      mode: "plan",
      status: "waiting_input"
    });
    const revisionId = randomUUID();
    const now = nowIso();
    projectDb
      .prepare(
        `INSERT INTO plan_revisions (
           id, plan_task_id, revision_number, status, feedback, raw_output, parse_error, created_by_user_id, created_at, approved_at
         ) VALUES (?, ?, 1, 'proposed', NULL, ?, NULL, ?, ?, NULL)`
      )
      .run(revisionId, planId, "tasks:\n  - id: a\n    title: A\n    prompt: A\n  - id: b\n    title: B\n    prompt: B\n", userId, now);
    const itemAId = randomUUID();
    const itemBId = randomUUID();
    projectDb
      .prepare(
        `INSERT INTO plan_revision_items (id, revision_id, item_key, item_type, title, prompt, ordinal, created_at)
         VALUES (?, ?, ?, 'execution_task', ?, ?, ?, ?)`
      )
      .run(itemAId, revisionId, "a", "A", "A", 1, now);
    projectDb
      .prepare(
        `INSERT INTO plan_revision_items (id, revision_id, item_key, item_type, title, prompt, ordinal, created_at)
         VALUES (?, ?, ?, 'execution_task', ?, ?, ?, ?)`
      )
      .run(itemBId, revisionId, "b", "B", "B", 2, now);
    projectDb.prepare("INSERT INTO plan_revision_item_dependencies (revision_item_id, depends_on_item_key) VALUES (?, ?)").run(itemAId, "b");
    projectDb.prepare("INSERT INTO plan_revision_item_dependencies (revision_item_id, depends_on_item_key) VALUES (?, ?)").run(itemBId, "a");

    await assert.rejects(
      async () => approvePlan({ userId, planId }),
      (error: unknown) =>
        error instanceof CliServiceError
        && error.code === "VALIDATION"
        && /Cyclic dependency detected/i.test(error.message)
    );
  });

  test("dependency diagnostics exposes unresolved ids, reasons, and lineage", () => {
    const userId = createUser();
    const basePath = randomPath("dependency-diagnostics-project");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    const blockerId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Blocker",
      status: "in_progress"
    });
    const taskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Dependent",
      status: "queued"
    });
    const metadata = {
      schema_version: 1,
      tier: "task",
      dependencies: {
        same_tier: [{ id: blockerId, tier: "task", reason: "await_blocker_merge" }]
      }
    };
    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(metadata), nowIso(), taskId);

    const task = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow;
    const diagnostics = buildDependencyDiagnostics({ projectDb, task });
    assert.equal(diagnostics.unresolved[0]?.id, blockerId);
    assert.equal(diagnostics.unresolved[0]?.reason, "await_blocker_merge");
    assert.equal(diagnostics.lineage[0]?.fromId, taskId);
    assert.equal(diagnostics.lineage[0]?.toId, blockerId);
  });
});

describe("integration: orchestration hooks and job queue", () => {
  beforeEach(() => {
    resetAppDatabaseState();
  });

  test("duplicate hook events do not produce duplicate effective work", async () => {
    const userId = createUser();
    const basePath = randomPath("hook-dedupe");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    const taskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Hook Dedupe Task",
      status: "queued"
    });

    let handledCount = 0;
    registerOrchestrationJobHandler("task_queue_dispatch", async () => {
      handledCount += 1;
    });

    recordEvent({
      projectId,
      taskId,
      eventType: "task.status_changed",
      payload: { fromStatus: "queued", toStatus: "in_progress", reasonCode: "manual_test" },
      database: projectDb
    });
    recordEvent({
      projectId,
      taskId,
      eventType: "task.status_changed",
      payload: { fromStatus: "queued", toStatus: "in_progress", reasonCode: "manual_test" },
      database: projectDb
    });

    await runOrchestrationJobQueuePassForTests();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await runOrchestrationJobQueuePassForTests();
    await runOrchestrationJobQueuePassForTests();
    assert.equal(handledCount, 1);
  });

  test("burst updates are debounced and coalesced", async () => {
    const userId = createUser();
    const basePath = randomPath("hook-debounce");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    const taskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Hook Debounce Task",
      status: "queued"
    });

    let handledCount = 0;
    registerOrchestrationJobHandler("task_queue_dispatch", async () => {
      handledCount += 1;
    });

    for (let idx = 0; idx < 4; idx += 1) {
      recordEvent({
        projectId,
        taskId,
        eventType: "task.status_changed",
        payload: { fromStatus: "queued", toStatus: "in_progress", reasonCode: "burst_test" },
        database: projectDb
      });
    }

    await runOrchestrationJobQueuePassForTests();
    assert.equal(handledCount, 0);
    await new Promise((resolve) => setTimeout(resolve, 750));
    await runOrchestrationJobQueuePassForTests();
    assert.equal(handledCount, 1);
  });

  test("queue restart does not violate idempotency", async () => {
    const userId = createUser();
    const basePath = randomPath("hook-restart");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    let handledCount = 0;
    registerOrchestrationJobHandler("task_queue_dispatch", async () => {
      handledCount += 1;
    });

    enqueueOrchestrationJob({
      projectId,
      taskId: null,
      jobType: "task_queue_dispatch",
      idempotencyKey: "restart-safe-job",
      debounceMs: 0,
      dedupeWindowMs: 5_000,
      database: projectDb
    });
    await runOrchestrationJobQueuePassForTests();
    assert.equal(handledCount, 1);

    resetOrchestrationJobQueueForTests();
    registerOrchestrationJobHandler("task_queue_dispatch", async () => {
      handledCount += 1;
    });
    await runOrchestrationJobQueuePassForTests();
    assert.equal(handledCount, 1);
  });

  test("non-material output updates do not thrash orchestration hooks", async () => {
    const userId = createUser();
    const basePath = randomPath("output-monitor");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    const taskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Output Monitor Task",
      status: "in_progress"
    });

    let handledCount = 0;
    registerOrchestrationJobHandler("plan_orchestration_pass", async () => {
      handledCount += 1;
    });

    const first = observeNodeOutputMaterialChange({
      projectDb,
      taskId,
      source: "runtime_session",
      rawOutput: "Plan step started\nWorking..."
    });
    assert.equal(first.materialChanged, true);
    if (first.materialChanged) {
      recordEvent({
        projectId,
        taskId,
        eventType: "task.output.material_changed",
        payload: {
          source: first.source,
          outputHash: first.outputHash,
          previousOutputHash: first.previousOutputHash
        },
        database: projectDb
      });
    }

    const nonMaterial = observeNodeOutputMaterialChange({
      projectDb,
      taskId,
      source: "runtime_session",
      rawOutput: "Plan step started  \r\nWorking...\n"
    });
    assert.equal(nonMaterial.materialChanged, false);

    await runOrchestrationJobQueuePassForTests();
    await new Promise((resolve) => setTimeout(resolve, 1_750));
    await runOrchestrationJobQueuePassForTests();
    assert.equal(handledCount, 1);
  });

  test("watchdog enqueues stale-node readiness and re-review actions with event audit trail", async () => {
    const userId = createUser();
    const basePath = randomPath("watchdog");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const blockerId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Watchdog Blocker",
      status: "in_progress"
    });
    const blockedTaskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Watchdog Blocked",
      status: "queued"
    });
    projectDb.prepare("INSERT INTO task_dependencies (task_id, dependency_task_id, created_at) VALUES (?, ?, ?)").run(
      blockedTaskId,
      blockerId,
      nowIso()
    );

    const staleRunningTaskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Watchdog Running",
      status: "in_progress"
    });

    const staleIso = new Date(Date.now() - 8 * 60_000).toISOString();
    projectDb.prepare("UPDATE tasks SET updated_at = ? WHERE id IN (?, ?, ?)").run(staleIso, blockerId, blockedTaskId, staleRunningTaskId);

    let queueDispatchCount = 0;
    let planPassCount = 0;
    registerOrchestrationJobHandler("task_queue_dispatch", async () => {
      queueDispatchCount += 1;
    });
    registerOrchestrationJobHandler("plan_orchestration_pass", async () => {
      planPassCount += 1;
    });

    const watchdogResult = runOrchestrationWatchdog({
      projectId,
      projectDb,
      trigger: "integration_test"
    });
    assert.equal(watchdogResult.readinessCount > 0, true);
    assert.equal(watchdogResult.reviewCount > 0, true);

    await runOrchestrationJobQueuePassForTests();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await runOrchestrationJobQueuePassForTests();
    assert.equal(queueDispatchCount > 0, true);
    assert.equal(planPassCount > 0, true);

    const watchdogEvents = projectDb
      .prepare(
        `SELECT payload
         FROM events
         WHERE event_type = 'orchestration.watchdog.action.enqueued'
         ORDER BY created_at ASC`
      )
      .all() as Array<{ payload: string }>;
    assert.equal(watchdogEvents.length >= 2, true);
    const actions = watchdogEvents
      .map((row) => {
        try {
          return (JSON.parse(row.payload) as { action?: string }).action ?? "";
        } catch {
          return "";
        }
      })
      .filter(Boolean);
    assert.equal(actions.includes("evaluate_readiness"), true);
    assert.equal(actions.includes("re_review"), true);
  });
});

describe("integration: hierarchical decomposition and readiness jobs", () => {
  beforeEach(() => {
    resetAppDatabaseState();
    startHierarchicalOrchestrationJobs();
  });

  test("decompose auto-mode derives missing lower tiers from epoch", async () => {
    const userId = createUser();
    const basePath = randomPath("decompose-epoch");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const epochId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Epoch Node",
      mode: "plan",
      status: "queued"
    });
    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "epoch" }),
      nowIso(),
      epochId
    );

    await runDecomposeForTask({
      projectDb,
      projectId,
      taskId: epochId,
      autoMode: true
    });

    const children = projectDb
      .prepare("SELECT id, parent_plan_task_id, metadata_json FROM tasks WHERE project_id = ? ORDER BY created_at ASC")
      .all(projectId) as Array<{ id: string; parent_plan_task_id: string | null; metadata_json: string | null }>;
    const tiers = children
      .map((row) => {
        try {
          return JSON.parse(row.metadata_json ?? "{}")?.tier as string | undefined;
        } catch {
          return undefined;
        }
      })
      .filter((tier): tier is string => Boolean(tier));

    assert.ok(tiers.includes("epoch"));
    assert.ok(tiers.includes("phase"));
    assert.ok(tiers.includes("plan"));
    assert.ok(tiers.includes("task"));
    assert.ok(tiers.includes("exec"));
  });

  test("decompose auto-mode derives only lower tiers from phase/plan/task starts", async () => {
    const fixtures: Array<{ tier: "phase" | "plan" | "task"; mode: "plan" | "execution"; expected: string[] }> = [
      { tier: "phase", mode: "plan", expected: ["plan", "task", "exec"] },
      { tier: "plan", mode: "plan", expected: ["task", "exec"] },
      { tier: "task", mode: "execution", expected: ["exec"] }
    ];

    for (const fixture of fixtures) {
      const userId = createUser();
      const basePath = randomPath(`decompose-${fixture.tier}`);
      const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
      const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

      const rootId = insertTask({
        projectDb,
        projectId,
        userId,
        title: `Root ${fixture.tier}`,
        mode: fixture.mode,
        status: "queued"
      });
      projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify({ schema_version: 1, tier: fixture.tier }),
        nowIso(),
        rootId
      );
      await runDecomposeForTask({
        projectDb,
        projectId,
        taskId: rootId,
        autoMode: true
      });
      const root = projectDb
        .prepare("SELECT * FROM tasks WHERE title = ? ORDER BY created_at DESC LIMIT 1")
        .get(`Root ${fixture.tier}`) as TaskRow;
      const all = projectDb
        .prepare("SELECT id, parent_plan_task_id, metadata_json FROM tasks WHERE project_id = ? ORDER BY created_at ASC")
        .all(projectId) as Array<{ id: string; parent_plan_task_id: string | null; metadata_json: string | null }>;
      const descendants: Array<{ metadata_json: string | null }> = [];
      const queue = [root.id];
      while (queue.length > 0) {
        const parentId = queue.shift() as string;
        const children = all.filter((row) => row.parent_plan_task_id === parentId);
        for (const child of children) {
          descendants.push({ metadata_json: child.metadata_json });
          queue.push(child.id);
        }
      }
      const tiers = new Set(
        descendants
          .map((row) => {
            try {
              return JSON.parse(row.metadata_json ?? "{}")?.tier as string | undefined;
            } catch {
              return undefined;
            }
          })
          .filter((value): value is string => Boolean(value))
      );
      for (const expectedTier of fixture.expected) {
        assert.equal(tiers.has(expectedTier), true, `missing ${expectedTier} for ${fixture.tier}`);
      }
    }
  });

  test("evaluate_readiness emits deterministic structured decisions", async () => {
    const userId = createUser();
    const basePath = randomPath("evaluate-readiness");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const blockerId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Blocker",
      mode: "execution",
      status: "in_progress"
    });
    const taskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Readiness Target",
      mode: "execution",
      status: "queued"
    });
    projectDb.prepare("INSERT INTO task_dependencies (task_id, dependency_task_id, created_at) VALUES (?, ?, ?)").run(
      taskId,
      blockerId,
      nowIso()
    );

    const firstDecision = await runEvaluateReadinessForTask({
      projectDb,
      taskId
    });
    assert.ok(firstDecision);
    const firstKey = String(firstDecision?.idempotencyKey ?? "");
    assert.ok(firstKey.length > 0);
    assert.equal(firstDecision?.reasonCodes.includes("DEPS_INCOMPLETE"), true);

    const secondDecision = await runEvaluateReadinessForTask({
      projectDb,
      taskId
    });
    assert.equal(secondDecision?.idempotencyKey, firstKey);

    const latest = projectDb
      .prepare(
        `SELECT payload
         FROM events
         WHERE task_id = ? AND event_type = 'orchestration.readiness.evaluated'
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(taskId) as { payload: string } | undefined;
    assert.ok(latest?.payload);
    const latestPayload = JSON.parse(latest?.payload ?? "{}");
    assert.equal(latestPayload?.readiness?.idempotency_key, firstKey);
  });
});
