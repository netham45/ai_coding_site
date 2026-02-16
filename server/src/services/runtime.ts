import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../db/index.js";
import type { ProjectRow, TaskRow, TaskStatus } from "../types.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";
import { recordEvent } from "./events.js";
import { cloneLocalBaseToWorkspace, createTaskBranch, getHeadCommitSha, taskBranchName } from "./git.js";
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
  killSession,
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

function getTask(taskId: string): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
}

function getProject(projectId: string): ProjectRow | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
}

function getParentPlanTask(task: TaskRow): TaskRow | undefined {
  if (!task.parent_plan_task_id) {
    return undefined;
  }
  return db.prepare("SELECT * FROM tasks WHERE id = ? AND mode = 'plan'").get(task.parent_plan_task_id) as TaskRow | undefined;
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

function getLatestSession(taskId: string): SessionRow | undefined {
  return db
    .prepare("SELECT * FROM task_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(taskId) as SessionRow | undefined;
}

function getActiveSessions(taskId: string): SessionRow[] {
  return db
    .prepare(
      "SELECT * FROM task_sessions WHERE task_id = ? AND status IN ('starting','running','waiting_input') ORDER BY started_at DESC"
    )
    .all(taskId) as SessionRow[];
}

function hasNewerActiveSession(taskId: string, startedAt: string, excludeSessionId: string): boolean {
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
  taskId: string;
  fromStatus: string;
  toStatus: string;
  reason: string;
  actorUserId?: string | null;
}): void {
  db.prepare(
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
  const fromRuntimeActiveState = row.status === "in_progress" || row.status === "waiting_input";
  if (!fromRuntimeActiveState) {
    return;
  }
  db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(params.toStatus, nowIso(), params.taskId);
  insertTransition({
    taskId: params.taskId,
    fromStatus: row.status,
    toStatus: params.toStatus,
    reason: params.reason,
    actorUserId: params.actorUserId
  });
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
  if (taskIsBlocked(task.id)) {
    throw new Error("Task is blocked by unmerged dependencies");
  }
  const initialDisallowed =
    task.mode === "plan"
      ? ["merged", "cancelled"]
      : ["merged", "cancelled", "merge_ready", "merge_conflict"];
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
  for (const existing of existingSessions) {
    const alive = await hasSession(existing.tmux_socket_path, existing.tmux_session_name);
    if (alive) {
      await killSession(existing.tmux_socket_path, existing.tmux_session_name);
    }
    db.prepare(
      "UPDATE task_sessions SET status = 'stopped', ended_at = ?, last_heartbeat_at = ?, failure_reason = COALESCE(failure_reason, 'superseded_by_new_start') WHERE id = ?"
    ).run(nowIso(), nowIso(), existing.id);
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      sessionId: existing.id,
      eventType: "session.restarted",
      payload: { actorUserId }
    });
  }

  // Re-check task status after cleanup to avoid racing with cancel/merge actions.
  const latestBeforeStart = getTask(task.id);
  if (!latestBeforeStart) {
    throw new Error("Task not found");
  }
  const latestDisallowed =
    latestBeforeStart.mode === "plan"
      ? ["merged", "cancelled"]
      : ["merged", "cancelled", "merge_ready", "merge_conflict"];
  if (latestDisallowed.includes(latestBeforeStart.status)) {
    throw new Error(`Task cannot be started from status ${latestBeforeStart.status}`);
  }

  const effectivePrompt = buildEffectivePrompt(project, task.task_prompt);
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
  if (latestTask && ["queued", "failed", "waiting_input"].includes(latestTask.status)) {
    db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").run(nowIso(), task.id);
    insertTransition({
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
  const session = getLatestSession(taskId);
  if (!session || !["running", "waiting_input"].includes(session.status)) {
    throw new Error("No running session available for task");
  }

  const alive = await hasSession(session.tmux_socket_path, session.tmux_session_name);
  if (!alive) {
    throw new Error("Runtime session is not alive");
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
  const session = getLatestSession(taskId);
  if (!session || !["starting", "running", "waiting_input"].includes(session.status)) {
    throw new Error("No active session to stop");
  }

  let finalOutput = session.last_output;
  try {
    finalOutput = await capturePane(session.tmux_socket_path, session.tmux_session_name);
  } catch {
    // keep previous buffer
  }

  await killSession(session.tmux_socket_path, session.tmux_session_name);
  db.prepare("UPDATE task_sessions SET status = 'stopped', ended_at = ?, last_heartbeat_at = ?, last_output = ? WHERE id = ?").run(
    nowIso(),
    nowIso(),
    finalOutput,
    session.id
  );

  transitionTaskIfNeeded({ taskId, toStatus: "waiting_input", reason: "session_stopped_by_user", actorUserId });

  const task = getTask(taskId);
  if (task) {
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      sessionId: session.id,
      eventType: "session.stopped",
      payload: { actorUserId }
    });
  }
}

async function monitorSession(session: SessionRow): Promise<void> {
  const alive = await hasSession(session.tmux_socket_path, session.tmux_session_name);
  if (!alive) {
    if (hasNewerActiveSession(session.task_id, session.started_at, session.id)) {
      db.prepare(
        "UPDATE task_sessions SET status = 'stopped', ended_at = ?, last_heartbeat_at = ?, failure_reason = COALESCE(failure_reason, 'superseded_by_newer_session') WHERE id = ?"
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
    const stopStatus = paneStatus.status === 0 ? "stopped" : "crashed";
    db.prepare("UPDATE task_sessions SET status = ?, ended_at = ?, exit_code = ?, last_heartbeat_at = ? WHERE id = ?").run(
      stopStatus,
      nowIso(),
      paneStatus.status,
      nowIso(),
      session.id
    );

    if (paneStatus.status === 0) {
      transitionTaskIfNeeded({ taskId: session.task_id, toStatus: "merge_ready", reason: "runtime_exited_cleanly" });
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
  }

  if (signal.taskStatus) {
    transitionTaskIfNeeded({
      taskId: session.task_id,
      toStatus: signal.taskStatus,
      reason: signal.reason || "adapter_signal"
    });
  }
}

export async function recoverRuntimeSessions(): Promise<void> {
  await ensureTmuxAvailable();
  const rows = db
    .prepare("SELECT * FROM task_sessions WHERE status IN ('starting','running','waiting_input') ORDER BY started_at ASC")
    .all() as SessionRow[];

  for (const row of rows) {
    const alive = await hasSession(row.tmux_socket_path, row.tmux_session_name);
    if (!alive) {
      db.prepare("UPDATE task_sessions SET status = 'crashed', ended_at = ?, last_heartbeat_at = ? WHERE id = ?").run(
        nowIso(),
        nowIso(),
        row.id
      );
      transitionTaskIfNeeded({ taskId: row.task_id, toStatus: "failed", reason: "recovery_missing_tmux" });
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
    const activeSessions = db
      .prepare("SELECT * FROM task_sessions WHERE status IN ('starting','running','waiting_input') ORDER BY started_at ASC")
      .all() as SessionRow[];

    for (const session of activeSessions) {
      try {
        await monitorSession(session);
      } catch (error: any) {
        if (hasNewerActiveSession(session.task_id, session.started_at, session.id)) {
          db.prepare(
            "UPDATE task_sessions SET status = 'stopped', ended_at = ?, failure_reason = COALESCE(failure_reason, 'superseded_by_newer_session'), last_heartbeat_at = ? WHERE id = ?"
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
