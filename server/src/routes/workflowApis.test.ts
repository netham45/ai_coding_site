import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type Database from "better-sqlite3";
import { createApp } from "../app.js";
import { db as appDb, closeAllProjectDbs, ensureProjectDb } from "../db/index.js";
import { nowIso } from "../utils/time.js";

type ApiResponse = {
  status: number;
  json: any;
  text: string;
};

let server: http.Server;
let apiBaseUrl = "";

function randomPath(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ai-coding-site-${prefix}-`));
}

function createUser(userId = randomUUID()): string {
  const now = nowIso();
  appDb
    .prepare("INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(userId, `${userId}@example.com`, `user-${userId.slice(0, 8)}`, now, now);
  appDb
    .prepare("INSERT INTO user_settings (user_id, default_ai_command, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(userId, "codex --yolo {prompt}", now, now);
  return userId;
}

function createProject(params: { userId: string; basePath: string }): string {
  const now = nowIso();
  const projectId = randomUUID();
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
      "ready",
      params.userId,
      now,
      now
    );
  appDb.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
    projectId,
    params.userId,
    now
  );
  return projectId;
}

function insertTask(params: {
  projectDb: Database.Database;
  projectId: string;
  userId: string;
  title: string;
  status: string;
}): string {
  const taskId = randomUUID();
  const now = nowIso();
  params.projectDb
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
      params.projectId,
      params.title,
      "prompt",
      "",
      "effective prompt",
      "codex --yolo {prompt}",
      0,
      "execution",
      params.status,
      randomPath("workflow-task"),
      "abc123",
      params.userId,
      now,
      now
    );
  return taskId;
}

async function callApi(pathname: string, options?: { method?: string; body?: unknown; userId?: string }): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) headers["content-type"] = "application/json";
  if (options?.userId) headers["x-user-id"] = options.userId;
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
  return { status: response.status, json, text };
}

describe("workflow APIs", () => {
  before(() => {
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("definitions CRUD and run start/tick/cancel return full run stage state", async () => {
    const userId = createUser();
    const basePath = randomPath("workflow-api-crud");
    const projectId = createProject({ userId, basePath });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    const taskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Workflow Node",
      status: "queued"
    });

    const createDefinition = await callApi(`/api/projects/${projectId}/workflow-definitions`, {
      method: "POST",
      userId,
      body: {
        name: "release",
        version: 1,
        definitionYaml: "version: 1\nstages:\n  - id: build\n  - id: verify\n    depends_on: [build]"
      }
    });
    assert.equal(createDefinition.status, 201);
    const definitionId = createDefinition.json?.definition?.id as string;
    assert.equal(createDefinition.json?.definition?.name, "release");

    const patchDefinition = await callApi(`/api/projects/${projectId}/workflow-definitions/${definitionId}`, {
      method: "PATCH",
      userId,
      body: { version: 2 }
    });
    assert.equal(patchDefinition.status, 200);
    assert.equal(patchDefinition.json?.definition?.version, 2);

    const startRun = await callApi(`/api/projects/${projectId}/workflow-runs/start`, {
      method: "POST",
      userId,
      body: { workflowDefinitionId: definitionId, taskId }
    });
    assert.equal(startRun.status, 201);
    assert.equal(startRun.json?.workflow?.run?.status, "running");
    assert.equal(Array.isArray(startRun.json?.workflow?.stages), true);
    assert.equal(startRun.json?.workflow?.stages?.length, 2);
    assert.equal(typeof startRun.json?.workflow?.stages?.[0]?.diagnostics?.attemptsStarted, "number");

    const runId = startRun.json?.workflow?.run?.id as string;
    const tickRun = await callApi(`/api/projects/${projectId}/workflow-runs/${runId}/tick`, {
      method: "POST",
      userId
    });
    assert.equal(tickRun.status, 200);
    assert.equal(typeof tickRun.json?.progressed, "boolean");
    assert.equal(Array.isArray(tickRun.json?.workflow?.events), true);

    const cancelRun = await callApi(`/api/projects/${projectId}/workflow-runs/${runId}/cancel`, {
      method: "POST",
      userId,
      body: { reason: "manual stop" }
    });
    assert.equal(cancelRun.status, 200);
    assert.equal(cancelRun.json?.workflow?.run?.status, "cancelled");
    assert.equal(cancelRun.json?.workflow?.stages?.[0]?.status, "cancelled");

    const deleteDefinition = await callApi(`/api/projects/${projectId}/workflow-definitions/${definitionId}`, {
      method: "DELETE",
      userId
    });
    assert.equal(deleteDefinition.status, 200);
    assert.equal(deleteDefinition.json?.ok, true);
  });

  test("node workflow status exposes latest workflow diagnostics", async () => {
    const userId = createUser();
    const basePath = randomPath("workflow-api-node-status");
    const projectId = createProject({ userId, basePath });
    const projectDb = ensureProjectDb({ projectId, basePath, initializeIfMissing: true }).db;
    const taskId = insertTask({
      projectDb,
      projectId,
      userId,
      title: "Node With Workflow",
      status: "queued"
    });

    const beforeRun = await callApi(`/api/nodes/${taskId}/workflow-status`, { userId });
    assert.equal(beforeRun.status, 200);
    assert.equal(beforeRun.json?.workflow, null);

    const createDefinition = await callApi(`/api/projects/${projectId}/workflow-definitions`, {
      method: "POST",
      userId,
      body: {
        name: "single-stage",
        version: 1,
        definitionYaml: "version: 1\nstages:\n  - id: execute"
      }
    });
    assert.equal(createDefinition.status, 201);

    const startRun = await callApi(`/api/projects/${projectId}/workflow-runs/start`, {
      method: "POST",
      userId,
      body: {
        workflowDefinitionId: createDefinition.json?.definition?.id,
        taskId
      }
    });
    assert.equal(startRun.status, 201);

    const status = await callApi(`/api/nodes/${taskId}/workflow-status`, { userId });
    assert.equal(status.status, 200);
    assert.equal(status.json?.nodeId, taskId);
    assert.equal(status.json?.workflow?.run?.taskId, taskId);
    assert.equal(Array.isArray(status.json?.workflow?.stages), true);
    assert.equal(typeof status.json?.workflow?.stages?.[0]?.diagnostics?.attemptsStarted, "number");
  });
});
