import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { db as appDb, isProjectDbError, resolveProjectDatabase } from "../db/index.js";
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
import { buildIdeResumeCommand, ideSessionRunning, prepareIdeWorkspace, startIdeSession, stopIdeSession } from "../services/ide.js";
import { parsePlanOutput } from "../services/planParser.js";
import { buildEffectivePrompt } from "../services/promptBuilder.js";
import { kickTaskQueueProcessing } from "../services/queue.js";
import { buildAutomationVisibility } from "../services/automationVisibility.js";
import { buildInitialNodeMetadata, readNodeMetadata, serializeNodeMetadata, writeNodeMetadata } from "../services/orchestration/metadata.js";
import { readReplanControl } from "../services/orchestration/idempotency.js";
import { runParentCompletionFeedbackLoop } from "../services/orchestration/completion.js";
import {
  buildConflictResolutionArtifact,
  buildMergeGateChecklist,
  describeFailedMergeGates,
  requiredMergeGatesPassed
} from "../services/orchestration/conflictResolution.js";
import {
  buildDependencyDiagnostics,
  partitionDependenciesByTier,
  resolveAndValidateNodeDependencies,
  validateProposedNodeGraph
} from "../services/orchestration/dependencyGraph.js";
import { enqueueOrchestrationJob, kickOrchestrationJobQueueProcessing } from "../services/orchestration/jobQueue.js";
import { assertTaskStatusTransition, evaluateParentCompletionGuards } from "../services/orchestration/stateMachine.js";
import { sendTaskRuntimeInputWorker, startTaskRuntimeWorker } from "../services/runtimeWorker.js";
import { startBuiltinWorkflowForTierTask, type BuiltinWorkflowTier } from "../services/workflowBuiltins.js";
import { hasSession } from "../services/tmux.js";
import type {
  IdeInstanceRow,
  MergeRecordRow,
  NodeDependencyRef,
  PlanRevisionItemDependencyRow,
  PlanRevisionItemRow,
  PlanRevisionRow,
  ProjectRow,
  TaskRow,
  TaskSessionRow,
  TaskStatus,
  TaskTransitionRow
} from "../types.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

const mergeLocks = new Set<string>();
const PLAN_OUTPUT_RELATIVE_PATH = ".ai-plan/latest-plan.yaml";
const MAX_SUB_PLAN_RECURSION_DEPTH = 6;

export type CliServiceErrorCode = "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE";

export class CliServiceError extends Error {
  readonly code: CliServiceErrorCode;

  constructor(code: CliServiceErrorCode, message: string) {
    super(message);
    this.name = "CliServiceError";
    this.code = code;
  }
}

function throwIfProjectDbError(error: unknown): never {
  if (isProjectDbError(error)) {
    if (error.code === "PROJECT_DB_UNAVAILABLE") {
      throw new CliServiceError("UNAVAILABLE", error.message);
    }
    throw new CliServiceError("CONFLICT", error.message);
  }
  throw error;
}

function projectForUser(projectId: string, userId: string): ProjectRow | undefined {
  return appDb
    .prepare(
      `SELECT p.*
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE p.id = ? AND pm.user_id = ?`
    )
    .get(projectId, userId) as ProjectRow | undefined;
}

function memberProjectsForUser(userId: string): ProjectRow[] {
  return appDb
    .prepare(
      `SELECT p.*
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = ?`
    )
    .all(userId) as ProjectRow[];
}

type UserProjectContext = {
  project: ProjectRow;
  projectDb: Database.Database;
};

function projectDatabaseFor(project: ProjectRow, intent: "read" | "write"): Database.Database {
  try {
    return resolveProjectDatabase({
      appDb,
      projectId: project.id,
      basePath: project.base_path,
      intent
    }).database;
  } catch (error) {
    throwIfProjectDbError(error);
  }
}

function contextsForUser(params: { userId: string; intent: "read" | "write"; projectId?: string }): UserProjectContext[] {
  if (params.projectId) {
    const project = projectForUser(params.projectId, params.userId);
    if (!project) {
      throw new CliServiceError("NOT_FOUND", "Project not found");
    }
    return [{ project, projectDb: projectDatabaseFor(project, params.intent) }];
  }

  return memberProjectsForUser(params.userId).map((project) => ({
    project,
    projectDb: projectDatabaseFor(project, params.intent)
  }));
}

function taskForUser(
  taskId: string,
  userId: string,
  intent: "read" | "write"
): { task: TaskRow; project: ProjectRow; projectDb: Database.Database } | undefined {
  const projects = memberProjectsForUser(userId);
  for (const project of projects) {
    const projectDb = projectDatabaseFor(project, intent);
    const task = projectDb
      .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
      .get(taskId, project.id) as TaskRow | undefined;
    if (task) {
      return { task, project, projectDb };
    }
  }
  return undefined;
}

function taskForUserWithFilters(
  params: { taskId: string; userId: string; intent: "read" | "write"; projectId?: string; planId?: string }
): { task: TaskRow; project: ProjectRow; projectDb: Database.Database } | undefined {
  const contexts = contextsForUser({ userId: params.userId, intent: params.intent, projectId: params.projectId });
  for (const context of contexts) {
    const task = context.projectDb
      .prepare(
        `SELECT *
         FROM tasks
         WHERE id = ?
           AND project_id = ?
           AND (? IS NULL OR parent_plan_task_id = ?)
         LIMIT 1`
      )
      .get(params.taskId, context.project.id, params.planId ?? null, params.planId ?? null) as TaskRow | undefined;
    if (task) {
      return { task, project: context.project, projectDb: context.projectDb };
    }
  }
  return undefined;
}

function planForUser(
  planTaskId: string,
  userId: string,
  intent: "read" | "write"
): { plan: TaskRow; project: ProjectRow; projectDb: Database.Database } | undefined {
  const projects = memberProjectsForUser(userId);
  for (const project of projects) {
    const projectDb = projectDatabaseFor(project, intent);
    const plan = projectDb
      .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ? AND mode = 'plan'")
      .get(planTaskId, project.id) as TaskRow | undefined;
    if (plan) {
      return { plan, project, projectDb };
    }
  }
  return undefined;
}

function parentPlanTaskFor(projectDb: Database.Database, task: TaskRow): TaskRow | undefined {
  if (!task.parent_plan_task_id) return undefined;
  return projectDb
    .prepare("SELECT * FROM tasks WHERE id = ? AND mode = 'plan'")
    .get(task.parent_plan_task_id) as TaskRow | undefined;
}

function resolveAiCommand(inputAiCommand: string | undefined, userId: string): string {
  if (inputAiCommand) {
    return inputAiCommand;
  }
  const settings = appDb
    .prepare("SELECT default_ai_command, default_ai_commands FROM user_settings WHERE user_id = ?")
    .get(userId) as { default_ai_command: string; default_ai_commands?: string } | undefined;
  if (!settings) {
    return "codex --yolo {prompt}";
  }

  try {
    const parsed = JSON.parse(settings.default_ai_commands ?? "[]");
    if (Array.isArray(parsed)) {
      const first = parsed.find((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (first) {
        return first.trim();
      }
    }
  } catch {
    // Fall through to legacy value.
  }

  return settings.default_ai_command || "codex --yolo {prompt}";
}

function serializeTask(projectDb: Database.Database, task: TaskRow) {
  const dependencyTaskIds = projectDb
    .prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
    .all(task.id) as Array<{ dependency_task_id: string }>;
  const blockedByTaskIds = projectDb
    .prepare(
      `SELECT td.dependency_task_id
       FROM task_dependencies td
       JOIN tasks dep ON dep.id = td.dependency_task_id
       WHERE td.task_id = ? AND dep.status != 'merged'
       ORDER BY dep.created_at ASC`
    )
    .all(task.id) as Array<{ dependency_task_id: string }>;
  const { metadata: nodeMetadata } = readNodeMetadata({
    projectDb,
    task,
    dependencyTaskIds: dependencyTaskIds.map((x) => x.dependency_task_id)
  });
  const replan = readReplanControl(nodeMetadata);
  const autoMode = typeof nodeMetadata.custom?.auto_mode === "boolean"
    ? Boolean(nodeMetadata.custom?.auto_mode)
    : true;

  return {
    id: task.id,
    projectId: task.project_id,
    title: task.title,
    taskPrompt: task.task_prompt,
    result: task.result,
    effectivePrompt: task.effective_prompt,
    aiCommand: task.ai_command,
    autoMerge: Boolean(task.auto_merge),
    autoStart: Boolean(task.auto_start),
    autoMergeOnComplete: Boolean(task.auto_merge_on_complete),
    mode: task.mode,
    nodeMetadata,
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
    orchestrationControls: {
      autoMode,
      replan: {
        maxIterations: replan.maxIterations,
        iterationsUsed: replan.iterationsUsed,
        remainingIterations: Math.max(0, replan.maxIterations - replan.iterationsUsed),
        budgetOverride: replan.budgetOverride,
        gapHashesSeen: replan.gapHashesSeen
      }
    },
    createdByUserId: task.created_by_user_id,
    createdAt: task.created_at,
    updatedAt: task.updated_at
  };
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

function recordTaskTransition(params: {
  projectDb: Database.Database;
  taskId: string;
  fromStatus: string;
  toStatus: string;
  reasonCode: string;
  reasonDetail?: string;
  actorUserId: string;
}): void {
  const reason = params.reasonDetail ? `${params.reasonCode}: ${params.reasonDetail}` : params.reasonCode;
  params.projectDb.prepare(
    `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(makeId(), params.taskId, params.fromStatus, params.toStatus, reason, params.actorUserId, nowIso());
}

function setTaskStatus(
  projectDb: Database.Database,
  task: TaskRow,
  nextStatus: TaskStatus,
  reasonCode: string,
  actorUserId: string,
  updates?: {
    mergedAt?: string | null;
    mergedByUserId?: string | null;
    headCommitSha?: string | null;
    cancelReason?: string | null;
  }
): TaskRow {
  const now = nowIso();
  const hasBlockingDependencies = taskIsBlocked(projectDb, task.id);
  const hasPendingChildren = task.mode === "plan" ? hasUnmergedPlanChildren(projectDb, task.id) : false;
  const parentGuards = evaluateParentCompletionGuards(projectDb, task);
  let transitionLifecycles: { fromLifecycle: string; toLifecycle: string };
  try {
    transitionLifecycles = assertTaskStatusTransition({
      mode: task.mode,
      fromStatus: task.status,
      toStatus: nextStatus,
      hasBlockingDependencies,
      hasPendingChildren,
      parentGuards
    });
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "illegal transition"));
  }

  projectDb.transaction(() => {
    const fromStatus = task.status;
    if (nextStatus === "merged") {
      projectDb
        .prepare(
          "UPDATE tasks SET status = ?, cancel_reason = NULL, merged_at = ?, merged_by_user_id = ?, head_commit_sha = ?, updated_at = ? WHERE id = ?"
        )
        .run(nextStatus, updates?.mergedAt ?? now, updates?.mergedByUserId ?? actorUserId, updates?.headCommitSha ?? null, now, task.id);
    } else {
      projectDb
        .prepare("UPDATE tasks SET status = ?, cancel_reason = ?, merged_at = NULL, merged_by_user_id = NULL, updated_at = ? WHERE id = ?")
        .run(nextStatus, updates?.cancelReason ?? null, now, task.id);
    }
    recordTaskTransition({
      projectDb,
      taskId: task.id,
      fromStatus,
      toStatus: nextStatus,
      reasonCode,
      reasonDetail: `lifecycle ${transitionLifecycles.fromLifecycle}->${transitionLifecycles.toLifecycle}`,
      actorUserId
    });
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      eventType: "task.status_changed",
      payload: {
        fromStatus,
        toStatus: nextStatus,
        reasonCode,
        lifecycle: transitionLifecycles
      },
      database: projectDb
    });
  })();
  return projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
}

function latestSession(projectDb: Database.Database, taskId: string): TaskSessionRow | undefined {
  return projectDb
    .prepare("SELECT * FROM task_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(taskId) as TaskSessionRow | undefined;
}

function latestIde(projectDb: Database.Database, taskId: string): IdeInstanceRow | undefined {
  return projectDb
    .prepare("SELECT * FROM ide_instances WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT 1")
    .get(taskId) as IdeInstanceRow | undefined;
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

function dependencyTaskIdsFor(projectDb: Database.Database, taskId: string): string[] {
  return (
    projectDb
      .prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Array<{ dependency_task_id: string }>
  ).map((row) => row.dependency_task_id);
}

function nodeTierForTask(projectDb: Database.Database, task: TaskRow): "epoch" | "phase" | "plan" | "task" | "exec" {
  return readNodeMetadata({
    projectDb,
    task,
    dependencyTaskIds: dependencyTaskIdsFor(projectDb, task.id)
  }).metadata.tier;
}

function hasUnmergedPlanChildren(projectDb: Database.Database, planTaskId: string): boolean {
  const row = projectDb
    .prepare("SELECT id FROM tasks WHERE parent_plan_task_id = ? AND status != 'merged' LIMIT 1")
    .get(planTaskId) as { id: string } | undefined;
  return Boolean(row?.id);
}

function workspaceIsClean(status: Awaited<ReturnType<typeof getWorkspaceGitStatus>>): boolean {
  return status.untracked === 0 && status.staged === 0 && status.unstaged === 0 && status.conflicted === 0;
}

function refreshTaskRow(projectDb: Database.Database, taskId: string): TaskRow | undefined {
  return projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
}

async function maybeAdvanceParentPlanAfterChildMerge(params: {
  project: ProjectRow;
  projectDb: Database.Database;
  mergedTask: TaskRow;
  actorUserId: string;
}): Promise<void> {
  if (!params.mergedTask.parent_plan_task_id) {
    return;
  }

  const parentPlan = planTaskInProject(params.projectDb, params.project.id, params.mergedTask.parent_plan_task_id);
  if (!parentPlan) {
    return;
  }

  if (hasUnmergedPlanChildren(params.projectDb, parentPlan.id)) {
    if (["queued", "in_progress", "waiting_input"].includes(parentPlan.status)) {
      const awaitingChildren = setTaskStatus(
        params.projectDb,
        parentPlan,
        "awaiting_children",
        "plan_waiting_for_children",
        params.actorUserId
      );
      recordEvent({
        projectId: awaitingChildren.project_id,
        taskId: awaitingChildren.id,
        eventType: "plan.awaiting_children",
        payload: {},
        database: params.projectDb
      });
    }
    return;
  }

  let latestParent = refreshTaskRow(params.projectDb, parentPlan.id);
  if (!latestParent || ["merged", "cancelled", "failed"].includes(latestParent.status)) {
    return;
  }

  if (latestParent.status === "merge_conflict") {
    recordEvent({
      projectId: latestParent.project_id,
      taskId: latestParent.id,
      eventType: "plan.auto_merge_on_complete.blocked",
      payload: { reason: "merge_conflict" },
      database: params.projectDb
    });
    return;
  }

  if (latestParent.status !== "merge_ready") {
    const completion = await runParentCompletionFeedbackLoop({
      projectDb: params.projectDb,
      projectId: latestParent.project_id,
      parentTaskId: latestParent.id
    });
    if (!completion?.verified) {
      recordEvent({
        projectId: latestParent.project_id,
        taskId: latestParent.id,
        eventType: "plan.parent_completion.blocked",
        payload: {
          reason: completion?.budgetExhausted ? "verification_failed_budget_exhausted" : "verification_failed_delta_planned"
        },
        database: params.projectDb
      });
      return;
    }

    latestParent = refreshTaskRow(params.projectDb, latestParent.id);
    if (!latestParent) return;

    try {
      latestParent = setTaskStatus(
        params.projectDb,
        latestParent,
        "merge_ready",
        "plan_children_merged_auto_merge_ready",
        params.actorUserId
      );
      recordEvent({
        projectId: latestParent.project_id,
        taskId: latestParent.id,
        eventType: "plan.mark_merge_ready",
        payload: { auto: true, reason: "children_merged" },
        database: params.projectDb
      });
    } catch (error: any) {
      recordEvent({
        projectId: latestParent.project_id,
        taskId: latestParent.id,
        eventType: "plan.parent_completion.blocked",
        payload: { reason: String(error?.message ?? "parent completion guard failed") },
        database: params.projectDb
      });
      return;
    }
  }

  if (!latestParent.auto_merge_on_complete) {
    return;
  }

  recordEvent({
    projectId: latestParent.project_id,
    taskId: latestParent.id,
    eventType: "plan.auto_merge_on_complete.started",
    payload: { reason: "children_merged" },
    database: params.projectDb
  });

  try {
    await mergePlan({ userId: params.actorUserId, planId: latestParent.id });
  } catch (error: any) {
    recordEvent({
      projectId: latestParent.project_id,
      taskId: latestParent.id,
      eventType: "plan.auto_merge_on_complete.failed",
      payload: { error: String(error?.message ?? "plan auto-merge failed") },
      database: params.projectDb
    });
  }
}

type TaskGitTopology = {
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
      throw new CliServiceError("CONFLICT", "Parent plan task not found");
    }
    const planBranch = taskBranchName(parentPlan.id);
    return {
      pullRemoteRef: planBranch,
      mergeTargetPath: parentPlan.workspace_path,
      mergeTargetBranch: planBranch,
      syncMergeTargetFromOrigin: false,
      mergeLockKey: `repo:${path.resolve(parentPlan.workspace_path)}`
    };
  }

  return {
    pullRemoteRef: params.project.default_branch,
    mergeTargetPath: params.project.base_path,
    mergeTargetBranch: params.project.default_branch,
    syncMergeTargetFromOrigin: true,
    mergeLockKey: `repo:${path.resolve(params.project.base_path)}`
  };
}

function planOutputFilePath(workspacePath: string): string {
  return path.join(workspacePath, PLAN_OUTPUT_RELATIVE_PATH);
}

function planTaskInProject(projectDb: Database.Database, projectId: string, planTaskId: string): TaskRow | undefined {
  return projectDb
    .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ? AND mode = 'plan'")
    .get(planTaskId, projectId) as TaskRow | undefined;
}

function resolvePlanDepth(
  projectDb: Database.Database,
  planTaskId: string,
  cache: Map<string, number>,
  visiting: Set<string> = new Set<string>()
): number {
  const cached = cache.get(planTaskId);
  if (cached !== undefined) {
    return cached;
  }
  if (visiting.has(planTaskId)) {
    throw new CliServiceError("CONFLICT", "Invalid plan topology: cyclic parent plan relationship detected");
  }
  visiting.add(planTaskId);
  const plan = projectDb.prepare("SELECT * FROM tasks WHERE id = ? AND mode = 'plan'").get(planTaskId) as TaskRow | undefined;
  if (!plan) {
    throw new CliServiceError("VALIDATION", "Invalid plan topology: referenced parent plan was not found");
  }
  const depth =
    plan.parent_plan_task_id === null ? 0 : resolvePlanDepth(projectDb, plan.parent_plan_task_id, cache, visiting) + 1;
  visiting.delete(planTaskId);
  cache.set(planTaskId, depth);
  return depth;
}

function getLatestSessionOutput(projectDb: Database.Database, taskId: string): string {
  const row = projectDb
    .prepare("SELECT last_output FROM task_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(taskId) as { last_output: string } | undefined;
  return (row?.last_output ?? "").trim();
}

function readPlanOutputSource(projectDb: Database.Database, plan: TaskRow): { raw: string; source: "file" | "session_output"; filePath: string } {
  const filePath = planOutputFilePath(plan.workspace_path);
  try {
    const fileValue = fs.readFileSync(filePath, "utf8").trim();
    if (fileValue) {
      return { raw: fileValue, source: "file", filePath };
    }
  } catch {
    // Fall through to session output.
  }

  const raw = getLatestSessionOutput(projectDb, plan.id);
  return { raw, source: "session_output", filePath };
}

function markPlanLifecycleFlags(projectDb: Database.Database, plan: TaskRow, updates: { synthesisPassed?: boolean; verificationPassed?: boolean; reasonCode: string }): void {
  const metadataRead = readNodeMetadata({ projectDb, task: plan, dependencyTaskIds: [] });
  const metadata = metadataRead.metadata;
  metadata.lifecycle = {
    synthesis_passed: updates.synthesisPassed ?? metadata.lifecycle?.synthesis_passed,
    verification_passed: updates.verificationPassed ?? metadata.lifecycle?.verification_passed,
    last_transition_reason_code: updates.reasonCode
  };
  writeNodeMetadata({
    projectDb,
    taskId: plan.id,
    metadata
  });
}

function nextRevisionNumber(projectDb: Database.Database, planTaskId: string): number {
  const row = projectDb
    .prepare("SELECT COALESCE(MAX(revision_number), 0) AS max_number FROM plan_revisions WHERE plan_task_id = ?")
    .get(planTaskId) as { max_number: number };
  return Number(row.max_number) + 1;
}

function planningFormatInstructions(): string {
  return [
    "CLI Usage Context:",
    "- Run commands from /server.",
    "- First run `npm run cli -- --help` to view all available commands and options.",
    "- Execute commands with `npm run cli -- <command>`.",
    "- Available commands:",
    "  - tasks list [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks all [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks active [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks get <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks summary <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks details <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks create --project <projectId> --title <title> --prompt <prompt> [--ai-command <cmd>] [--depends-on a,b] [--auto-merge]",
    "  - tasks start <taskId>",
    "  - tasks input <taskId> --text <text>",
    "  - tasks pull-main <taskId>",
    "  - plans list [--project-id <projectId>] [--plan-id <planId>]",
    "  - plans create --project <projectId> --title <title> --prompt <prompt> [--ai-command <cmd>] [--auto-start] [--auto-merge-on-complete] [--parent-plan-id <planId>]",
    "  - plans get <planId>",
    "  - plans review <planId>",
    "  - plans extract <planId>",
    "  - plans regenerate <planId> --feedback <text>",
    "  - plans approve <planId> [--auto-merge-item-keys a,b] [--auto-start] [--auto-merge-on-complete] [--parent-plan-id <planId>] [--task-edits-file path.json]",
    "  - info <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  - session start <taskId>",
    "  - session input <taskId> --text <text>",
    "  - create task ...",
    "  - create plan ...",
    "  - review task <taskId>",
    "  - review plan <planId>",
    "  - review <taskId>",
    "  - ide status <taskId>",
    "  - ide start <taskId>",
    "  - ide stop <taskId>",
    "  - ready_merge <taskId>",
    "  - ready_merge task <taskId>",
    "  - ready_merge plan <planId>",
    "  - merge <taskId>",
    "  - merge task <taskId>",
    "  - merge plan <planId>",
    "",
    "Planner Output Contract:",
    "Return the final plan as YAML only.",
    "Wrap YAML in a fenced block using ```yaml.",
    "Top-level key must be `tasks:` (or `items:` for compatibility).",
    "Optional top-level defaults:",
    "- auto_start: default for sub_plan items",
    "- auto_merge_on_complete: default for sub_plan items",
    "- auto_merge_item_keys: execution item ids that should auto-merge",
    "Each plan item entry must include:",
    "- id: unique task identifier",
    "- title: short task title",
    "- prompt: implementation prompt for that task",
    "- item_type: execution_task | sub_plan (optional, defaults to execution_task)",
    "- depends_on: list of task ids (optional)",
    "Dependencies may reference any prior item type and must form an acyclic graph.",
    "Optional item-level automation:",
    "- execution_task: auto_merge: true|false",
    "- sub_plan: auto_start: true|false, auto_merge_on_complete: true|false",
    "After generating YAML, write the exact same YAML to this file in the workspace:",
    PLAN_OUTPUT_RELATIVE_PATH
  ].join("\n");
}

function buildPlanTaskPrompt(userPrompt: string): string {
  return `${userPrompt.trim()}\n\n${planningFormatInstructions()}`.trim();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createIdeToken(): string {
  return randomBytes(24).toString("hex");
}

function issueIdeLaunchUrl(params: {
  projectDb: Database.Database;
  taskId: string;
  ideId: string;
  folderPath?: string;
  workspacePath?: string;
}): string {
  const rawToken = createIdeToken();
  params.projectDb.prepare("UPDATE ide_instances SET access_token_hash = ?, last_heartbeat_at = ? WHERE id = ?").run(
    hashToken(rawToken),
    nowIso(),
    params.ideId
  );
  const folderQuery = params.folderPath ? `&folder=${encodeURIComponent(params.folderPath)}` : "";
  const workspaceQuery = params.workspacePath ? `&workspace=${encodeURIComponent(params.workspacePath)}` : "";
  return `/api/tasks/${params.taskId}/ide/view?token=${encodeURIComponent(rawToken)}${workspaceQuery}${folderQuery}`;
}

async function buildIdeLaunchUrl(projectDb: Database.Database, task: TaskRow, ideId: string): Promise<string> {
  try {
    const session = latestSession(projectDb, task.id);
    let attachableSession: TaskSessionRow | null = null;
    let resumeCommand: string | null = session
      ? buildIdeResumeCommand({
          detectedTool: session.detected_tool,
          backendCommand: session.backend_command
        })
      : null;
    if (session && ["starting", "running", "waiting_input"].includes(session.status)) {
      const alive = await hasSession(session.tmux_socket_path, session.tmux_session_name);
      if (alive) {
        attachableSession = session;
      } else {
        const now = nowIso();
        projectDb
          .prepare(
            "UPDATE task_sessions SET status = 'crashed', ended_at = COALESCE(ended_at, ?), last_heartbeat_at = ?, failure_reason = COALESCE(failure_reason, 'ide_open_missing_tmux') WHERE id = ?"
          )
          .run(now, now, session.id);
      }
    }
    const openPath = await prepareIdeWorkspace({
      taskId: task.id,
      workspacePath: task.workspace_path,
      hasSessionHistory: Boolean(session),
      tmuxSocketPath: attachableSession?.tmux_socket_path,
      tmuxSessionName: attachableSession?.tmux_session_name,
      resumeCommand
    });
    if (openPath.endsWith(".code-workspace")) {
      return issueIdeLaunchUrl({ projectDb, taskId: task.id, ideId, workspacePath: openPath });
    }
    return issueIdeLaunchUrl({ projectDb, taskId: task.id, ideId, folderPath: openPath });
  } catch {
    return issueIdeLaunchUrl({ projectDb, taskId: task.id, ideId, folderPath: task.workspace_path });
  }
}

export async function listTasks(params: { userId: string; projectId: string }) {
  return listAllTasks({ userId: params.userId, projectId: params.projectId });
}

export async function listAllTasks(params: { userId: string; projectId?: string; planId?: string }) {
  const contexts = contextsForUser({ userId: params.userId, intent: "read", projectId: params.projectId });
  const tasks = contexts.flatMap(({ project, projectDb }) => {
    const rows = projectDb
      .prepare(
        `SELECT *
         FROM tasks
         WHERE project_id = ?
           AND mode = 'execution'
           AND (? IS NULL OR parent_plan_task_id = ?)
         ORDER BY created_at DESC`
      )
      .all(project.id, params.planId ?? null, params.planId ?? null) as TaskRow[];
    return rows.map((task) => serializeTask(projectDb, task));
  });
  return { tasks };
}

export async function listActiveTasks(params: { userId: string; projectId?: string; planId?: string }) {
  const contexts = contextsForUser({ userId: params.userId, intent: "read", projectId: params.projectId });
  const tasks = contexts.flatMap(({ project, projectDb }) => {
    const rows = projectDb
      .prepare(
        `SELECT *
         FROM tasks
         WHERE project_id = ?
           AND mode = 'execution'
           AND status IN ('queued', 'in_progress', 'waiting_input', 'merge_ready', 'merge_conflict')
           AND (? IS NULL OR parent_plan_task_id = ?)
         ORDER BY created_at DESC`
      )
      .all(project.id, params.planId ?? null, params.planId ?? null) as TaskRow[];
    return rows.map((task) => serializeTask(projectDb, task));
  });
  return { tasks };
}

export async function createTask(params: {
  userId: string;
  projectId: string;
  title: string;
  taskPrompt: string;
  aiCommand?: string;
  autoMerge?: boolean;
  dependencyTaskIds?: string[];
  dependencyNodeRefs?: NodeDependencyRef[];
}) {
  const project = projectForUser(params.projectId, params.userId);
  if (!project) {
    throw new CliServiceError("NOT_FOUND", "Project not found");
  }
  const projectDb = projectDatabaseFor(project, "write");
  if (project.clone_status !== "ready") {
    throw new CliServiceError("CONFLICT", "Project base repository is not ready");
  }
  if (params.title.trim().length < 2) {
    throw new CliServiceError("VALIDATION", "title must be at least 2 characters");
  }
  if (params.taskPrompt.trim().length === 0) {
    throw new CliServiceError("VALIDATION", "prompt is required");
  }

  const id = makeId();
  const now = nowIso();
  const workspacePath = path.join(path.dirname(project.base_path), "tasks", id);
  const aiCommand = resolveAiCommand(params.aiCommand, params.userId);
  const effectivePrompt = buildEffectivePrompt(project, params.taskPrompt);
  const dependencyTaskIds = params.dependencyTaskIds ?? [];
  const autoMerge = Boolean(params.autoMerge);
  let dependencyResolution: ReturnType<typeof resolveAndValidateNodeDependencies>;
  try {
    dependencyResolution = resolveAndValidateNodeDependencies({
      projectDb,
      projectId: project.id,
      nodeId: id,
      nodeTier: "task",
      dependencyTaskIds,
      dependencyNodeRefs: params.dependencyNodeRefs
    });
  } catch (error: any) {
    throw new CliServiceError("VALIDATION", String(error?.message ?? "Invalid dependencies"));
  }
  const dependencies = dependencyResolution.taskDependencies;
  const unresolvedDependencies = dependencyResolution.unresolvedTaskDependencies;
  const isBlocked = unresolvedDependencies.length > 0;
  const partitionedDeps = partitionDependenciesByTier(dependencyResolution.normalizedDependencies, "task");

  let baseCommitSha: string;
  try {
    baseCommitSha = await getHeadCommitSha(project.base_path);
    if (!isBlocked) {
      await cloneLocalBaseToWorkspace({ basePath: project.base_path, baseBranch: project.default_branch, workspacePath });
      await createTaskBranch(workspacePath, id);
    }
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "Failed to initialize task workspace"));
  }

  projectDb.transaction(() => {
    const metadataJson = serializeNodeMetadata(
      buildInitialNodeMetadata({
        task: {
          id,
          project_id: project.id,
          mode: "execution",
          metadata_json: null,
          auto_merge: autoMerge ? 1 : 0,
          auto_start: 0,
          auto_merge_on_complete: 0,
          parent_plan_task_id: null,
          source_plan_revision_id: null,
          source_plan_item_key: null
        },
        dependencyTaskIds: dependencies.map((dependency) => dependency.id),
        tier: "task",
        sameTierDependencies: partitionedDeps.sameTierDependencies,
        crossTierDependencies: partitionedDeps.crossTierDependencies
      })
    );
    projectDb.prepare(
      `INSERT INTO tasks (
        id, project_id, title, task_prompt, result, effective_prompt, ai_command,
        auto_merge, metadata_json,
        mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
        status, workspace_path, base_commit_sha_at_create, head_commit_sha,
        cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, 'execution', NULL, NULL, NULL, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
    ).run(
      id,
      project.id,
      params.title,
      params.taskPrompt,
      effectivePrompt,
      aiCommand,
      autoMerge ? 1 : 0,
      metadataJson,
      workspacePath,
      baseCommitSha,
      params.userId,
      now,
      now
    );

    projectDb.prepare(
      `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(makeId(), id, "null", "queued", isBlocked ? "task_created_blocked" : "task_created", params.userId, now);

    for (const dependency of dependencies) {
      projectDb.prepare("INSERT INTO task_dependencies (task_id, dependency_task_id, created_at) VALUES (?, ?, ?)").run(id, dependency.id, now);
    }
  })();

  recordEvent({
    projectId: project.id,
    taskId: id,
    eventType: "task.created",
    database: projectDb,
    payload: {
      title: params.title,
      aiCommand,
      autoMerge,
      workspacePath,
      baseCommitShaAtCreate: baseCommitSha,
      dependencyTaskIds: dependencies.map((x) => x.id),
      dependencyNodeRefs: dependencyResolution.normalizedDependencies,
      blockedByTaskIds: unresolvedDependencies.map((x) => x.id),
      blocked: isBlocked
    }
  });

  const task = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
  kickTaskQueueProcessing();
  return { task: serializeTask(projectDb, task) };
}

export async function getTaskInfo(params: { userId: string; taskId: string }) {
  const scopedTask = taskForUser(params.taskId, params.userId, "read");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Task not found");
  }
  const { task, projectDb } = scopedTask;
  const transitions = projectDb
    .prepare("SELECT * FROM task_state_transitions WHERE task_id = ? ORDER BY created_at ASC")
    .all(task.id) as TaskTransitionRow[];
  const mergeRecords = projectDb
    .prepare("SELECT * FROM merge_records WHERE task_id = ? ORDER BY created_at DESC")
    .all(task.id) as MergeRecordRow[];

  let gitStatus: Awaited<ReturnType<typeof getWorkspaceGitStatus>> | null = null;
  try {
    gitStatus = await getWorkspaceGitStatus(task.workspace_path);
  } catch {
    gitStatus = null;
  }
  const visibility = buildAutomationVisibility(projectDb, task);
  const dependencyDiagnostics = buildDependencyDiagnostics({ projectDb, task });

  return {
    task: serializeTask(projectDb, task),
    transitions: transitions.map(serializeTransition),
    session: serializeSession(latestSession(projectDb, task.id)),
    ide: serializeIde(latestIde(projectDb, task.id)),
    gitStatus,
    mergeRecords: mergeRecords.map(serializeMergeRecord),
    dependencyDiagnostics,
    automation: visibility.automation,
    waiting: visibility.waiting,
    orchestration: visibility.orchestration
  };
}

export async function getTaskDetails(params: { userId: string; taskId: string; projectId?: string; planId?: string }) {
  const scopedTask = taskForUserWithFilters({
    taskId: params.taskId,
    userId: params.userId,
    intent: "read",
    projectId: params.projectId,
    planId: params.planId
  });
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Task not found");
  }
  const { task, projectDb } = scopedTask;
  const transitions = projectDb
    .prepare("SELECT * FROM task_state_transitions WHERE task_id = ? ORDER BY created_at ASC")
    .all(task.id) as TaskTransitionRow[];
  const mergeRecords = projectDb
    .prepare("SELECT * FROM merge_records WHERE task_id = ? ORDER BY created_at DESC")
    .all(task.id) as MergeRecordRow[];

  let gitStatus: Awaited<ReturnType<typeof getWorkspaceGitStatus>> | null = null;
  try {
    gitStatus = await getWorkspaceGitStatus(task.workspace_path);
  } catch {
    gitStatus = null;
  }
  const visibility = buildAutomationVisibility(projectDb, task);

  return {
    task: serializeTask(projectDb, task),
    transitions: transitions.map(serializeTransition),
    session: serializeSession(latestSession(projectDb, task.id)),
    ide: serializeIde(latestIde(projectDb, task.id)),
    gitStatus,
    mergeRecords: mergeRecords.map(serializeMergeRecord),
    automation: visibility.automation,
    waiting: visibility.waiting,
    orchestration: visibility.orchestration
  };
}

export async function getTaskSummary(params: { userId: string; taskId: string; projectId?: string; planId?: string }) {
  const scopedTask = taskForUserWithFilters({
    taskId: params.taskId,
    userId: params.userId,
    intent: "read",
    projectId: params.projectId,
    planId: params.planId
  });
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Task not found");
  }
  const { task, projectDb } = scopedTask;
  return {
    task: {
      id: task.id,
      projectId: task.project_id,
      parentPlanTaskId: task.parent_plan_task_id,
      title: task.title,
      mode: task.mode,
      status: task.status,
      isBlocked: taskIsBlocked(projectDb, task.id),
      result: task.result,
      createdAt: task.created_at,
      updatedAt: task.updated_at
    },
    session: serializeSession(latestSession(projectDb, task.id)),
    ide: serializeIde(latestIde(projectDb, task.id))
  };
}

export async function startNode(params: { userId: string; nodeId: string; autoMode?: boolean }) {
  const scopedTask = taskForUser(params.nodeId, params.userId, "write");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Node not found");
  }
  const { task, project, projectDb } = scopedTask;
  const diagnostics = buildDependencyDiagnostics({ projectDb, task });
  if (diagnostics.unresolved.length > 0) {
    throw new CliServiceError("CONFLICT", "Node is blocked by unresolved dependencies");
  }
  const tier = nodeTierForTask(projectDb, task);

  if (tier === "epoch" || tier === "phase" || tier === "plan") {
    try {
      startBuiltinWorkflowForTierTask({
        db: projectDb,
        projectId: project.id,
        taskId: task.id,
        tier: tier as BuiltinWorkflowTier,
        createdByUserId: params.userId
      });
    } catch (error: any) {
      throw new CliServiceError("CONFLICT", String(error?.message ?? "Failed to start node workflow"));
    }
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      eventType: "orchestration.manual_start",
      database: projectDb,
      payload: {
        source: "cli",
        requestedAutoMode: typeof params.autoMode === "boolean" ? params.autoMode : null,
        actorUserId: params.userId,
        strategy: "workflow_engine"
      }
    });
  } else {
    try {
      await startTaskRuntimeWorker(task.id, params.userId, {
        projectId: project.id,
        basePath: project.base_path,
        projectDb
      });
    } catch (error: any) {
      throw new CliServiceError("CONFLICT", String(error?.message ?? "Failed to start node runtime"));
    }
    if (tier !== "exec") {
      recordEvent({
        projectId: task.project_id,
        taskId: task.id,
        eventType: "orchestration.manual_start",
        database: projectDb,
        payload: {
          source: "cli",
          requestedAutoMode: typeof params.autoMode === "boolean" ? params.autoMode : null,
          actorUserId: params.userId,
          strategy: "runtime_session"
        }
      });
    }
  }

  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  return { node: serializeTask(projectDb, updated), tier };
}

export async function toggleNodeAutoMode(params: { userId: string; nodeId: string; enabled: boolean }) {
  const scopedTask = taskForUser(params.nodeId, params.userId, "write");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Node not found");
  }
  const { task, projectDb } = scopedTask;
  const metadata = readNodeMetadata({
    projectDb,
    task,
    dependencyTaskIds: dependencyTaskIdsFor(projectDb, task.id)
  }).metadata;
  writeNodeMetadata({
    projectDb,
    taskId: task.id,
    metadata: {
      ...metadata,
      orchestration: {
        ...(metadata.orchestration ?? {}),
        auto_start: params.enabled
      },
      custom: {
        ...(metadata.custom ?? {}),
        auto_mode: params.enabled
      }
    }
  });
  projectDb.prepare("UPDATE tasks SET auto_start = ?, updated_at = ? WHERE id = ?").run(params.enabled ? 1 : 0, nowIso(), task.id);
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "orchestration.override.auto_mode",
    database: projectDb,
    payload: {
      enabled: params.enabled,
      source: "cli",
      actorUserId: params.userId
    }
  });
  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  return { node: serializeTask(projectDb, updated) };
}

export async function toggleNodeAutoMerge(params: { userId: string; nodeId: string; enabled: boolean; onComplete?: boolean }) {
  const scopedTask = taskForUser(params.nodeId, params.userId, "write");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Node not found");
  }
  const { task, projectDb } = scopedTask;
  const onComplete = params.onComplete ?? task.mode === "plan";
  if (onComplete) {
    projectDb.prepare("UPDATE tasks SET auto_merge_on_complete = ?, updated_at = ? WHERE id = ?").run(
      params.enabled ? 1 : 0,
      nowIso(),
      task.id
    );
  } else {
    projectDb.prepare("UPDATE tasks SET auto_merge = ?, updated_at = ? WHERE id = ?").run(
      params.enabled ? 1 : 0,
      nowIso(),
      task.id
    );
  }

  const metadata = readNodeMetadata({
    projectDb,
    task,
    dependencyTaskIds: dependencyTaskIdsFor(projectDb, task.id)
  }).metadata;
  writeNodeMetadata({
    projectDb,
    taskId: task.id,
    metadata: {
      ...metadata,
      orchestration: {
        ...(metadata.orchestration ?? {}),
        auto_merge: onComplete ? metadata.orchestration?.auto_merge : params.enabled,
        auto_merge_on_complete: onComplete ? params.enabled : metadata.orchestration?.auto_merge_on_complete
      }
    }
  });
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "orchestration.override.auto_merge",
    database: projectDb,
    payload: {
      enabled: params.enabled,
      onComplete,
      source: "cli",
      actorUserId: params.userId
    }
  });
  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  return { node: serializeTask(projectDb, updated) };
}

export async function forceNodeReReview(params: { userId: string; nodeId: string; reason?: string }) {
  const scopedTask = taskForUser(params.nodeId, params.userId, "write");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Node not found");
  }
  const { task, projectDb } = scopedTask;
  const { pendingEventId } = enqueueOrchestrationJob({
    database: projectDb,
    projectId: task.project_id,
    taskId: task.id,
    jobType: "re_review",
    idempotencyKey: `manual_re_review:${task.id}:${makeId()}`,
    debounceMs: 0,
    dedupeWindowMs: 250,
    metadata: {
      source: "cli.manual_re_review",
      reason: params.reason ?? null,
      actorUserId: params.userId
    }
  });
  kickOrchestrationJobQueueProcessing();
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "orchestration.override.force_re_review",
    database: projectDb,
    payload: {
      pendingEventId,
      reason: params.reason ?? null,
      source: "cli",
      actorUserId: params.userId
    }
  });
  return { ok: true, pendingEventId };
}

export async function approveNodeBudgetOverride(params: { userId: string; nodeId: string; enabled?: boolean; reason?: string }) {
  const scopedTask = taskForUser(params.nodeId, params.userId, "write");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Node not found");
  }
  const { task, projectDb } = scopedTask;
  const enabled = params.enabled ?? true;
  const metadata = readNodeMetadata({
    projectDb,
    task,
    dependencyTaskIds: dependencyTaskIdsFor(projectDb, task.id)
  }).metadata;
  writeNodeMetadata({
    projectDb,
    taskId: task.id,
    metadata: {
      ...metadata,
      custom: {
        ...(metadata.custom ?? {}),
        replan_budget_override: enabled
      }
    }
  });
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "orchestration.override.replan_budget",
    database: projectDb,
    payload: {
      enabled,
      reason: params.reason ?? null,
      source: "cli",
      actorUserId: params.userId
    }
  });
  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  return { node: serializeTask(projectDb, updated) };
}

export async function startTaskSession(params: { userId: string; taskId: string }) {
  const scopedTask = taskForUser(params.taskId, params.userId, "write");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Task not found");
  }
  const { task, project, projectDb } = scopedTask;
  if (taskIsBlocked(projectDb, task.id)) {
    throw new CliServiceError("CONFLICT", "Task is blocked by unmerged dependencies");
  }
  try {
    await startTaskRuntimeWorker(task.id, params.userId, {
      projectId: project.id,
      basePath: project.base_path,
      projectDb
    });
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "Failed to start task runtime"));
  }
  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  return { task: serializeTask(projectDb, updated), session: serializeSession(latestSession(projectDb, task.id)) };
}

export async function sendTaskSessionInput(params: { userId: string; taskId: string; text: string }) {
  if (!params.text.trim()) {
    throw new CliServiceError("VALIDATION", "text is required");
  }
  const scopedTask = taskForUser(params.taskId, params.userId, "write");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Task not found");
  }
  const { task, project, projectDb } = scopedTask;
  try {
    await sendTaskRuntimeInputWorker(task.id, params.userId, params.text, {
      projectId: project.id,
      basePath: project.base_path,
      projectDb
    });
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "Failed to send input"));
  }
  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  return { task: serializeTask(projectDb, updated), session: serializeSession(latestSession(projectDb, task.id)) };
}

export async function markTaskMergeReady(params: { userId: string; taskId: string }) {
  const scopedTask = taskForUser(params.taskId, params.userId, "write");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Task not found");
  }
  const { task, projectDb } = scopedTask;
  try {
    assertTaskStatusTransition({
      mode: task.mode,
      fromStatus: task.status,
      toStatus: "merge_ready",
      hasBlockingDependencies: taskIsBlocked(projectDb, task.id),
      hasPendingChildren: false,
      parentGuards: evaluateParentCompletionGuards(projectDb, task)
    });
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "illegal transition"));
  }
  let status: Awaited<ReturnType<typeof getWorkspaceGitStatus>>;
  try {
    status = await getWorkspaceGitStatus(task.workspace_path);
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "Failed to read task git status"));
  }
  const hasUncommitted =
    status.untracked > 0 ||
    status.staged > 0 ||
    status.unstaged > 0 ||
    status.conflicted > 0;
  if (hasUncommitted) {
    throw new CliServiceError("CONFLICT", "Task has uncommitted or untracked changes. Commit or clean workspace before marking merge-ready.");
  }

  const updated = setTaskStatus(projectDb, task, "merge_ready", "user_marked_merge_ready", params.userId);
  recordEvent({
    projectId: updated.project_id,
    taskId: updated.id,
    eventType: "task.mark_merge_ready",
    payload: {},
    database: projectDb
  });
  return {
    task: serializeTask(projectDb, updated),
    summary: `task ${updated.id} status=${updated.status}`
  };
}

export async function mergeTask(params: { userId: string; taskId: string }) {
  const scopedTask = taskForUser(params.taskId, params.userId, "write");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Task not found");
  }
  const { task, project, projectDb } = scopedTask;
  if (task.status !== "merge_ready") {
    throw new CliServiceError("CONFLICT", "Task must be merge_ready before merge");
  }
  let gitStatus: Awaited<ReturnType<typeof getWorkspaceGitStatus>>;
  try {
    gitStatus = await getWorkspaceGitStatus(task.workspace_path);
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "Failed to read task git status"));
  }
  const mergeGateChecklist = buildMergeGateChecklist({
    task,
    hasBlockingDependencies: taskIsBlocked(projectDb, task.id),
    hasPendingChildren: false,
    workspaceClean: workspaceIsClean(gitStatus),
    parentGuards: evaluateParentCompletionGuards(projectDb, task)
  });
  if (!requiredMergeGatesPassed(mergeGateChecklist)) {
    throw new CliServiceError("CONFLICT", `Merge gates failed: ${describeFailedMergeGates(mergeGateChecklist)}`);
  }

  const parentPlanTask = parentPlanTaskFor(projectDb, task);
  const topology = resolveTaskGitTopology({ task, project, parentPlanTask });
  const lockKey = topology.mergeLockKey;
  if (mergeLocks.has(lockKey)) {
    throw new CliServiceError("CONFLICT", "Another merge is currently running for this merge target");
  }
  mergeLocks.add(lockKey);

  try {
    let queueKickNeeded = false;
    const sourceCommitSha = await getHeadCommitSha(task.workspace_path);
    const targetBaseCommitSha = await getHeadCommitSha(topology.mergeTargetPath);
    const mergeRecordId = makeId();
    const createdAt = nowIso();
    projectDb.prepare(
      `INSERT INTO merge_records (
        id, task_id, project_id, source_commit_sha, target_base_commit_sha, merge_commit_sha, status,
        conflict_summary, error_message, created_by_user_id, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?, NULL)`
    ).run(mergeRecordId, task.id, project.id, sourceCommitSha, targetBaseCommitSha, params.userId, createdAt);

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
        const resolutionArtifact = buildConflictResolutionArtifact({
          task,
          parentTask: parentPlanTask,
          conflictFiles: mergeResult.conflictFiles,
          mergeGateChecklist,
          mergeTargetBranch: topology.mergeTargetBranch,
          sourceCommitSha,
          targetBaseCommitSha
        });
        const conflictSummary = mergeResult.conflictFiles.join("\n");
        projectDb.prepare("UPDATE merge_records SET status = 'conflict', conflict_summary = ?, completed_at = ? WHERE id = ?").run(
          conflictSummary || "conflicts detected",
          completedAt,
          mergeRecordId
        );
        setTaskStatus(projectDb, task, "merge_conflict", "merge_conflict", params.userId);
        recordEvent({
          projectId: project.id,
          taskId: task.id,
          eventType: "task.merge_conflict",
          database: projectDb,
          payload: {
            conflictFiles: mergeResult.conflictFiles,
            conflictResolution: resolutionArtifact
          }
        });
      } else {
        projectDb.prepare("UPDATE merge_records SET status = 'merged', merge_commit_sha = ?, completed_at = ? WHERE id = ?").run(
          mergeResult.mergeCommitSha,
          completedAt,
          mergeRecordId
        );
        setTaskStatus(projectDb, task, "merged", "merge_success", params.userId, {
          mergedAt: completedAt,
          mergedByUserId: params.userId,
          headCommitSha: mergeResult.mergeCommitSha
        });
        recordEvent({
          projectId: project.id,
          taskId: task.id,
          eventType: "task.merged",
          database: projectDb,
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
      const message = String(error?.message ?? "merge failed");
      projectDb.prepare("UPDATE merge_records SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?").run(
        message,
        completedAt,
        mergeRecordId
      );
      recordEvent({
        projectId: project.id,
        taskId: task.id,
        eventType: "task.merge_failed",
        database: projectDb,
        payload: { error: message }
      });
      throw new CliServiceError("CONFLICT", message);
    }

    const updatedTask = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
    const mergeRecords = projectDb
      .prepare("SELECT * FROM merge_records WHERE task_id = ? ORDER BY created_at DESC")
      .all(task.id) as MergeRecordRow[];
    const latestMergeRecord = mergeRecords[0];
    if (updatedTask.status === "merged") {
      await maybeAdvanceParentPlanAfterChildMerge({
        project,
        projectDb,
        mergedTask: updatedTask,
        actorUserId: params.userId
      });
    }
    if (queueKickNeeded) {
      kickTaskQueueProcessing();
    }
    return {
      task: serializeTask(projectDb, updatedTask),
      mergeRecords: mergeRecords.map(serializeMergeRecord),
      summary: `task ${updatedTask.id} status=${updatedTask.status} merge_record=${latestMergeRecord?.status ?? "unknown"}`
    };
  } finally {
    mergeLocks.delete(lockKey);
  }
}

export async function markPlanMergeReady(params: { userId: string; planId: string }) {
  const scopedPlan = planForUser(params.planId, params.userId, "write");
  if (!scopedPlan) {
    throw new CliServiceError("NOT_FOUND", "Plan not found");
  }
  const { plan, projectDb } = scopedPlan;
  if (hasUnmergedPlanChildren(projectDb, plan.id)) {
    throw new CliServiceError("CONFLICT", "Plan has child tasks that are not merged");
  }
  try {
    assertTaskStatusTransition({
      mode: plan.mode,
      fromStatus: plan.status,
      toStatus: "merge_ready",
      hasBlockingDependencies: taskIsBlocked(projectDb, plan.id),
      hasPendingChildren: false,
      parentGuards: evaluateParentCompletionGuards(projectDb, plan)
    });
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "illegal transition"));
  }

  let status: Awaited<ReturnType<typeof getWorkspaceGitStatus>>;
  try {
    status = await getWorkspaceGitStatus(plan.workspace_path);
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "Failed to read plan git status"));
  }
  const hasUncommitted =
    status.untracked > 0 ||
    status.staged > 0 ||
    status.unstaged > 0 ||
    status.conflicted > 0;
  if (hasUncommitted) {
    throw new CliServiceError("CONFLICT", "Plan has uncommitted or untracked changes. Commit or clean workspace before marking merge-ready.");
  }

  const updated = setTaskStatus(projectDb, plan, "merge_ready", "user_marked_merge_ready", params.userId);
  recordEvent({
    projectId: updated.project_id,
    taskId: updated.id,
    eventType: "plan.mark_merge_ready",
    payload: {},
    database: projectDb
  });
  return {
    plan: serializeTask(projectDb, updated),
    summary: `plan ${updated.id} status=${updated.status}`
  };
}

export async function mergePlan(params: { userId: string; planId: string }) {
  const scopedPlan = planForUser(params.planId, params.userId, "write");
  if (!scopedPlan) {
    throw new CliServiceError("NOT_FOUND", "Plan not found");
  }
  const { plan, project, projectDb } = scopedPlan;
  if (plan.status !== "merge_ready") {
    throw new CliServiceError("CONFLICT", "Plan must be merge_ready before merge");
  }
  if (hasUnmergedPlanChildren(projectDb, plan.id)) {
    throw new CliServiceError("CONFLICT", "Plan has child tasks that are not merged");
  }
  let gitStatus: Awaited<ReturnType<typeof getWorkspaceGitStatus>>;
  try {
    gitStatus = await getWorkspaceGitStatus(plan.workspace_path);
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "Failed to read plan git status"));
  }
  const mergeGateChecklist = buildMergeGateChecklist({
    task: plan,
    hasBlockingDependencies: taskIsBlocked(projectDb, plan.id),
    hasPendingChildren: hasUnmergedPlanChildren(projectDb, plan.id),
    workspaceClean: workspaceIsClean(gitStatus),
    parentGuards: evaluateParentCompletionGuards(projectDb, plan)
  });
  if (!requiredMergeGatesPassed(mergeGateChecklist)) {
    throw new CliServiceError("CONFLICT", `Merge gates failed: ${describeFailedMergeGates(mergeGateChecklist)}`);
  }

  const parentPlanTask = parentPlanTaskFor(projectDb, plan);
  const topology = resolveTaskGitTopology({ task: plan, project, parentPlanTask });
  const lockKey = topology.mergeLockKey;
  if (mergeLocks.has(lockKey)) {
    throw new CliServiceError("CONFLICT", "Another merge is currently running for this merge target");
  }
  mergeLocks.add(lockKey);

  try {
    let queueKickNeeded = false;
    const sourceCommitSha = await getHeadCommitSha(plan.workspace_path);
    const targetBaseCommitSha = await getHeadCommitSha(topology.mergeTargetPath);
    const mergeRecordId = makeId();
    const createdAt = nowIso();
    projectDb.prepare(
      `INSERT INTO merge_records (
        id, task_id, project_id, source_commit_sha, target_base_commit_sha, merge_commit_sha, status,
        conflict_summary, error_message, created_by_user_id, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?, NULL)`
    ).run(mergeRecordId, plan.id, project.id, sourceCommitSha, targetBaseCommitSha, params.userId, createdAt);

    try {
      const mergeResult = await mergeTaskWorkspaceIntoTarget({
        targetPath: topology.mergeTargetPath,
        targetBranch: topology.mergeTargetBranch,
        syncTargetBranchFromOrigin: topology.syncMergeTargetFromOrigin,
        workspacePath: plan.workspace_path,
        taskId: plan.id
      });
      const completedAt = nowIso();

      if (mergeResult.conflicted) {
        const resolutionArtifact = buildConflictResolutionArtifact({
          task: plan,
          parentTask: parentPlanTask,
          conflictFiles: mergeResult.conflictFiles,
          mergeGateChecklist,
          mergeTargetBranch: topology.mergeTargetBranch,
          sourceCommitSha,
          targetBaseCommitSha
        });
        const conflictSummary = mergeResult.conflictFiles.join("\n");
        projectDb.prepare("UPDATE merge_records SET status = 'conflict', conflict_summary = ?, completed_at = ? WHERE id = ?").run(
          conflictSummary || "conflicts detected",
          completedAt,
          mergeRecordId
        );
        setTaskStatus(projectDb, plan, "merge_conflict", "merge_conflict", params.userId);
        recordEvent({
          projectId: project.id,
          taskId: plan.id,
          eventType: "plan.merge_conflict",
          database: projectDb,
          payload: {
            conflictFiles: mergeResult.conflictFiles,
            conflictResolution: resolutionArtifact
          }
        });
      } else {
        projectDb.prepare("UPDATE merge_records SET status = 'merged', merge_commit_sha = ?, completed_at = ? WHERE id = ?").run(
          mergeResult.mergeCommitSha,
          completedAt,
          mergeRecordId
        );
        setTaskStatus(projectDb, plan, "merged", "merge_success", params.userId, {
          mergedAt: completedAt,
          mergedByUserId: params.userId,
          headCommitSha: mergeResult.mergeCommitSha
        });
        recordEvent({
          projectId: project.id,
          taskId: plan.id,
          eventType: "plan.merged",
          database: projectDb,
          payload: {
            mergeCommitSha: mergeResult.mergeCommitSha,
            sourceBranch: `task/${plan.id}`,
            targetBranch: topology.mergeTargetBranch
          }
        });
        queueKickNeeded = true;
      }
    } catch (error: any) {
      const completedAt = nowIso();
      const message = String(error?.message ?? "merge failed");
      projectDb.prepare("UPDATE merge_records SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?").run(
        message,
        completedAt,
        mergeRecordId
      );
      recordEvent({
        projectId: project.id,
        taskId: plan.id,
        eventType: "plan.merge_failed",
        database: projectDb,
        payload: { error: message }
      });
      throw new CliServiceError("CONFLICT", message);
    }

    const updatedPlan = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(plan.id) as TaskRow;
    const mergeRecords = projectDb
      .prepare("SELECT * FROM merge_records WHERE task_id = ? ORDER BY created_at DESC")
      .all(plan.id) as MergeRecordRow[];
    const latestMergeRecord = mergeRecords[0];
    if (updatedPlan.status === "merged") {
      await maybeAdvanceParentPlanAfterChildMerge({
        project,
        projectDb,
        mergedTask: updatedPlan,
        actorUserId: params.userId
      });
    }
    if (queueKickNeeded) {
      kickTaskQueueProcessing();
    }
    return {
      plan: serializeTask(projectDb, updatedPlan),
      mergeRecords: mergeRecords.map(serializeMergeRecord),
      summary: `plan ${updatedPlan.id} status=${updatedPlan.status} merge_record=${latestMergeRecord?.status ?? "unknown"}`
    };
  } finally {
    mergeLocks.delete(lockKey);
  }
}

export async function reviewTaskMergeRecords(params: { userId: string; taskId: string }) {
  const scopedTask = taskForUser(params.taskId, params.userId, "read");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Task not found");
  }
  const { task, projectDb } = scopedTask;
  const mergeRecords = projectDb
    .prepare("SELECT * FROM merge_records WHERE task_id = ? ORDER BY created_at DESC")
    .all(task.id) as MergeRecordRow[];
  return { mergeRecords: mergeRecords.map(serializeMergeRecord) };
}

export async function ideStatus(params: { userId: string; taskId: string }) {
  const scopedTask = taskForUser(params.taskId, params.userId, "write");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Task not found");
  }
  const { task, projectDb } = scopedTask;
  let gitStatus: Awaited<ReturnType<typeof getWorkspaceGitStatus>> | null = null;
  try {
    gitStatus = await getWorkspaceGitStatus(task.workspace_path);
  } catch {
    gitStatus = null;
  }
  return { ide: serializeIde(latestIde(projectDb, task.id)), gitStatus };
}

export async function ideStart(params: { userId: string; taskId: string }) {
  const scopedTask = taskForUser(params.taskId, params.userId, "write");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Task not found");
  }
  const { task, projectDb } = scopedTask;
  const existing = latestIde(projectDb, task.id);
  if (existing && ["starting", "running"].includes(existing.status) && ideSessionRunning(task.id)) {
    return { ide: serializeIde(existing), launchUrl: await buildIdeLaunchUrl(projectDb, task, existing.id) };
  }

  const ideId = makeId();
  const now = nowIso();
  projectDb
    .prepare("INSERT INTO ide_instances (id, task_id, provider, url, access_token_hash, status, started_at, ended_at, last_heartbeat_at) VALUES (?, ?, ?, ?, '', 'starting', ?, NULL, ?)")
    .run(ideId, task.id, "openvscode_server", "", now, now);

  try {
    const launched = await startIdeSession({ taskId: task.id, workspacePath: task.workspace_path });
    projectDb.prepare("UPDATE ide_instances SET provider = ?, url = ?, status = 'running', last_heartbeat_at = ? WHERE id = ?").run(
      launched.provider,
      launched.url,
      nowIso(),
      ideId
    );
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      eventType: "ide.started",
      database: projectDb,
      payload: { ideId, provider: launched.provider, url: launched.url }
    });
  } catch (error: any) {
    const nowFailed = nowIso();
    projectDb.prepare("UPDATE ide_instances SET status = 'failed', ended_at = ?, last_heartbeat_at = ? WHERE id = ?").run(nowFailed, nowFailed, ideId);
    throw new CliServiceError("CONFLICT", String(error?.message ?? "Failed to start IDE session"));
  }

  const ide = projectDb.prepare("SELECT * FROM ide_instances WHERE id = ?").get(ideId) as IdeInstanceRow | undefined;
  return { ide: serializeIde(ide), launchUrl: await buildIdeLaunchUrl(projectDb, task, ideId) };
}

export async function ideStop(params: { userId: string; taskId: string }) {
  const scopedTask = taskForUser(params.taskId, params.userId, "read");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Task not found");
  }
  const { task, projectDb } = scopedTask;
  const ide = latestIde(projectDb, task.id);
  if (!ide || !["starting", "running"].includes(ide.status)) {
    stopIdeSession(task.id);
    return { ide: null, stopped: false };
  }

  stopIdeSession(task.id);
  const now = nowIso();
  projectDb.prepare("UPDATE ide_instances SET status = 'stopped', ended_at = ?, last_heartbeat_at = ? WHERE id = ?").run(now, now, ide.id);
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "ide.stopped",
    database: projectDb,
    payload: { ideId: ide.id }
  });
  const updated = projectDb.prepare("SELECT * FROM ide_instances WHERE id = ?").get(ide.id) as IdeInstanceRow | undefined;
  return { ide: serializeIde(updated) };
}

export async function listPlans(params: { userId: string; projectId?: string; planId?: string }) {
  const contexts = contextsForUser({ userId: params.userId, intent: "read", projectId: params.projectId });
  const plans = contexts.flatMap(({ project, projectDb }) => {
    const rows = projectDb
      .prepare(
        `SELECT *
         FROM tasks
         WHERE project_id = ?
           AND mode = 'plan'
           AND (? IS NULL OR id = ?)
         ORDER BY created_at DESC`
      )
      .all(project.id, params.planId ?? null, params.planId ?? null) as TaskRow[];
    return rows.map((plan) => serializeTask(projectDb, plan));
  });
  return { plans };
}

export async function createPlan(params: {
  userId: string;
  projectId: string;
  title: string;
  taskPrompt: string;
  aiCommand?: string;
  autoStart?: boolean;
  autoMergeOnComplete?: boolean;
  parentPlanTaskId?: string;
}) {
  const project = projectForUser(params.projectId, params.userId);
  if (!project) {
    throw new CliServiceError("NOT_FOUND", "Project not found");
  }
  const projectDb = projectDatabaseFor(project, "write");
  if (project.clone_status !== "ready") {
    throw new CliServiceError("CONFLICT", "Project base repository is not ready");
  }
  if (params.title.trim().length < 2) {
    throw new CliServiceError("VALIDATION", "title must be at least 2 characters");
  }
  if (!params.taskPrompt.trim()) {
    throw new CliServiceError("VALIDATION", "prompt is required");
  }

  const plannerPrompt = buildPlanTaskPrompt(params.taskPrompt);
  const id = makeId();
  const now = nowIso();
  const workspacePath = path.join(path.dirname(project.base_path), "tasks", id);
  const aiCommand = resolveAiCommand(params.aiCommand, params.userId);
  const effectivePrompt = buildEffectivePrompt(project, plannerPrompt);
  const autoStart = Boolean(params.autoStart);
  const autoMergeOnComplete = Boolean(params.autoMergeOnComplete);

  let parentPlanTask: TaskRow | undefined;
  if (params.parentPlanTaskId) {
    parentPlanTask = planTaskInProject(projectDb, project.id, params.parentPlanTaskId);
    if (!parentPlanTask) {
      throw new CliServiceError("VALIDATION", "parentPlanTaskId must reference an existing plan in this project");
    }
  }

  let baseCommitSha: string;
  try {
    const sourcePath = parentPlanTask ? parentPlanTask.workspace_path : project.base_path;
    const sourceBranch = parentPlanTask ? taskBranchName(parentPlanTask.id) : project.default_branch;
    baseCommitSha = await getHeadCommitSha(sourcePath);
    await cloneLocalBaseToWorkspace({ basePath: sourcePath, baseBranch: sourceBranch, workspacePath });
    await createTaskBranch(workspacePath, id);
    await fs.promises.mkdir(path.join(workspacePath, ".ai-plan"), { recursive: true });
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "Failed to initialize plan workspace"));
  }

  projectDb.transaction(() => {
    const metadataJson = serializeNodeMetadata(
      buildInitialNodeMetadata({
        task: {
          id,
          project_id: project.id,
          mode: "plan",
          metadata_json: null,
          auto_merge: 0,
          auto_start: autoStart ? 1 : 0,
          auto_merge_on_complete: autoMergeOnComplete ? 1 : 0,
          parent_plan_task_id: parentPlanTask?.id ?? null,
          source_plan_revision_id: null,
          source_plan_item_key: null
        },
        dependencyTaskIds: [],
        tier: "plan",
        crossTierDependencies: parentPlanTask ? [{ id: parentPlanTask.id, tier: "plan", reason: "parent_plan" }] : []
      })
    );
    projectDb.prepare(
      `INSERT INTO tasks (
        id, project_id, title, task_prompt, result, effective_prompt, ai_command,
        auto_merge, auto_start, auto_merge_on_complete, metadata_json,
        mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
        status, workspace_path, base_commit_sha_at_create, head_commit_sha,
        cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', ?, ?, 0, ?, ?, ?, 'plan', ?, NULL, NULL, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
    ).run(
      id,
      project.id,
      params.title,
      plannerPrompt,
      effectivePrompt,
      aiCommand,
      autoStart ? 1 : 0,
      autoMergeOnComplete ? 1 : 0,
      metadataJson,
      parentPlanTask?.id ?? null,
      workspacePath,
      baseCommitSha,
      params.userId,
      now,
      now
    );

    projectDb.prepare(
      `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(makeId(), id, "null", "queued", "plan_created", params.userId, now);
  })();

  recordEvent({
    projectId: project.id,
    taskId: id,
    eventType: "plan.created",
    database: projectDb,
    payload: {
      title: params.title,
      aiCommand,
      autoStart,
      autoMergeOnComplete,
      parentPlanTaskId: parentPlanTask?.id ?? null,
      workspacePath,
      baseCommitShaAtCreate: baseCommitSha
    }
  });

  const task = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
  kickTaskQueueProcessing();
  return { plan: serializeTask(projectDb, task) };
}

export async function getPlan(params: { userId: string; planId: string }) {
  const scopedPlan = planForUser(params.planId, params.userId, "read");
  if (!scopedPlan) {
    throw new CliServiceError("NOT_FOUND", "Plan not found");
  }
  const { plan, projectDb } = scopedPlan;

  const transitions = projectDb
    .prepare("SELECT * FROM task_state_transitions WHERE task_id = ? ORDER BY created_at ASC")
    .all(plan.id) as TaskTransitionRow[];
  const revisions = projectDb
    .prepare("SELECT * FROM plan_revisions WHERE plan_task_id = ? ORDER BY revision_number DESC")
    .all(plan.id) as PlanRevisionRow[];

  const revisionItems = revisions.length
    ? (projectDb
        .prepare(
          `SELECT *
           FROM plan_revision_items
           WHERE revision_id IN (${revisions.map(() => "?").join(",")})
           ORDER BY ordinal ASC`
        )
        .all(...revisions.map((row) => row.id)) as PlanRevisionItemRow[])
    : [];

  const dependencies = revisionItems.length
    ? (projectDb
        .prepare(
          `SELECT d.*
           FROM plan_revision_item_dependencies d
           JOIN plan_revision_items i ON i.id = d.revision_item_id
           WHERE i.revision_id IN (${revisions.map(() => "?").join(",")})`
        )
        .all(...revisions.map((row) => row.id)) as PlanRevisionItemDependencyRow[])
    : [];

  const itemsByRevision = new Map<string, Array<{
    id: string;
    itemKey: string;
    itemType: string;
    title: string;
    prompt: string;
    ordinal: number;
    dependsOnItemKeys: string[];
  }>>();
  for (const item of revisionItems) {
    const dependsOnItemKeys = dependencies.filter((dep) => dep.revision_item_id === item.id).map((dep) => dep.depends_on_item_key);
    if (!itemsByRevision.has(item.revision_id)) {
      itemsByRevision.set(item.revision_id, []);
    }
    itemsByRevision.get(item.revision_id)?.push({
      id: item.id,
      itemKey: item.item_key,
      itemType: item.item_type,
      title: item.title,
      prompt: item.prompt,
      ordinal: item.ordinal,
      dependsOnItemKeys
    });
  }

  const approvedTasks = projectDb
    .prepare("SELECT * FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
    .all(plan.id) as TaskRow[];
  const visibility = buildAutomationVisibility(projectDb, plan);

  return {
    plan: serializeTask(projectDb, plan),
    transitions: transitions.map(serializeTransition),
    revisions: revisions.map((revision) => ({
      id: revision.id,
      planTaskId: revision.plan_task_id,
      revisionNumber: revision.revision_number,
      status: revision.status,
      feedback: revision.feedback,
      rawOutput: revision.raw_output,
      parseError: revision.parse_error,
      createdByUserId: revision.created_by_user_id,
      createdAt: revision.created_at,
      approvedAt: revision.approved_at,
      items: (itemsByRevision.get(revision.id) ?? []).sort((a, b) => a.ordinal - b.ordinal)
    })),
    approvedTasks: approvedTasks.map((task) => serializeTask(projectDb, task)),
    automation: visibility.automation,
    waiting: visibility.waiting,
    orchestration: visibility.orchestration
  };
}

export async function reviewPlan(params: { userId: string; planId: string }) {
  return getPlan(params);
}

export async function extractPlan(params: { userId: string; planId: string }) {
  const scopedPlan = planForUser(params.planId, params.userId, "write");
  if (!scopedPlan) {
    throw new CliServiceError("NOT_FOUND", "Plan not found");
  }
  const { plan, projectDb } = scopedPlan;

  const source = readPlanOutputSource(projectDb, plan);
  if (!source.raw) {
    throw new CliServiceError("CONFLICT", "No plan output available. Generate plan YAML first.");
  }

  const revisionId = makeId();
  const revisionNumber = nextRevisionNumber(projectDb, plan.id);
  const createdAt = nowIso();

  try {
    const parsed = parsePlanOutput(source.raw);
    fs.mkdirSync(path.dirname(source.filePath), { recursive: true });
    fs.writeFileSync(source.filePath, `${parsed.yamlText.trim()}\n`, "utf8");
    projectDb.transaction(() => {
      projectDb.prepare("UPDATE plan_revisions SET status = 'superseded' WHERE plan_task_id = ? AND status = 'proposed'").run(plan.id);
      projectDb.prepare(
        `INSERT INTO plan_revisions (
          id, plan_task_id, revision_number, status, feedback, raw_output, parse_error, created_by_user_id, created_at, approved_at
         ) VALUES (?, ?, ?, 'proposed', NULL, ?, NULL, ?, ?, NULL)`
      ).run(revisionId, plan.id, revisionNumber, parsed.yamlText, params.userId, createdAt);

      for (let i = 0; i < parsed.tasks.length; i += 1) {
        const task = parsed.tasks[i];
        const itemId = makeId();
        projectDb.prepare(
          `INSERT INTO plan_revision_items (id, revision_id, item_key, item_type, title, prompt, ordinal, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(itemId, revisionId, task.itemKey, task.itemType, task.title, task.prompt, i + 1, createdAt);

        for (const dep of task.dependsOnItemKeys) {
          projectDb.prepare("INSERT INTO plan_revision_item_dependencies (revision_item_id, depends_on_item_key) VALUES (?, ?)").run(itemId, dep);
        }
      }
    })();
    markPlanLifecycleFlags(projectDb, plan, {
      synthesisPassed: true,
      reasonCode: "plan_synthesis_passed"
    });

    recordEvent({
      projectId: plan.project_id,
      taskId: plan.id,
      eventType: "plan.revision.extracted",
      database: projectDb,
      payload: { revisionId, revisionNumber, items: parsed.tasks.length, source: source.source, planFile: source.filePath }
    });
    return { ok: true, revisionId, revisionNumber, tasksExtracted: parsed.tasks.length, source: source.source, planFile: source.filePath };
  } catch (error: any) {
    const parseError = String(error?.message ?? "Failed to parse plan output");
    projectDb.prepare(
      `INSERT INTO plan_revisions (
        id, plan_task_id, revision_number, status, feedback, raw_output, parse_error, created_by_user_id, created_at, approved_at
       ) VALUES (?, ?, ?, 'parse_failed', NULL, ?, ?, ?, ?, NULL)`
    ).run(revisionId, plan.id, revisionNumber, source.raw, parseError, params.userId, createdAt);
    throw new CliServiceError("VALIDATION", parseError);
  }
}

export async function regeneratePlan(params: { userId: string; planId: string; feedback: string }) {
  if (!params.feedback.trim()) {
    throw new CliServiceError("VALIDATION", "feedback is required");
  }
  const scopedPlan = planForUser(params.planId, params.userId, "write");
  if (!scopedPlan) {
    throw new CliServiceError("NOT_FOUND", "Plan not found");
  }
  const { plan, project, projectDb } = scopedPlan;
  const feedback = params.feedback.trim();
  const revisionId = makeId();
  const revisionNumber = nextRevisionNumber(projectDb, plan.id);
  const createdAt = nowIso();
  const guidance = [
    "Regenerate the plan based on this feedback and restate the complete plan.",
    "Return plan output as YAML using the required schema under top-level `tasks:`.",
    "Write the exact YAML to file:",
    PLAN_OUTPUT_RELATIVE_PATH,
    "Then print the YAML in a ```yaml fenced block.",
    "Feedback:",
    feedback
  ].join("\n");

  try {
    await sendTaskRuntimeInputWorker(plan.id, params.userId, guidance, {
      projectId: project.id,
      basePath: project.base_path,
      projectDb
    });
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "Plan runtime is not ready for feedback"));
  }

  projectDb.prepare(
    `INSERT INTO plan_revisions (
      id, plan_task_id, revision_number, status, feedback, raw_output, parse_error, created_by_user_id, created_at, approved_at
     ) VALUES (?, ?, ?, 'feedback_requested', ?, '', NULL, ?, ?, NULL)`
  ).run(revisionId, plan.id, revisionNumber, feedback, params.userId, createdAt);

  recordEvent({
    projectId: plan.project_id,
    taskId: plan.id,
    eventType: "plan.revision.feedback_requested",
    database: projectDb,
    payload: { revisionId, revisionNumber }
  });
  return { ok: true, revisionId, revisionNumber };
}

export async function approvePlan(params: {
  userId: string;
  planId: string;
  autoStart?: boolean;
  autoMergeOnComplete?: boolean;
  parentPlanTaskId?: string | null;
  autoMergeItemKeys?: string[];
  taskEdits?: Array<{
    itemKey: string;
    itemType?: "execution_task" | "sub_plan";
    title: string;
    description: string;
    prompt?: string;
    aiCommand?: string;
    parentPlanTaskId?: string | null;
    autoStart?: boolean;
    autoMergeOnComplete?: boolean;
  }>;
}) {
  const scopedPlan = planForUser(params.planId, params.userId, "write");
  if (!scopedPlan) {
    throw new CliServiceError("NOT_FOUND", "Plan not found");
  }
  const { plan, project, projectDb } = scopedPlan;

  const latestRevision = projectDb
    .prepare(
      `SELECT *
       FROM plan_revisions
       WHERE plan_task_id = ? AND status = 'proposed'
       ORDER BY revision_number DESC
       LIMIT 1`
    )
    .get(plan.id) as PlanRevisionRow | undefined;
  if (!latestRevision) {
    throw new CliServiceError("CONFLICT", "No proposed revision available to approve");
  }

  const alreadyApproved = projectDb
    .prepare("SELECT id FROM tasks WHERE source_plan_revision_id = ? LIMIT 1")
    .get(latestRevision.id) as { id: string } | undefined;
  if (alreadyApproved) {
    const approvedTasks = projectDb
      .prepare("SELECT * FROM tasks WHERE source_plan_revision_id = ? ORDER BY created_at ASC")
      .all(latestRevision.id) as TaskRow[];
    return { approvedTasks: approvedTasks.map((task) => serializeTask(projectDb, task)) };
  }

  const items = projectDb
    .prepare("SELECT * FROM plan_revision_items WHERE revision_id = ? ORDER BY ordinal ASC")
    .all(latestRevision.id) as PlanRevisionItemRow[];
  if (!items.length) {
    throw new CliServiceError("CONFLICT", "Latest revision has no tasks");
  }
  const depRows = projectDb
    .prepare(
      `SELECT d.*
       FROM plan_revision_item_dependencies d
       JOIN plan_revision_items i ON i.id = d.revision_item_id
       WHERE i.revision_id = ?`
    )
    .all(latestRevision.id) as PlanRevisionItemDependencyRow[];

  const itemIdToDeps = new Map<string, string[]>();
  const autoMergeItemKeys = new Set((params.autoMergeItemKeys ?? []).map((key) => key.toLowerCase()));
  const taskEditsByItemKey = new Map((params.taskEdits ?? []).map((edit) => [edit.itemKey.toLowerCase(), edit]));
  let parsedRevisionDefaults:
    | {
        autoStart: boolean;
        autoMergeOnComplete: boolean;
        tasksByItemKey: Map<
          string,
          {
            itemType: "execution_task" | "sub_plan";
            autoMerge: boolean;
            autoStart: boolean;
            autoMergeOnComplete: boolean;
          }
        >;
      }
    | undefined;
  try {
    const parsedRevision = parsePlanOutput(latestRevision.raw_output);
    parsedRevisionDefaults = {
      autoStart: parsedRevision.autoStart,
      autoMergeOnComplete: parsedRevision.autoMergeOnComplete,
      tasksByItemKey: new Map(
        parsedRevision.tasks.map((task) => [
          task.itemKey.toLowerCase(),
          {
            itemType: task.itemType,
            autoMerge: task.autoMerge,
            autoStart: task.autoStart,
            autoMergeOnComplete: task.autoMergeOnComplete
          }
        ])
      )
    };
  } catch {
    // Fallback to revision rows only when stored raw_output is not parseable.
  }
  const defaultSubPlanAutoStart = params.autoStart ?? parsedRevisionDefaults?.autoStart ?? false;
  const defaultSubPlanAutoMergeOnComplete = params.autoMergeOnComplete ?? parsedRevisionDefaults?.autoMergeOnComplete ?? false;
  const defaultSubPlanParentPlanTaskId = params.parentPlanTaskId === undefined ? plan.id : params.parentPlanTaskId;
  const defaultExecutionAutoMerge = Boolean(plan.auto_start);
  const planDepthCache = new Map<string, number>();
  const currentPlanDepth = resolvePlanDepth(projectDb, plan.id, planDepthCache);
  for (const row of depRows) {
    if (!itemIdToDeps.has(row.revision_item_id)) {
      itemIdToDeps.set(row.revision_item_id, []);
    }
    itemIdToDeps.get(row.revision_item_id)?.push(row.depends_on_item_key);
  }

  const itemKeyToTaskId = new Map<string, string>();
  const taskRows: Array<{
    item: PlanRevisionItemRow;
    taskId: string;
    workspacePath: string;
    dependencyTaskIds: string[];
    dependencyNodeRefs: NodeDependencyRef[];
    mode: "execution" | "plan";
    parentPlanTaskId: string | null;
    autoStart: boolean;
    autoMergeOnComplete: boolean;
    autoMerge: boolean;
    sourcePath: string;
    sourceBranch: string;
    baseCommitShaAtCreate: string;
  }> = [];
  for (const item of items) {
    const taskId = makeId();
    const edit = taskEditsByItemKey.get(item.item_key.toLowerCase());
    const parsedRevisionItem = parsedRevisionDefaults?.tasksByItemKey.get(item.item_key.toLowerCase());
    const itemType = edit?.itemType ?? parsedRevisionItem?.itemType ?? item.item_type;
    const mode = itemType === "sub_plan" ? "plan" : "execution";
    const autoMerge = mode === "execution"
      && (
        autoMergeItemKeys.has(item.item_key.toLowerCase())
        || Boolean(parsedRevisionItem?.autoMerge)
        || defaultExecutionAutoMerge
      );
    const autoStart = mode === "plan" ? (edit?.autoStart ?? parsedRevisionItem?.autoStart ?? defaultSubPlanAutoStart) : false;
    const autoMergeOnComplete =
      mode === "plan"
        ? (edit?.autoMergeOnComplete ?? parsedRevisionItem?.autoMergeOnComplete ?? defaultSubPlanAutoMergeOnComplete)
        : false;
    const parentPlanTaskId =
      mode === "plan"
        ? (edit?.parentPlanTaskId === undefined ? defaultSubPlanParentPlanTaskId : edit.parentPlanTaskId)
        : plan.id;
    let sourcePath = plan.workspace_path;
    let sourceBranch = taskBranchName(plan.id);
    if (parentPlanTaskId && parentPlanTaskId !== plan.id) {
      const targetParentPlan = planTaskInProject(projectDb, project.id, parentPlanTaskId);
      if (!targetParentPlan) {
        throw new CliServiceError("VALIDATION", `Invalid parent plan target for item ${item.item_key}`);
      }
      sourcePath = targetParentPlan.workspace_path;
      sourceBranch = taskBranchName(targetParentPlan.id);
    } else if (!parentPlanTaskId) {
      sourcePath = project.base_path;
      sourceBranch = project.default_branch;
    }
    const planDepth =
      mode !== "plan"
        ? -1
        : ((parentPlanTaskId === null
            ? 0
            : (parentPlanTaskId === plan.id
                ? currentPlanDepth
                : resolvePlanDepth(projectDb, parentPlanTaskId, planDepthCache))) + 1);
    if (mode === "plan" && planDepth > MAX_SUB_PLAN_RECURSION_DEPTH) {
      throw new CliServiceError(
        "VALIDATION",
        `Sub-plan recursion depth ${planDepth} exceeds limit ${MAX_SUB_PLAN_RECURSION_DEPTH} for item ${item.item_key}`
      );
    }

    itemKeyToTaskId.set(item.item_key.toLowerCase(), taskId);
    taskRows.push({
      item,
      taskId,
      workspacePath: path.join(path.dirname(project.base_path), "tasks", taskId),
      dependencyTaskIds: [],
      dependencyNodeRefs: [],
      mode,
      parentPlanTaskId,
      autoStart,
      autoMergeOnComplete,
      autoMerge,
      sourcePath,
      sourceBranch,
      baseCommitShaAtCreate: ""
    });
  }

  for (const row of taskRows) {
    const depKeys = itemIdToDeps.get(row.item.id) ?? [];
    row.dependencyTaskIds = depKeys.map((depKey) => {
      const depTaskId = itemKeyToTaskId.get(depKey.toLowerCase());
      if (!depTaskId) {
        throw new CliServiceError("CONFLICT", `Revision contains unknown dependency: ${depKey}`);
      }
      return depTaskId;
    });
    row.dependencyNodeRefs = depKeys.map((depKey, idx) => {
      const depTaskId = row.dependencyTaskIds[idx];
      const depRow = taskRows.find((candidate) => candidate.taskId === depTaskId);
      const depTier = depRow?.mode === "plan" ? "plan" : "exec";
      return {
        id: depTaskId,
        tier: depTier,
        reason: `plan_item:${depKey}`
      };
    });
  }
  try {
    validateProposedNodeGraph({
      projectDb,
      projectId: project.id,
      proposedNodes: taskRows.map((row) => ({
        id: row.taskId,
        tier: row.mode === "plan" ? "plan" : "exec",
        dependencies: row.dependencyNodeRefs
      }))
    });
  } catch (error: any) {
    throw new CliServiceError("VALIDATION", String(error?.message ?? "Invalid dependency graph"));
  }

  try {
    for (const row of taskRows) {
      row.baseCommitShaAtCreate = await getHeadCommitSha(row.sourcePath);
      if (row.dependencyTaskIds.length > 0) continue;
      await cloneLocalBaseToWorkspace({
        basePath: row.sourcePath,
        baseBranch: row.sourceBranch,
        workspacePath: row.workspacePath
      });
      await createTaskBranch(row.workspacePath, row.taskId);
      if (row.mode === "plan") {
        await fs.promises.mkdir(path.join(row.workspacePath, ".ai-plan"), { recursive: true });
      }
    }
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "Failed to initialize plan task workspaces"));
  }

  const createdAt = nowIso();
  projectDb.transaction(() => {
    projectDb.prepare("UPDATE plan_revisions SET status = 'approved', approved_at = ? WHERE id = ?").run(createdAt, latestRevision.id);
    for (const row of taskRows) {
      const edit = taskEditsByItemKey.get(row.item.item_key.toLowerCase());
      const title = edit?.title.trim() || row.item.title;
      const description = edit?.description.trim() || row.item.prompt;
      const prompt = edit?.prompt?.trim() ?? "";
      const basePrompt = [description, prompt].filter(Boolean).join("\n\n");
      const taskPrompt = row.mode === "plan" ? buildPlanTaskPrompt(basePrompt) : basePrompt;
      const aiCommand = resolveAiCommand(edit?.aiCommand?.trim() || undefined, params.userId);
      const nodeTier = row.mode === "plan" ? "plan" : "exec";
      const materializedDependencies = [
        ...row.dependencyNodeRefs,
        { id: plan.id, tier: "plan" as const, reason: "created_from_plan_revision" }
      ];
      const partitionedDeps = partitionDependenciesByTier(materializedDependencies, nodeTier);
      const metadataJson = serializeNodeMetadata(
        buildInitialNodeMetadata({
          task: {
            id: row.taskId,
            project_id: project.id,
            mode: row.mode,
            metadata_json: null,
            auto_merge: row.autoMerge ? 1 : 0,
            auto_start: row.autoStart ? 1 : 0,
            auto_merge_on_complete: row.autoMergeOnComplete ? 1 : 0,
            parent_plan_task_id: row.parentPlanTaskId,
            source_plan_revision_id: latestRevision.id,
            source_plan_item_key: row.item.item_key
          },
          dependencyTaskIds: row.dependencyTaskIds,
          tier: nodeTier,
          sameTierDependencies: partitionedDeps.sameTierDependencies,
          crossTierDependencies: partitionedDeps.crossTierDependencies
        })
      );

      projectDb.prepare(
        `INSERT INTO tasks (
          id, project_id, title, task_prompt, result, effective_prompt, ai_command,
          auto_merge, auto_start, auto_merge_on_complete, metadata_json,
          mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
          status, workspace_path, base_commit_sha_at_create, head_commit_sha,
          cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
      ).run(
        row.taskId,
        project.id,
        title,
        taskPrompt,
        buildEffectivePrompt(project, taskPrompt),
        aiCommand,
        row.autoMerge ? 1 : 0,
        row.autoStart ? 1 : 0,
        row.autoMergeOnComplete ? 1 : 0,
        metadataJson,
        row.mode,
        row.parentPlanTaskId,
        latestRevision.id,
        row.item.item_key,
        row.workspacePath,
        row.baseCommitShaAtCreate,
        params.userId,
        createdAt,
        createdAt
      );

      projectDb.prepare(
        `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        makeId(),
        row.taskId,
        "null",
        "queued",
        row.dependencyTaskIds.length ? "task_created_from_plan_blocked" : "task_created_from_plan",
        params.userId,
        createdAt
      );

      for (const dependencyTaskId of row.dependencyTaskIds) {
        projectDb.prepare("INSERT INTO task_dependencies (task_id, dependency_task_id, created_at) VALUES (?, ?, ?)").run(
          row.taskId,
          dependencyTaskId,
          createdAt
        );
      }
    }
  })();
  markPlanLifecycleFlags(projectDb, plan, {
    synthesisPassed: true,
    verificationPassed: true,
    reasonCode: "plan_verification_passed"
  });

  recordEvent({
    projectId: project.id,
    taskId: plan.id,
    eventType: "plan.approved",
    database: projectDb,
    payload: {
      revisionId: latestRevision.id,
      tasksCreated: taskRows.length
    }
  });
  kickTaskQueueProcessing();

  const approvedTasks = projectDb
    .prepare("SELECT * FROM tasks WHERE source_plan_revision_id = ? ORDER BY created_at ASC")
    .all(latestRevision.id) as TaskRow[];
  return { approvedTasks: approvedTasks.map((task) => serializeTask(projectDb, task)) };
}

export async function pullTaskMain(params: { userId: string; taskId: string }) {
  const scopedTask = taskForUser(params.taskId, params.userId, "write");
  if (!scopedTask) {
    throw new CliServiceError("NOT_FOUND", "Task not found");
  }
  const { task, project, projectDb } = scopedTask;
  if (taskIsBlocked(projectDb, task.id)) {
    throw new CliServiceError("CONFLICT", "Task is blocked by unmerged dependencies");
  }

  const parentPlanTask = parentPlanTaskFor(projectDb, task);
  const topology = resolveTaskGitTopology({ task, project, parentPlanTask });
  let pullResult: Awaited<ReturnType<typeof pullRemoteRefIntoTaskWorkspace>>;
  try {
    pullResult = await pullRemoteRefIntoTaskWorkspace({
      workspacePath: task.workspace_path,
      remoteRef: topology.pullRemoteRef
    });
  } catch (error: any) {
    throw new CliServiceError("CONFLICT", String(error?.message ?? "Failed to pull from main"));
  }

  const now = nowIso();
  projectDb.prepare("UPDATE tasks SET head_commit_sha = ?, updated_at = ? WHERE id = ?").run(pullResult.headCommitSha, now, task.id);
  let latestTask = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  if (pullResult.conflicted && latestTask.status !== "merge_conflict") {
    latestTask = setTaskStatus(projectDb, latestTask, "merge_conflict", "pull_main_conflict", params.userId);
  }
  if (!pullResult.conflicted && latestTask.status === "merge_conflict") {
    latestTask = setTaskStatus(projectDb, latestTask, "in_progress", "pull_main_resolved", params.userId);
  }

  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "task.pull_main",
    database: projectDb,
    payload: {
      targetRef: topology.pullRemoteRef,
      conflicted: pullResult.conflicted,
      conflictFiles: pullResult.conflictFiles,
      headCommitSha: pullResult.headCommitSha
    }
  });

  return {
    task: serializeTask(projectDb, latestTask),
    sync: {
      targetRef: topology.pullRemoteRef,
      conflicted: pullResult.conflicted,
      conflictFiles: pullResult.conflictFiles,
      headCommitSha: pullResult.headCommitSha
    }
  };
}
