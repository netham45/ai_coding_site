import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { z } from "zod";
import { db } from "../db/index.js";
import { recordEvent } from "../services/events.js";
import {
  cloneLocalBaseToWorkspace,
  createTaskBranch,
  getHeadCommitSha,
  getWorkspaceGitStatus,
  mergeTaskWorkspaceIntoTarget,
  pullRemoteRefIntoTaskWorkspace,
  taskBranchName
} from "../services/git.js";
import { ideSessionRunning, ideSessionTarget, prepareIdeWorkspace, startIdeSession, stopIdeSession } from "../services/ide.js";
import { kickTaskQueueProcessing } from "../services/queue.js";
import { sendTaskRuntimeInput, startTaskRuntime, stopTaskRuntime } from "../services/runtime.js";
import { issueTerminalToken } from "../services/terminalToken.js";
import { buildEffectivePrompt } from "../services/promptBuilder.js";
import type { IdeInstanceRow, MergeRecordRow, ProjectRow, TaskRow, TaskSessionRow, TaskStatus, TaskTransitionRow } from "../types.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

const createTaskSchema = z.object({
  title: z.string().min(2).max(160),
  taskPrompt: z.string().min(1).max(12000),
  aiCommand: z.string().min(1).max(500).optional(),
  autoMerge: z.boolean().optional(),
  dependencyTaskIds: z.array(z.string().uuid()).max(200).optional()
});

const patchTaskSchema = z.object({
  aiCommand: z.string().min(1).max(500).optional()
});

const inputSchema = z.object({
  text: z.string().min(1).max(20000)
});

const cancelTaskSchema = z.object({
  reason: z.string().min(1).max(1000)
});

const mergeLocks = new Set<string>();

function isSafeTaskWorkspacePath(workspacePath: string, projectBasePath: string): boolean {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const projectTasksRoot = path.resolve(path.dirname(projectBasePath), "tasks");
  const relative = path.relative(projectTasksRoot, resolvedWorkspacePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function projectForUser(projectId: string, userId: string): ProjectRow | undefined {
  return db
    .prepare(
      `SELECT p.*
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE p.id = ? AND pm.user_id = ?`
    )
    .get(projectId, userId) as ProjectRow | undefined;
}

function taskForUser(taskId: string, userId: string): TaskRow | undefined {
  return db
    .prepare(
      `SELECT t.*
       FROM tasks t
       JOIN project_members pm ON pm.project_id = t.project_id
       WHERE t.id = ? AND pm.user_id = ?`
    )
    .get(taskId, userId) as TaskRow | undefined;
}

function parentPlanTaskForUser(task: TaskRow, userId: string): TaskRow | undefined {
  if (!task.parent_plan_task_id) {
    return undefined;
  }
  return db
    .prepare(
      `SELECT t.*
       FROM tasks t
       JOIN project_members pm ON pm.project_id = t.project_id
       WHERE t.id = ? AND pm.user_id = ? AND t.mode = 'plan'`
    )
    .get(task.parent_plan_task_id, userId) as TaskRow | undefined;
}

type TaskGitTopology = {
  sourceRepoPath: string;
  sourceBranch: string;
  pullRemoteRef: string;
  mergeTargetPath: string;
  mergeTargetBranch: string;
  syncMergeTargetFromOrigin: boolean;
  mergeLockKey: string;
};

function resolveTaskGitTopology(params: { task: TaskRow; project: ProjectRow; parentPlanTask?: TaskRow | undefined }): TaskGitTopology {
  if (params.task.parent_plan_task_id) {
    const parentPlan = params.parentPlanTask;
    if (!parentPlan) {
      throw new Error("Parent plan task not found");
    }
    const planBranch = taskBranchName(parentPlan.id);
    return {
      sourceRepoPath: parentPlan.workspace_path,
      sourceBranch: planBranch,
      pullRemoteRef: planBranch,
      mergeTargetPath: parentPlan.workspace_path,
      mergeTargetBranch: planBranch,
      syncMergeTargetFromOrigin: false,
      mergeLockKey: `repo:${path.resolve(parentPlan.workspace_path)}`
    };
  }

  return {
    sourceRepoPath: params.project.base_path,
    sourceBranch: params.project.default_branch,
    pullRemoteRef: params.project.default_branch,
    mergeTargetPath: params.project.base_path,
    mergeTargetBranch: params.project.default_branch,
    syncMergeTargetFromOrigin: true,
    mergeLockKey: `repo:${path.resolve(params.project.base_path)}`
  };
}

function latestSession(taskId: string): TaskSessionRow | undefined {
  return db
    .prepare("SELECT * FROM task_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(taskId) as TaskSessionRow | undefined;
}

function activeSessions(taskId: string): TaskSessionRow[] {
  return db
    .prepare("SELECT * FROM task_sessions WHERE task_id = ? AND status IN ('starting','running','waiting_input')")
    .all(taskId) as TaskSessionRow[];
}

function latestIde(taskId: string): IdeInstanceRow | undefined {
  return db
    .prepare("SELECT * FROM ide_instances WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT 1")
    .get(taskId) as IdeInstanceRow | undefined;
}

function serializeTask(task: TaskRow) {
  const dependencyTaskIds = db
    .prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
    .all(task.id) as Array<{ dependency_task_id: string }>;
  const blockedByTaskIds = db
    .prepare(
      `SELECT td.dependency_task_id
       FROM task_dependencies td
       JOIN tasks dep ON dep.id = td.dependency_task_id
       WHERE td.task_id = ? AND dep.status != 'merged'
       ORDER BY dep.created_at ASC`
    )
    .all(task.id) as Array<{ dependency_task_id: string }>;

  return {
    id: task.id,
    projectId: task.project_id,
    title: task.title,
    taskPrompt: task.task_prompt,
    result: task.result,
    effectivePrompt: task.effective_prompt,
    aiCommand: task.ai_command,
    autoMerge: Boolean(task.auto_merge),
    mode: task.mode,
    parentPlanTaskId: task.parent_plan_task_id,
    sourcePlanRevisionId: task.source_plan_revision_id,
    sourcePlanItemKey: task.source_plan_item_key,
    status: task.status,
    workspacePath: task.workspace_path,
    baseCommitShaAtCreate: task.base_commit_sha_at_create,
    headCommitSha: task.head_commit_sha,
    cancelReason: task.cancel_reason,
    mergedAt: task.merged_at,
    mergedByUserId: task.merged_by_user_id,
    dependencyTaskIds: dependencyTaskIds.map((x) => x.dependency_task_id),
    blockedByTaskIds: blockedByTaskIds.map((x) => x.dependency_task_id),
    isBlocked: task.status === "queued" && blockedByTaskIds.length > 0,
    createdByUserId: task.created_by_user_id,
    createdAt: task.created_at,
    updatedAt: task.updated_at
  };
}

function resolveTaskDependencies(params: { projectId: string; dependencyTaskIds: string[]; taskId?: string }): TaskRow[] {
  const unique = [...new Set(params.dependencyTaskIds)];
  if (unique.length !== params.dependencyTaskIds.length) {
    throw new Error("Duplicate dependency ids are not allowed");
  }
  if (params.taskId && unique.includes(params.taskId)) {
    throw new Error("A task cannot depend on itself");
  }
  if (unique.length === 0) {
    return [];
  }

  const placeholders = unique.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE project_id = ? AND id IN (${placeholders})`)
    .all(params.projectId, ...unique) as TaskRow[];
  if (rows.length !== unique.length) {
    throw new Error("One or more dependencies were not found in this project");
  }
  return rows;
}

function taskIsBlocked(taskId: string): boolean {
  const row = db
    .prepare(
      `SELECT td.task_id
       FROM task_dependencies td
       JOIN tasks dep ON dep.id = td.dependency_task_id
       WHERE td.task_id = ? AND dep.status != 'merged'
       LIMIT 1`
    )
    .get(taskId) as { task_id: string } | undefined;
  return Boolean(row?.task_id);
}

function serializeTransition(row: TaskTransitionRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at
  };
}

function serializeSession(session: TaskSessionRow | undefined) {
  if (!session) return null;
  return {
    id: session.id,
    taskId: session.task_id,
    tmuxSessionName: session.tmux_session_name,
    tmuxSocketPath: session.tmux_socket_path,
    paneId: session.pane_id,
    detectedTool: session.detected_tool,
    backendCommand: session.backend_command,
    status: session.status,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    lastHeartbeatAt: session.last_heartbeat_at,
    lastOutput: session.last_output,
    exitCode: session.exit_code,
    failureReason: session.failure_reason
  };
}

function serializeIde(row: IdeInstanceRow | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    provider: row.provider,
    url: row.url,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastHeartbeatAt: row.last_heartbeat_at
  };
}

function serializeMergeRecord(row: MergeRecordRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    sourceCommitSha: row.source_commit_sha,
    targetBaseCommitSha: row.target_base_commit_sha,
    mergeCommitSha: row.merge_commit_sha,
    status: row.status,
    conflictSummary: row.conflict_summary,
    errorMessage: row.error_message,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createIdeToken(): string {
  return randomBytes(24).toString("hex");
}

function issueIdeLaunchUrl(params: { taskId: string; ideId: string; folderPath?: string; workspacePath?: string }): string {
  const rawToken = createIdeToken();
  db.prepare("UPDATE ide_instances SET access_token_hash = ?, last_heartbeat_at = ? WHERE id = ?").run(
    hashToken(rawToken),
    nowIso(),
    params.ideId
  );
  const folderQuery = params.folderPath ? `&folder=${encodeURIComponent(params.folderPath)}` : "";
  const workspaceQuery = params.workspacePath ? `&workspace=${encodeURIComponent(params.workspacePath)}` : "";
  return `/api/tasks/${params.taskId}/ide/view?token=${encodeURIComponent(rawToken)}${workspaceQuery}${folderQuery}`;
}

async function buildIdeLaunchUrl(task: TaskRow, ideId: string): Promise<string> {
  try {
    const session = latestSession(task.id);
    const attachableSession = session && ["starting", "running", "waiting_input"].includes(session.status) ? session : null;
    const openPath = await prepareIdeWorkspace({
      taskId: task.id,
      workspacePath: task.workspace_path,
      tmuxSocketPath: attachableSession?.tmux_socket_path,
      tmuxSessionName: attachableSession?.tmux_session_name
    });
    if (openPath.endsWith(".code-workspace")) {
      return issueIdeLaunchUrl({ taskId: task.id, ideId, workspacePath: openPath });
    }
    return issueIdeLaunchUrl({ taskId: task.id, ideId, folderPath: openPath });
  } catch {
    // Fall back to direct folder launch if workspace file generation fails.
    return issueIdeLaunchUrl({ taskId: task.id, ideId, folderPath: task.workspace_path });
  }
}

function rewriteProxyLocation(params: { location: string; taskId: string; targetPort: number }): string {
  const proxyBase = `/api/tasks/${params.taskId}/ide/proxy`;
  const localPrefix = `http://127.0.0.1:${params.targetPort}`;
  if (params.location.startsWith(localPrefix)) {
    return `${proxyBase}${params.location.slice(localPrefix.length) || "/"}`;
  }
  if (params.location.startsWith("/")) {
    return `${proxyBase}${params.location}`;
  }
  return params.location;
}

function proxyIdeHttp(req: any, res: any, params: { taskId: string; targetPort: number }): void {
  const proxyBase = `/api/tasks/${params.taskId}/ide/proxy`;
  const host = req.headers.host || "localhost";
  const incoming = new URL(req.originalUrl || req.url, `http://${host}`);
  const upstreamPathname = incoming.pathname.startsWith(proxyBase) ? incoming.pathname.slice(proxyBase.length) || "/" : "/";
  const upstreamPath = `${upstreamPathname}${incoming.search}`;

  const requestHeaders = { ...req.headers };
  delete requestHeaders.connection;
  delete requestHeaders["content-length"];
  requestHeaders["x-forwarded-host"] = req.headers.host || "";
  requestHeaders["x-forwarded-proto"] = req.protocol || "http";
  requestHeaders["x-forwarded-for"] = req.ip || "";

  const upstreamReq = http.request(
    {
      hostname: "127.0.0.1",
      port: params.targetPort,
      method: req.method,
      path: upstreamPath,
      headers: requestHeaders
    },
    (upstreamRes) => {
      const headers = { ...upstreamRes.headers } as Record<string, string | string[] | undefined>;
      if (typeof headers.location === "string") {
        headers.location = rewriteProxyLocation({
          location: headers.location,
          taskId: params.taskId,
          targetPort: params.targetPort
        });
      }
      if (Array.isArray(headers.location) && headers.location.length > 0) {
        headers.location = headers.location.map((location) =>
          rewriteProxyLocation({
            location,
            taskId: params.taskId,
            targetPort: params.targetPort
          })
        );
      }
      res.status(upstreamRes.statusCode || 502);
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        res.setHeader(key, value as any);
      }
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on("error", (error) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `IDE proxy request failed: ${String(error.message || error)}` });
    } else {
      res.end();
    }
  });

  req.pipe(upstreamReq);
}

function resolveAiCommand(inputAiCommand: string | undefined, userId: string): string {
  if (inputAiCommand) {
    return inputAiCommand;
  }
  const settings = db
    .prepare("SELECT default_ai_command FROM user_settings WHERE user_id = ?")
    .get(userId) as { default_ai_command: string } | undefined;
  return settings?.default_ai_command || "codex --yolo {prompt}";
}

function recordTaskTransition(params: {
  taskId: string;
  fromStatus: string;
  toStatus: string;
  reason: string;
  actorUserId: string;
}): void {
  db.prepare(
    `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(makeId(), params.taskId, params.fromStatus, params.toStatus, params.reason, params.actorUserId, nowIso());
}

function setTaskStatus(task: TaskRow, nextStatus: TaskStatus, reason: string, actorUserId: string): TaskRow {
  const now = nowIso();
  db.transaction(() => {
    if (nextStatus === "merged") {
      db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, now, task.id);
    } else {
      db.prepare("UPDATE tasks SET status = ?, merged_at = NULL, merged_by_user_id = NULL, updated_at = ? WHERE id = ?").run(
        nextStatus,
        now,
        task.id
      );
    }
    recordTaskTransition({
      taskId: task.id,
      fromStatus: task.status,
      toStatus: nextStatus,
      reason,
      actorUserId
    });
  })();
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
}

export const tasksRouter = Router();

tasksRouter.post("/projects/:projectId/tasks", async (req, res) => {
  const parsed = createTaskSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const project = projectForUser(req.params.projectId, req.user.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.clone_status !== "ready") {
    res.status(409).json({ error: "Project base repository is not ready" });
    return;
  }

  const input = parsed.data;
  const id = makeId();
  const now = nowIso();
  const workspacePath = path.join(path.dirname(project.base_path), "tasks", id);
  const aiCommand = resolveAiCommand(input.aiCommand, req.user.id);
  const effectivePrompt = buildEffectivePrompt(project, input.taskPrompt);
  const dependencyTaskIds = input.dependencyTaskIds ?? [];
  const autoMerge = Boolean(input.autoMerge);

  let dependencies: TaskRow[];
  try {
    dependencies = resolveTaskDependencies({ projectId: project.id, dependencyTaskIds, taskId: id });
  } catch (error: any) {
    res.status(400).json({ error: String(error?.message ?? "Invalid dependencies") });
    return;
  }

  const unresolvedDependencies = dependencies.filter((x) => x.status !== "merged");
  const isBlocked = unresolvedDependencies.length > 0;

  let baseCommitSha: string;
  try {
    baseCommitSha = await getHeadCommitSha(project.base_path);
    if (!isBlocked) {
      await cloneLocalBaseToWorkspace({ basePath: project.base_path, baseBranch: project.default_branch, workspacePath });
      await createTaskBranch(workspacePath, id);
    }
  } catch (error: any) {
    const message = String(error?.message ?? "Failed to initialize task workspace");
    res.status(500).json({ error: message });
    return;
  }

  db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (
        id, project_id, title, task_prompt, result, effective_prompt, ai_command,
        auto_merge,
        mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
        status, workspace_path, base_commit_sha_at_create, head_commit_sha,
        cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', ?, ?, ?, 'execution', NULL, NULL, NULL, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
    ).run(
      id,
      project.id,
      input.title,
      input.taskPrompt,
      effectivePrompt,
      aiCommand,
      autoMerge ? 1 : 0,
      workspacePath,
      baseCommitSha,
      req.user.id,
      now,
      now
    );

    db.prepare(
      `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(makeId(), id, "null", "queued", isBlocked ? "task_created_blocked" : "task_created", req.user.id, now);

    for (const dependency of dependencies) {
      db.prepare(
        "INSERT INTO task_dependencies (task_id, dependency_task_id, created_at) VALUES (?, ?, ?)"
      ).run(id, dependency.id, now);
    }
  })();

  recordEvent({
    projectId: project.id,
    taskId: id,
    eventType: "task.created",
    payload: {
      title: input.title,
      aiCommand,
      autoMerge,
      workspacePath,
      baseCommitShaAtCreate: baseCommitSha,
      dependencyTaskIds: dependencies.map((x) => x.id),
      blockedByTaskIds: unresolvedDependencies.map((x) => x.id),
      blocked: isBlocked
    }
  });

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
  kickTaskQueueProcessing();
  res.status(201).json({ task: serializeTask(task) });
});

tasksRouter.get("/projects/:projectId/tasks", (req, res) => {
  const project = projectForUser(req.params.projectId, req.user.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const tasks = db
    .prepare("SELECT * FROM tasks WHERE project_id = ? AND parent_plan_task_id IS NULL ORDER BY created_at DESC")
    .all(project.id) as TaskRow[];

  res.json({ tasks: tasks.map(serializeTask) });
});

tasksRouter.get("/tasks/:taskId", async (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const transitions = db
    .prepare("SELECT * FROM task_state_transitions WHERE task_id = ? ORDER BY created_at ASC")
    .all(task.id) as TaskTransitionRow[];
  const mergeRecords = db
    .prepare("SELECT * FROM merge_records WHERE task_id = ? ORDER BY created_at DESC")
    .all(task.id) as MergeRecordRow[];

  let gitStatus: Awaited<ReturnType<typeof getWorkspaceGitStatus>> | null = null;
  try {
    gitStatus = await getWorkspaceGitStatus(task.workspace_path);
  } catch {
    gitStatus = null;
  }

  res.json({
    task: serializeTask(task),
    transitions: transitions.map(serializeTransition),
    session: serializeSession(latestSession(task.id)),
    ide: serializeIde(latestIde(task.id)),
    gitStatus,
    mergeRecords: mergeRecords.map(serializeMergeRecord)
  });
});

tasksRouter.patch("/tasks/:taskId", (req, res) => {
  const parsed = patchTaskSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  if (task.status !== "queued") {
    res.status(409).json({ error: "Task configuration can only be edited while queued" });
    return;
  }

  const input = parsed.data;
  const nextAiCommand = input.aiCommand ?? task.ai_command;
  db.prepare("UPDATE tasks SET ai_command = ?, updated_at = ? WHERE id = ?").run(
    nextAiCommand,
    nowIso(),
    task.id
  );

  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "task.updated",
    payload: {
      aiCommand: nextAiCommand
    }
  });

  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  res.json({ task: serializeTask(updated) });
});

tasksRouter.post("/tasks/:taskId/start", async (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (taskIsBlocked(task.id)) {
    res.status(409).json({ error: "Task is blocked by unmerged dependencies" });
    return;
  }

  try {
    await startTaskRuntime(task.id, req.user.id);
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to start task runtime") });
    return;
  }

  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  res.json({ task: serializeTask(updated), session: serializeSession(latestSession(task.id)) });
});

tasksRouter.post("/tasks/:taskId/input", async (req, res) => {
  const parsed = inputSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  try {
    await sendTaskRuntimeInput(task.id, req.user.id, parsed.data.text);
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to send input") });
    return;
  }

  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  res.json({ task: serializeTask(updated), session: serializeSession(latestSession(task.id)) });
});

tasksRouter.post("/tasks/:taskId/stop", async (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  try {
    await stopTaskRuntime(task.id, req.user.id);
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to stop session") });
    return;
  }

  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  res.json({ task: serializeTask(updated), session: serializeSession(latestSession(task.id)) });
});

tasksRouter.post("/tasks/:taskId/pull-main", async (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  if (["merged", "cancelled", "failed"].includes(task.status)) {
    res.status(409).json({ error: "Cannot pull main into a terminal task state" });
    return;
  }
  if (taskIsBlocked(task.id)) {
    res.status(409).json({ error: "Task is blocked by unmerged dependencies" });
    return;
  }

  const project = projectForUser(task.project_id, req.user.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const parentPlanTask = parentPlanTaskForUser(task, req.user.id);
  let topology: TaskGitTopology;
  try {
    topology = resolveTaskGitTopology({ task, project, parentPlanTask });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to resolve task repository topology") });
    return;
  }

  let pullResult: Awaited<ReturnType<typeof pullRemoteRefIntoTaskWorkspace>>;
  try {
    pullResult = await pullRemoteRefIntoTaskWorkspace({
      workspacePath: task.workspace_path,
      remoteRef: topology.pullRemoteRef
    });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to pull from main") });
    return;
  }

  const now = nowIso();
  db.prepare("UPDATE tasks SET head_commit_sha = ?, updated_at = ? WHERE id = ?").run(pullResult.headCommitSha, now, task.id);

  let latestTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  if (pullResult.conflicted && latestTask.status !== "merge_conflict") {
    latestTask = setTaskStatus(latestTask, "merge_conflict", "pull_main_conflict", req.user.id);
  }
  if (!pullResult.conflicted && latestTask.status === "merge_conflict") {
    latestTask = setTaskStatus(latestTask, "in_progress", "pull_main_resolved", req.user.id);
  }

  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "task.pull_main",
    payload: {
      targetRef: topology.pullRemoteRef,
      conflicted: pullResult.conflicted,
      conflictFiles: pullResult.conflictFiles,
      headCommitSha: pullResult.headCommitSha
    }
  });

  res.json({
    task: serializeTask(latestTask),
    sync: {
      targetRef: topology.pullRemoteRef,
      conflicted: pullResult.conflicted,
      conflictFiles: pullResult.conflictFiles,
      headCommitSha: pullResult.headCommitSha
    }
  });
});

tasksRouter.post("/tasks/:taskId/mark-merge-ready", async (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const active = activeSessions(task.id);
  if (active.length) {
    try {
      await stopTaskRuntime(task.id, req.user.id);
    } catch (error: any) {
      res.status(409).json({ error: String(error?.message ?? "Failed to stop active runtime before marking merge-ready") });
      return;
    }
  }

  let status: Awaited<ReturnType<typeof getWorkspaceGitStatus>>;
  try {
    status = await getWorkspaceGitStatus(task.workspace_path);
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to read task git status") });
    return;
  }

  const hasUncommitted =
    status.untracked > 0 ||
    status.staged > 0 ||
    status.unstaged > 0 ||
    status.conflicted > 0;
  if (hasUncommitted) {
    res.status(409).json({
      error: "Task has uncommitted or untracked changes. Commit or clean workspace before marking merge-ready.",
      gitStatus: status
    });
    return;
  }

  const updated = setTaskStatus(task, "merge_ready", "user_marked_merge_ready", req.user.id);
  recordEvent({
    projectId: updated.project_id,
    taskId: updated.id,
    eventType: "task.mark_merge_ready",
    payload: {}
  });
  res.json({ task: serializeTask(updated) });
});

tasksRouter.post("/tasks/:taskId/cancel", (req, res) => {
  const parsed = cancelTaskSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  if (!["queued", "in_progress", "waiting_input", "merge_ready", "merge_conflict"].includes(task.status)) {
    res.status(409).json({ error: "Task cannot be cancelled from current state" });
    return;
  }

  const now = nowIso();
  db.transaction(() => {
    db.prepare("UPDATE tasks SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?").run(parsed.data.reason, now, task.id);
    recordTaskTransition({
      taskId: task.id,
      fromStatus: task.status,
      toStatus: "cancelled",
      reason: "task_cancelled",
      actorUserId: req.user.id
    });
  })();
  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "task.cancelled",
    payload: {
      reason: parsed.data.reason
    }
  });
  res.json({ task: serializeTask(updated) });
});

tasksRouter.post("/tasks/:taskId/rerun", async (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const project = projectForUser(task.project_id, req.user.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.clone_status !== "ready") {
    res.status(409).json({ error: "Project base repository is not ready" });
    return;
  }
  const parentPlanTask = parentPlanTaskForUser(task, req.user.id);
  let topology: TaskGitTopology;
  try {
    topology = resolveTaskGitTopology({ task, project, parentPlanTask });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to resolve task repository topology") });
    return;
  }

  const now = nowIso();
  try {
    const ide = latestIde(task.id);
    if (ide && ["starting", "running"].includes(ide.status) && ideSessionRunning(task.id)) {
      stopIdeSession(task.id);
    }
    if (ide && ["starting", "running"].includes(ide.status)) {
      db.prepare("UPDATE ide_instances SET status = 'stopped', ended_at = ?, last_heartbeat_at = ? WHERE id = ?").run(now, now, ide.id);
    }

    const sessions = activeSessions(task.id);
    for (const session of sessions) {
      db.prepare(
        "UPDATE task_sessions SET status = 'stopped', ended_at = ?, last_heartbeat_at = ?, failure_reason = COALESCE(failure_reason, 'task_rerun_reset') WHERE id = ?"
      ).run(nowIso(), nowIso(), session.id);
    }

    if (!isSafeTaskWorkspacePath(task.workspace_path, project.base_path)) {
      throw new Error("Unsafe task workspace path; refusing to reset outside task workspace directory");
    }

    await fs.promises.rm(task.workspace_path, { recursive: true, force: true });
    const baseCommitSha = await getHeadCommitSha(topology.sourceRepoPath);
    await cloneLocalBaseToWorkspace({
      basePath: topology.sourceRepoPath,
      baseBranch: topology.sourceBranch,
      workspacePath: task.workspace_path
    });
    await createTaskBranch(task.workspace_path, task.id);

    const latestTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
    const updatedAt = nowIso();
    db.transaction(() => {
      db.prepare(
        `UPDATE tasks
         SET status = 'queued',
             result = '',
             workspace_path = ?,
             base_commit_sha_at_create = ?,
             head_commit_sha = NULL,
             cancel_reason = NULL,
             merged_at = NULL,
             merged_by_user_id = NULL,
             updated_at = ?
         WHERE id = ?`
      ).run(task.workspace_path, baseCommitSha, updatedAt, task.id);
      recordTaskTransition({
        taskId: task.id,
        fromStatus: latestTask.status,
        toStatus: "queued",
        reason: "task_rerun_reset",
        actorUserId: req.user.id
      });
    })();

    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      eventType: "task.rerun",
      payload: {
        previousStatus: latestTask.status,
        baseCommitShaAtCreate: baseCommitSha
      }
    });
    res.json({ task: serializeTask(updated) });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to re-run task") });
  }
});

tasksRouter.post("/tasks/:taskId/merge", async (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (task.status !== "merge_ready") {
    res.status(409).json({ error: "Task must be merge_ready before merge" });
    return;
  }

  const project = projectForUser(task.project_id, req.user.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const parentPlanTask = parentPlanTaskForUser(task, req.user.id);
  let topology: TaskGitTopology;
  try {
    topology = resolveTaskGitTopology({ task, project, parentPlanTask });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to resolve task repository topology") });
    return;
  }
  const lockKey = topology.mergeLockKey;

  if (mergeLocks.has(lockKey)) {
    res.status(409).json({ error: "Another merge is currently running for this merge target" });
    return;
  }
  mergeLocks.add(lockKey);

  try {
    let queueKickNeeded = false;
    const sourceCommitSha = await getHeadCommitSha(task.workspace_path);
    const targetBaseCommitSha = await getHeadCommitSha(topology.mergeTargetPath);
    const mergeRecordId = makeId();
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO merge_records (
        id, task_id, project_id, source_commit_sha, target_base_commit_sha, merge_commit_sha, status,
        conflict_summary, error_message, created_by_user_id, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?, NULL)`
    ).run(mergeRecordId, task.id, project.id, sourceCommitSha, targetBaseCommitSha, req.user.id, createdAt);

    try {
      const mergeResult = await mergeTaskWorkspaceIntoTarget({
        targetPath: topology.mergeTargetPath,
        targetBranch: topology.mergeTargetBranch,
        syncTargetBranchFromOrigin: topology.syncMergeTargetFromOrigin,
        workspacePath: task.workspace_path,
        taskId: task.id
      });
      const completedAt = nowIso();

      if (mergeResult.conflicted) {
        const conflictSummary = mergeResult.conflictFiles.join("\n");
        db.transaction(() => {
          db.prepare(
            "UPDATE merge_records SET status = 'conflict', conflict_summary = ?, completed_at = ? WHERE id = ?"
          ).run(conflictSummary || "conflicts detected", completedAt, mergeRecordId);
          db.prepare("UPDATE tasks SET status = 'merge_conflict', updated_at = ? WHERE id = ?").run(completedAt, task.id);
          recordTaskTransition({
            taskId: task.id,
            fromStatus: "merge_ready",
            toStatus: "merge_conflict",
            reason: "merge_conflict",
            actorUserId: req.user.id
          });
        })();
        recordEvent({
          projectId: project.id,
          taskId: task.id,
          eventType: "task.merge_conflict",
          payload: {
            conflictFiles: mergeResult.conflictFiles
          }
        });
      } else {
        db.transaction(() => {
          db.prepare(
            "UPDATE merge_records SET status = 'merged', merge_commit_sha = ?, completed_at = ? WHERE id = ?"
          ).run(mergeResult.mergeCommitSha, completedAt, mergeRecordId);
          db.prepare(
            "UPDATE tasks SET status = 'merged', merged_at = ?, merged_by_user_id = ?, head_commit_sha = ?, updated_at = ? WHERE id = ?"
          ).run(completedAt, req.user.id, mergeResult.mergeCommitSha, completedAt, task.id);
          recordTaskTransition({
            taskId: task.id,
            fromStatus: "merge_ready",
            toStatus: "merged",
            reason: "merge_success",
            actorUserId: req.user.id
          });
        })();
        recordEvent({
          projectId: project.id,
          taskId: task.id,
          eventType: "task.merged",
          payload: {
            mergeCommitSha: mergeResult.mergeCommitSha,
            sourceBranch: `task/${task.id}`,
            targetBranch: topology.mergeTargetBranch
          }
        });
        queueKickNeeded = true;
      }
    } catch (error: any) {
      const completedAt = nowIso();
      db.prepare("UPDATE merge_records SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?").run(
        String(error?.message ?? "merge failed"),
        completedAt,
        mergeRecordId
      );
      throw error;
    }

    const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
    const mergeRecords = db
      .prepare("SELECT * FROM merge_records WHERE task_id = ? ORDER BY created_at DESC")
      .all(task.id) as MergeRecordRow[];
    res.json({ task: serializeTask(updatedTask), mergeRecords: mergeRecords.map(serializeMergeRecord) });
    if (queueKickNeeded) {
      kickTaskQueueProcessing();
    }
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Merge failed") });
  } finally {
    mergeLocks.delete(lockKey);
  }
});

tasksRouter.get("/tasks/:taskId/merge-records", (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const mergeRecords = db
    .prepare("SELECT * FROM merge_records WHERE task_id = ? ORDER BY created_at DESC")
    .all(task.id) as MergeRecordRow[];
  res.json({ mergeRecords: mergeRecords.map(serializeMergeRecord) });
});

tasksRouter.get("/tasks/:taskId/terminal-token", (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const { token, expiresAt } = issueTerminalToken(task.id, req.user.id);
  res.json({
    token,
    expiresAt,
    wsPath: `/ws/tasks/${task.id}/terminal`
  });
});

tasksRouter.get("/tasks/:taskId/ide", async (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  let gitStatus: Awaited<ReturnType<typeof getWorkspaceGitStatus>> | null = null;
  try {
    gitStatus = await getWorkspaceGitStatus(task.workspace_path);
  } catch {
    gitStatus = null;
  }

  res.json({
    ide: serializeIde(latestIde(task.id)),
    gitStatus
  });
});

tasksRouter.post("/tasks/:taskId/ide/start", async (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  if (!fs.existsSync(task.workspace_path)) {
    res.status(409).json({ error: "Task workspace folder is missing" });
    return;
  }

  const current = latestIde(task.id);
  if (current && current.status === "running" && ideSessionRunning(task.id)) {
    const launchUrl = await buildIdeLaunchUrl(task, current.id);
    res.json({ ide: serializeIde(current), launchUrl });
    return;
  }

  let launched: Awaited<ReturnType<typeof startIdeSession>>;
  try {
    launched = await startIdeSession({
      taskId: task.id,
      workspacePath: task.workspace_path
    });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to start IDE session") });
    return;
  }

  const now = nowIso();
  const ideId = makeId();
  db.transaction(() => {
    if (current && current.status !== "stopped" && current.status !== "failed") {
      db.prepare("UPDATE ide_instances SET status = 'stopped', ended_at = ?, last_heartbeat_at = ? WHERE id = ?").run(
        now,
        now,
        current.id
      );
    }
    db.prepare(
      `INSERT INTO ide_instances (
        id, task_id, provider, url, access_token_hash, status, started_at, ended_at, last_heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, ?)`
    ).run(ideId, task.id, launched.provider, launched.url, hashToken("pending"), now, now);
  })();

  const launchUrl = await buildIdeLaunchUrl(task, ideId);
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "ide.started",
    payload: {
      ideId,
      provider: launched.provider,
      url: launched.url
    }
  });

  const ide = db.prepare("SELECT * FROM ide_instances WHERE id = ?").get(ideId) as IdeInstanceRow | undefined;
  res.json({ ide: serializeIde(ide), launchUrl });
});

tasksRouter.post("/tasks/:taskId/ide/token", async (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const ide = latestIde(task.id);
  if (!ide || !["starting", "running"].includes(ide.status)) {
    res.status(409).json({ error: "No active IDE instance for task" });
    return;
  }
  if (!ideSessionRunning(task.id)) {
    db.prepare("UPDATE ide_instances SET status = 'failed', ended_at = ?, last_heartbeat_at = ? WHERE id = ?").run(nowIso(), nowIso(), ide.id);
    res.status(409).json({ error: "IDE runtime is not available" });
    return;
  }

  const launchUrl = await buildIdeLaunchUrl(task, ide.id);
  res.json({ ide: serializeIde(ide), launchUrl });
});

tasksRouter.post("/tasks/:taskId/ide/stop", (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const ide = latestIde(task.id);
  if (!ide || !["starting", "running"].includes(ide.status)) {
    stopIdeSession(task.id);
    res.json({ ide: null, stopped: false });
    return;
  }

  stopIdeSession(task.id);
  const now = nowIso();
  db.prepare("UPDATE ide_instances SET status = 'stopped', ended_at = ?, last_heartbeat_at = ? WHERE id = ?").run(now, now, ide.id);
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "ide.stopped",
    payload: {
      ideId: ide.id
    }
  });

  const updated = db.prepare("SELECT * FROM ide_instances WHERE id = ?").get(ide.id) as IdeInstanceRow | undefined;
  res.json({ ide: serializeIde(updated) });
});

tasksRouter.get("/tasks/:taskId/ide/view", async (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).send("Task not found");
    return;
  }

  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token) {
    res.status(401).send("Missing IDE token");
    return;
  }

  const ide = latestIde(task.id);
  if (!ide || ide.status !== "running" || !ideSessionRunning(task.id)) {
    res.status(409).send("IDE is not running");
    return;
  }

  if (hashToken(token) !== ide.access_token_hash) {
    res.status(401).send("Invalid IDE token");
    return;
  }

  const workspace = typeof req.query.workspace === "string" ? req.query.workspace : "";
  const folder = typeof req.query.folder === "string" ? req.query.folder : "";
  const locationQuery = workspace
    ? `?workspace=${encodeURIComponent(workspace)}`
    : folder
      ? `?folder=${encodeURIComponent(folder)}`
      : "";
  res.redirect(302, `/api/tasks/${task.id}/ide/proxy/${locationQuery}`);
});

tasksRouter.all("/tasks/:taskId/ide/proxy*", (req, res) => {
  const task = taskForUser(req.params.taskId, req.user.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const ide = latestIde(task.id);
  if (!ide || ide.status !== "running" || !ideSessionRunning(task.id)) {
    res.status(409).json({ error: "IDE is not running" });
    return;
  }

  const target = ideSessionTarget(task.id);
  if (!target) {
    res.status(409).json({ error: "IDE target is unavailable" });
    return;
  }

  proxyIdeHttp(req, res, { taskId: task.id, targetPort: target.port });
});
