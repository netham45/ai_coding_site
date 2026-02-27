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
  PROJECT_DB_DIRNAME,
  PROJECT_DB_FILENAME,
  PROJECT_DB_SCHEMA_VERSION,
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
import { openSqliteDatabase } from "./db/sqlite.js";
import { CliServiceError, approvePlan, extractPlan, reviewPlan, startNode } from "./application/cliServices.js";
import { buildDependencyDiagnostics } from "./services/orchestration/dependencyGraph.js";
import { assertTaskStatusTransition, canTransitionLifecycle, evaluateParentCompletionGuards } from "./services/orchestration/stateMachine.js";
import {
  enqueueOrchestrationJob,
  registerOrchestrationJobHandler,
  resetOrchestrationJobQueueForTests,
  runOrchestrationJobQueuePassForTests
} from "./services/orchestration/jobQueue.js";
import { startHierarchicalOrchestrationJobs } from "./services/orchestration/jobs/index.js";
import { runDeltaPlanForTask } from "./services/orchestration/jobs/deltaPlan.js";
import { runEvaluateReadinessForTask } from "./services/orchestration/jobs/evaluateReadiness.js";
import { runReReviewForTask } from "./services/orchestration/jobs/reReview.js";
import { runSynthesizeForParent, runVerifyForParent } from "./services/orchestration/completion.js";
import { observeNodeOutputMaterialChange } from "./services/orchestration/outputMonitor.js";
import { runOrchestrationWatchdog } from "./services/orchestration/watchdog.js";
import { parsePlanOutput } from "./services/planParser.js";
import { runPlanOrchestrationPassForTests } from "./services/planOrchestrator.js";
import { recordEvent } from "./services/events.js";
import { buildIdeResumeCommand, prepareIdeWorkspace } from "./services/ide.js";
import { runRuntimeTaskWorker } from "./services/runtimeWorker.js";
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

function gitHead(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function waitForLatestSessionId(projectDb: Database.Database, taskId: string, timeoutMs = 12_000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const row = projectDb
      .prepare("SELECT id FROM task_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(taskId) as { id: string } | undefined;
    if (row?.id) {
      return row.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for task session for task ${taskId}`);
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

async function callApiAt(baseUrl: string, pathname: string, options?: { method?: string; body?: unknown; userId?: string }): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options?.userId) {
    headers["x-user-id"] = options.userId;
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
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

async function callApi(pathname: string, options?: { method?: string; body?: unknown; userId?: string }): Promise<ApiResponse> {
  return callApiAt(apiBaseUrl, pathname, options);
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
    assert.equal(tableExists(upgraded, "workflow_definitions"), true);
    assert.equal(tableExists(upgraded, "workflow_runs"), true);
    assert.equal(tableExists(upgraded, "workflow_stage_runs"), true);
    assert.equal(tableExists(upgraded, "workflow_check_results"), true);
    assert.equal(tableExists(upgraded, "workflow_events"), true);
    assert.equal(Number(upgraded.pragma("user_version", { simple: true })), 3);
    const projectMetadata = upgraded
      .prepare("SELECT schema_version FROM project_metadata WHERE project_id = ?")
      .get(projectId) as { schema_version: number };
    assert.equal(projectMetadata.schema_version, 3);
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

  test("legacy and unified create endpoints produce expected tiers, modes, and dependencies", async () => {
    const userId = createUser();
    const basePath = randomPath("nodes-endpoint");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    runGit(["init", "-b", "main"], basePath);
    runGit(["config", "user.email", "tests@example.com"], basePath);
    runGit(["config", "user.name", "Tests"], basePath);
    fs.writeFileSync(path.join(basePath, "README.md"), "seed\n", "utf8");
    runGit(["add", "."], basePath);
    runGit(["commit", "-m", "initial"], basePath);

    const legacyPlanCreate = await callApi(`/api/projects/${projectId}/plans`, {
      method: "POST",
      userId,
      body: {
        title: "Legacy Plan",
        taskPrompt: "Draft a legacy plan prompt.",
        autoStart: true
      }
    });
    assert.equal(legacyPlanCreate.status, 201);
    const legacyPlanId = legacyPlanCreate.json?.plan?.id;
    assert.equal(legacyPlanCreate.json?.plan?.mode, "plan");
    assert.equal(legacyPlanCreate.json?.plan?.nodeMetadata?.tier, "plan");

    const legacyTaskCreate = await callApi(`/api/projects/${projectId}/tasks`, {
      method: "POST",
      userId,
      body: {
        title: "Legacy Task",
        taskPrompt: "Implement legacy task changes.",
        dependencyNodeRefs: [{ id: legacyPlanId, tier: "plan", reason: "legacy_plan_dependency" }]
      }
    });
    assert.equal(legacyTaskCreate.status, 201);
    const legacyTaskId = legacyTaskCreate.json?.task?.id;
    assert.equal(legacyTaskCreate.json?.task?.mode, "execution");
    assert.equal(legacyTaskCreate.json?.task?.nodeMetadata?.tier, "task");
    assert.equal(legacyTaskCreate.json?.task?.dependencyTaskIds.includes(legacyPlanId), true);

    const epochCreate = await callApi(`/api/projects/${projectId}/nodes`, {
      method: "POST",
      userId,
      body: {
        title: "Program Epoch",
        taskPrompt: "Define the top-level program milestone.",
        nodeTier: "epoch",
        autoStart: true
      }
    });
    assert.equal(epochCreate.status, 201);
    const epochId = epochCreate.json?.node?.id;
    assert.equal(epochCreate.json?.node?.mode, "plan");
    assert.equal(epochCreate.json?.node?.nodeMetadata?.tier, "epoch");

    const phaseCreate = await callApi(`/api/projects/${projectId}/nodes`, {
      method: "POST",
      userId,
      body: {
        title: "Delivery Phase",
        taskPrompt: "Break the epoch into a single delivery phase.",
        nodeTier: "phase",
        parentNodeId: epochId,
        dependencyNodeRefs: [{ id: epochId, tier: "epoch", reason: "parent_phase_sequence" }]
      }
    });
    assert.equal(phaseCreate.status, 201);
    const phaseId = phaseCreate.json?.node?.id;
    assert.equal(phaseCreate.json?.node?.mode, "plan");
    assert.equal(phaseCreate.json?.node?.nodeMetadata?.tier, "phase");
    assert.equal(phaseCreate.json?.node?.parentPlanTaskId, epochId);

    const planCreate = await callApi(`/api/projects/${projectId}/nodes`, {
      method: "POST",
      userId,
      body: {
        title: "Implementation Plan",
        taskPrompt: "Draft implementation plan details for this phase.",
        nodeTier: "plan",
        parentNodeId: phaseId
      }
    });
    assert.equal(planCreate.status, 201);
    const planId = planCreate.json?.node?.id;
    assert.equal(planCreate.json?.node?.mode, "plan");
    assert.equal(planCreate.json?.node?.nodeMetadata?.tier, "plan");
    assert.equal(planCreate.json?.node?.parentPlanTaskId, phaseId);

    const taskCreate = await callApi(`/api/projects/${projectId}/nodes`, {
      method: "POST",
      userId,
      body: {
        title: "Execute Implementation",
        taskPrompt: "Implement the code changes from the plan.",
        nodeTier: "task",
        parentNodeId: planId,
        dependencyNodeRefs: [{ id: planId, tier: "plan", reason: "await_plan_completion" }],
        autoMerge: true
      }
    });
    assert.equal(taskCreate.status, 201);
    const taskId = taskCreate.json?.node?.id;
    assert.equal(taskCreate.json?.node?.mode, "execution");
    assert.equal(taskCreate.json?.node?.nodeMetadata?.tier, "task");
    assert.equal(taskCreate.json?.node?.parentPlanTaskId, planId);

    const storedRows = projectDb
      .prepare("SELECT id, mode, metadata_json FROM tasks WHERE id IN (?, ?, ?, ?, ?, ?)")
      .all(legacyPlanId, legacyTaskId, epochId, phaseId, planId, taskId) as Array<{ id: string; mode: string; metadata_json: string | null }>;
    const rowById = new Map(storedRows.map((row) => [row.id, row]));
    assert.equal(rowById.get(legacyPlanId)?.mode, "plan");
    assert.equal(rowById.get(legacyTaskId)?.mode, "execution");
    assert.equal(rowById.get(epochId)?.mode, "plan");
    assert.equal(rowById.get(phaseId)?.mode, "plan");
    assert.equal(rowById.get(planId)?.mode, "plan");
    assert.equal(rowById.get(taskId)?.mode, "execution");

    const legacyPlanMetadata = JSON.parse(rowById.get(legacyPlanId)?.metadata_json ?? "{}");
    assert.equal(legacyPlanMetadata?.tier, "plan");
    const legacyTaskMetadata = JSON.parse(rowById.get(legacyTaskId)?.metadata_json ?? "{}");
    assert.equal(legacyTaskMetadata?.tier, "task");
    const taskMetadata = JSON.parse(rowById.get(taskId)?.metadata_json ?? "{}");
    assert.equal(taskMetadata?.tier, "task");

    const persistedDependencies = projectDb
      .prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Array<{ dependency_task_id: string }>;
    assert.equal(persistedDependencies.some((row) => row.dependency_task_id === planId), true);
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

  test("task rerun resets task without violating base commit NOT NULL constraint", async () => {
    const userId = createUser();
    const basePath = randomPath("rerun-base-commit");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    runGit(["init", "-b", "main"], basePath);
    runGit(["config", "user.email", "tests@example.com"], basePath);
    runGit(["config", "user.name", "Tests"], basePath);
    fs.writeFileSync(path.join(basePath, "README.md"), "one\n", "utf8");
    runGit(["add", "."], basePath);
    runGit(["commit", "-m", "initial"], basePath);
    const initialSha = gitHead(basePath);
    fs.writeFileSync(path.join(basePath, "README.md"), "two\n", "utf8");
    runGit(["commit", "-am", "second"], basePath);
    const latestSha = gitHead(basePath);

    const taskId = randomUUID();
    const workspacePath = path.join(path.dirname(basePath), "tasks", taskId);
    fs.mkdirSync(workspacePath, { recursive: true });

    const now = nowIso();
    projectDb
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
        "Rerun Task",
        "prompt",
        "done",
        "effective",
        "codex --yolo {prompt}",
        0,
        "execution",
        "failed",
        workspacePath,
        initialSha,
        userId,
        now,
        now
      );

    const rerun = await callApi(`/api/tasks/${taskId}/rerun`, { method: "POST", userId });
    assert.equal(rerun.status, 200);
    assert.equal(rerun.json?.task?.baseCommitShaAtCreate, latestSha);

    const updated = projectDb
      .prepare("SELECT status, base_commit_sha_at_create FROM tasks WHERE id = ?")
      .get(taskId) as { status: string; base_commit_sha_at_create: string };
    assert.equal(updated.status, "queued");
    assert.equal(updated.base_commit_sha_at_create, latestSha);
  });

  test("task rerun clears active runtime session records so restart uses a new session", async () => {
    const userId = createUser();
    const basePath = randomPath("rerun-clears-runtime");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    runGit(["init", "-b", "main"], basePath);
    runGit(["config", "user.email", "tests@example.com"], basePath);
    runGit(["config", "user.name", "Tests"], basePath);
    fs.writeFileSync(path.join(basePath, "README.md"), "one\n", "utf8");
    runGit(["add", "."], basePath);
    runGit(["commit", "-m", "initial"], basePath);
    const initialSha = gitHead(basePath);

    const taskId = randomUUID();
    const workspacePath = path.join(path.dirname(basePath), "tasks", taskId);
    fs.mkdirSync(workspacePath, { recursive: true });

    const now = nowIso();
    projectDb
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
        "Rerun Runtime Reset",
        "prompt",
        "done",
        "effective",
        "codex --yolo {prompt}",
        0,
        "execution",
        "failed",
        workspacePath,
        initialSha,
        userId,
        now,
        now
      );

    const sessionId = randomUUID();
    projectDb
      .prepare(
        `INSERT INTO task_sessions (
           id, task_id, tmux_session_name, tmux_socket_path, pane_id, detected_tool,
           backend_command, status, started_at, ended_at, last_heartbeat_at, last_output, exit_code, failure_reason
         ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'running', ?, NULL, ?, '', NULL, NULL)`
      )
      .run(sessionId, taskId, `task_${taskId}_oldrun`, path.join(os.tmpdir(), `${taskId}.sock`), "codex --yolo prompt", now, now);

    const rerun = await callApi(`/api/tasks/${taskId}/rerun`, { method: "POST", userId });
    assert.equal(rerun.status, 200);
    assert.equal(rerun.json?.task?.status, "queued");

    const session = projectDb
      .prepare("SELECT status, failure_reason, ended_at FROM task_sessions WHERE id = ?")
      .get(sessionId) as { status: string; failure_reason: string | null; ended_at: string | null } | undefined;
    assert.equal(session, undefined);
    const sessionCount = projectDb
      .prepare("SELECT COUNT(*) AS count FROM task_sessions WHERE task_id = ?")
      .get(taskId) as { count: number };
    assert.equal(sessionCount.count, 0);
  });

  test("ide workspace task uses codex resume command for historical codex sessions", async () => {
    const workspacePath = randomPath("ide-resume-command");
    const taskId = randomUUID();
    const resumeCommand = buildIdeResumeCommand({
      detectedTool: "codex",
      backendCommand: "codex --yolo"
    });
    assert.equal(resumeCommand, "'codex' resume");

    const openPath = await prepareIdeWorkspace({
      taskId,
      workspacePath,
      hasSessionHistory: true,
      resumeCommand
    });

    assert.equal(openPath.endsWith(".code-workspace"), true);
    const workspaceSpec = JSON.parse(fs.readFileSync(openPath, "utf8")) as {
      tasks: { tasks: Array<{ command: string }> };
    };
    assert.equal(workspaceSpec.tasks.tasks[0]?.command.includes("'codex' resume"), true);
  });

  test("ide resume command builder ignores non-codex tools", () => {
    const resumeCommand = buildIdeResumeCommand({
      detectedTool: "custom",
      backendCommand: "some-tool run"
    });
    assert.equal(resumeCommand, null);
  });

  test("start endpoint does not hang when a same-task runtime worker is already wedged", async () => {
    const userId = createUser();
    const basePath = randomPath("runtime-worker-deadlock");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = resolveProjectDatabase({
      appDb,
      projectId,
      basePath,
      intent: "write"
    }).database;

    const taskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Deadlock Repro",
      mode: "execution",
      status: "queued"
    });

    void runRuntimeTaskWorker(taskId, async () => await new Promise<void>(() => undefined));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    try {
      const response = await fetch(`${apiBaseUrl}/api/tasks/${taskId}/start`, {
        method: "POST",
        headers: { "x-user-id": userId },
        signal: controller.signal
      });
      assert.notEqual(response.status, 404);
    } catch (error: any) {
      if (error?.name === "AbortError") {
        assert.fail("Request hung behind a wedged runtime task worker key (deadlock regression)");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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

  test("legacy project DB migrates missing orchestration columns and metadata schema version", () => {
    const userId = createUser();
    const basePath = randomPath("legacy-project-db-upgrade");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const dbDir = path.join(basePath, PROJECT_DB_DIRNAME);
    const dbPath = path.join(dbDir, PROJECT_DB_FILENAME);
    const createdAt = nowIso();
    const updatedAt = nowIso();
    fs.mkdirSync(dbDir, { recursive: true });

    const legacyDb = openSqliteDatabase(dbPath);
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS project_config (
        project_id TEXT PRIMARY KEY,
        project_prompt TEXT NOT NULL DEFAULT '',
        project_rules TEXT NOT NULL DEFAULT '',
        coding_standard TEXT NOT NULL DEFAULT '',
        coding_standard_other TEXT NOT NULL DEFAULT '',
        project_other TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        task_prompt TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT '',
        effective_prompt TEXT NOT NULL,
        ai_command TEXT NOT NULL DEFAULT 'codex --yolo {prompt}',
        auto_merge INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge IN (0,1)),
        mode TEXT NOT NULL DEFAULT 'execution' CHECK (mode IN ('execution','plan')),
        parent_plan_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        source_plan_revision_id TEXT REFERENCES plan_revisions(id) ON DELETE SET NULL,
        source_plan_item_key TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued','in_progress','waiting_input','merge_ready','merged','cancelled','failed','merge_conflict')),
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
      CREATE TABLE IF NOT EXISTS project_metadata (
        project_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO project_config (
        project_id,
        project_prompt,
        project_rules,
        coding_standard,
        coding_standard_other,
        project_other,
        created_at,
        updated_at
      ) VALUES ('${projectId}', '', '', '', '', '', '${createdAt}', '${updatedAt}');
      INSERT INTO project_metadata (project_id, schema_version, created_at, updated_at)
      VALUES ('${projectId}', 1, '${createdAt}', '${updatedAt}');
    `);
    legacyDb.pragma("user_version = 1");
    legacyDb.close();

    const handle = ensureProjectDb({
      projectId,
      basePath,
      initializeIfMissing: false
    });

    const taskColumns = handle.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    assert.equal(taskColumns.some((col) => col.name === "auto_start"), true);
    assert.equal(taskColumns.some((col) => col.name === "auto_merge_on_complete"), true);
    const hasOrchestrationTable = tableExists(handle.db, "plan_orchestration_state");
    assert.equal(hasOrchestrationTable, true);
    const schemaVersion = handle.db.pragma("user_version", { simple: true }) as number;
    assert.equal(schemaVersion, PROJECT_DB_SCHEMA_VERSION);
    assert.equal(handle.metadata.schema_version, PROJECT_DB_SCHEMA_VERSION);
    assert.equal(handle.db.prepare("SELECT auto_start FROM tasks LIMIT 1").all().length, 0);
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

    const mergeConflictEvent = projectDb
      .prepare("SELECT payload FROM events WHERE task_id = ? AND event_type = 'plan.merge_conflict' ORDER BY created_at DESC LIMIT 1")
      .get(parentPlanId) as { payload: string } | undefined;
    assert.equal(Boolean(mergeConflictEvent), true);
    const mergeConflictPayload = JSON.parse(String(mergeConflictEvent?.payload ?? "{}")) as {
      conflictResolution?: {
        prompt_template_path?: string;
        conflict_resolution?: {
          patch_plan?: unknown[];
          escalation?: { required?: boolean };
        };
      };
    };
    assert.equal(
      mergeConflictPayload.conflictResolution?.prompt_template_path,
      "prompts/intent-preserving-conflict-resolution.md"
    );
    assert.equal(
      Array.isArray(mergeConflictPayload.conflictResolution?.conflict_resolution?.patch_plan),
      true
    );
    assert.equal(
      Boolean(mergeConflictPayload.conflictResolution?.conflict_resolution?.escalation?.required),
      true
    );

    const mergeFailedHookEvent = projectDb
      .prepare("SELECT event_type FROM events WHERE task_id = ? AND event_type = 'orchestration.hook.on_merge_failed' ORDER BY created_at DESC LIMIT 1")
      .get(parentPlanId) as { event_type: string } | undefined;
    assert.equal(mergeFailedHookEvent?.event_type, "orchestration.hook.on_merge_failed");

    const recoverReady = runCli(["ready_merge", "plan", parentPlanId, "--json"]);
    assert.equal(recoverReady.code, 0);
    assert.equal(recoverReady.json?.plan?.status, "merge_ready");
  });

  test("merge plan enforces verification gate even when status is merge_ready", () => {
    const userId = ensureLocalUser();
    const basePath = randomPath("cli-plan-merge-gate-project");
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
      taskId: randomUUID(),
      title: "Plan Missing Verification",
      mode: "plan",
      status: "merge_ready"
    });
    const planPath = (projectDb.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(planId) as { workspace_path: string }).workspace_path;

    runGit(["clone", "--branch", "main", basePath, planPath], serverRoot);
    runGit(["config", "user.email", "tests@example.com"], planPath);
    runGit(["config", "user.name", "Tests"], planPath);
    runGit(["switch", "-c", `task/${planId}`], planPath);

    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "plan", lifecycle: { synthesis_passed: true, verification_passed: false } }),
      nowIso(),
      planId
    );

    const mergePlanAttempt = runCli(["merge", "plan", planId, "--json"]);
    assert.equal(mergePlanAttempt.code, 4);
    assert.match(mergePlanAttempt.stderr, /Merge gates failed/);
    assert.match(mergePlanAttempt.stderr, /plan_verification_passed/);
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

  test("material output updates enqueue workflow-owned task_queue_dispatch jobs", async () => {
    const userId = createUser();
    const basePath = randomPath("output-monitor-cutover-default");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    const taskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Output Monitor Cutover",
      status: "in_progress"
    });

    let handledCount = 0;
    registerOrchestrationJobHandler("task_queue_dispatch", async () => {
      handledCount += 1;
    });

    const changed = observeNodeOutputMaterialChange({
      projectDb,
      taskId,
      source: "runtime_session",
      rawOutput: "Plan step started\nWorking..."
    });
    assert.equal(changed.materialChanged, true);
    if (changed.materialChanged) {
      recordEvent({
        projectId,
        taskId,
        eventType: "task.output.material_changed",
        payload: {
          source: changed.source,
          outputHash: changed.outputHash,
          previousOutputHash: changed.previousOutputHash
        },
        database: projectDb
      });
    }

    await runOrchestrationJobQueuePassForTests();
    await new Promise((resolve) => setTimeout(resolve, 1_750));
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
    registerOrchestrationJobHandler("task_queue_dispatch", async () => {
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

    let readinessCount = 0;
    let reviewCount = 0;
    registerOrchestrationJobHandler("evaluate_readiness", async () => {
      readinessCount += 1;
    });
    registerOrchestrationJobHandler("re_review", async () => {
      reviewCount += 1;
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
    assert.equal(readinessCount > 0, true);
    assert.equal(reviewCount > 0, true);

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

  test("start triggers runtime session for non-exec and extract surfaces YAML proposed children", async () => {
    const userId = createUser();
    const basePath = randomPath("runtime-decompose-session");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Runtime Plan Node",
      mode: "plan",
      status: "queued"
    });

    const plan = projectDb.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(planId) as { workspace_path: string };
    fs.mkdirSync(plan.workspace_path, { recursive: true });
    runGit(["init", "-b", "main"], plan.workspace_path);
    runGit(["config", "user.email", "tests@example.com"], plan.workspace_path);
    runGit(["config", "user.name", "Tests"], plan.workspace_path);
    fs.writeFileSync(path.join(plan.workspace_path, "README.md"), "runtime decomposition workspace\n", "utf8");
    runGit(["add", "."], plan.workspace_path);
    runGit(["commit", "-m", "init"], plan.workspace_path);
    runGit(["checkout", "-b", `task/${planId}`], plan.workspace_path);

    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "phase" }),
      nowIso(),
      planId
    );

    const started = await startNode({ userId, nodeId: planId, autoMode: true });
    assert.equal(started.tier, "phase");

    const sessionId = await waitForLatestSessionId(projectDb, planId);
    const runtimeYaml = [
      "```yaml",
      "tasks:",
      "  - id: build_exec",
      "    title: Build execution task",
      "    prompt: Implement execution behavior",
      "  - id: follow_up_plan",
      "    item_type: sub_plan",
      "    title: Follow-up plan",
      "    prompt: Plan remaining work",
      "    depends_on: [build_exec]",
      "```",
      ""
    ].join("\n");
    projectDb.prepare("UPDATE task_sessions SET last_output = ?, last_heartbeat_at = ? WHERE id = ?").run(runtimeYaml, nowIso(), sessionId);

    const extracted = await extractPlan({ userId, planId });
    assert.equal(extracted.ok, true);
    assert.equal(extracted.source, "session_output");
    assert.equal(extracted.tasksExtracted, 2);

    const planArtifact = path.join(plan.workspace_path, ".ai-plan", "latest-plan.yaml");
    assert.equal(fs.existsSync(planArtifact), true);
    const artifactYaml = fs.readFileSync(planArtifact, "utf8");
    assert.equal(artifactYaml.includes("id: build_exec"), true);
    assert.equal(artifactYaml.includes("id: follow_up_plan"), true);

    const reviewed = await reviewPlan({ userId, planId });
    const proposed = reviewed.revisions.find((revision: { status: string }) => revision.status === "proposed");
    assert.ok(proposed);
    assert.deepEqual(
      proposed.items.map((item: { itemKey: string }) => item.itemKey),
      ["build_exec", "follow_up_plan"]
    );

    const manualStartEvent = projectDb
      .prepare("SELECT event_type FROM events WHERE task_id = ? AND event_type = 'orchestration.manual_start' LIMIT 1")
      .get(planId) as { event_type: string } | undefined;
    assert.equal(manualStartEvent?.event_type, "orchestration.manual_start");
  });

  test("approve creates children from extracted YAML without mirrored placeholder children", async () => {
    const userId = createUser();
    const basePath = randomPath("runtime-approve-children");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Approve Plan Node",
      mode: "plan",
      status: "queued"
    });
    const plan = projectDb.prepare("SELECT workspace_path FROM tasks WHERE id = ?").get(planId) as { workspace_path: string };
    fs.mkdirSync(plan.workspace_path, { recursive: true });
    runGit(["init", "-b", "main"], plan.workspace_path);
    runGit(["config", "user.email", "tests@example.com"], plan.workspace_path);
    runGit(["config", "user.name", "Tests"], plan.workspace_path);
    fs.writeFileSync(path.join(plan.workspace_path, "README.md"), "approve flow workspace\n", "utf8");
    runGit(["add", "."], plan.workspace_path);
    runGit(["commit", "-m", "init"], plan.workspace_path);
    runGit(["checkout", "-b", `task/${planId}`], plan.workspace_path);

    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "phase" }),
      nowIso(),
      planId
    );

    await startNode({ userId, nodeId: planId, autoMode: true });
    const sessionId = await waitForLatestSessionId(projectDb, planId);
    const runtimeYaml = [
      "```yaml",
      "tasks:",
      "  - id: implement_feature",
      "    title: Implement feature",
      "    prompt: Build the feature",
      "  - id: validate_feature",
      "    title: Validate feature",
      "    prompt: Test the feature",
      "    depends_on: [implement_feature]",
      "```",
      ""
    ].join("\n");
    projectDb.prepare("UPDATE task_sessions SET last_output = ?, last_heartbeat_at = ? WHERE id = ?").run(runtimeYaml, nowIso(), sessionId);

    const extracted = await extractPlan({ userId, planId });
    assert.equal(extracted.ok, true);

    const reviewed = await reviewPlan({ userId, planId });
    const proposed = reviewed.revisions.find((revision: { status: string }) => revision.status === "proposed");
    assert.ok(proposed);

    const approved = await approvePlan({ userId, planId });
    assert.equal(approved.approvedTasks.length, 2);

    const children = projectDb
      .prepare(
        `SELECT source_plan_item_key, source_plan_revision_id
         FROM tasks
         WHERE parent_plan_task_id = ?
         ORDER BY created_at ASC`
      )
      .all(planId) as Array<{ source_plan_item_key: string | null; source_plan_revision_id: string | null }>;
    assert.equal(children.length, 2);
    assert.deepEqual(
      children.map((row) => row.source_plan_item_key),
      ["implement_feature", "validate_feature"]
    );
    assert.equal(children.every((row) => row.source_plan_revision_id === proposed.id), true);

    const mirroredPlaceholderCount = projectDb
      .prepare("SELECT COUNT(*) AS count FROM tasks WHERE parent_plan_task_id = ? AND source_plan_item_key IS NULL")
      .get(planId) as { count: number };
    assert.equal(mirroredPlaceholderCount.count, 0);
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

  test("re_review coalesces rapid completion bursts and re-evaluates unblocked dependents", async () => {
    const userId = createUser();
    const basePath = randomPath("re-review-burst");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const blockerId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Burst Blocker",
      mode: "execution",
      status: "in_progress"
    });
    const dependentId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Burst Dependent",
      mode: "execution",
      status: "queued"
    });
    projectDb
      .prepare("INSERT INTO task_dependencies (task_id, dependency_task_id, created_at) VALUES (?, ?, ?)")
      .run(dependentId, blockerId, nowIso());
    projectDb.prepare("UPDATE tasks SET status = 'merged', updated_at = ? WHERE id = ?").run(nowIso(), blockerId);

    for (let idx = 0; idx < 5; idx += 1) {
      recordEvent({
        projectId,
        taskId: blockerId,
        eventType: "task.status_changed",
        payload: {
          fromStatus: "in_progress",
          toStatus: "merged",
          reasonCode: "burst_completion"
        },
        database: projectDb
      });
    }

    await runOrchestrationJobQueuePassForTests();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await runOrchestrationJobQueuePassForTests();
    await runOrchestrationJobQueuePassForTests();

    const reReviewResult = await runReReviewForTask({
      projectDb,
      projectId,
      anchorTaskId: blockerId
    });
    assert.equal(reReviewResult.impactedTaskIds.includes(dependentId), true);

    const readinessEvent = projectDb
      .prepare(
        `SELECT payload
         FROM events
         WHERE task_id = ? AND event_type = 'orchestration.readiness.evaluated'
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(dependentId) as { payload: string } | undefined;
    assert.ok(readinessEvent?.payload);
    const readinessPayload = JSON.parse(readinessEvent?.payload ?? "{}");
    assert.equal(readinessPayload?.readiness?.blockers?.length ?? 1, 0);
  });

  test("delta_plan enforces max replan budget unless explicit override is set", async () => {
    const userId = createUser();
    const basePath = randomPath("delta-plan-budget");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Delta Plan Parent",
      mode: "plan",
      status: "awaiting_children"
    });
    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({
        schema_version: 1,
        tier: "plan",
        budgets: { max_replans: 1 }
      }),
      nowIso(),
      planId
    );

    insertTask({
      projectDb,
      projectId,
      userId,
      title: "Initial Failed Child",
      mode: "execution",
      status: "failed",
      parentPlanTaskId: planId
    });

    const first = await runDeltaPlanForTask({ projectDb, taskId: planId });
    assert.equal((first?.createdChildIds.length ?? 0) > 0, true);

    insertTask({
      projectDb,
      projectId,
      userId,
      title: "Second Failed Child",
      mode: "execution",
      status: "failed",
      parentPlanTaskId: planId
    });
    const second = await runDeltaPlanForTask({ projectDb, taskId: planId });
    assert.equal(second?.budgetExceeded, true);
    assert.equal(second?.createdChildIds.length, 0);

    const parentBeforeOverride = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(planId) as TaskRow;
    const parsed = JSON.parse(parentBeforeOverride.metadata_json ?? "{}");
    parsed.custom = {
      ...(parsed.custom ?? {}),
      replan_budget_override: true
    };
    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(parsed),
      nowIso(),
      planId
    );

    const third = await runDeltaPlanForTask({ projectDb, taskId: planId });
    assert.equal((third?.createdChildIds.length ?? 0) > 0, true);
    assert.equal(third?.budgetExceeded, false);
  });

  test("re_review triggers delta_plan from child completion changes without infinite replanning loops", async () => {
    const userId = createUser();
    const basePath = randomPath("re-review-delta");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Review Parent",
      mode: "plan",
      status: "awaiting_children"
    });
    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "plan", budgets: { max_replans: 3 } }),
      nowIso(),
      planId
    );
    const failedChildId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Review Failed Child",
      mode: "execution",
      status: "failed",
      parentPlanTaskId: planId
    });

    const firstReview = await runReReviewForTask({
      projectDb,
      projectId,
      anchorTaskId: failedChildId
    });
    assert.equal(firstReview.deltaPlanEnqueued.includes(planId), true);
    const firstDelta = await runDeltaPlanForTask({ projectDb, taskId: planId });
    assert.equal((firstDelta?.createdChildIds.length ?? 0) > 0, true);

    const secondReview = await runReReviewForTask({
      projectDb,
      projectId,
      anchorTaskId: failedChildId
    });
    assert.equal(secondReview.deltaPlanEnqueued.includes(planId), true);
    const secondDelta = await runDeltaPlanForTask({ projectDb, taskId: planId });
    assert.equal(secondDelta?.createdChildIds.length, 0);
  });

  test("synthesize persists summary and requirement-to-evidence coverage matrix artifacts", async () => {
    const userId = createUser();
    const basePath = randomPath("synthesize-artifacts");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Synthesis Parent",
      mode: "plan",
      status: "awaiting_children"
    });
    projectDb.prepare("UPDATE tasks SET task_prompt = ?, metadata_json = ?, updated_at = ? WHERE id = ?").run(
      "- Implement API endpoint\n- Add integration tests",
      JSON.stringify({ schema_version: 1, tier: "plan" }),
      nowIso(),
      planId
    );
    const childId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Implement API endpoint",
      mode: "execution",
      status: "merged",
      parentPlanTaskId: planId
    });
    projectDb.prepare("UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?").run(
      "Implemented API endpoint and request validation.",
      nowIso(),
      childId
    );

    const synth = await runSynthesizeForParent({
      projectDb,
      projectId,
      parentTaskId: planId
    });
    assert.ok(synth);
    assert.equal(synth?.artifact.template.id, "ip-09");
    assert.equal(Array.isArray(synth?.artifact.coverage_matrix), true);
    assert.equal((synth?.artifact.coverage_matrix.length ?? 0) >= 2, true);

    const eventRow = projectDb
      .prepare(
        `SELECT payload
         FROM events
         WHERE task_id = ? AND event_type = 'orchestration.synthesize.completed'
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(planId) as { payload: string } | undefined;
    assert.ok(eventRow?.payload);
    const payload = JSON.parse(eventRow?.payload ?? "{}");
    assert.equal(payload?.artifact?.summary?.length > 0, true);
    assert.equal(Array.isArray(payload?.artifact?.coverage_matrix), true);
    assert.equal(payload?.artifact?.coverage_matrix?.every((row: any) => typeof row?.requirement_id === "string"), true);
    assert.equal(
      payload?.artifact?.coverage_matrix?.every((row: any) => Array.isArray(row?.evidence)),
      true
    );

    const metadataRow = projectDb.prepare("SELECT metadata_json FROM tasks WHERE id = ?").get(planId) as { metadata_json: string | null };
    const metadata = JSON.parse(metadataRow.metadata_json ?? "{}");
    assert.equal(Boolean(metadata?.custom?.synthesis_artifact_event_id), true);
  });

  test("verify failure deterministically enqueues bounded delta work and records verdict artifact", async () => {
    const userId = createUser();
    const basePath = randomPath("verify-delta-loop");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;

    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Verify Parent",
      mode: "plan",
      status: "awaiting_children"
    });
    projectDb.prepare("UPDATE tasks SET task_prompt = ?, metadata_json = ?, updated_at = ? WHERE id = ?").run(
      "- deliver backend endpoint\n- include integration tests",
      JSON.stringify({ schema_version: 1, tier: "plan", budgets: { max_replans: 1 } }),
      nowIso(),
      planId
    );
    insertTask({
      projectDb,
      projectId,
      userId,
      title: "Only endpoint child",
      mode: "execution",
      status: "merged",
      parentPlanTaskId: planId
    });

    const first = await runVerifyForParent({
      projectDb,
      projectId,
      parentTaskId: planId
    });
    assert.ok(first);
    assert.equal(first?.artifact.template.id, "ip-10");
    assert.equal(first?.artifact.verdict, "fail");
    assert.equal(first?.artifact.delta_plan_enqueued, true);

    await runOrchestrationJobQueuePassForTests();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await runOrchestrationJobQueuePassForTests();
    await runOrchestrationJobQueuePassForTests();

    const second = await runVerifyForParent({
      projectDb,
      projectId,
      parentTaskId: planId
    });
    assert.ok(second);
    assert.equal(second?.artifact.verdict, "fail");
    assert.equal(typeof second?.artifact.budget_exhausted, "boolean");
    assert.equal(typeof second?.artifact.delta_plan_enqueued, "boolean");

    const latestVerify = projectDb
      .prepare(
        `SELECT payload
         FROM events
         WHERE task_id = ? AND event_type = 'orchestration.verify.completed'
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(planId) as { payload: string } | undefined;
    const verifyPayload = JSON.parse(latestVerify?.payload ?? "{}");
    assert.equal(verifyPayload?.artifact?.verdict, "fail");

    const metadataRow = projectDb.prepare("SELECT metadata_json FROM tasks WHERE id = ?").get(planId) as { metadata_json: string | null };
    const metadata = JSON.parse(metadataRow.metadata_json ?? "{}");
    assert.equal(metadata?.lifecycle?.synthesis_passed, true);
    assert.equal(metadata?.lifecycle?.verification_passed, false);
    assert.equal(metadata?.custom?.verification_verdict, "fail");
  });

  test("orchestration hierarchy and dependency graph endpoints provide cross-tier navigation data", async () => {
    const userId = createUser();
    const basePath = randomPath("hierarchy-api");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    const now = nowIso();

    const epochId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Epoch",
      mode: "plan",
      status: "queued"
    });
    const phaseId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Phase",
      mode: "plan",
      status: "queued",
      parentPlanTaskId: epochId
    });
    const planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Plan",
      mode: "plan",
      status: "queued",
      parentPlanTaskId: phaseId
    });
    const taskTierId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Task Tier",
      mode: "execution",
      status: "queued",
      parentPlanTaskId: planId
    });
    const execId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Exec Tier",
      mode: "execution",
      status: "queued",
      parentPlanTaskId: taskTierId
    });

    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "epoch", custom: { auto_mode: true } }),
      now,
      epochId
    );
    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "phase", custom: { auto_mode: true } }),
      now,
      phaseId
    );
    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "plan", budgets: { max_replans: 3 } }),
      now,
      planId
    );
    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({
        schema_version: 1,
        tier: "task",
        dependencies: { cross_tier: [{ id: planId, tier: "plan", reason: "await_parent_plan" }] }
      }),
      now,
      taskTierId
    );
    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({
        schema_version: 1,
        tier: "exec",
        dependencies: { same_tier: [{ id: taskTierId, tier: "task", reason: "await_task_tier" }] }
      }),
      now,
      execId
    );
    projectDb.prepare("INSERT INTO task_dependencies (task_id, dependency_task_id, created_at) VALUES (?, ?, ?)").run(
      execId,
      taskTierId,
      now
    );

    const app = createApp();
    const localServer = app.listen(0);
    const localAddress = localServer.address();
    if (!localAddress || typeof localAddress === "string") {
      throw new Error("Failed to start test server");
    }
    const localBaseUrl = `http://127.0.0.1:${localAddress.port}`;
    const localCallApi = (pathname: string, options?: { method?: string; body?: unknown; userId?: string }) =>
      callApiAt(localBaseUrl, pathname, options);

    try {
      const hierarchy = await localCallApi(`/api/projects/${projectId}/hierarchy`, { userId });
      assert.equal(hierarchy.status, 200);
      assert.equal(hierarchy.json?.hierarchy?.roots?.length, 1);
      assert.equal(Array.isArray(hierarchy.json?.hierarchy?.nodes), true);
      assert.equal(hierarchy.json?.hierarchy?.roots?.[0]?.tier, "epoch");
      assert.equal(hierarchy.json?.hierarchy?.roots?.[0]?.children?.[0]?.tier, "phase");
      assert.equal(hierarchy.json?.hierarchy?.roots?.[0]?.children?.[0]?.children?.[0]?.tier, "plan");
      assert.equal(hierarchy.json?.hierarchy?.roots?.[0]?.children?.[0]?.children?.[0]?.children?.[0]?.tier, "task");
      assert.equal(
        hierarchy.json?.hierarchy?.roots?.[0]?.children?.[0]?.children?.[0]?.children?.[0]?.children?.[0]?.tier,
        "exec"
      );
      assert.equal(typeof hierarchy.json?.hierarchy?.roots?.[0]?.task?.orchestrationControls?.replan?.iterationsUsed, "number");
      const execHierarchyNode = (hierarchy.json?.hierarchy?.nodes ?? []).find((node: any) => node.task?.id === execId);
      assert.equal(execHierarchyNode?.tier, "exec");
      assert.equal(Array.isArray(execHierarchyNode?.waiting?.unresolvedDependencyDetails), true);
      assert.equal(execHierarchyNode?.waiting?.unresolvedDependencyDetails?.[0]?.id, taskTierId);
      assert.equal(execHierarchyNode?.waiting?.unresolvedDependencyDetails?.[0]?.tier, "task");
      assert.equal(execHierarchyNode?.waiting?.unresolvedDependencyDetails?.[0]?.reason, "await_task_tier");

      const graph = await localCallApi(`/api/projects/${projectId}/dependency-graph`, { userId });
      assert.equal(graph.status, 200);
      assert.equal(Array.isArray(graph.json?.graph?.nodes), true);
      assert.equal(Array.isArray(graph.json?.graph?.edges), true);
      const graphExecNode = (graph.json?.graph?.nodes ?? []).find((node: any) => node.id === execId);
      assert.equal(graphExecNode?.tier, "exec");
      assert.equal(graphExecNode?.mode, "execution");
      assert.equal(typeof graphExecNode?.dependencyCount, "number");
      assert.equal(
        graph.json?.graph?.edges?.some((edge: any) => edge.fromId === execId && edge.toId === taskTierId && edge.reason === "await_task_tier"),
        true
      );

      const nodeDetails = await localCallApi(`/api/nodes/${execId}`, { userId });
      assert.equal(nodeDetails.status, 200);
      assert.equal(nodeDetails.json?.node?.id, execId);
      assert.equal(nodeDetails.json?.dependencyDiagnostics?.node?.tier, "exec");
      assert.equal(Array.isArray(nodeDetails.json?.children), true);
    } finally {
      await new Promise<void>((resolve) => {
        localServer.close(() => resolve());
      });
    }
  });

  test("tasks and hierarchy endpoints preserve shared node ordering for epoch->phase->plan->task hierarchies", async () => {
    const userId = createUser();
    const basePath = randomPath("hierarchy-order-parity");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    const tiedTimestamp = "2026-02-27T00:00:00.000Z";

    const chainA = {
      epochId: insertTask({ projectDb, projectId, userId, title: "A Epoch", mode: "plan", status: "queued" }),
      phaseId: "",
      planId: "",
      taskId: ""
    };
    chainA.phaseId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "A Phase",
      mode: "plan",
      status: "queued",
      parentPlanTaskId: chainA.epochId
    });
    chainA.planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "A Plan",
      mode: "plan",
      status: "queued",
      parentPlanTaskId: chainA.phaseId
    });
    chainA.taskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "A Task",
      mode: "execution",
      status: "queued",
      parentPlanTaskId: chainA.planId
    });

    const chainB = {
      epochId: insertTask({ projectDb, projectId, userId, title: "B Epoch", mode: "plan", status: "queued" }),
      phaseId: "",
      planId: "",
      taskId: ""
    };
    chainB.phaseId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "B Phase",
      mode: "plan",
      status: "queued",
      parentPlanTaskId: chainB.epochId
    });
    chainB.planId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "B Plan",
      mode: "plan",
      status: "queued",
      parentPlanTaskId: chainB.phaseId
    });
    chainB.taskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "B Task",
      mode: "execution",
      status: "queued",
      parentPlanTaskId: chainB.planId
    });

    const tierById = new Map<string, "epoch" | "phase" | "plan" | "task">([
      [chainA.epochId, "epoch"],
      [chainA.phaseId, "phase"],
      [chainA.planId, "plan"],
      [chainA.taskId, "task"],
      [chainB.epochId, "epoch"],
      [chainB.phaseId, "phase"],
      [chainB.planId, "plan"],
      [chainB.taskId, "task"]
    ]);
    for (const [taskId, tier] of tierById.entries()) {
      projectDb.prepare("UPDATE tasks SET metadata_json = ?, created_at = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify({ schema_version: 1, tier }),
        tiedTimestamp,
        tiedTimestamp,
        taskId
      );
    }

    const tasksResponse = await callApi(`/api/projects/${projectId}/tasks`, { userId });
    assert.equal(tasksResponse.status, 200);
    const taskListIds = (tasksResponse.json?.tasks ?? []).map((task: any) => task.id);
    assert.equal(taskListIds.length, 2);
    assert.deepEqual(new Set(taskListIds), new Set([chainA.epochId, chainB.epochId]));

    const hierarchyResponse = await callApi(`/api/projects/${projectId}/hierarchy`, { userId });
    assert.equal(hierarchyResponse.status, 200);
    const hierarchyRootIds = (hierarchyResponse.json?.hierarchy?.roots ?? []).map((node: any) => node.task.id);
    assert.deepEqual(hierarchyRootIds, taskListIds);

    const chainByRootId = new Map<string, { epochId: string; phaseId: string; planId: string; taskId: string }>([
      [chainA.epochId, chainA],
      [chainB.epochId, chainB]
    ]);
    const flattenHierarchy = (nodes: any[]): string[] => nodes.flatMap((node) => [node.task.id, ...flattenHierarchy(node.children ?? [])]);
    const hierarchyDfsIds = flattenHierarchy(hierarchyResponse.json?.hierarchy?.roots ?? []);
    const expectedHierarchyDfsIds = taskListIds.flatMap((rootId: string) => {
      const chain = chainByRootId.get(rootId);
      if (!chain) throw new Error(`Missing chain for root ${rootId}`);
      return [chain.epochId, chain.phaseId, chain.planId, chain.taskId];
    });
    assert.deepEqual(hierarchyDfsIds, expectedHierarchyDfsIds);

    const hierarchyNodeIds = (hierarchyResponse.json?.hierarchy?.nodes ?? []).map((node: any) => node.task.id);
    const sharedIdsFromHierarchyNodes = hierarchyNodeIds.filter((id: string) => taskListIds.includes(id));
    assert.deepEqual(sharedIdsFromHierarchyNodes, taskListIds);
  });

  test("manual orchestration override actions validate input and are audited", async () => {
    const userId = createUser();
    const basePath = randomPath("override-actions");
    const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    const nodeId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Override Node",
      mode: "plan",
      status: "queued"
    });
    projectDb.prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ schema_version: 1, tier: "plan", budgets: { max_replans: 1 } }),
      nowIso(),
      nodeId
    );

    const app = createApp();
    const localServer = app.listen(0);
    const localAddress = localServer.address();
    if (!localAddress || typeof localAddress === "string") {
      throw new Error("Failed to start test server");
    }
    const localBaseUrl = `http://127.0.0.1:${localAddress.port}`;
    const localCallApi = (pathname: string, options?: { method?: string; body?: unknown; userId?: string }) =>
      callApiAt(localBaseUrl, pathname, options);

    try {
      const invalidAutoMode = await localCallApi(`/api/nodes/${nodeId}/auto-mode`, {
        method: "POST",
        userId,
        body: {}
      });
      assert.equal(invalidAutoMode.status, 400);

      const autoMode = await localCallApi(`/api/nodes/${nodeId}/auto-mode`, {
        method: "POST",
        userId,
        body: { enabled: false }
      });
      assert.equal(autoMode.status, 200);
      assert.equal(autoMode.json?.node?.orchestrationControls?.autoMode, false);

      const autoMerge = await localCallApi(`/api/nodes/${nodeId}/auto-merge`, {
        method: "POST",
        userId,
        body: { enabled: true, onComplete: true }
      });
      assert.equal(autoMerge.status, 200);
      assert.equal(autoMerge.json?.node?.autoMergeOnComplete, true);

      const budgetOverride = await localCallApi(`/api/nodes/${nodeId}/approve-budget-override`, {
        method: "POST",
        userId,
        body: { reason: "human approved" }
      });
      assert.equal(budgetOverride.status, 200);
      assert.equal(budgetOverride.json?.node?.orchestrationControls?.replan?.budgetOverride, true);

      const forceReReview = await localCallApi(`/api/nodes/${nodeId}/force-re-review`, {
        method: "POST",
        userId,
        body: { reason: "manual retry" }
      });
      assert.equal(forceReReview.status, 202);
      assert.equal(Boolean(forceReReview.json?.pendingEventId), true);

      const startNode = await localCallApi(`/api/nodes/${nodeId}/start`, {
        method: "POST",
        userId,
        body: { autoMode: true }
      });
      assert.equal(startNode.status, 200);
      assert.equal(startNode.json?.started, true);
      assert.equal(startNode.json?.tier, "plan");

      const auditTypes = (
        projectDb
          .prepare("SELECT event_type FROM events WHERE task_id = ? ORDER BY created_at ASC")
          .all(nodeId) as Array<{ event_type: string }>
      ).map((row) => row.event_type);
      assert.equal(auditTypes.includes("orchestration.override.auto_mode"), true);
      assert.equal(auditTypes.includes("orchestration.override.auto_merge"), true);
      assert.equal(auditTypes.includes("orchestration.override.replan_budget"), true);
      assert.equal(auditTypes.includes("orchestration.override.force_re_review"), true);
      assert.equal(auditTypes.includes("orchestration.manual_start"), true);
    } finally {
      await new Promise<void>((resolve) => {
        localServer.close(() => resolve());
      });
    }
  });

  test("compatibility mode env no longer disables orchestration endpoints", async () => {
    const previousCompatibility = process.env.ORCHESTRATION_COMPATIBILITY_MODE;
    process.env.ORCHESTRATION_COMPATIBILITY_MODE = "1";
    try {
      const userId = createUser();
      const basePath = randomPath("compat-mode");
      const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
      const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
      const taskId = insertTask({
        projectDb,
        projectId,
        userId,
        title: "Compatibility Task",
        mode: "execution",
        status: "queued"
      });

      const app = createApp();
      const localServer = app.listen(0);
      const localAddress = localServer.address();
      if (!localAddress || typeof localAddress === "string") {
        throw new Error("Failed to start test server");
      }
      const localBaseUrl = `http://127.0.0.1:${localAddress.port}`;
      const localCallApi = (pathname: string, options?: { method?: string; body?: unknown; userId?: string }) =>
        callApiAt(localBaseUrl, pathname, options);

      try {
        const listTasks = await localCallApi(`/api/projects/${projectId}/tasks`, { userId });
        assert.equal(listTasks.status, 200);
        assert.equal(Array.isArray(listTasks.json?.tasks), true);

        const taskDetails = await localCallApi(`/api/tasks/${taskId}`, { userId });
        assert.equal(taskDetails.status, 200);
        assert.equal(taskDetails.json?.task?.id, taskId);

        const hierarchy = await localCallApi(`/api/projects/${projectId}/hierarchy`, { userId });
        assert.equal(hierarchy.status, 200);
        assert.equal(Array.isArray(hierarchy.json?.hierarchy?.nodes), true);

        const nodeStart = await localCallApi(`/api/nodes/${taskId}/start`, {
          method: "POST",
          userId,
          body: {}
        });
        assert.equal(nodeStart.status, 200);
        assert.equal(nodeStart.json?.started, true);
      } finally {
        await new Promise<void>((resolve) => {
          localServer.close(() => resolve());
        });
      }
    } finally {
      process.env.ORCHESTRATION_COMPATIBILITY_MODE = previousCompatibility;
    }
  });

  test("hierarchy/action env flags no longer disable orchestration APIs", async () => {
    const previousHierarchy = process.env.ORCHESTRATION_HIERARCHY_API_ENABLED;
    const previousActions = process.env.ORCHESTRATION_ACTIONS_API_ENABLED;
    const previousCompatibility = process.env.ORCHESTRATION_COMPATIBILITY_MODE;
    process.env.ORCHESTRATION_COMPATIBILITY_MODE = "0";
    process.env.ORCHESTRATION_HIERARCHY_API_ENABLED = "false";
    process.env.ORCHESTRATION_ACTIONS_API_ENABLED = "false";
    try {
      const userId = createUser();
      const basePath = randomPath("flag-disable");
      const projectId = createProject({ userId, basePath, cloneStatus: "ready" });
      const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
      const taskId = insertTask({
        projectDb,
        projectId,
        userId,
        title: "Flagged Node",
        mode: "plan",
        status: "queued"
      });

      const app = createApp();
      const localServer = app.listen(0);
      const localAddress = localServer.address();
      if (!localAddress || typeof localAddress === "string") {
        throw new Error("Failed to start test server");
      }
      const localBaseUrl = `http://127.0.0.1:${localAddress.port}`;
      const localCallApi = (pathname: string, options?: { method?: string; body?: unknown; userId?: string }) =>
        callApiAt(localBaseUrl, pathname, options);

      try {
        const nodeDetails = await localCallApi(`/api/nodes/${taskId}`, { userId });
        assert.equal(nodeDetails.status, 200);
        assert.equal(nodeDetails.json?.node?.id, taskId);

        const graph = await localCallApi(`/api/projects/${projectId}/dependency-graph`, { userId });
        assert.equal(graph.status, 200);
        assert.equal(Array.isArray(graph.json?.graph?.nodes), true);

        const toggleAutoMode = await localCallApi(`/api/nodes/${taskId}/auto-mode`, {
          method: "POST",
          userId,
          body: { enabled: false }
        });
        assert.equal(toggleAutoMode.status, 200);
        assert.equal(toggleAutoMode.json?.node?.id, taskId);

        const taskDetails = await localCallApi(`/api/tasks/${taskId}`, { userId });
        assert.equal(taskDetails.status, 200);
        assert.equal(taskDetails.json?.task?.id, taskId);
      } finally {
        await new Promise<void>((resolve) => {
          localServer.close(() => resolve());
        });
      }
    } finally {
      process.env.ORCHESTRATION_COMPATIBILITY_MODE = previousCompatibility;
      process.env.ORCHESTRATION_HIERARCHY_API_ENABLED = previousHierarchy;
      process.env.ORCHESTRATION_ACTIONS_API_ENABLED = previousActions;
    }
  });
});
