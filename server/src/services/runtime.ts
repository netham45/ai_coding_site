import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hydrateProjectWithConfig, projectDbForProject } from "../db/index.js";
import { allAppProjects, appProjectById, taskContextById } from "../db/ownership.js";
import type { Database as DatabaseType } from "better-sqlite3";
import type { ProjectRow, TaskRow, TaskStatus } from "../types.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";
import { recordEvent } from "./events.js";
import {
  cloneLocalBaseToWorkspace,
  createTaskBranch,
  getHeadCommitSha,
  getWorkspaceGitStatus,
  mergeTaskWorkspaceIntoTarget,
  pullRemoteRefIntoTaskWorkspace,
  pushBranchToOrigin,
  taskBranchName
} from "./git.js";
import { buildEffectivePrompt } from "./promptBuilder.js";
import { buildCommand, parseLifecycleSignals } from "./adapters.js";
import {
  buildSessionName,
  buildSocketPath,
  capturePane,
  createSession,
  ensureTmuxAvailable,
  getPaneId,
  hasSession,
  paneExitStatus,
  sendInput
} from "./tmux.js";

type SessionRow = {
  id: string;
  task_id: string;
  tmux_session_name: string;
  tmux_socket_path: string;
  pane_id: string | null;
  detected_tool: string | null;
  backend_command: string;
  status: "starting" | "running" | "waiting_input" | "stopped" | "crashed" | "failed";
  started_at: string;
  ended_at: string | null;
  last_heartbeat_at: string | null;
  last_output: string;
  exit_code: number | null;
  failure_reason: string | null;
};

const tmuxRoot = path.join(os.tmpdir(), "ai-coding-site-tmux");
const WAITING_INPUT_IDLE_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 1000;
const AUTO_MERGE_READY_TIMEOUT_MS = 5 * 60 * 1000;
const AUTO_MERGE_POLL_INTERVAL_MS = 1250;
const TASK_SUMMARY_WAIT_TIMEOUT_MS = 2 * 60 * 1000;
const TASK_SUMMARY_POLL_INTERVAL_MS = 1000;
const TASK_SUMMARY_FILE_NAME = ".ai-task-summary.md";
const autoMergeTaskIds = new Set<string>();

function projectDbForTask(taskId: string): DatabaseType | undefined {
  return taskContextById(taskId)?.db;
}

function getTask(taskId: string): TaskRow | undefined {
  const db = projectDbForTask(taskId);
  if (!db) {
    return undefined;
  }
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
}

function getProject(projectId: string): ProjectRow | undefined {
  const appProject = appProjectById(projectId);
  if (!appProject) {
    return undefined;
  }
  return hydrateProjectWithConfig(appProject);
}

function getParentPlanTask(task: TaskRow): TaskRow | undefined {
  if (!task.parent_plan_task_id) {
    return undefined;
  }
  const db = projectDbForTask(task.id);
  if (!db) {
    return undefined;
  }
  return db.prepare("SELECT * FROM tasks WHERE id = ? AND mode = 'plan'").get(task.parent_plan_task_id) as TaskRow | undefined;
}

function taskIsBlocked(taskId: string): boolean {
  const db = projectDbForTask(taskId);
  if (!db) {
    return false;
  }
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

function getDependencySummariesForTask(taskId: string): Array<{ id: string; title: string; result: string }> {
  const db = projectDbForTask(taskId);
  if (!db) {
    return [];
  }
  return db
    .prepare(
      `SELECT dep.id, dep.title, dep.result
       FROM task_dependencies td
       JOIN tasks dep ON dep.id = td.dependency_task_id
       WHERE td.task_id = ?
       ORDER BY td.created_at ASC`
    )
    .all(taskId) as Array<{ id: string; title: string; result: string }>;
}

function getLatestSession(taskId: string): SessionRow | undefined {
  const db = projectDbForTask(taskId);
  if (!db) {
    return undefined;
  }
  return db
    .prepare("SELECT * FROM task_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(taskId) as SessionRow | undefined;
}

function getActiveSessions(taskId: string): SessionRow[] {
  const db = projectDbForTask(taskId);
  if (!db) {
    return [];
  }
  return db
    .prepare(
      "SELECT * FROM task_sessions WHERE task_id = ? AND status IN ('starting','running','waiting_input') ORDER BY started_at DESC"
    )
    .all(taskId) as SessionRow[];
}

function hasNewerActiveSession(taskId: string, startedAt: string, excludeSessionId: string): boolean {
  const db = projectDbForTask(taskId);
  if (!db) {
    return false;
  }
  const row = db
    .prepare(
      `SELECT id FROM task_sessions
       WHERE task_id = ?
         AND status IN ('starting','running','waiting_input')
         AND id != ?
         AND started_at > ?
       LIMIT 1`
    )
    .get(taskId, excludeSessionId, startedAt) as { id: string } | undefined;
  return Boolean(row?.id);
}

function insertTransition(params: {
  projectDb: DatabaseType;
  taskId: string;
  fromStatus: string;
  toStatus: string;
  reason: string;
  actorUserId?: string | null;
}): void {
  params.projectDb.prepare(
    `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(makeId(), params.taskId, params.fromStatus, params.toStatus, params.reason, params.actorUserId ?? null, nowIso());
}

function transitionTaskIfNeeded(params: {
  taskId: string;
  toStatus: TaskStatus;
  reason: string;
  actorUserId?: string | null;
}): void {
  const row = getTask(params.taskId);
  if (!row || row.status === params.toStatus) {
    return;
  }
  const db = projectDbForTask(params.taskId);
  if (!db) {
    return;
  }
  const fromRuntimeActiveState = row.status === "in_progress" || row.status === "waiting_input";
  if (!fromRuntimeActiveState) {
    return;
  }
  db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(params.toStatus, nowIso(), params.taskId);
  insertTransition({
    projectDb: db,
    taskId: params.taskId,
    fromStatus: row.status,
    toStatus: params.toStatus,
    reason: params.reason,
    actorUserId: params.actorUserId
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readTaskSummaryFromWorkspace(workspacePath: string): string {
  const filePath = path.join(workspacePath, TASK_SUMMARY_FILE_NAME);
  if (!fs.existsSync(filePath)) {
    return "";
  }
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function saveTaskResult(taskId: string, result: string): void {
  const db = projectDbForTask(taskId);
  if (!db) {
    return;
  }
  db.prepare("UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?").run(result, nowIso(), taskId);
}

async function ensureTaskSummaryCaptured(taskId: string, actorUserId: string): Promise<string> {
  const task = getTask(taskId);
  if (!task) {
    throw new Error("Task not found");
  }

  const summaryPath = path.join(task.workspace_path, TASK_SUMMARY_FILE_NAME);
  try {
    fs.rmSync(summaryPath, { force: true });
  } catch {
    // best effort; stale file should not block summary regeneration
  }

  await sendTaskRuntimeInput(
    task.id,
    actorUserId,
    [
      "Before auto-merge, generate a summary of this task.",
      `Write it to ${TASK_SUMMARY_FILE_NAME} in the workspace root.`,
      "Include:",
      "- Goal and outcome",
      "- Key code changes",
      "- Tests/validation performed",
      "- Remaining risks or follow-ups",
      "After writing the file, wait for further input."
    ].join("\n")
  );

  const deadline = Date.now() + TASK_SUMMARY_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const latestTask = getTask(task.id);
    if (!latestTask) {
      throw new Error("Task not found");
    }
    if (["cancelled", "failed", "merge_conflict", "merged"].includes(latestTask.status)) {
      throw new Error(`Task entered terminal state ${latestTask.status} before summary capture completed`);
    }

    const summary = readTaskSummaryFromWorkspace(latestTask.workspace_path);
    if (summary) {
      saveTaskResult(latestTask.id, summary);
      recordEvent({
        projectId: latestTask.project_id,
        taskId: latestTask.id,
        eventType: "task.summary.captured",
        payload: { file: TASK_SUMMARY_FILE_NAME }
      });
      return summary;
    }

    await sleep(TASK_SUMMARY_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for runtime to write task summary");
}

function updateTaskStatus(params: {
  taskId: string;
  toStatus: TaskStatus;
  reason: string;
  actorUserId?: string | null;
  mergedAt?: string | null;
  mergedByUserId?: string | null;
  headCommitSha?: string | null;
}): void {
  const row = getTask(params.taskId);
  if (!row || row.status === params.toStatus) {
    return;
  }
  const db = projectDbForTask(params.taskId);
  if (!db) {
    return;
  }

  db.prepare(
    `UPDATE tasks
     SET status = ?,
         merged_at = ?,
         merged_by_user_id = ?,
         head_commit_sha = COALESCE(?, head_commit_sha),
         updated_at = ?
     WHERE id = ?`
  ).run(
    params.toStatus,
    params.mergedAt ?? null,
    params.mergedByUserId ?? null,
    params.headCommitSha ?? null,
    nowIso(),
    params.taskId
  );

  insertTransition({
    projectDb: db,
    taskId: params.taskId,
    fromStatus: row.status,
    toStatus: params.toStatus,
    reason: params.reason,
    actorUserId: params.actorUserId
  });
}

async function awaitAutoMergeReady(taskId: string): Promise<TaskRow> {
  const deadline = Date.now() + AUTO_MERGE_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const task = getTask(taskId);
    if (!task) {
      throw new Error("Task not found");
    }
    if (task.status === "merge_ready") {
      return task;
    }
    if (["cancelled", "failed", "merge_conflict", "merged"].includes(task.status)) {
      throw new Error(`Task entered terminal state ${task.status} before auto-merge could proceed`);
    }

    const gitStatus = await getWorkspaceGitStatus(task.workspace_path);
    const cleanWorkspace =
      gitStatus.untracked === 0 &&
      gitStatus.staged === 0 &&
      gitStatus.unstaged === 0 &&
      gitStatus.conflicted === 0;
    if (cleanWorkspace && ["in_progress", "waiting_input"].includes(task.status)) {
      updateTaskStatus({
        taskId: task.id,
        toStatus: "merge_ready",
        reason: "auto_merge_marked_merge_ready",
      });
      const ready = getTask(task.id);
      if (ready && ready.status === "merge_ready") {
        return ready;
      }
    }

    await sleep(AUTO_MERGE_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for task to become merge_ready during auto-merge");
}

async function ensureIdleWaitingInput(taskId: string, actorUserId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) {
    return;
  }
  if (!["merge_ready", "merged", "cancelled"].includes(task.status)) {
    updateTaskStatus({
      taskId,
      toStatus: "waiting_input",
      reason: "auto_merge_failed_waiting_input",
      actorUserId
    });
  }
}

async function runAutoMerge(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task || !task.auto_merge || !["waiting_input", "merge_ready"].includes(task.status)) {
    return;
  }
  const db = projectDbForTask(task.id);
  if (!db) {
    throw new Error("Task database unavailable");
  }

  const project = getProject(task.project_id);
  if (!project) {
    throw new Error("Project not found");
  }

  const actorUserId = task.created_by_user_id;
  const sourceCommitSha = await getHeadCommitSha(task.workspace_path);
  const targetBaseCommitSha = await getHeadCommitSha(project.base_path);
  const mergeRecordId = makeId();
  const mergeStartedAt = nowIso();

  db.prepare(
    `INSERT INTO merge_records (
      id, task_id, project_id, source_commit_sha, target_base_commit_sha, merge_commit_sha, status,
      conflict_summary, error_message, created_by_user_id, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?, NULL)`
  ).run(mergeRecordId, task.id, project.id, sourceCommitSha, targetBaseCommitSha, actorUserId, mergeStartedAt);

  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "task.auto_merge.started",
    payload: {}
  });

  try {
    await ensureTaskSummaryCaptured(task.id, actorUserId);

    const pullResult = await pullRemoteRefIntoTaskWorkspace({
      workspacePath: task.workspace_path,
      remoteRef: project.default_branch
    });
    db.prepare("UPDATE tasks SET head_commit_sha = ?, updated_at = ? WHERE id = ?").run(pullResult.headCommitSha, nowIso(), task.id);
    if (pullResult.conflicted) {
      throw new Error(
        pullResult.conflictFiles.length
          ? `Pull from ${project.default_branch} resulted in conflicts: ${pullResult.conflictFiles.join(", ")}`
          : `Pull from ${project.default_branch} resulted in conflicts`
      );
    }

    await sendTaskRuntimeInput(
      task.id,
      actorUserId,
      [
        "Auto-merge requested.",
        "Please do all of the following now:",
        "1) Pull in any latest changes if needed.",
        "2) Resolve any issues.",
        "3) Commit all required code changes to this task branch.",
        "4) Do not exit the runtime. Leave it running and wait for further input when done."
      ].join("\n")
    );

    const mergeReadyTask = await awaitAutoMergeReady(task.id);
    const mergeResult = await mergeTaskWorkspaceIntoTarget({
      targetPath: project.base_path,
      targetBranch: project.default_branch,
      syncTargetBranchFromOrigin: true,
      workspacePath: mergeReadyTask.workspace_path,
      taskId: mergeReadyTask.id
    });
    if (mergeResult.conflicted) {
      throw new Error(
        mergeResult.conflictFiles.length
          ? `Merge into ${project.default_branch} conflicted: ${mergeResult.conflictFiles.join(", ")}`
          : `Merge into ${project.default_branch} conflicted`
      );
    }

    await pushBranchToOrigin({ repoPath: project.base_path, branch: project.default_branch });

    const completedAt = nowIso();
    db.transaction(() => {
      db.prepare("UPDATE merge_records SET status = 'merged', merge_commit_sha = ?, completed_at = ? WHERE id = ?").run(
        mergeResult.mergeCommitSha,
        completedAt,
        mergeRecordId
      );
      db.prepare(
        "UPDATE tasks SET status = 'merged', merged_at = ?, merged_by_user_id = ?, head_commit_sha = ?, updated_at = ? WHERE id = ?"
      ).run(completedAt, actorUserId, mergeResult.mergeCommitSha, completedAt, task.id);
      insertTransition({
        projectDb: db,
        taskId: task.id,
        fromStatus: "merge_ready",
        toStatus: "merged",
        reason: "auto_merge_success",
        actorUserId
      });
    })();

    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      eventType: "task.auto_merge.merged",
      payload: {
        targetBranch: project.default_branch,
        mergeCommitSha: mergeResult.mergeCommitSha
      }
    });
  } catch (error: any) {
    const completedAt = nowIso();
    db.prepare("UPDATE merge_records SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?").run(
      String(error?.message ?? "auto-merge failed"),
      completedAt,
      mergeRecordId
    );
    await ensureIdleWaitingInput(task.id, actorUserId);
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      eventType: "task.auto_merge.failed",
      payload: { error: String(error?.message ?? "auto-merge failed") }
    });
  }
}

function maybeStartAutoMerge(taskId: string): void {
  if (autoMergeTaskIds.has(taskId)) {
    return;
  }
  const task = getTask(taskId);
  if (!task || !task.auto_merge || !["waiting_input", "merge_ready"].includes(task.status)) {
    return;
  }

  autoMergeTaskIds.add(taskId);
  void runAutoMerge(taskId).finally(() => {
    autoMergeTaskIds.delete(taskId);
  });
}

export function triggerAutoMergeIfEligible(taskId: string): void {
  maybeStartAutoMerge(taskId);
}

function kickPendingAutoMergeTasks(): void {
  const pendingAutoMergeTasks = db
    .prepare("SELECT id FROM tasks WHERE auto_merge = 1 AND status IN ('waiting_input', 'merge_ready')")
    .all() as Array<{ id: string }>;
  for (const task of pendingAutoMergeTasks) {
    maybeStartAutoMerge(task.id);
  }
}

function buildRuntimeEnv(): { env: Record<string, string>; cleanup?: () => void } {
  const env = { ...process.env } as Record<string, string>;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.CLICOLOR_FORCE = "1";
  delete env.NO_COLOR;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "Never";
  return { env };
}

export async function startTaskRuntime(taskId: string, actorUserId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) {
    throw new Error("Task not found");
  }
  const db = projectDbForTask(task.id);
  if (!db) {
    throw new Error("Task database unavailable");
  }
  if (taskIsBlocked(task.id)) {
    throw new Error("Task is blocked by unmerged dependencies");
  }
  const initialDisallowed =
    task.mode === "plan"
      ? ["merged", "cancelled"]
      : ["merged", "cancelled", "merge_conflict"];
  if (initialDisallowed.includes(task.status)) {
    throw new Error(`Task cannot be started from status ${task.status}`);
  }
  const project = getProject(task.project_id);
  if (!project) {
    throw new Error("Project not found");
  }
  const workspaceGitPath = path.join(task.workspace_path, ".git");
  if (!fs.existsSync(workspaceGitPath)) {
    let sourcePath = project.base_path;
    let sourceBranch = project.default_branch;
    if (task.parent_plan_task_id) {
      const parentPlanTask = getParentPlanTask(task);
      if (!parentPlanTask) {
        throw new Error("Parent plan task not found");
      }
      sourcePath = parentPlanTask.workspace_path;
      sourceBranch = taskBranchName(parentPlanTask.id);
    }

    const baseCommitSha = await getHeadCommitSha(sourcePath);
    await cloneLocalBaseToWorkspace({
      basePath: sourcePath,
      baseBranch: sourceBranch,
      workspacePath: task.workspace_path
    });
    await createTaskBranch(task.workspace_path, task.id);
    db.prepare("UPDATE tasks SET base_commit_sha_at_create = ?, updated_at = ? WHERE id = ?").run(baseCommitSha, nowIso(), task.id);
  }

  await ensureTmuxAvailable();

  const existingSessions = getActiveSessions(taskId);
  if (existingSessions.length) {
    // Runtime sessions are never force-stopped by server-side start requests.
    return;
  }

  // Re-check task status after cleanup to avoid racing with cancel/merge actions.
  const latestBeforeStart = getTask(task.id);
  if (!latestBeforeStart) {
    throw new Error("Task not found");
  }
  const latestDisallowed =
    latestBeforeStart.mode === "plan"
      ? ["merged", "cancelled"]
      : ["merged", "cancelled", "merge_conflict"];
  if (latestDisallowed.includes(latestBeforeStart.status)) {
    throw new Error(`Task cannot be started from status ${latestBeforeStart.status}`);
  }

  const dependencySummaries = getDependencySummariesForTask(task.id);
  const effectivePrompt = buildEffectivePrompt(project, task.task_prompt, dependencySummaries);
  db.prepare("UPDATE tasks SET effective_prompt = ?, updated_at = ? WHERE id = ?").run(effectivePrompt, nowIso(), task.id);

  const built = buildCommand(task.ai_command, effectivePrompt);
  const sessionId = makeId();
  const sessionName = buildSessionName(task.id, sessionId);
  const socketPath = buildSocketPath(tmuxRoot, task.id);
  const now = nowIso();

  db.prepare(
    `INSERT INTO task_sessions (
      id, task_id, tmux_session_name, tmux_socket_path, pane_id, detected_tool,
      backend_command, status, started_at, ended_at, last_heartbeat_at, last_output, exit_code, failure_reason
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'starting', ?, NULL, NULL, '', NULL, NULL)`
  ).run(sessionId, task.id, sessionName, socketPath, built.detectedTool, `${built.command} ${built.args.join(" ")}`, now);

  const latestTask = getTask(task.id);
  if (latestTask && latestTask.status !== "in_progress") {
    db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").run(nowIso(), task.id);
    insertTransition({
      projectDb: db,
      taskId: task.id,
      fromStatus: latestTask.status,
      toStatus: "in_progress",
      reason: "runtime_started",
      actorUserId
    });
  }
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    sessionId,
    eventType: "session.starting",
    payload: { sessionName, socketPath, tool: built.detectedTool }
  });

  const runtimeEnv = buildRuntimeEnv();
  try {
    await createSession({
      socketPath,
      sessionName,
      cwd: task.workspace_path,
      command: built.command,
      args: built.args,
      env: runtimeEnv.env
    });
    const paneId = await getPaneId(socketPath, sessionName);
    db.prepare("UPDATE task_sessions SET pane_id = ?, status = 'running', last_heartbeat_at = ? WHERE id = ?").run(
      paneId,
      nowIso(),
      sessionId
    );

    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      sessionId,
      eventType: "session.running",
      payload: { paneId }
    });
  } catch (error: any) {
    const reason = String(error?.message ?? "failed to start runtime");
    db.prepare("UPDATE task_sessions SET status = 'failed', ended_at = ?, failure_reason = ? WHERE id = ?").run(nowIso(), reason, sessionId);
    transitionTaskIfNeeded({ taskId: task.id, toStatus: "failed", reason: "runtime_start_failed", actorUserId });
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      sessionId,
      eventType: "session.failed",
      payload: { reason }
    });
    throw new Error(reason);
  } finally {
    runtimeEnv.cleanup?.();
  }
}

export async function sendTaskRuntimeInput(taskId: string, actorUserId: string, text: string): Promise<void> {
  let session = getLatestSession(taskId);
  const hasRunnableSession = session && ["running", "waiting_input"].includes(session.status);
  if (!hasRunnableSession) {
    await startTaskRuntime(taskId, actorUserId);
    session = getLatestSession(taskId);
  }
  if (!session || !["running", "waiting_input"].includes(session.status)) {
    throw new Error("No running session available for task");
  }
  const db = projectDbForTask(session.task_id);
  if (!db) {
    throw new Error("Task database unavailable");
  }

  let alive = await hasSession(session.tmux_socket_path, session.tmux_session_name);
  if (!alive) {
    await startTaskRuntime(taskId, actorUserId);
    session = getLatestSession(taskId);
    if (!session || !["running", "waiting_input"].includes(session.status)) {
      throw new Error("No running session available for task");
    }
    alive = await hasSession(session.tmux_socket_path, session.tmux_session_name);
    if (!alive) {
      throw new Error("Runtime session is not alive");
    }
  }

  await sendInput(session.tmux_socket_path, session.tmux_session_name, text);
  db.prepare("UPDATE task_sessions SET status = 'running', last_heartbeat_at = ? WHERE id = ?").run(nowIso(), session.id);

  transitionTaskIfNeeded({ taskId, toStatus: "in_progress", reason: "user_input", actorUserId });

  const task = getTask(taskId);
  if (task) {
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      sessionId: session.id,
      eventType: "session.input",
      payload: { chars: text.length }
    });
  }
}

export async function stopTaskRuntime(taskId: string, actorUserId: string): Promise<void> {
  void taskId;
  void actorUserId;
  throw new Error("Stopping runtime sessions is disabled");
}

async function monitorSession(session: SessionRow): Promise<void> {
  const db = projectDbForTask(session.task_id);
  if (!db) {
    return;
  }
  const alive = await hasSession(session.tmux_socket_path, session.tmux_session_name);
  if (!alive) {
    if (hasNewerActiveSession(session.task_id, session.started_at, session.id)) {
      db.prepare(
        "UPDATE task_sessions SET status = 'crashed', ended_at = ?, last_heartbeat_at = ?, failure_reason = COALESCE(failure_reason, 'superseded_by_newer_session') WHERE id = ?"
      ).run(nowIso(), nowIso(), session.id);
      return;
    }
    db.prepare("UPDATE task_sessions SET status = 'crashed', ended_at = ?, last_heartbeat_at = ? WHERE id = ? AND ended_at IS NULL").run(
      nowIso(),
      nowIso(),
      session.id
    );
    transitionTaskIfNeeded({ taskId: session.task_id, toStatus: "failed", reason: "runtime_crashed" });
    return;
  }

  const paneStatus = await paneExitStatus(session.tmux_socket_path, session.tmux_session_name);
  if (paneStatus.dead) {
    const stopStatus = "crashed";
    db.prepare("UPDATE task_sessions SET status = ?, ended_at = ?, exit_code = ?, last_heartbeat_at = ? WHERE id = ?").run(
      stopStatus,
      nowIso(),
      paneStatus.status,
      nowIso(),
      session.id
    );

    if (paneStatus.status === 0) {
      transitionTaskIfNeeded({ taskId: session.task_id, toStatus: "merge_ready", reason: "runtime_exited_cleanly" });
      maybeStartAutoMerge(session.task_id);
    } else {
      transitionTaskIfNeeded({ taskId: session.task_id, toStatus: "failed", reason: "runtime_exited_nonzero" });
    }
    return;
  }

  const output = await capturePane(session.tmux_socket_path, session.tmux_session_name);
  const signal = parseLifecycleSignals(output);
  const outputChanged = output !== session.last_output;
  const now = Date.now();
  const lastActivityMs = session.last_heartbeat_at ? Date.parse(session.last_heartbeat_at) : Number.NaN;
  const idleMs = Number.isFinite(lastActivityMs) ? now - lastActivityMs : Number.POSITIVE_INFINITY;

  if (outputChanged) {
    db.prepare("UPDATE task_sessions SET last_heartbeat_at = ?, last_output = ? WHERE id = ?").run(nowIso(), output, session.id);
    if (session.status === "waiting_input") {
      db.prepare("UPDATE task_sessions SET status = 'running' WHERE id = ?").run(session.id);
    }
    transitionTaskIfNeeded({ taskId: session.task_id, toStatus: "in_progress", reason: "runtime_output_activity" });
  }

  if (signal.sessionStatus === "waiting_input" && session.status !== "waiting_input") {
    db.prepare("UPDATE task_sessions SET status = 'waiting_input', last_heartbeat_at = COALESCE(last_heartbeat_at, ?) WHERE id = ?").run(
      nowIso(),
      session.id
    );
  }

  if (!outputChanged && session.status === "running" && idleMs >= WAITING_INPUT_IDLE_MS) {
    db.prepare("UPDATE task_sessions SET status = 'waiting_input' WHERE id = ?").run(session.id);
    transitionTaskIfNeeded({ taskId: session.task_id, toStatus: "waiting_input", reason: "runtime_idle_no_output" });
    maybeStartAutoMerge(session.task_id);
  }

  if (signal.taskStatus) {
    transitionTaskIfNeeded({
      taskId: session.task_id,
      toStatus: signal.taskStatus,
      reason: signal.reason || "adapter_signal"
    });
    if (signal.taskStatus === "waiting_input") {
      maybeStartAutoMerge(session.task_id);
    } else if (signal.taskStatus === "merge_ready") {
      maybeStartAutoMerge(session.task_id);
    }
  }
}

export async function recoverRuntimeSessions(): Promise<void> {
  await ensureTmuxAvailable();
  kickPendingAutoMergeTasks();

  const rows = db
    .prepare("SELECT * FROM task_sessions WHERE status IN ('starting','running','waiting_input') ORDER BY started_at ASC")
    .all() as SessionRow[];

  for (const row of rows) {
    const alive = await hasSession(row.session.tmux_socket_path, row.session.tmux_session_name);
    if (!alive) {
      row.db.prepare("UPDATE task_sessions SET status = 'crashed', ended_at = ?, last_heartbeat_at = ? WHERE id = ?").run(
        nowIso(),
        nowIso(),
        row.session.id
      );
      transitionTaskIfNeeded({ taskId: row.session.task_id, toStatus: "failed", reason: "recovery_missing_tmux" });
    }
  }
}

let heartbeatTimer: NodeJS.Timeout | null = null;

export async function startRuntimeHeartbeat(): Promise<void> {
  await recoverRuntimeSessions();
  if (heartbeatTimer) {
    return;
  }

  heartbeatTimer = setInterval(async () => {
    kickPendingAutoMergeTasks();

    const activeSessions = db
      .prepare("SELECT * FROM task_sessions WHERE status IN ('starting','running','waiting_input') ORDER BY started_at ASC")
      .all() as SessionRow[];

    for (const session of activeSessions) {
      const db = projectDbForTask(session.task_id);
      if (!db) {
        continue;
      }
      try {
        await monitorSession(session);
      } catch (error: any) {
        if (hasNewerActiveSession(session.task_id, session.started_at, session.id)) {
          db.prepare(
            "UPDATE task_sessions SET status = 'crashed', ended_at = ?, failure_reason = COALESCE(failure_reason, 'superseded_by_newer_session'), last_heartbeat_at = ? WHERE id = ?"
          ).run(nowIso(), nowIso(), nowIso(), session.id);
          continue;
        }
        db.prepare("UPDATE task_sessions SET status = 'crashed', ended_at = ?, failure_reason = ?, last_heartbeat_at = ? WHERE id = ?").run(
          nowIso(),
          String(error?.message ?? "heartbeat failure"),
          nowIso(),
          session.id
        );
        transitionTaskIfNeeded({ taskId: session.task_id, toStatus: "failed", reason: "heartbeat_failure" });
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}
