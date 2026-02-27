import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db as appDb, resolveProjectDatabase, type SplitPersistenceBackend } from "../db/index.js";
import type { AppProjectRow, ProjectRow, TaskRow, TaskStatus } from "../types.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";
import { recordEvent } from "./events.js";
import { observeNodeOutputMaterialChange } from "./orchestration/outputMonitor.js";
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

export type RuntimeTaskContext = {
  projectId: string;
  basePath?: string;
  projectDb?: Database.Database;
  backend?: SplitPersistenceBackend;
};

type RuntimeProjectContext = {
  project: AppProjectRow;
  projectDb: Database.Database;
  backend: SplitPersistenceBackend;
};

const tmuxRoot = path.join(os.tmpdir(), "ai-coding-site-tmux");
const WAITING_INPUT_IDLE_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const OUTPUT_PERSIST_INTERVAL_MS = 15000;
const AUTO_MERGE_READY_TIMEOUT_MS = 5 * 60 * 1000;
const AUTO_MERGE_POLL_INTERVAL_MS = 1250;
const TASK_SUMMARY_WAIT_TIMEOUT_MS = 2 * 60 * 1000;
const TASK_SUMMARY_POLL_INTERVAL_MS = 1000;
const TASK_SUMMARY_FILE_NAME = ".ai-task-summary.md";
const autoMergeTaskIds = new Set<string>();

type SessionActivityCache = {
  lastOutput: string;
  lastActivityMs: number;
  lastPersistedAtMs: number;
};

const sessionActivityById = new Map<string, SessionActivityCache>();
const sessionStartupTmuxCommandById = new Map<string, string>();

type TaskGitTopology = {
  pullRemoteRef: string;
  mergeTargetPath: string;
  mergeTargetBranch: string;
  syncMergeTargetFromOrigin: boolean;
  shouldPushTargetBranchToOrigin: boolean;
};

function listRuntimeProjects(): AppProjectRow[] {
  return appDb
    .prepare(
      `SELECT
         id,
         name,
         slug,
         repo_url,
         default_branch,
         base_path,
         clone_status,
         clone_error,
         created_by_user_id,
         created_at,
         updated_at
       FROM projects
       ORDER BY created_at ASC`
    )
    .all() as AppProjectRow[];
}

function appProjectById(projectId: string): AppProjectRow | undefined {
  return appDb
    .prepare(
      `SELECT
         id,
         name,
         slug,
         repo_url,
         default_branch,
         base_path,
         clone_status,
         clone_error,
         created_by_user_id,
         created_at,
         updated_at
       FROM projects
       WHERE id = ?`
    )
    .get(projectId) as AppProjectRow | undefined;
}

function loadProjectConfig(projectDb: Database.Database, projectId: string) {
  const row = projectDb
    .prepare(
      `SELECT
         project_prompt,
         project_rules,
         coding_standard,
         coding_standard_other,
         project_other
       FROM project_config
       WHERE project_id = ?`
    )
    .get(projectId) as
    | {
        project_prompt: string;
        project_rules: string;
        coding_standard: string;
        coding_standard_other: string;
        project_other: string;
      }
    | undefined;

  return {
    project_prompt: row?.project_prompt ?? "",
    project_rules: row?.project_rules ?? "",
    coding_standard: row?.coding_standard ?? "",
    coding_standard_other: row?.coding_standard_other ?? "",
    project_other: row?.project_other ?? ""
  };
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function loadMonolithProjectConfig(projectId: string): {
  project_prompt: string;
  project_rules: string;
  coding_standard: string;
  coding_standard_other: string;
  project_other: string;
} {
  const hasLegacyColumns =
    tableHasColumn(appDb, "projects", "project_prompt") &&
    tableHasColumn(appDb, "projects", "project_rules") &&
    tableHasColumn(appDb, "projects", "coding_standard") &&
    tableHasColumn(appDb, "projects", "coding_standard_other") &&
    tableHasColumn(appDb, "projects", "project_other");
  if (!hasLegacyColumns) {
    return {
      project_prompt: "",
      project_rules: "",
      coding_standard: "",
      coding_standard_other: "",
      project_other: ""
    };
  }

  const row = appDb
    .prepare(
      `SELECT
         project_prompt,
         project_rules,
         coding_standard,
         coding_standard_other,
         project_other
       FROM projects
       WHERE id = ?`
    )
    .get(projectId) as
    | {
        project_prompt: string;
        project_rules: string;
        coding_standard: string;
        coding_standard_other: string;
        project_other: string;
      }
    | undefined;

  return {
    project_prompt: row?.project_prompt ?? "",
    project_rules: row?.project_rules ?? "",
    coding_standard: row?.coding_standard ?? "",
    coding_standard_other: row?.coding_standard_other ?? "",
    project_other: row?.project_other ?? ""
  };
}

function buildProjectWithConfig(project: AppProjectRow, projectDb: Database.Database, backend: SplitPersistenceBackend): ProjectRow {
  return {
    ...project,
    ...(backend === "project" ? loadProjectConfig(projectDb, project.id) : loadMonolithProjectConfig(project.id))
  };
}

function contextHintFromProjectContext(context: RuntimeProjectContext): RuntimeTaskContext {
  return {
    projectId: context.project.id,
    basePath: context.project.base_path,
    projectDb: context.projectDb,
    backend: context.backend
  };
}

function getTask(projectDb: Database.Database, taskId: string, projectId?: string): TaskRow | undefined {
  if (projectId) {
    return projectDb.prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?").get(taskId, projectId) as TaskRow | undefined;
  }
  return projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
}

function getParentPlanTask(projectDb: Database.Database, task: TaskRow): TaskRow | undefined {
  if (!task.parent_plan_task_id) {
    return undefined;
  }
  return projectDb.prepare("SELECT * FROM tasks WHERE id = ? AND mode = 'plan'").get(task.parent_plan_task_id) as TaskRow | undefined;
}

function resolveTaskProjectContext(taskId: string, context?: RuntimeTaskContext): RuntimeProjectContext {
  if (context?.projectId) {
    const project = appProjectById(context.projectId);
    if (!project) {
      throw new Error("Project not found");
    }
    const basePath = context.basePath ?? project.base_path;
    const scoped =
      context.projectDb
        ? {
            database: context.projectDb,
            backend: context.backend ?? (context.projectDb === appDb ? "monolith" : ("project" as SplitPersistenceBackend))
          }
        : resolveProjectDatabase({
            appDb,
            projectId: project.id,
            basePath,
            intent: "write"
          });
    const projectDb = scoped.database;
    const task = getTask(projectDb, taskId, project.id);
    if (!task) {
      throw new Error("Task not found");
    }
    return {
      project: {
        ...project,
        base_path: basePath
      },
      projectDb,
      backend: scoped.backend
    };
  }

  for (const project of listRuntimeProjects()) {
    const scoped = resolveProjectDatabase({
      appDb,
      projectId: project.id,
      basePath: project.base_path,
      intent: "write"
    });
    const projectDb = scoped.database;
    const task = getTask(projectDb, taskId, project.id);
    if (task) {
      return { project, projectDb, backend: scoped.backend };
    }
  }

  throw new Error("Task not found");
}

function listAvailableProjectContexts(): RuntimeProjectContext[] {
  const contexts: RuntimeProjectContext[] = [];
  for (const project of listRuntimeProjects()) {
    const scoped = resolveProjectDatabase({
      appDb,
      projectId: project.id,
      basePath: project.base_path,
      intent: "write"
    });
    contexts.push({ project, projectDb: scoped.database, backend: scoped.backend });
  }
  return contexts;
}

function resolveTaskGitTopology(projectDb: Database.Database, task: TaskRow, project: ProjectRow): TaskGitTopology {
  if (task.parent_plan_task_id) {
    const parentPlanTask = getParentPlanTask(projectDb, task);
    if (!parentPlanTask) {
      throw new Error("Parent plan task not found");
    }
    const planBranch = taskBranchName(parentPlanTask.id);
    return {
      pullRemoteRef: planBranch,
      mergeTargetPath: parentPlanTask.workspace_path,
      mergeTargetBranch: planBranch,
      syncMergeTargetFromOrigin: false,
      shouldPushTargetBranchToOrigin: false
    };
  }

  return {
    pullRemoteRef: project.default_branch,
    mergeTargetPath: project.base_path,
    mergeTargetBranch: project.default_branch,
    syncMergeTargetFromOrigin: true,
    shouldPushTargetBranchToOrigin: true
  };
}

function taskIsBlocked(projectDb: Database.Database, taskId: string): boolean {
  const row = projectDb
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

function getDependencySummariesForTask(projectDb: Database.Database, taskId: string): Array<{ id: string; title: string; result: string }> {
  return projectDb
    .prepare(
      `SELECT dep.id, dep.title, dep.result
       FROM task_dependencies td
       JOIN tasks dep ON dep.id = td.dependency_task_id
       WHERE td.task_id = ?
       ORDER BY td.created_at ASC`
    )
    .all(taskId) as Array<{ id: string; title: string; result: string }>;
}

function getLatestSession(projectDb: Database.Database, taskId: string): SessionRow | undefined {
  return projectDb
    .prepare("SELECT * FROM task_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(taskId) as SessionRow | undefined;
}

function getActiveSessions(projectDb: Database.Database, taskId: string): SessionRow[] {
  return projectDb
    .prepare(
      "SELECT * FROM task_sessions WHERE task_id = ? AND status IN ('starting','running','waiting_input') ORDER BY started_at DESC"
    )
    .all(taskId) as SessionRow[];
}

function listSessionsForHeartbeat(projectDb: Database.Database): SessionRow[] {
  return projectDb
    .prepare(
      `SELECT ts.*
       FROM task_sessions ts
       JOIN tasks t ON t.id = ts.task_id
       WHERE ts.status IN ('starting','running','waiting_input')
         AND t.status IN ('in_progress','waiting_input')
       ORDER BY ts.started_at ASC`
    )
    .all() as SessionRow[];
}

function hasNewerActiveSession(projectDb: Database.Database, taskId: string, startedAt: string, excludeSessionId: string): boolean {
  const row = projectDb
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

function insertTransition(
  projectDb: Database.Database,
  params: {
    taskId: string;
    fromStatus: string;
    toStatus: string;
    reason: string;
    actorUserId?: string | null;
  }
): void {
  projectDb.prepare(
    `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(makeId(), params.taskId, params.fromStatus, params.toStatus, params.reason, params.actorUserId ?? null, nowIso());
}

function transitionTaskIfNeeded(
  projectDb: Database.Database,
  params: {
    taskId: string;
    toStatus: TaskStatus;
    reason: string;
    actorUserId?: string | null;
  }
): void {
  const row = getTask(projectDb, params.taskId);
  if (!row || row.status === params.toStatus) {
    return;
  }
  const fromRuntimeActiveState = row.status === "in_progress" || row.status === "waiting_input";
  if (!fromRuntimeActiveState) {
    return;
  }
  projectDb.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(params.toStatus, nowIso(), params.taskId);
  insertTransition(projectDb, {
    taskId: params.taskId,
    fromStatus: row.status,
    toStatus: params.toStatus,
    reason: params.reason,
    actorUserId: params.actorUserId
  });
  recordEvent({
    projectId: row.project_id,
    taskId: row.id,
    eventType: "task.status_changed",
    payload: {
      fromStatus: row.status,
      toStatus: params.toStatus,
      reasonCode: params.reason,
      source: "runtime.transitionTaskIfNeeded"
    },
    database: projectDb
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

function saveTaskResult(projectDb: Database.Database, taskId: string, result: string): void {
  projectDb.prepare("UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?").run(result, nowIso(), taskId);
}

function ensureWorkspaceGitignoreRule(workspacePath: string, rule: string): void {
  const gitignorePath = path.join(workspacePath, ".gitignore");
  let existing = "";
  try {
    existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  } catch {
    existing = "";
  }

  const hasRule = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(rule);
  if (hasRule) {
    return;
  }

  const next = existing.length === 0 ? `${rule}\n` : `${existing.replace(/\s*$/, "\n")}${rule}\n`;
  fs.writeFileSync(gitignorePath, next, "utf8");
}

async function ensureTaskSummaryCaptured(taskId: string, actorUserId: string, context: RuntimeTaskContext): Promise<string> {
  const taskContext = resolveTaskProjectContext(taskId, context);
  const task = getTask(taskContext.projectDb, taskId);
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
      "- Research completed and key findings (if any)",
      "- Questions answered during the task and the answers",
      "- Tests/validation performed",
      "- Remaining risks or follow-ups",
      "After writing the file, wait for further input."
    ].join("\n"),
    context
  );

  const deadline = Date.now() + TASK_SUMMARY_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const latestTask = getTask(taskContext.projectDb, task.id);
    if (!latestTask) {
      throw new Error("Task not found");
    }
    if (["cancelled", "failed", "merge_conflict", "merged"].includes(latestTask.status)) {
      throw new Error(`Task entered terminal state ${latestTask.status} before summary capture completed`);
    }

    const summary = readTaskSummaryFromWorkspace(latestTask.workspace_path);
    if (summary) {
      saveTaskResult(taskContext.projectDb, latestTask.id, summary);
      recordEvent({
        projectId: latestTask.project_id,
        taskId: latestTask.id,
        eventType: "task.summary.captured",
        payload: { file: TASK_SUMMARY_FILE_NAME },
        database: taskContext.projectDb
      });
      return summary;
    }

    await sleep(TASK_SUMMARY_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for runtime to write task summary");
}

function updateTaskStatus(
  projectDb: Database.Database,
  params: {
    taskId: string;
    toStatus: TaskStatus;
    reason: string;
    actorUserId?: string | null;
    mergedAt?: string | null;
    mergedByUserId?: string | null;
    headCommitSha?: string | null;
  }
): void {
  const row = getTask(projectDb, params.taskId);
  if (!row || row.status === params.toStatus) {
    return;
  }

  projectDb.prepare(
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

  insertTransition(projectDb, {
    taskId: params.taskId,
    fromStatus: row.status,
    toStatus: params.toStatus,
    reason: params.reason,
    actorUserId: params.actorUserId
  });
  recordEvent({
    projectId: row.project_id,
    taskId: row.id,
    eventType: "task.status_changed",
    payload: {
      fromStatus: row.status,
      toStatus: params.toStatus,
      reasonCode: params.reason,
      source: "runtime.updateTaskStatus"
    },
    database: projectDb
  });
}

async function awaitAutoMergeReady(projectDb: Database.Database, taskId: string): Promise<TaskRow> {
  const deadline = Date.now() + AUTO_MERGE_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const task = getTask(projectDb, taskId);
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
      updateTaskStatus(projectDb, {
        taskId: task.id,
        toStatus: "merge_ready",
        reason: "auto_merge_marked_merge_ready"
      });
      const ready = getTask(projectDb, task.id);
      if (ready && ready.status === "merge_ready") {
        return ready;
      }
    }

    await sleep(AUTO_MERGE_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for task to become merge_ready during auto-merge");
}

async function ensureIdleWaitingInput(projectDb: Database.Database, taskId: string, actorUserId: string): Promise<void> {
  const task = getTask(projectDb, taskId);
  if (!task) {
    return;
  }
  if (!["merge_ready", "merged", "cancelled"].includes(task.status)) {
    updateTaskStatus(projectDb, {
      taskId,
      toStatus: "waiting_input",
      reason: "auto_merge_failed_waiting_input",
      actorUserId
    });
  }
}

async function runAutoMerge(taskId: string, context?: RuntimeTaskContext): Promise<void> {
  const taskContext = resolveTaskProjectContext(taskId, context);
  const scopeHint = contextHintFromProjectContext(taskContext);
  const task = getTask(taskContext.projectDb, taskId);
  if (!task || !task.auto_merge || !["waiting_input", "merge_ready", "merge_conflict"].includes(task.status)) {
    return;
  }

  const project = buildProjectWithConfig(taskContext.project, taskContext.projectDb, taskContext.backend);
  const topology = resolveTaskGitTopology(taskContext.projectDb, task, project);

  const actorUserId = task.created_by_user_id;
  if (task.status === "merge_conflict") {
    const latestConflict = taskContext.projectDb
      .prepare("SELECT conflict_summary FROM merge_records WHERE task_id = ? AND status = 'conflict' ORDER BY created_at DESC LIMIT 1")
      .get(task.id) as { conflict_summary?: string | null } | undefined;
    const conflictSummary = String(latestConflict?.conflict_summary ?? "").trim();
    ensureWorkspaceGitignoreRule(task.workspace_path, ".ai-coding-site*.code-workspace");
    ensureWorkspaceGitignoreRule(task.workspace_path, ".ai-task-summary.md");
    await sendTaskRuntimeInput(
      task.id,
      actorUserId,
      [
        "Auto-merge hit merge conflicts. Resolve them now in this task branch.",
        "",
        conflictSummary ? "Conflict details:" : "Conflict details unavailable in merge record.",
        conflictSummary || "(none recorded)",
        "",
        "Required next steps:",
        "1) Pull/rebase as needed and resolve conflicts in this task workspace.",
        "2) Stage and commit ALL workspace changes (`git add -A`).",
        "3) Leave no modified, deleted, or untracked files.",
        "4) Stay in the runtime and wait for further input when done."
      ].join("\n"),
      scopeHint
    );
    updateTaskStatus(taskContext.projectDb, {
      taskId: task.id,
      toStatus: "waiting_input",
      reason: "auto_merge_conflict_retry_requested",
      actorUserId
    });
    return;
  }

  const sourceCommitSha = await getHeadCommitSha(task.workspace_path);
  const targetBaseCommitSha = await getHeadCommitSha(topology.mergeTargetPath);
  const mergeRecordId = makeId();
  const mergeStartedAt = nowIso();

  taskContext.projectDb.prepare(
    `INSERT INTO merge_records (
      id, task_id, project_id, source_commit_sha, target_base_commit_sha, merge_commit_sha, status,
      conflict_summary, error_message, created_by_user_id, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?, NULL)`
  ).run(mergeRecordId, task.id, project.id, sourceCommitSha, targetBaseCommitSha, actorUserId, mergeStartedAt);

  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "task.auto_merge.started",
    payload: {},
    database: taskContext.projectDb
  });

  try {
    let mergeReadyTask: TaskRow;
    if (task.status === "merge_ready") {
      mergeReadyTask = task;
    } else {
      await ensureTaskSummaryCaptured(task.id, actorUserId, scopeHint);
      ensureWorkspaceGitignoreRule(task.workspace_path, ".ai-coding-site*.code-workspace");
      ensureWorkspaceGitignoreRule(task.workspace_path, ".ai-task-summary.md");

      await sendTaskRuntimeInput(
        task.id,
        actorUserId,
        [
          "Auto-merge requested.",
          "Please do all of the following now:",
          "1) Pull in any latest changes if needed.",
          "2) Resolve any issues.",
          "3) Stage and commit ALL workspace changes to this task branch (use `git add -A`). Include .gitignore updates and do not leave modified, deleted, or untracked files.",
          "4) Do not exit the runtime. Leave it running and wait for further input when done."
        ].join("\n"),
        scopeHint
      );

      mergeReadyTask = await awaitAutoMergeReady(taskContext.projectDb, task.id);
    }

    const pullResult = await pullRemoteRefIntoTaskWorkspace({
      workspacePath: mergeReadyTask.workspace_path,
      remoteRef: topology.pullRemoteRef
    });
    taskContext.projectDb
      .prepare("UPDATE tasks SET head_commit_sha = ?, updated_at = ? WHERE id = ?")
      .run(pullResult.headCommitSha, nowIso(), task.id);
    if (pullResult.conflicted) {
      throw new Error(
        pullResult.conflictFiles.length
          ? `Pull from ${topology.pullRemoteRef} resulted in conflicts: ${pullResult.conflictFiles.join(", ")}`
          : `Pull from ${topology.pullRemoteRef} resulted in conflicts`
      );
    }

    const mergeResult = await mergeTaskWorkspaceIntoTarget({
      targetPath: topology.mergeTargetPath,
      targetBranch: topology.mergeTargetBranch,
      syncTargetBranchFromOrigin: topology.syncMergeTargetFromOrigin,
      workspacePath: mergeReadyTask.workspace_path,
      taskId: mergeReadyTask.id
    });
    if (mergeResult.conflicted) {
      throw new Error(
        mergeResult.conflictFiles.length
          ? `Merge into ${topology.mergeTargetBranch} conflicted: ${mergeResult.conflictFiles.join(", ")}`
          : `Merge into ${topology.mergeTargetBranch} conflicted`
      );
    }

    if (topology.shouldPushTargetBranchToOrigin) {
      await pushBranchToOrigin({ repoPath: topology.mergeTargetPath, branch: topology.mergeTargetBranch });
    }

    const completedAt = nowIso();
    taskContext.projectDb.transaction(() => {
      taskContext.projectDb.prepare("UPDATE merge_records SET status = 'merged', merge_commit_sha = ?, completed_at = ? WHERE id = ?").run(
        mergeResult.mergeCommitSha,
        completedAt,
        mergeRecordId
      );
      taskContext.projectDb.prepare(
        "UPDATE tasks SET status = 'merged', merged_at = ?, merged_by_user_id = ?, head_commit_sha = ?, updated_at = ? WHERE id = ?"
      ).run(completedAt, actorUserId, mergeResult.mergeCommitSha, completedAt, task.id);
      insertTransition(taskContext.projectDb, {
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
        targetBranch: topology.mergeTargetBranch,
        mergeCommitSha: mergeResult.mergeCommitSha
      },
      database: taskContext.projectDb
    });
  } catch (error: any) {
    const failureMessage = String(error?.message ?? "auto-merge failed");
    try {
      ensureWorkspaceGitignoreRule(task.workspace_path, ".ai-coding-site*.code-workspace");
      ensureWorkspaceGitignoreRule(task.workspace_path, ".ai-task-summary.md");
      await sendTaskRuntimeInput(
        task.id,
        actorUserId,
        [
          "Auto-merge failed. Fix this now before waiting again.",
          "",
          "Exact error:",
          failureMessage,
          "",
          "Required next steps:",
          "1) Resolve the issue that caused this failure.",
          "2) Stage and commit ALL workspace changes (`git add -A`).",
          "3) Leave no modified, deleted, or untracked files.",
          "4) Stay in the runtime and wait for further input when done."
        ].join("\n"),
        scopeHint
      );
    } catch {
      // best effort: failure notification to runtime should not block status/error persistence
    }

    const completedAt = nowIso();
    taskContext.projectDb.prepare("UPDATE merge_records SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?").run(
      failureMessage,
      completedAt,
      mergeRecordId
    );
    await ensureIdleWaitingInput(taskContext.projectDb, task.id, actorUserId);
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      eventType: "task.auto_merge.failed",
      payload: { error: failureMessage },
      database: taskContext.projectDb
    });
  }
}

function maybeStartAutoMerge(taskId: string, context?: RuntimeTaskContext): void {
  if (autoMergeTaskIds.has(taskId)) {
    return;
  }

  let taskContext: RuntimeProjectContext;
  let task: TaskRow | undefined;
  try {
    taskContext = resolveTaskProjectContext(taskId, context);
    task = getTask(taskContext.projectDb, taskId);
  } catch {
    return;
  }

  if (!task || !task.auto_merge || !["waiting_input", "merge_ready", "merge_conflict"].includes(task.status)) {
    return;
  }

  autoMergeTaskIds.add(taskId);
  void runAutoMerge(taskId, contextHintFromProjectContext(taskContext)).finally(() => {
    autoMergeTaskIds.delete(taskId);
  });
}

export function triggerAutoMergeIfEligible(taskId: string, context?: RuntimeTaskContext): void {
  maybeStartAutoMerge(taskId, context);
}

function kickPendingAutoMergeTasks(contexts?: RuntimeProjectContext[]): void {
  const activeContexts = contexts ?? listAvailableProjectContexts();
  for (const context of activeContexts) {
    const pendingAutoMergeTasks = context.projectDb
      .prepare("SELECT id FROM tasks WHERE auto_merge = 1 AND status IN ('waiting_input', 'merge_ready', 'merge_conflict')")
      .all() as Array<{ id: string }>;
    for (const task of pendingAutoMergeTasks) {
      maybeStartAutoMerge(task.id, contextHintFromProjectContext(context));
    }
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

function quoteShellArg(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function renderShellCommand(tokens: string[]): string {
  return tokens.map(quoteShellArg).join(" ");
}

async function writePromptToTempFile(prompt: string): Promise<string> {
  const filePath = path.join(os.tmpdir(), `ai-coding-site-prompt-${makeId()}.txt`);
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

export async function startTaskRuntime(taskId: string, actorUserId: string, context?: RuntimeTaskContext): Promise<void> {
  const taskContext = resolveTaskProjectContext(taskId, context);
  const projectDb = taskContext.projectDb;
  const project = buildProjectWithConfig(taskContext.project, projectDb, taskContext.backend);
  const task = getTask(projectDb, taskId);
  if (!task) {
    throw new Error("Task not found");
  }

  if (taskIsBlocked(projectDb, task.id)) {
    throw new Error("Task is blocked by unmerged dependencies");
  }

  const initialDisallowed =
    task.mode === "plan"
      ? ["merged", "cancelled"]
      : ["merged", "cancelled", "merge_conflict"];
  if (initialDisallowed.includes(task.status)) {
    throw new Error(`Task cannot be started from status ${task.status}`);
  }

  const workspaceGitPath = path.join(task.workspace_path, ".git");
  if (!fs.existsSync(workspaceGitPath)) {
    let sourcePath = project.base_path;
    let sourceBranch = project.default_branch;
    if (task.parent_plan_task_id) {
      const parentPlanTask = getParentPlanTask(projectDb, task);
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
    if (task.mode === "plan") {
      await fs.promises.mkdir(path.join(task.workspace_path, ".ai-plan"), { recursive: true });
    }
    projectDb.prepare("UPDATE tasks SET base_commit_sha_at_create = ?, updated_at = ? WHERE id = ?").run(baseCommitSha, nowIso(), task.id);
  }

  await ensureTmuxAvailable();

  const existingSessions = getActiveSessions(projectDb, taskId);
  if (existingSessions.length) {
    let hasLiveSession = false;
    for (const session of existingSessions) {
      const alive = await hasSession(session.tmux_socket_path, session.tmux_session_name);
      if (alive) {
        hasLiveSession = true;
        break;
      }
      projectDb
        .prepare(
          "UPDATE task_sessions SET status = 'crashed', ended_at = COALESCE(ended_at, ?), last_heartbeat_at = ?, failure_reason = COALESCE(failure_reason, 'stale_session_missing_tmux') WHERE id = ?"
        )
        .run(nowIso(), nowIso(), session.id);
    }
    if (hasLiveSession) {
      // Runtime sessions are never force-stopped by server-side start requests.
      return;
    }
  }

  // Re-check task status after cleanup to avoid racing with cancel/merge actions.
  const latestBeforeStart = getTask(projectDb, task.id);
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

  const dependencySummaries = getDependencySummariesForTask(projectDb, task.id);
  const effectivePrompt = buildEffectivePrompt(project, task.task_prompt, dependencySummaries);
  projectDb.prepare("UPDATE tasks SET effective_prompt = ?, updated_at = ? WHERE id = ?").run(effectivePrompt, nowIso(), task.id);

  const built = buildCommand(task.ai_command);
  const sessionId = makeId();
  const sessionName = buildSessionName(task.id, sessionId);
  const socketPath = buildSocketPath(tmuxRoot, task.id);
  const now = nowIso();

  projectDb.prepare(
    `INSERT INTO task_sessions (
      id, task_id, tmux_session_name, tmux_socket_path, pane_id, detected_tool,
      backend_command, status, started_at, ended_at, last_heartbeat_at, last_output, exit_code, failure_reason
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'starting', ?, NULL, NULL, '', NULL, NULL)`
  ).run(sessionId, task.id, sessionName, socketPath, built.detectedTool, `${built.command} ${built.args.join(" ")}`, now);

  const latestTask = getTask(projectDb, task.id);
  if (latestTask && latestTask.status !== "in_progress") {
    projectDb.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").run(nowIso(), task.id);
    insertTransition(projectDb, {
      taskId: task.id,
      fromStatus: latestTask.status,
      toStatus: "in_progress",
      reason: "runtime_started",
      actorUserId
    });
  }

  const runtimeEnv = buildRuntimeEnv();
  let promptFilePath: string | null = null;
  try {
    promptFilePath = await writePromptToTempFile(effectivePrompt);
    const startupCommand = "bash";
    const codexInstruction = quoteShellArg(`read the prompt from ${promptFilePath} and execute it`);
    const startupScript = `codex --yolo ${codexInstruction}`;
    const startupArgs = ["-lc", startupScript];
    const tmuxStartupCommand = renderShellCommand([
      "tmux",
      "-S",
      socketPath,
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      task.workspace_path,
      startupCommand,
      ...startupArgs
    ]);
    sessionStartupTmuxCommandById.set(sessionId, tmuxStartupCommand);
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      sessionId,
      eventType: "session.starting",
      payload: {
        sessionName,
        socketPath,
        tool: built.detectedTool,
        startupTmuxCommand: tmuxStartupCommand
      },
      database: projectDb
    });
    await createSession({
      socketPath,
      sessionName,
      cwd: task.workspace_path,
      command: startupCommand,
      args: startupArgs,
      env: runtimeEnv.env
    });
    const paneId = await getPaneId(socketPath, sessionName);
    projectDb.prepare("UPDATE task_sessions SET pane_id = ?, status = 'running', last_heartbeat_at = ? WHERE id = ?").run(
      paneId,
      nowIso(),
      sessionId
    );

    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      sessionId,
      eventType: "session.running",
      payload: { paneId },
      database: projectDb
    });
  } catch (error: any) {
    sessionStartupTmuxCommandById.delete(sessionId);
    if (promptFilePath) {
      await fs.promises.rm(promptFilePath, { force: true }).catch(() => {
        // best effort cleanup; shell path also removes the file on success.
      });
    }
    const reason = String(error?.message ?? "failed to start runtime");
    const failureMeta = error?.meta && typeof error.meta === "object" ? error.meta : undefined;
    projectDb.prepare("UPDATE task_sessions SET status = 'failed', ended_at = ?, failure_reason = ? WHERE id = ?").run(nowIso(), reason, sessionId);
    transitionTaskIfNeeded(projectDb, { taskId: task.id, toStatus: "failed", reason: "runtime_start_failed", actorUserId });
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      sessionId,
      eventType: "session.failed",
      payload: {
        reason,
        startupContext: failureMeta
      },
      database: projectDb
    });
    throw new Error(reason);
  } finally {
    runtimeEnv.cleanup?.();
  }
}

export async function sendTaskRuntimeInput(
  taskId: string,
  actorUserId: string,
  text: string,
  context?: RuntimeTaskContext
): Promise<void> {
  const taskContext = resolveTaskProjectContext(taskId, context);
  const scopeHint = contextHintFromProjectContext(taskContext);
  const projectDb = taskContext.projectDb;

  let session = getLatestSession(projectDb, taskId);
  const hasRunnableSession = session && ["running", "waiting_input"].includes(session.status);
  if (!hasRunnableSession) {
    await startTaskRuntime(taskId, actorUserId, scopeHint);
    session = getLatestSession(projectDb, taskId);
  }
  if (!session || !["running", "waiting_input"].includes(session.status)) {
    throw new Error("No running session available for task");
  }

  let alive = await hasSession(session.tmux_socket_path, session.tmux_session_name);
  if (!alive) {
    await startTaskRuntime(taskId, actorUserId, scopeHint);
    session = getLatestSession(projectDb, taskId);
    if (!session || !["running", "waiting_input"].includes(session.status)) {
      throw new Error("No running session available for task");
    }
    alive = await hasSession(session.tmux_socket_path, session.tmux_session_name);
    if (!alive) {
      throw new Error("Runtime session is not alive");
    }
  }

  await sendInput(session.tmux_socket_path, session.tmux_session_name, text);
  projectDb.prepare("UPDATE task_sessions SET status = 'running', last_heartbeat_at = ? WHERE id = ?").run(nowIso(), session.id);

  transitionTaskIfNeeded(projectDb, { taskId, toStatus: "in_progress", reason: "user_input", actorUserId });

  const task = getTask(projectDb, taskId);
  if (task) {
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      sessionId: session.id,
      eventType: "session.input",
      payload: { chars: text.length },
      database: projectDb
    });
  }
}

export async function stopTaskRuntime(taskId: string, actorUserId: string): Promise<void> {
  void taskId;
  void actorUserId;
  throw new Error("Stopping runtime sessions is disabled");
}

async function monitorSession(context: RuntimeProjectContext, session: SessionRow): Promise<void> {
  const projectDb = context.projectDb;
  const scopeHint = contextHintFromProjectContext(context);
  const alive = await hasSession(session.tmux_socket_path, session.tmux_session_name);
  if (!alive) {
    sessionActivityById.delete(session.id);
    const hasSessionCommand = `tmux -S ${session.tmux_socket_path} has-session -t ${session.tmux_session_name}`;
    const startupTmuxCommand = sessionStartupTmuxCommandById.get(session.id) ?? session.backend_command;
    const missingTmuxReason = `runtime_session_missing_tmux (check: ${hasSessionCommand}; launch: ${startupTmuxCommand})`;
    if (hasNewerActiveSession(projectDb, session.task_id, session.started_at, session.id)) {
      projectDb
        .prepare(
          "UPDATE task_sessions SET status = 'crashed', ended_at = ?, last_heartbeat_at = ?, failure_reason = COALESCE(failure_reason, 'superseded_by_newer_session') WHERE id = ?"
        )
        .run(nowIso(), nowIso(), session.id);
      return;
    }
    sessionStartupTmuxCommandById.delete(session.id);
    projectDb
      .prepare(
        "UPDATE task_sessions SET status = 'crashed', ended_at = ?, last_heartbeat_at = ?, failure_reason = COALESCE(failure_reason, ?) WHERE id = ? AND ended_at IS NULL"
      )
      .run(nowIso(), nowIso(), missingTmuxReason, session.id);
    transitionTaskIfNeeded(projectDb, { taskId: session.task_id, toStatus: "failed", reason: "runtime_crashed" });
    return;
  }

  const paneStatus = await paneExitStatus(session.tmux_socket_path, session.tmux_session_name);
  if (paneStatus.dead) {
    sessionActivityById.delete(session.id);
    sessionStartupTmuxCommandById.delete(session.id);
    const stopStatus = "crashed";
    const nonZeroReason =
      paneStatus.status && paneStatus.status !== 0 ? `runtime_exited_nonzero_exit_code_${paneStatus.status}` : null;
    projectDb
      .prepare(
        "UPDATE task_sessions SET status = ?, ended_at = ?, exit_code = ?, last_heartbeat_at = ?, failure_reason = COALESCE(failure_reason, ?) WHERE id = ?"
      )
      .run(stopStatus, nowIso(), paneStatus.status, nowIso(), nonZeroReason, session.id);

    if (paneStatus.status === 0) {
      transitionTaskIfNeeded(projectDb, { taskId: session.task_id, toStatus: "merge_ready", reason: "runtime_exited_cleanly" });
      maybeStartAutoMerge(session.task_id, scopeHint);
    } else {
      transitionTaskIfNeeded(projectDb, { taskId: session.task_id, toStatus: "failed", reason: "runtime_exited_nonzero" });
    }
    return;
  }

  const output = await capturePane(session.tmux_socket_path, session.tmux_session_name);
  const outputMonitor = observeNodeOutputMaterialChange({
    projectDb,
    taskId: session.task_id,
    source: "runtime_session",
    rawOutput: output,
    debounceMs: 2_000
  });
  if (outputMonitor.materialChanged) {
    recordEvent({
      projectId: context.project.id,
      taskId: session.task_id,
      sessionId: session.id,
      eventType: "task.output.material_changed",
      payload: {
        source: outputMonitor.source,
        outputHash: outputMonitor.outputHash,
        previousOutputHash: outputMonitor.previousOutputHash
      },
      database: projectDb
    });
  }
  const signal = parseLifecycleSignals(output);
  const now = Date.now();
  const persistedHeartbeatMs = session.last_heartbeat_at ? Date.parse(session.last_heartbeat_at) : Number.NaN;
  const cached = sessionActivityById.get(session.id) ?? {
    lastOutput: session.last_output,
    lastActivityMs: Number.isFinite(persistedHeartbeatMs) ? persistedHeartbeatMs : now,
    lastPersistedAtMs: Number.isFinite(persistedHeartbeatMs) ? persistedHeartbeatMs : 0
  };
  const outputChanged = output !== cached.lastOutput;
  const idleMs = now - cached.lastActivityMs;

  if (outputChanged) {
    cached.lastOutput = output;
    cached.lastActivityMs = now;
    if (now - cached.lastPersistedAtMs >= OUTPUT_PERSIST_INTERVAL_MS) {
      projectDb.prepare("UPDATE task_sessions SET last_heartbeat_at = ?, last_output = ? WHERE id = ?").run(nowIso(), output, session.id);
      cached.lastPersistedAtMs = now;
    }
    if (session.status === "waiting_input") {
      projectDb.prepare("UPDATE task_sessions SET status = 'running' WHERE id = ?").run(session.id);
    }
    transitionTaskIfNeeded(projectDb, { taskId: session.task_id, toStatus: "in_progress", reason: "runtime_output_activity" });
  }

  if (signal.sessionStatus === "waiting_input" && session.status !== "waiting_input") {
    projectDb.prepare("UPDATE task_sessions SET status = 'waiting_input', last_heartbeat_at = COALESCE(last_heartbeat_at, ?) WHERE id = ?").run(
      nowIso(),
      session.id
    );
  }

  if (!outputChanged && session.status === "running" && idleMs >= WAITING_INPUT_IDLE_MS) {
    projectDb.prepare("UPDATE task_sessions SET status = 'waiting_input' WHERE id = ?").run(session.id);
    transitionTaskIfNeeded(projectDb, { taskId: session.task_id, toStatus: "waiting_input", reason: "runtime_idle_no_output" });
    maybeStartAutoMerge(session.task_id, scopeHint);
  }

  if (signal.taskStatus) {
    transitionTaskIfNeeded(projectDb, {
      taskId: session.task_id,
      toStatus: signal.taskStatus,
      reason: signal.reason || "adapter_signal"
    });
    if (signal.taskStatus === "waiting_input") {
      maybeStartAutoMerge(session.task_id, scopeHint);
    } else if (signal.taskStatus === "merge_ready") {
      maybeStartAutoMerge(session.task_id, scopeHint);
    }
  }

  sessionActivityById.set(session.id, cached);
}

export async function recoverRuntimeSessions(): Promise<void> {
  await ensureTmuxAvailable();
  const contexts = listAvailableProjectContexts();
  kickPendingAutoMergeTasks(contexts);

  for (const context of contexts) {
    const rows = listSessionsForHeartbeat(context.projectDb);

    for (const row of rows) {
      const alive = await hasSession(row.tmux_socket_path, row.tmux_session_name);
      if (!alive) {
        const hasSessionCommand = `tmux -S ${row.tmux_socket_path} has-session -t ${row.tmux_session_name}`;
        const startupTmuxCommand = sessionStartupTmuxCommandById.get(row.id) ?? row.backend_command;
        const missingTmuxReason = `recovery_missing_tmux (check: ${hasSessionCommand}; launch: ${startupTmuxCommand})`;
        sessionStartupTmuxCommandById.delete(row.id);
        context.projectDb
          .prepare(
            "UPDATE task_sessions SET status = 'crashed', ended_at = ?, last_heartbeat_at = ?, failure_reason = COALESCE(failure_reason, ?) WHERE id = ?"
          )
          .run(nowIso(), nowIso(), missingTmuxReason, row.id);
        transitionTaskIfNeeded(context.projectDb, { taskId: row.task_id, toStatus: "failed", reason: "recovery_missing_tmux" });
      }
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
    const contexts = listAvailableProjectContexts();
    kickPendingAutoMergeTasks(contexts);
    for (const context of contexts) {
      const activeSessions = listSessionsForHeartbeat(context.projectDb);

      for (const session of activeSessions) {
        try {
          await monitorSession(context, session);
        } catch (error: any) {
          if (hasNewerActiveSession(context.projectDb, session.task_id, session.started_at, session.id)) {
            sessionStartupTmuxCommandById.delete(session.id);
            context.projectDb
              .prepare(
                "UPDATE task_sessions SET status = 'crashed', ended_at = ?, failure_reason = COALESCE(failure_reason, 'superseded_by_newer_session'), last_heartbeat_at = ? WHERE id = ?"
              )
              .run(nowIso(), nowIso(), nowIso(), session.id);
            continue;
          }
          sessionStartupTmuxCommandById.delete(session.id);
          context.projectDb.prepare("UPDATE task_sessions SET status = 'crashed', ended_at = ?, failure_reason = ?, last_heartbeat_at = ? WHERE id = ?").run(
            nowIso(),
            String(error?.message ?? "heartbeat failure"),
            nowIso(),
            session.id
          );
          transitionTaskIfNeeded(context.projectDb, { taskId: session.task_id, toStatus: "failed", reason: "heartbeat_failure" });
        }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}
