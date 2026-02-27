import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { db as appDb, isProjectDbError, resolveProjectDatabase } from "../db/index.js";
import { recordEvent } from "../services/events.js";
import {
  cloneLocalBaseToWorkspace,
  createTaskBranch,
  getHeadCommitSha,
  getWorkspaceGitStatusCached,
  getWorkspaceGitStatus,
  mergeTaskWorkspaceIntoTarget,
  pullRemoteRefIntoTaskWorkspace,
  refreshBaseFromOrigin,
  taskBranchName
} from "../services/git.js";
import { buildIdeResumeCommand, ideSessionRunning, ideSessionTarget, prepareIdeWorkspace, startIdeSession, stopIdeSession } from "../services/ide.js";
import { kickTaskQueueProcessing } from "../services/queue.js";
import { triggerAutoMergeIfEligible } from "../services/runtime.js";
import { sendTaskRuntimeInputWorker, startTaskRuntimeWorker } from "../services/runtimeWorker.js";
import { hasSession, killSession } from "../services/tmux.js";
import { buildEffectivePrompt } from "../services/promptBuilder.js";
import { buildAutomationVisibility } from "../services/automationVisibility.js";
import { buildInitialNodeMetadata, readNodeMetadata, serializeNodeMetadata, writeNodeMetadata } from "../services/orchestration/metadata.js";
import { buildDependencyDiagnostics, partitionDependenciesByTier, resolveAndValidateNodeDependencies } from "../services/orchestration/dependencyGraph.js";
import { readReplanControl } from "../services/orchestration/idempotency.js";
import { enqueueOrchestrationJob, kickOrchestrationJobQueueProcessing } from "../services/orchestration/jobQueue.js";
import { orchestrationActionsApiEnabled, orchestrationHierarchyApiEnabled } from "../config/featureFlags.js";
import {
  createWorkflowDefinition,
  createWorkflowRun,
  deleteWorkflowDefinition,
  getWorkflowDefinitionById,
  getWorkflowRunById,
  listWorkflowCheckResultsByStageRun,
  listWorkflowDefinitionsByProject,
  listWorkflowEventsByRun,
  listWorkflowEventsByStageRun,
  listWorkflowRunsByProject,
  listWorkflowStageRunsByRun,
  transitionWorkflowRunStatus,
  transitionWorkflowStageRunStatus,
  updateWorkflowDefinition
} from "../services/workflowRepository.js";
import { startWorkflowRun, tickWorkflowRun } from "../services/workflowEngine.js";
import {
  workflowDefinitionCreateSchema,
  workflowDefinitionPatchSchema,
  workflowRunCancelSchema,
  workflowRunStartSchema,
  workflowRunStateSchema
} from "../api/contracts/workflows.js";
import type {
  IdeInstanceRow,
  MergeRecordRow,
  NodeDependencyRef,
  NodeMetadata,
  NodeTier,
  ProjectRow,
  TaskRow,
  TaskSessionRow,
  TaskStatus,
  TaskTransitionRow
} from "../types.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";
import { logEndpoint } from "../utils/backendLogger.js";

const createTaskSchema = z.object({
  title: z.string().min(2).max(160),
  taskPrompt: z.string().min(1).max(12000),
  aiCommand: z.string().min(1).max(500).optional(),
  autoMerge: z.boolean().optional(),
  allowReplanBudgetOverride: z.boolean().optional(),
  dependencyTaskIds: z.array(z.string().uuid()).max(200).optional(),
  dependencyNodeRefs: z.array(z.object({
    id: z.string().min(1).max(200),
    tier: z.enum(["epoch", "phase", "plan", "task", "exec"]).optional(),
    reason: z.string().min(1).max(500).optional()
  })).max(200).optional()
});

const createNodeSchema = z.object({
  title: z.string().min(2).max(160),
  taskPrompt: z.string().min(1).max(12000),
  nodeTier: z.enum(["epoch", "phase", "plan", "task"]),
  aiCommand: z.string().min(1).max(500).optional(),
  autoMerge: z.boolean().optional(),
  autoStart: z.boolean().optional(),
  autoMergeOnComplete: z.boolean().optional(),
  allowReplanBudgetOverride: z.boolean().optional(),
  parentNodeId: z.string().min(1).max(200).optional(),
  dependencyTaskIds: z.array(z.string().uuid()).max(200).optional(),
  dependencyNodeRefs: z.array(z.object({
    id: z.string().min(1).max(200),
    tier: z.enum(["epoch", "phase", "plan", "task", "exec"]).optional(),
    reason: z.string().min(1).max(500).optional()
  })).max(200).optional()
});

function withReplanBudgetOverride(metadata: any, enabled: boolean) {
  if (!enabled) return metadata;
  return {
    ...metadata,
    custom: {
      ...(metadata.custom ?? {}),
      replan_budget_override: true
    }
  };
}

const patchTaskSchema = z.object({
  aiCommand: z.string().min(1).max(500).optional()
});

const inputSchema = z.object({
  text: z.string().min(1).max(20000)
});

const cancelTaskSchema = z.object({
  reason: z.string().min(1).max(1000)
});

const startNodeSchema = z.object({
  autoMode: z.boolean().optional()
});

const autoModeSchema = z.object({
  enabled: z.boolean()
});

const autoMergeSchema = z.object({
  enabled: z.boolean(),
  onComplete: z.boolean().optional()
});

const forceReReviewSchema = z.object({
  reason: z.string().min(1).max(1000).optional()
});

const approveBudgetOverrideSchema = z.object({
  reason: z.string().min(1).max(1000).optional(),
  enabled: z.boolean().optional()
});

function respondFeatureDisabled(res: any, feature: string): void {
  res.status(404).json({ error: `Feature disabled: ${feature}`, code: "FEATURE_DISABLED" });
}

const mergeLocks = new Set<string>();
const TASK_DETAIL_INCLUDE_GIT_DEFAULT = /^(1|true|yes)$/i.test(process.env.AI_CODING_TASK_DETAIL_INCLUDE_GIT_DEFAULT ?? "");
const TASK_DETAIL_INCLUDE_HEAVY_DEFAULT = /^(1|true|yes)$/i.test(process.env.AI_CODING_TASK_DETAIL_INCLUDE_HEAVY_DEFAULT ?? "");

function queryBoolFlag(input: unknown, fallback: boolean): boolean {
  if (typeof input !== "string") return fallback;
  const normalized = input.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function durationFrom(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function logRouteStage(route: string, stage: string, startedAt: bigint, fields?: Record<string, unknown>): void {
  logEndpoint("http.route.stage", {
    route,
    stage,
    durationMs: durationFrom(startedAt),
    ...(fields ?? {})
  });
}

function parseTime(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

type WorkflowLifecycleState = "blocked" | "ready" | "running" | "waiting_input" | "verifying";

type ChronoTaskRow = TaskRow & { __rowid?: number };

function compareTaskRowsChronological(a: ChronoTaskRow, b: ChronoTaskRow): number {
  const createdDiff = parseTime(b.created_at) - parseTime(a.created_at);
  if (createdDiff !== 0) return createdDiff;
  const updatedDiff = parseTime(b.updated_at) - parseTime(a.updated_at);
  if (updatedDiff !== 0) return updatedDiff;
  const rowidDiff = (b.__rowid ?? Number.NEGATIVE_INFINITY) - (a.__rowid ?? Number.NEGATIVE_INFINITY);
  if (rowidDiff !== 0) return rowidDiff;
  const titleDiff = a.title.localeCompare(b.title);
  if (titleDiff !== 0) return titleDiff;
  return a.id.localeCompare(b.id);
}

function isSafeTaskWorkspacePath(workspacePath: string, projectBasePath: string): boolean {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const projectTasksRoot = path.resolve(path.dirname(projectBasePath), "tasks");
  const relative = path.relative(projectTasksRoot, resolvedWorkspacePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
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

function respondProjectDbError(res: any, error: unknown): boolean {
  if (!isProjectDbError(error)) {
    return false;
  }
  const status = error.code === "PROJECT_DB_UNAVAILABLE" ? 503 : 409;
  res.status(status).json({
    error: error.message,
    code: error.code
  });
  return true;
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

function projectDatabaseFor(project: ProjectRow, intent: "read" | "write"): Database.Database {
  return resolveProjectDatabase({
    appDb,
    projectId: project.id,
    basePath: project.base_path,
    intent
  }).database;
}

function taskForUser(
  taskId: string,
  userId: string,
  intent: "read" | "write"
): { task: TaskRow; project: ProjectRow; projectDb: Database.Database } | undefined {
  const projects = memberProjectsForUser(userId);
  for (const project of projects) {
    let projectDb: Database.Database;
    try {
      projectDb = projectDatabaseFor(project, intent);
    } catch (error) {
      if (isProjectDbError(error)) {
        continue;
      }
      throw error;
    }
    const task = projectDb
      .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
      .get(taskId, project.id) as TaskRow | undefined;
    if (task) {
      return { task, project, projectDb };
    }
  }
  return undefined;
}

function parentPlanTaskForUser(projectDb: Database.Database, task: TaskRow): TaskRow | undefined {
  if (!task.parent_plan_task_id) {
    return undefined;
  }
  return projectDb
    .prepare("SELECT * FROM tasks WHERE id = ? AND mode = 'plan'")
    .get(task.parent_plan_task_id) as TaskRow | undefined;
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

function serializeTask(
  projectDb: Database.Database,
  task: TaskRow,
  options: {
    includeCompletion?: boolean;
  } = {}
) {
  const includeCompletion = options.includeCompletion ?? true;
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
  const completion = includeCompletion ? buildCompletionEvidence(projectDb, task, nodeMetadata) : undefined;

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
    ...(completion ? { completion } : {}),
    createdByUserId: task.created_by_user_id,
    createdAt: task.created_at,
    updatedAt: task.updated_at
  };
}

type CompletionEvidenceView = {
  synthesisArtifactEventId: string | null;
  verificationArtifactEventId: string | null;
  verificationVerdict: "pass" | "fail" | null;
  summary: string | null;
  synthesisArtifact: Record<string, unknown> | null;
  verificationArtifact: Record<string, unknown> | null;
  deltaLoopHistory: Array<Record<string, unknown>>;
};

function parseJsonObject(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "string") return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readEventArtifact(
  projectDb: Database.Database,
  eventId: string | null,
  expectedType: string
): Record<string, unknown> | null {
  if (!eventId) return null;
  const row = projectDb
    .prepare("SELECT event_type, payload FROM events WHERE id = ? LIMIT 1")
    .get(eventId) as { event_type: string; payload: string } | undefined;
  if (!row || row.event_type !== expectedType) return null;
  const parsed = parseJsonObject(row.payload);
  const artifact = parsed?.artifact;
  return artifact && typeof artifact === "object" ? (artifact as Record<string, unknown>) : null;
}

function readVerificationHistory(projectDb: Database.Database, taskId: string): Array<Record<string, unknown>> {
  const rows = projectDb
    .prepare(
      `SELECT id, payload
       FROM events
       WHERE task_id = ? AND event_type = 'orchestration.verify.completed'
       ORDER BY created_at ASC`
    )
    .all(taskId) as Array<{ id: string; payload: string }>;
  return rows
    .map((row) => {
      const parsed = parseJsonObject(row.payload);
      const artifact = parsed?.artifact;
      if (!artifact || typeof artifact !== "object") return null;
      return {
        generated_at: (artifact as Record<string, unknown>).generated_at ?? null,
        verdict: (artifact as Record<string, unknown>).verdict ?? null,
        reasons: Array.isArray((artifact as Record<string, unknown>).reasons)
          ? ((artifact as Record<string, unknown>).reasons as unknown[])
          : [],
        failing_requirements: Array.isArray((artifact as Record<string, unknown>).failing_requirements)
          ? ((artifact as Record<string, unknown>).failing_requirements as unknown[])
          : [],
        delta_plan_enqueued: Boolean((artifact as Record<string, unknown>).delta_plan_enqueued),
        budget_exhausted: Boolean((artifact as Record<string, unknown>).budget_exhausted),
        verification_artifact_event_id: row.id
      } as Record<string, unknown>;
    })
    .filter((value): value is Record<string, unknown> => Boolean(value))
    .slice(-20);
}

function buildCompletionEvidence(projectDb: Database.Database, task: TaskRow, nodeMetadata: NodeMetadata): CompletionEvidenceView {
  const custom = ((nodeMetadata.custom ?? {}) as Record<string, unknown>) ?? {};
  const completionArtifacts =
    custom.completion_artifacts && typeof custom.completion_artifacts === "object"
      ? (custom.completion_artifacts as Record<string, unknown>)
      : {};
  const synthesisArtifactEventId = typeof custom.synthesis_artifact_event_id === "string"
    ? custom.synthesis_artifact_event_id
    : null;
  const verificationArtifactEventId = typeof custom.verification_artifact_event_id === "string"
    ? custom.verification_artifact_event_id
    : null;
  const verificationVerdict = custom.verification_verdict === "pass" || custom.verification_verdict === "fail"
    ? custom.verification_verdict
    : null;

  const synthesisArtifact = completionArtifacts.synthesis && typeof completionArtifacts.synthesis === "object"
    ? (completionArtifacts.synthesis as Record<string, unknown>)
    : readEventArtifact(projectDb, synthesisArtifactEventId, "orchestration.synthesize.completed");
  const verificationArtifact = completionArtifacts.verification && typeof completionArtifacts.verification === "object"
    ? (completionArtifacts.verification as Record<string, unknown>)
    : readEventArtifact(projectDb, verificationArtifactEventId, "orchestration.verify.completed");
  const deltaLoopHistory = Array.isArray(completionArtifacts.delta_loop_history)
    ? (completionArtifacts.delta_loop_history as Array<Record<string, unknown>>).slice(-20)
    : readVerificationHistory(projectDb, task.id);

  return {
    synthesisArtifactEventId,
    verificationArtifactEventId,
    verificationVerdict,
    summary: typeof synthesisArtifact?.summary === "string" ? synthesisArtifact.summary : null,
    synthesisArtifact,
    verificationArtifact,
    deltaLoopHistory
  };
}

function directDependencies(projectDb: Database.Database, task: TaskRow): {
  nodeTier: NodeTier;
  dependencies: NodeDependencyRef[];
} {
  const dependencyTaskIds = projectDb
    .prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
    .all(task.id) as Array<{ dependency_task_id: string }>;
  const metadata = readNodeMetadata({
    projectDb,
    task,
    dependencyTaskIds: dependencyTaskIds.map((row) => row.dependency_task_id)
  }).metadata;
  const nodeTier = metadata.tier;
  const refs = [
    ...(metadata.dependencies?.same_tier ?? []).map((dep) => ({
      id: dep.id,
      tier: dep.tier ?? nodeTier,
      reason: dep.reason
    })),
    ...(metadata.dependencies?.cross_tier ?? []).map((dep) => ({
      id: dep.id,
      tier: dep.tier ?? "task",
      reason: dep.reason
    }))
  ];
  const seen = new Set<string>();
  const dependencies = refs.filter((dep) => {
    const key = `${dep.tier}:${dep.id}`;
    if (!dep.id || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { nodeTier, dependencies };
}

type HierarchyDependencyDetail = {
  id: string;
  tier: NodeTier;
  reason: string | null;
  status: TaskStatus | null;
};

type HierarchyDependencyMapRow = {
  task_id: string;
  dependency_task_id: string;
  dependency_status: TaskStatus | null;
};

function buildHierarchyWaitingState(params: {
  status: TaskStatus;
  blockedByTaskIds: string[];
  unresolvedDependencyDetails: HierarchyDependencyDetail[];
}) {
  const unresolvedDependencyIds = params.unresolvedDependencyDetails.map((dep) => dep.id);
  const dependencyBlockerTaskId = params.blockedByTaskIds[0] ?? null;

  if (params.status === "queued" && params.blockedByTaskIds.length > 0) {
    return {
      waiting: true,
      reasonCode: "blocked_dependencies",
      reason: "Task is queued but blocked by unmerged dependencies.",
      dependencyBlockerTaskId,
      unresolvedDependencyIds,
      unresolvedDependencyDetails: params.unresolvedDependencyDetails
    };
  }
  if (params.status === "awaiting_children") {
    return {
      waiting: true,
      reasonCode: "awaiting_children",
      reason: "Plan is waiting for child tasks to merge.",
      dependencyBlockerTaskId,
      unresolvedDependencyIds,
      unresolvedDependencyDetails: params.unresolvedDependencyDetails
    };
  }
  if (params.status === "waiting_input") {
    return {
      waiting: true,
      reasonCode: "waiting_input",
      reason: "Task is waiting for runtime input or follow-up automation.",
      dependencyBlockerTaskId,
      unresolvedDependencyIds,
      unresolvedDependencyDetails: params.unresolvedDependencyDetails
    };
  }
  if (params.status === "merge_conflict") {
    return {
      waiting: true,
      reasonCode: "merge_conflict",
      reason: "Task is waiting for merge conflict resolution.",
      dependencyBlockerTaskId,
      unresolvedDependencyIds,
      unresolvedDependencyDetails: params.unresolvedDependencyDetails
    };
  }
  return {
    waiting: params.status === "queued" || params.status === "in_progress",
    reasonCode: params.status,
    reason: `Task is currently ${params.status}.`,
    dependencyBlockerTaskId,
    unresolvedDependencyIds,
    unresolvedDependencyDetails: params.unresolvedDependencyDetails
  };
}

function projectHierarchy(projectDb: Database.Database, projectId: string) {
  const tasks = (projectDb
    .prepare(
      `SELECT *
       , rowid AS __rowid
       FROM tasks
       WHERE project_id = ?`
    )
    .all(projectId) as ChronoTaskRow[]).sort(compareTaskRowsChronological);
  const dependencyRows = projectDb
    .prepare(
      `SELECT
         td.task_id,
         td.dependency_task_id,
         dep.status AS dependency_status
       FROM task_dependencies td
       JOIN tasks owner ON owner.id = td.task_id
       LEFT JOIN tasks dep ON dep.id = td.dependency_task_id
       WHERE owner.project_id = ?
       ORDER BY td.created_at ASC`
    )
    .all(projectId) as HierarchyDependencyMapRow[];

  const dependencyTaskIdsByTaskId = new Map<string, string[]>();
  const blockedByTaskIdsByTaskId = new Map<string, string[]>();
  const dependencyStatusByTaskId = new Map<string, Map<string, TaskStatus | null>>();
  for (const row of dependencyRows) {
    const depList = dependencyTaskIdsByTaskId.get(row.task_id) ?? [];
    depList.push(row.dependency_task_id);
    dependencyTaskIdsByTaskId.set(row.task_id, depList);

    const statusMap = dependencyStatusByTaskId.get(row.task_id) ?? new Map<string, TaskStatus | null>();
    statusMap.set(row.dependency_task_id, row.dependency_status ?? null);
    dependencyStatusByTaskId.set(row.task_id, statusMap);

    if (row.dependency_status !== "merged") {
      const blockedList = blockedByTaskIdsByTaskId.get(row.task_id) ?? [];
      blockedList.push(row.dependency_task_id);
      blockedByTaskIdsByTaskId.set(row.task_id, blockedList);
    }
  }

  const nodesByParent = new Map<string | null, any[]>();
  const nodeRows = tasks.map((task) => {
    const dependencyTaskIds = dependencyTaskIdsByTaskId.get(task.id) ?? [];
    const blockedByTaskIds = blockedByTaskIdsByTaskId.get(task.id) ?? [];
    const dependencyStatuses = dependencyStatusByTaskId.get(task.id) ?? new Map<string, TaskStatus | null>();
    const { metadata: nodeMetadata } = readNodeMetadata({
      projectDb,
      task,
      dependencyTaskIds
    });
    const nodeTier = nodeMetadata.tier;
    const replan = readReplanControl(nodeMetadata);
    const autoMode = typeof nodeMetadata.custom?.auto_mode === "boolean"
      ? Boolean(nodeMetadata.custom?.auto_mode)
      : true;
    const refs = [
      ...(nodeMetadata.dependencies?.same_tier ?? []).map((dep) => ({
        id: dep.id,
        tier: dep.tier ?? nodeTier,
        reason: dep.reason ?? null
      })),
      ...(nodeMetadata.dependencies?.cross_tier ?? []).map((dep) => ({
        id: dep.id,
        tier: dep.tier ?? "task",
        reason: dep.reason ?? null
      }))
    ];
    const unresolvedDependencyDetails = refs
      .filter((dep) => (dependencyStatuses.get(dep.id) ?? null) !== "merged")
      .filter((dep, index, source) =>
        source.findIndex((candidate) => candidate.id === dep.id && candidate.tier === dep.tier) === index
      )
      .map((dep) => ({
        id: dep.id,
        tier: dep.tier,
        reason: dep.reason,
        status: dependencyStatuses.get(dep.id) ?? null
      }));
    const waiting = buildHierarchyWaitingState({
      status: task.status,
      blockedByTaskIds,
      unresolvedDependencyDetails
    });
    return {
      task: {
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
        dependencyTaskIds,
        blockedByTaskIds,
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
      },
      tier: nodeTier,
      waiting
    };
  });

  for (const row of nodeRows) {
    const parentId = row.task.parentPlanTaskId ?? null;
    if (!nodesByParent.has(parentId)) {
      nodesByParent.set(parentId, []);
    }
    nodesByParent.get(parentId)?.push(row);
  }

  const attachChildren = (row: any): any => ({
    ...row,
    children: (nodesByParent.get(row.task.id) ?? []).map(attachChildren)
  });

  const roots = (nodesByParent.get(null) ?? []).map(attachChildren);
  return {
    projectId,
    roots,
    nodes: nodeRows
  };
}

function projectDependencyGraph(projectDb: Database.Database, projectId: string) {
  const tasks = projectDb
    .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC")
    .all(projectId) as TaskRow[];
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));

  const nodes = tasks.map((task) => {
    const deps = directDependencies(projectDb, task);
    return {
      id: task.id,
      title: task.title,
      mode: task.mode,
      status: task.status,
      tier: deps.nodeTier,
      dependencyCount: deps.dependencies.length
    };
  });

  const edges = tasks.flatMap((task) => {
    const deps = directDependencies(projectDb, task);
    return deps.dependencies.map((dep) => ({
      fromId: task.id,
      fromTier: deps.nodeTier,
      toId: dep.id,
      toTier: dep.tier ?? "task",
      toStatus: statusById.get(dep.id) ?? null,
      unresolved: statusById.get(dep.id) !== "merged",
      reason: dep.reason ?? null
    }));
  });

  return { projectId, nodes, edges };
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

function serializeWorkflowDefinitionRow(row: {
  id: string;
  project_id: string;
  name: string;
  version: number;
  definition_yaml: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    version: row.version,
    definitionYaml: row.definition_yaml,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeWorkflowRunState(projectDb: Database.Database, workflowRunId: string) {
  const run = getWorkflowRunById(projectDb, workflowRunId);
  if (!run) return null;
  const definition = getWorkflowDefinitionById(projectDb, run.workflow_definition_id);
  if (!definition) return null;

  const stages = listWorkflowStageRunsByRun(projectDb, run.id);
  const stageStates = stages.map((stage) => {
    const stageEvents = listWorkflowEventsByStageRun(projectDb, stage.id);
    const checks = listWorkflowCheckResultsByStageRun(projectDb, stage.id).map((check) => ({
      id: check.id,
      stageRunId: check.workflow_stage_run_id,
      checkName: check.check_name,
      status: check.status,
      details: safeParseJson(check.details_json),
      createdAt: check.created_at,
      updatedAt: check.updated_at
    }));

    let lifecycleState: WorkflowLifecycleState | null = null;
    let blockedBy: string[] = [];
    let attemptsStarted = 0;
    for (const event of stageEvents) {
      if (event.event_type === "workflow.stage.attempt.started") {
        attemptsStarted += 1;
      }
      if (event.event_type === "workflow.stage.lifecycle") {
        const payload = safeParseJson(event.payload) as { state?: unknown; unresolvedDependsOn?: unknown } | null;
        if (typeof payload?.state === "string") {
          lifecycleState = payload.state as WorkflowLifecycleState;
        }
        if (Array.isArray(payload?.unresolvedDependsOn)) {
          blockedBy = payload.unresolvedDependsOn.filter((entry): entry is string => typeof entry === "string");
        }
      }
    }

    return {
      id: stage.id,
      workflowRunId: stage.workflow_run_id,
      stageKey: stage.stage_key,
      ordinal: stage.ordinal,
      status: stage.status,
      startedAt: stage.started_at,
      completedAt: stage.completed_at,
      createdAt: stage.created_at,
      updatedAt: stage.updated_at,
      diagnostics: {
        lifecycleState,
        attemptsStarted,
        blockedBy,
        checks,
        recentEvents: stageEvents.slice(-25).map((event) => ({
          id: event.id,
          eventType: event.event_type,
          payload: safeParseJson(event.payload),
          createdAt: event.created_at
        }))
      }
    };
  });

  const responsePayload = {
    run: {
      id: run.id,
      workflowDefinitionId: run.workflow_definition_id,
      projectId: run.project_id,
      taskId: run.task_id,
      status: run.status,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      createdAt: run.created_at,
      updatedAt: run.updated_at
    },
    definition: serializeWorkflowDefinitionRow(definition),
    stages: stageStates,
    events: listWorkflowEventsByRun(projectDb, run.id).slice(-50).map((event) => ({
      id: event.id,
      eventType: event.event_type,
      payload: safeParseJson(event.payload),
      createdAt: event.created_at
    }))
  };

  return workflowRunStateSchema.parse(responsePayload);
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
      hasSessionHistory: Boolean(session) && task.status !== "queued",
      tmuxSocketPath: attachableSession?.tmux_socket_path,
      tmuxSessionName: attachableSession?.tmux_session_name,
      resumeCommand
    });
    if (openPath.endsWith(".code-workspace")) {
      return issueIdeLaunchUrl({ projectDb, taskId: task.id, ideId, workspacePath: openPath });
    }
    return issueIdeLaunchUrl({ projectDb, taskId: task.id, ideId, folderPath: openPath });
  } catch {
    // Fall back to direct folder launch if workspace file generation fails.
    return issueIdeLaunchUrl({ projectDb, taskId: task.id, ideId, folderPath: task.workspace_path });
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

function recordTaskTransition(params: {
  projectDb: Database.Database;
  taskId: string;
  fromStatus: string;
  toStatus: string;
  reason: string;
  actorUserId: string;
}): void {
  params.projectDb.prepare(
    `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(makeId(), params.taskId, params.fromStatus, params.toStatus, params.reason, params.actorUserId, nowIso());
}

function setTaskStatus(
  projectDb: Database.Database,
  task: TaskRow,
  nextStatus: TaskStatus,
  reason: string,
  actorUserId: string
): TaskRow {
  const now = nowIso();
  projectDb.transaction(() => {
    if (nextStatus === "merged") {
      projectDb.prepare("UPDATE tasks SET status = ?, cancel_reason = NULL, updated_at = ? WHERE id = ?").run(nextStatus, now, task.id);
    } else {
      projectDb
        .prepare("UPDATE tasks SET status = ?, cancel_reason = NULL, merged_at = NULL, merged_by_user_id = NULL, updated_at = ? WHERE id = ?")
        .run(
        nextStatus,
        now,
        task.id
      );
    }
    recordTaskTransition({
      projectDb,
      taskId: task.id,
      fromStatus: task.status,
      toStatus: nextStatus,
      reason,
      actorUserId
    });
  })();
  return projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
}

function getProjectAccessOrRespond(
  params: { projectId: string; userId: string; notFoundMessage: string; intent: "read" | "write" },
  res: any
): { project: ProjectRow; projectDb: Database.Database } | null {
  const project = projectForUser(params.projectId, params.userId);
  if (!project) {
    res.status(404).json({ error: params.notFoundMessage });
    return null;
  }
  try {
    return {
      project,
      projectDb: projectDatabaseFor(project, params.intent)
    };
  } catch (error) {
    if (respondProjectDbError(res, error)) {
      return null;
    }
    throw error;
  }
}

function getTaskAccessOrRespond(
  params: { taskId: string; userId: string; notFoundMessage: string; intent: "read" | "write" },
  res: any
): { task: TaskRow; project: ProjectRow; projectDb: Database.Database } | null {
  try {
    const scoped = taskForUser(params.taskId, params.userId, params.intent);
    if (!scoped) {
      res.status(404).json({ error: params.notFoundMessage });
      return null;
    }
    return scoped;
  } catch (error) {
    if (respondProjectDbError(res, error)) {
      return null;
    }
    throw error;
  }
}

export type CreateProjectNodeInput = {
  title: string;
  taskPrompt: string;
  nodeTier: "epoch" | "phase" | "plan" | "task";
  aiCommand?: string;
  autoMerge?: boolean;
  autoStart?: boolean;
  autoMergeOnComplete?: boolean;
  allowReplanBudgetOverride?: boolean;
  parentNodeId?: string;
  dependencyTaskIds?: string[];
  dependencyNodeRefs?: NodeDependencyRef[];
};

type CreateProjectNodeSource = "unified" | "legacyTask" | "legacyPlan";

type CreateProjectNodeParams = {
  project: ProjectRow;
  projectDb: Database.Database;
  userId: string;
  source: CreateProjectNodeSource;
  input: CreateProjectNodeInput;
};

type CreateProjectNodeError = Error & { status?: number };

function createProjectNodeError(status: number, message: string): CreateProjectNodeError {
  const error = new Error(message) as CreateProjectNodeError;
  error.status = status;
  return error;
}

export async function createProjectNode(params: CreateProjectNodeParams): Promise<TaskRow> {
  const { project, projectDb, userId, source, input } = params;
  const id = makeId();
  const now = nowIso();
  const mode: TaskRow["mode"] = input.nodeTier === "task" ? "execution" : "plan";
  const autoMerge = input.autoMerge ?? true;
  const autoStart = mode === "plan" ? Boolean(input.autoStart) : false;
  const autoMergeOnComplete = mode === "plan" ? (input.autoMergeOnComplete ?? true) : false;
  const allowReplanBudgetOverride = Boolean(input.allowReplanBudgetOverride);
  const aiCommand = resolveAiCommand(input.aiCommand, userId);
  const effectivePrompt = buildEffectivePrompt(project, input.taskPrompt);
  const workspacePath = path.join(path.dirname(project.base_path), "tasks", id);

  let parentTask: TaskRow | undefined;
  if (input.parentNodeId) {
    parentTask = projectDb
      .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
      .get(input.parentNodeId, project.id) as TaskRow | undefined;
    if (!parentTask) {
      if (source === "legacyPlan") {
        throw createProjectNodeError(400, "parentPlanTaskId must reference an existing plan in this project");
      }
      throw createProjectNodeError(400, "parentNodeId must reference an existing node in this project");
    }
    if (source === "legacyPlan" && parentTask.mode !== "plan") {
      throw createProjectNodeError(400, "parentPlanTaskId must reference an existing plan in this project");
    }
  }

  const parentDeps = parentTask
    ? (projectDb
      .prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
      .all(parentTask.id) as Array<{ dependency_task_id: string }>)
      .map((row) => row.dependency_task_id)
    : [];
  const parentTier = parentTask
    ? readNodeMetadata({ projectDb, task: parentTask, dependencyTaskIds: parentDeps }).metadata.tier
    : null;

  const materializedDependencyNodeRefs = [...(input.dependencyNodeRefs ?? [])];
  if (
    source === "unified"
    && parentTask
    && !materializedDependencyNodeRefs.some((dep) => dep.id === parentTask?.id)
  ) {
    materializedDependencyNodeRefs.push({
      id: parentTask.id,
      tier: parentTier ?? "plan",
      reason: "parent_node"
    });
  }

  let dependencyResolution: ReturnType<typeof resolveAndValidateNodeDependencies>;
  try {
    dependencyResolution = resolveAndValidateNodeDependencies({
      projectDb,
      projectId: project.id,
      nodeId: id,
      nodeTier: input.nodeTier,
      dependencyTaskIds: input.dependencyTaskIds ?? [],
      dependencyNodeRefs: materializedDependencyNodeRefs
    });
  } catch (error: any) {
    throw createProjectNodeError(400, String(error?.message ?? "Invalid dependencies"));
  }

  const dependencies = dependencyResolution.taskDependencies;
  const unresolvedDependencies = dependencyResolution.unresolvedTaskDependencies;
  const isBlocked = unresolvedDependencies.length > 0;
  const partitionedDeps = partitionDependenciesByTier(dependencyResolution.normalizedDependencies, input.nodeTier);
  const sourcePath = parentTask ? parentTask.workspace_path : project.base_path;
  const sourceBranch = parentTask ? taskBranchName(parentTask.id) : project.default_branch;

  let baseCommitSha: string;
  try {
    baseCommitSha = await getHeadCommitSha(sourcePath);
    if (!isBlocked) {
      await cloneLocalBaseToWorkspace({ basePath: sourcePath, baseBranch: sourceBranch, workspacePath });
      await createTaskBranch(workspacePath, id);
      if (mode === "plan") {
        await fs.promises.mkdir(path.join(workspacePath, ".ai-plan"), { recursive: true });
      }
    }
  } catch (error: any) {
    throw createProjectNodeError(500, String(error?.message ?? "Failed to initialize node workspace"));
  }

  projectDb.transaction(() => {
    const metadataJson = serializeNodeMetadata(
      withReplanBudgetOverride(buildInitialNodeMetadata({
        task: {
          id,
          project_id: project.id,
          mode,
          metadata_json: null,
          auto_merge: autoMerge ? 1 : 0,
          auto_start: autoStart ? 1 : 0,
          auto_merge_on_complete: autoMergeOnComplete ? 1 : 0,
          parent_plan_task_id: parentTask?.id ?? null,
          source_plan_revision_id: null,
          source_plan_item_key: null
        },
        dependencyTaskIds: dependencies.map((dependency) => dependency.id),
        tier: input.nodeTier,
        sameTierDependencies: partitionedDeps.sameTierDependencies,
        crossTierDependencies: partitionedDeps.crossTierDependencies
      }), allowReplanBudgetOverride)
    );

    projectDb.prepare(
      `INSERT INTO tasks (
        id, project_id, title, task_prompt, result, effective_prompt, ai_command,
        auto_merge, auto_start, auto_merge_on_complete, metadata_json,
        mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
        status, workspace_path, base_commit_sha_at_create, head_commit_sha,
        cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
    ).run(
      id,
      project.id,
      input.title,
      input.taskPrompt,
      effectivePrompt,
      aiCommand,
      autoMerge ? 1 : 0,
      autoStart ? 1 : 0,
      autoMergeOnComplete ? 1 : 0,
      metadataJson,
      mode,
      parentTask?.id ?? null,
      workspacePath,
      baseCommitSha,
      userId,
      now,
      now
    );

    const transitionReason = source === "legacyTask"
      ? (isBlocked ? "task_created_blocked" : "task_created")
      : source === "legacyPlan"
        ? "plan_created"
        : (isBlocked ? "node_created_blocked" : "node_created");
    projectDb.prepare(
      `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(makeId(), id, "null", "queued", transitionReason, userId, now);

    for (const dependency of dependencies) {
      projectDb.prepare("INSERT INTO task_dependencies (task_id, dependency_task_id, created_at) VALUES (?, ?, ?)").run(
        id,
        dependency.id,
        now
      );
    }
  })();

  recordEvent({
    projectId: project.id,
    taskId: id,
    eventType: mode === "plan" ? "plan.created" : "task.created",
    database: projectDb,
    payload: source === "legacyPlan"
      ? {
        title: input.title,
        aiCommand,
        autoStart,
        autoMergeOnComplete,
        allowReplanBudgetOverride,
        parentPlanTaskId: parentTask?.id ?? null,
        workspacePath,
        baseCommitShaAtCreate: baseCommitSha
      }
      : source === "legacyTask"
        ? {
          title: input.title,
          aiCommand,
          autoMerge,
          workspacePath,
          baseCommitShaAtCreate: baseCommitSha,
          dependencyTaskIds: dependencies.map((x) => x.id),
          dependencyNodeRefs: dependencyResolution.normalizedDependencies,
          blockedByTaskIds: unresolvedDependencies.map((x) => x.id),
          blocked: isBlocked,
          allowReplanBudgetOverride
        }
        : {
          title: input.title,
          nodeTier: input.nodeTier,
          aiCommand,
          autoMerge,
          autoStart,
          autoMergeOnComplete,
          allowReplanBudgetOverride,
          parentNodeId: parentTask?.id ?? null,
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
  return task;
}

export const tasksRouter = Router();

tasksRouter.post("/projects/:projectId/nodes", async (req, res) => {
  const parsed = createNodeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "write" },
    res
  );
  if (!scopedProject) return;
  const { project, projectDb } = scopedProject;

  if (project.clone_status !== "ready") {
    res.status(409).json({ error: "Project base repository is not ready" });
    return;
  }

  const input = parsed.data;
  let task: TaskRow;
  try {
    task = await createProjectNode({
      project,
      projectDb,
      userId: req.user.id,
      source: "unified",
      input
    });
  } catch (error: any) {
    const status = Number(error?.status);
    res.status(Number.isInteger(status) ? status : 500).json({ error: String(error?.message ?? "Failed to create node") });
    return;
  }

  res.status(201).json({ node: serializeTask(projectDb, task) });
});

tasksRouter.post("/projects/:projectId/tasks", async (req, res) => {
  const parsed = createTaskSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "write" },
    res
  );
  if (!scopedProject) return;
  const { project, projectDb } = scopedProject;

  if (project.clone_status !== "ready") {
    res.status(409).json({ error: "Project base repository is not ready" });
    return;
  }

  const input = parsed.data;
  let task: TaskRow;
  try {
    task = await createProjectNode({
      project,
      projectDb,
      userId: req.user.id,
      source: "legacyTask",
      input: {
        title: input.title,
        taskPrompt: input.taskPrompt,
        nodeTier: "task",
        aiCommand: input.aiCommand,
        autoMerge: input.autoMerge,
        allowReplanBudgetOverride: input.allowReplanBudgetOverride,
        dependencyTaskIds: input.dependencyTaskIds,
        dependencyNodeRefs: input.dependencyNodeRefs
      }
    });
  } catch (error: any) {
    const status = Number(error?.status);
    res.status(Number.isInteger(status) ? status : 500).json({ error: String(error?.message ?? "Failed to create task") });
    return;
  }

  res.status(201).json({ task: serializeTask(projectDb, task) });
});

tasksRouter.get("/projects/:projectId/tasks", (req, res) => {
  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "read" },
    res
  );
  if (!scopedProject) return;
  const { project, projectDb } = scopedProject;

  const tasks = (projectDb
    .prepare(
      `SELECT *
       , rowid AS __rowid
       FROM tasks
       WHERE project_id = ? AND parent_plan_task_id IS NULL`
    )
    .all(project.id) as ChronoTaskRow[]).sort(compareTaskRowsChronological);

  res.json({ tasks: tasks.map((task) => serializeTask(projectDb, task)) });
});

tasksRouter.get("/projects/:projectId/hierarchy", (req, res) => {
  if (!orchestrationHierarchyApiEnabled()) {
    respondFeatureDisabled(res, "orchestration_hierarchy_api");
    return;
  }
  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "read" },
    res
  );
  if (!scopedProject) return;
  res.json({ hierarchy: projectHierarchy(scopedProject.projectDb, scopedProject.project.id) });
});

tasksRouter.get("/projects/:projectId/dependency-graph", (req, res) => {
  if (!orchestrationHierarchyApiEnabled()) {
    respondFeatureDisabled(res, "orchestration_hierarchy_api");
    return;
  }
  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "read" },
    res
  );
  if (!scopedProject) return;
  res.json({ graph: projectDependencyGraph(scopedProject.projectDb, scopedProject.project.id) });
});

tasksRouter.get("/projects/:projectId/workflow-definitions", (req, res) => {
  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "read" },
    res
  );
  if (!scopedProject) return;
  const definitions = listWorkflowDefinitionsByProject(scopedProject.projectDb, scopedProject.project.id).map(serializeWorkflowDefinitionRow);
  res.json({ definitions });
});

tasksRouter.post("/projects/:projectId/workflow-definitions", (req, res) => {
  const parsed = workflowDefinitionCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }
  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "write" },
    res
  );
  if (!scopedProject) return;
  const created = createWorkflowDefinition(scopedProject.projectDb, {
    projectId: scopedProject.project.id,
    name: parsed.data.name,
    version: parsed.data.version,
    definitionYaml: parsed.data.definitionYaml,
    createdByUserId: req.user.id
  });
  res.status(201).json({ definition: serializeWorkflowDefinitionRow(created) });
});

tasksRouter.get("/projects/:projectId/workflow-definitions/:definitionId", (req, res) => {
  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "read" },
    res
  );
  if (!scopedProject) return;
  const definition = getWorkflowDefinitionById(scopedProject.projectDb, req.params.definitionId);
  if (!definition || definition.project_id !== scopedProject.project.id) {
    res.status(404).json({ error: "Workflow definition not found" });
    return;
  }
  res.json({ definition: serializeWorkflowDefinitionRow(definition) });
});

tasksRouter.patch("/projects/:projectId/workflow-definitions/:definitionId", (req, res) => {
  const parsed = workflowDefinitionPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }
  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "write" },
    res
  );
  if (!scopedProject) return;
  const existing = getWorkflowDefinitionById(scopedProject.projectDb, req.params.definitionId);
  if (!existing || existing.project_id !== scopedProject.project.id) {
    res.status(404).json({ error: "Workflow definition not found" });
    return;
  }
  const updated = updateWorkflowDefinition(scopedProject.projectDb, {
    id: existing.id,
    name: parsed.data.name ?? existing.name,
    version: parsed.data.version ?? existing.version,
    definitionYaml: parsed.data.definitionYaml ?? existing.definition_yaml
  });
  if (!updated) {
    res.status(404).json({ error: "Workflow definition not found" });
    return;
  }
  res.json({ definition: serializeWorkflowDefinitionRow(updated) });
});

tasksRouter.delete("/projects/:projectId/workflow-definitions/:definitionId", (req, res) => {
  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "write" },
    res
  );
  if (!scopedProject) return;
  const existing = getWorkflowDefinitionById(scopedProject.projectDb, req.params.definitionId);
  if (!existing || existing.project_id !== scopedProject.project.id) {
    res.status(404).json({ error: "Workflow definition not found" });
    return;
  }
  deleteWorkflowDefinition(scopedProject.projectDb, req.params.definitionId);
  res.json({ ok: true });
});

tasksRouter.get("/projects/:projectId/workflow-runs", (req, res) => {
  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "read" },
    res
  );
  if (!scopedProject) return;
  const runs = listWorkflowRunsByProject(scopedProject.projectDb, scopedProject.project.id)
    .map((run) => serializeWorkflowRunState(scopedProject.projectDb, run.id))
    .filter((run): run is NonNullable<typeof run> => Boolean(run));
  res.json({ runs });
});

tasksRouter.post("/projects/:projectId/workflow-runs/start", (req, res) => {
  const parsed = workflowRunStartSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }
  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "write" },
    res
  );
  if (!scopedProject) return;
  const definition = getWorkflowDefinitionById(scopedProject.projectDb, parsed.data.workflowDefinitionId);
  if (!definition || definition.project_id !== scopedProject.project.id) {
    res.status(404).json({ error: "Workflow definition not found" });
    return;
  }
  if (parsed.data.taskId) {
    const task = scopedProject.projectDb
      .prepare("SELECT id FROM tasks WHERE id = ? AND project_id = ? LIMIT 1")
      .get(parsed.data.taskId, scopedProject.project.id) as { id: string } | undefined;
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
  }
  const createdRun = createWorkflowRun(scopedProject.projectDb, {
    workflowDefinitionId: definition.id,
    projectId: scopedProject.project.id,
    taskId: parsed.data.taskId ?? null
  });
  const startedRun = startWorkflowRun({ db: scopedProject.projectDb, workflowRunId: createdRun.id });
  const state = serializeWorkflowRunState(scopedProject.projectDb, startedRun.id);
  if (!state) {
    res.status(500).json({ error: "Failed to load workflow run state" });
    return;
  }
  res.status(201).json({ workflow: state });
});

tasksRouter.get("/projects/:projectId/workflow-runs/:runId", (req, res) => {
  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "read" },
    res
  );
  if (!scopedProject) return;
  const run = getWorkflowRunById(scopedProject.projectDb, req.params.runId);
  if (!run || run.project_id !== scopedProject.project.id) {
    res.status(404).json({ error: "Workflow run not found" });
    return;
  }
  const state = serializeWorkflowRunState(scopedProject.projectDb, run.id);
  if (!state) {
    res.status(404).json({ error: "Workflow run not found" });
    return;
  }
  res.json({ workflow: state });
});

tasksRouter.post("/projects/:projectId/workflow-runs/:runId/tick", (req, res) => {
  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "write" },
    res
  );
  if (!scopedProject) return;
  const run = getWorkflowRunById(scopedProject.projectDb, req.params.runId);
  if (!run || run.project_id !== scopedProject.project.id) {
    res.status(404).json({ error: "Workflow run not found" });
    return;
  }
  const ticked = tickWorkflowRun({ db: scopedProject.projectDb, workflowRunId: run.id });
  const state = serializeWorkflowRunState(scopedProject.projectDb, run.id);
  if (!state) {
    res.status(404).json({ error: "Workflow run not found" });
    return;
  }
  res.json({ workflow: state, progressed: ticked.progressed });
});

tasksRouter.post("/projects/:projectId/workflow-runs/:runId/cancel", (req, res) => {
  const parsed = workflowRunCancelSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }
  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "write" },
    res
  );
  if (!scopedProject) return;
  const run = getWorkflowRunById(scopedProject.projectDb, req.params.runId);
  if (!run || run.project_id !== scopedProject.project.id) {
    res.status(404).json({ error: "Workflow run not found" });
    return;
  }
  if (run.status === "queued" || run.status === "running") {
    for (const stage of listWorkflowStageRunsByRun(scopedProject.projectDb, run.id)) {
      if (stage.status === "pending" || stage.status === "running") {
        transitionWorkflowStageRunStatus(scopedProject.projectDb, {
          stageRunId: stage.id,
          toStatus: "cancelled",
          reason: parsed.data.reason ?? "workflow_run_cancelled"
        });
      }
    }
    transitionWorkflowRunStatus(scopedProject.projectDb, {
      runId: run.id,
      toStatus: "cancelled",
      reason: parsed.data.reason ?? "workflow_run_cancelled"
    });
  }
  const state = serializeWorkflowRunState(scopedProject.projectDb, run.id);
  if (!state) {
    res.status(404).json({ error: "Workflow run not found" });
    return;
  }
  res.json({ workflow: state });
});

tasksRouter.get("/nodes/:nodeId/workflow-status", (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.nodeId, userId: req.user.id, notFoundMessage: "Node not found", intent: "read" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;
  const run = projectDb
    .prepare("SELECT * FROM workflow_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(task.id) as { id: string } | undefined;
  if (!run) {
    res.json({ nodeId: task.id, workflow: null });
    return;
  }
  const state = serializeWorkflowRunState(projectDb, run.id);
  res.json({ nodeId: task.id, workflow: state });
});

tasksRouter.get("/tasks/:taskId", async (req, res) => {
  const includeGitStatus = queryBoolFlag(req.query.includeGitStatus, TASK_DETAIL_INCLUDE_GIT_DEFAULT);
  const includeHeavy = queryBoolFlag(req.query.includeHeavy, TASK_DETAIL_INCLUDE_HEAVY_DEFAULT);
  const startedAt = process.hrtime.bigint();
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "read" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;

  const dbStartedAt = process.hrtime.bigint();
  const transitions = projectDb
    .prepare("SELECT * FROM task_state_transitions WHERE task_id = ? ORDER BY created_at ASC")
    .all(task.id) as TaskTransitionRow[];
  const mergeRecords = projectDb
    .prepare("SELECT * FROM merge_records WHERE task_id = ? ORDER BY created_at DESC")
    .all(task.id) as MergeRecordRow[];
  logRouteStage("/tasks/:taskId", "db-fetch", dbStartedAt, {
    taskId: task.id,
    transitionsCount: transitions.length,
    mergeRecordCount: mergeRecords.length
  });

  let gitStatus: Awaited<ReturnType<typeof getWorkspaceGitStatus>> | null = null;
  if (includeGitStatus) {
    const gitStartedAt = process.hrtime.bigint();
    try {
      gitStatus = await getWorkspaceGitStatusCached(task.workspace_path);
    } catch {
      gitStatus = null;
    }
    logRouteStage("/tasks/:taskId", "git-status", gitStartedAt, {
      taskId: task.id,
      included: true,
      available: Boolean(gitStatus)
    });
  } else {
    logRouteStage("/tasks/:taskId", "git-status", startedAt, {
      taskId: task.id,
      included: false
    });
  }
  const visibilityStartedAt = process.hrtime.bigint();
  const visibility = buildAutomationVisibility(projectDb, task);
  logRouteStage("/tasks/:taskId", "automation-visibility", visibilityStartedAt, { taskId: task.id });
  const serializeStartedAt = process.hrtime.bigint();
  const serializedTask = serializeTask(projectDb, task, { includeCompletion: includeHeavy });
  logRouteStage("/tasks/:taskId", "serialize-task", serializeStartedAt, { taskId: task.id, includeHeavy });

  res.json({
    task: serializedTask,
    transitions: transitions.map(serializeTransition),
    session: serializeSession(latestSession(projectDb, task.id)),
    ide: serializeIde(latestIde(projectDb, task.id)),
    gitStatus,
    mergeRecords: mergeRecords.map(serializeMergeRecord),
    dependencyDiagnostics: visibility.dependencyDiagnostics,
    automation: visibility.automation,
    waiting: visibility.waiting,
    orchestration: visibility.orchestration
  });
  logRouteStage("/tasks/:taskId", "response", startedAt, {
    taskId: task.id,
    includeGitStatus,
    includeHeavy
  });
});

tasksRouter.get("/tasks/:taskId/poll", (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "read" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;

  res.json({
    task: {
      id: task.id,
      projectId: task.project_id,
      status: task.status,
      mode: task.mode,
      isBlocked: task.status === "queued" && taskIsBlocked(projectDb, task.id),
      updatedAt: task.updated_at
    },
    session: serializeSession(latestSession(projectDb, task.id)),
    ide: serializeIde(latestIde(projectDb, task.id))
  });
});

tasksRouter.get("/nodes/:nodeId", async (req, res) => {
  if (!orchestrationHierarchyApiEnabled()) {
    respondFeatureDisabled(res, "orchestration_hierarchy_api");
    return;
  }
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.nodeId, userId: req.user.id, notFoundMessage: "Node not found", intent: "read" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;

  const transitions = projectDb
    .prepare("SELECT * FROM task_state_transitions WHERE task_id = ? ORDER BY created_at ASC")
    .all(task.id) as TaskTransitionRow[];
  const visibility = buildAutomationVisibility(projectDb, task);
  const children = projectDb
    .prepare("SELECT *, rowid AS __rowid FROM tasks WHERE parent_plan_task_id = ?")
    .all(task.id) as ChronoTaskRow[];
  children.sort(compareTaskRowsChronological);

  res.json({
    node: serializeTask(projectDb, task),
    transitions: transitions.map(serializeTransition),
    dependencyDiagnostics: visibility.dependencyDiagnostics,
    waiting: visibility.waiting,
    automation: visibility.automation,
    orchestration: visibility.orchestration,
    parent: (() => {
      if (!task.parent_plan_task_id) return null;
      const parent = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.parent_plan_task_id) as TaskRow | undefined;
      return parent ? serializeTask(projectDb, parent) : null;
    })(),
    children: children.map((child) => serializeTask(projectDb, child))
  });
});

tasksRouter.get("/tasks/:taskId/dependency-diagnostics", (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "read" },
    res
  );
  if (!scopedTask) return;
  const diagnostics = buildDependencyDiagnostics({ projectDb: scopedTask.projectDb, task: scopedTask.task });
  res.json({ diagnostics });
});

tasksRouter.post("/nodes/:nodeId/start", async (req, res) => {
  if (!orchestrationActionsApiEnabled()) {
    respondFeatureDisabled(res, "orchestration_actions_api");
    return;
  }
  const parsed = startNodeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.nodeId, userId: req.user.id, notFoundMessage: "Node not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, project, projectDb } = scopedTask;
  const depState = directDependencies(projectDb, task);
  const diagnostics = buildDependencyDiagnostics({ projectDb, task });
  if (diagnostics.unresolved.length > 0) {
    res.status(409).json({
      error: "Node is blocked by unresolved dependencies",
      blockedBy: diagnostics.unresolved
    });
    return;
  }

  try {
    await startTaskRuntimeWorker(task.id, req.user.id, {
      projectId: project.id,
      basePath: project.base_path,
      projectDb
    });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to start node") });
    return;
  }

  if (depState.nodeTier !== "exec") {
    const requestedAutoMode = typeof parsed.data.autoMode === "boolean" ? parsed.data.autoMode : null;
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      eventType: "orchestration.manual_start",
      database: projectDb,
      payload: {
        requestedAutoMode,
        actorUserId: req.user.id,
        strategy: "runtime_session"
      }
    });
  }

  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  res.json({ node: serializeTask(projectDb, updated), started: true, tier: depState.nodeTier });
});

tasksRouter.post("/nodes/:nodeId/auto-mode", (req, res) => {
  if (!orchestrationActionsApiEnabled()) {
    respondFeatureDisabled(res, "orchestration_actions_api");
    return;
  }
  const parsed = autoModeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.nodeId, userId: req.user.id, notFoundMessage: "Node not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;
  const dependencyTaskIds = projectDb
    .prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
    .all(task.id) as Array<{ dependency_task_id: string }>;
  const { metadata } = readNodeMetadata({
    projectDb,
    task,
    dependencyTaskIds: dependencyTaskIds.map((row) => row.dependency_task_id)
  });
  const nextMetadata = {
    ...metadata,
    orchestration: {
      ...(metadata.orchestration ?? {}),
      auto_start: parsed.data.enabled
    },
    custom: {
      ...(metadata.custom ?? {}),
      auto_mode: parsed.data.enabled
    }
  };
  writeNodeMetadata({
    projectDb,
    taskId: task.id,
    metadata: nextMetadata
  });
  projectDb.prepare("UPDATE tasks SET auto_start = ?, updated_at = ? WHERE id = ?").run(parsed.data.enabled ? 1 : 0, nowIso(), task.id);
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "orchestration.override.auto_mode",
    database: projectDb,
    payload: {
      enabled: parsed.data.enabled,
      actorUserId: req.user.id
    }
  });
  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  res.json({ node: serializeTask(projectDb, updated) });
});

tasksRouter.post("/nodes/:nodeId/auto-merge", (req, res) => {
  if (!orchestrationActionsApiEnabled()) {
    respondFeatureDisabled(res, "orchestration_actions_api");
    return;
  }
  const parsed = autoMergeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.nodeId, userId: req.user.id, notFoundMessage: "Node not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;
  const updateOnComplete = parsed.data.onComplete ?? task.mode === "plan";
  if (updateOnComplete) {
    projectDb.prepare("UPDATE tasks SET auto_merge_on_complete = ?, updated_at = ? WHERE id = ?").run(
      parsed.data.enabled ? 1 : 0,
      nowIso(),
      task.id
    );
  } else {
    projectDb.prepare("UPDATE tasks SET auto_merge = ?, updated_at = ? WHERE id = ?").run(
      parsed.data.enabled ? 1 : 0,
      nowIso(),
      task.id
    );
  }

  const dependencyTaskIds = projectDb
    .prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
    .all(task.id) as Array<{ dependency_task_id: string }>;
  const { metadata } = readNodeMetadata({
    projectDb,
    task,
    dependencyTaskIds: dependencyTaskIds.map((row) => row.dependency_task_id)
  });
  const nextMetadata = {
    ...metadata,
    orchestration: {
      ...(metadata.orchestration ?? {}),
      auto_merge: updateOnComplete ? metadata.orchestration?.auto_merge : parsed.data.enabled,
      auto_merge_on_complete: updateOnComplete ? parsed.data.enabled : metadata.orchestration?.auto_merge_on_complete
    }
  };
  writeNodeMetadata({ projectDb, taskId: task.id, metadata: nextMetadata });
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "orchestration.override.auto_merge",
    database: projectDb,
    payload: {
      enabled: parsed.data.enabled,
      onComplete: updateOnComplete,
      actorUserId: req.user.id
    }
  });
  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  res.json({ node: serializeTask(projectDb, updated) });
});

tasksRouter.post("/nodes/:nodeId/force-re-review", (req, res) => {
  if (!orchestrationActionsApiEnabled()) {
    respondFeatureDisabled(res, "orchestration_actions_api");
    return;
  }
  const parsed = forceReReviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.nodeId, userId: req.user.id, notFoundMessage: "Node not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
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
      source: "api.manual_re_review",
      reason: parsed.data.reason ?? null,
      actorUserId: req.user.id
    }
  });
  kickOrchestrationJobQueueProcessing();
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "orchestration.override.force_re_review",
    database: projectDb,
    payload: {
      reason: parsed.data.reason ?? null,
      pendingEventId,
      actorUserId: req.user.id
    }
  });
  res.status(202).json({ ok: true, pendingEventId });
});

tasksRouter.post("/nodes/:nodeId/approve-budget-override", (req, res) => {
  if (!orchestrationActionsApiEnabled()) {
    respondFeatureDisabled(res, "orchestration_actions_api");
    return;
  }
  const parsed = approveBudgetOverrideSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.nodeId, userId: req.user.id, notFoundMessage: "Node not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;
  const enabled = parsed.data.enabled ?? true;
  const dependencyTaskIds = projectDb
    .prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
    .all(task.id) as Array<{ dependency_task_id: string }>;
  const { metadata } = readNodeMetadata({
    projectDb,
    task,
    dependencyTaskIds: dependencyTaskIds.map((row) => row.dependency_task_id)
  });
  const nextMetadata = {
    ...metadata,
    custom: {
      ...(metadata.custom ?? {}),
      replan_budget_override: enabled
    }
  };
  writeNodeMetadata({ projectDb, taskId: task.id, metadata: nextMetadata });
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "orchestration.override.replan_budget",
    database: projectDb,
    payload: {
      enabled,
      reason: parsed.data.reason ?? null,
      actorUserId: req.user.id
    }
  });
  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  res.json({ node: serializeTask(projectDb, updated) });
});

tasksRouter.patch("/tasks/:taskId", (req, res) => {
  const parsed = patchTaskSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;

  if (task.status !== "queued") {
    res.status(409).json({ error: "Task configuration can only be edited while queued" });
    return;
  }

  const input = parsed.data;
  const nextAiCommand = input.aiCommand ?? task.ai_command;
  projectDb.prepare("UPDATE tasks SET ai_command = ?, updated_at = ? WHERE id = ?").run(
    nextAiCommand,
    nowIso(),
    task.id
  );

  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "task.updated",
    database: projectDb,
    payload: {
      aiCommand: nextAiCommand
    }
  });

  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  res.json({ task: serializeTask(projectDb, updated) });
});

tasksRouter.post("/tasks/:taskId/start", async (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, project, projectDb } = scopedTask;
  if (taskIsBlocked(projectDb, task.id)) {
    res.status(409).json({ error: "Task is blocked by unmerged dependencies" });
    return;
  }

  try {
    await startTaskRuntimeWorker(task.id, req.user.id, {
      projectId: project.id,
      basePath: project.base_path,
      projectDb
    });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to start task runtime") });
    return;
  }

  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  res.json({ task: serializeTask(projectDb, updated), session: serializeSession(latestSession(projectDb, task.id)) });
});

tasksRouter.post("/tasks/:taskId/input", async (req, res) => {
  const parsed = inputSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, project, projectDb } = scopedTask;

  try {
    await sendTaskRuntimeInputWorker(task.id, req.user.id, parsed.data.text, {
      projectId: project.id,
      basePath: project.base_path,
      projectDb
    });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to send input") });
    return;
  }

  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  res.json({ task: serializeTask(projectDb, updated), session: serializeSession(latestSession(projectDb, task.id)) });
});

tasksRouter.post("/tasks/:taskId/stop", async (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task } = scopedTask;

  void task;
  void req;
  res.status(409).json({ error: "Stopping runtime sessions is disabled" });
});

tasksRouter.post("/tasks/:taskId/pull-main", async (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, project, projectDb } = scopedTask;

  if (taskIsBlocked(projectDb, task.id)) {
    res.status(409).json({ error: "Task is blocked by unmerged dependencies" });
    return;
  }

  const parentPlanTask = parentPlanTaskForUser(projectDb, task);
  let topology: TaskGitTopology;
  try {
    topology = resolveTaskGitTopology({ task, project, parentPlanTask });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to resolve task repository topology") });
    return;
  }

  if (!task.parent_plan_task_id) {
    try {
      await refreshBaseFromOrigin({
        basePath: project.base_path,
        defaultBranch: project.default_branch
      });
    } catch (error: any) {
      res.status(409).json({ error: String(error?.message ?? "Failed to refresh base repository") });
      return;
    }
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
  projectDb.prepare("UPDATE tasks SET head_commit_sha = ?, updated_at = ? WHERE id = ?").run(pullResult.headCommitSha, now, task.id);

  let latestTask = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  if (pullResult.conflicted && latestTask.status !== "merge_conflict") {
    latestTask = setTaskStatus(projectDb, latestTask, "merge_conflict", "pull_main_conflict", req.user.id);
  }
  if (!pullResult.conflicted && latestTask.status === "merge_conflict") {
    latestTask = setTaskStatus(projectDb, latestTask, "in_progress", "pull_main_resolved", req.user.id);
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

  res.json({
    task: serializeTask(projectDb, latestTask),
    sync: {
      targetRef: topology.pullRemoteRef,
      conflicted: pullResult.conflicted,
      conflictFiles: pullResult.conflictFiles,
      headCommitSha: pullResult.headCommitSha
    }
  });
});

tasksRouter.post("/tasks/:taskId/mark-merge-ready", async (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;
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

  const updated = setTaskStatus(projectDb, task, "merge_ready", "user_marked_merge_ready", req.user.id);
  recordEvent({
    projectId: updated.project_id,
    taskId: updated.id,
    eventType: "task.mark_merge_ready",
    payload: {},
    database: projectDb
  });
  res.json({ task: serializeTask(projectDb, updated) });
});

tasksRouter.post("/tasks/:taskId/in-progress", (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;
  if (task.status === "waiting_input") {
    res.json({ task: serializeTask(projectDb, task) });
    return;
  }

  const updated = setTaskStatus(projectDb, task, "waiting_input", "user_marked_in_progress", req.user.id);
  recordEvent({
    projectId: updated.project_id,
    taskId: updated.id,
    eventType: "task.mark_in_progress",
    database: projectDb,
    payload: {
      fromStatus: task.status,
      toStatus: "waiting_input"
    }
  });
  res.json({ task: serializeTask(projectDb, updated) });
});

tasksRouter.post("/tasks/:taskId/cancel", (req, res) => {
  const parsed = cancelTaskSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;

  const now = nowIso();
  projectDb.transaction(() => {
    projectDb.prepare("UPDATE tasks SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?").run(parsed.data.reason, now, task.id);
    recordTaskTransition({
      projectDb,
      taskId: task.id,
      fromStatus: task.status,
      toStatus: "cancelled",
      reason: "task_cancelled",
      actorUserId: req.user.id
    });
  })();
  const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "task.cancelled",
    database: projectDb,
    payload: {
      reason: parsed.data.reason
    }
  });
  res.json({ task: serializeTask(projectDb, updated) });
});

tasksRouter.post("/tasks/:taskId/rerun", async (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, project, projectDb } = scopedTask;

  const now = nowIso();
  try {
    const ide = latestIde(projectDb, task.id);
    if (ide && ["starting", "running"].includes(ide.status) && ideSessionRunning(task.id)) {
      stopIdeSession(task.id);
    }
    if (ide && ["starting", "running"].includes(ide.status)) {
      projectDb.prepare("UPDATE ide_instances SET status = 'stopped', ended_at = ?, last_heartbeat_at = ? WHERE id = ?").run(now, now, ide.id);
    }

    const sessions = projectDb
      .prepare("SELECT * FROM task_sessions WHERE task_id = ? ORDER BY started_at DESC")
      .all(task.id) as TaskSessionRow[];
    projectDb
      .prepare(
        `UPDATE task_sessions
         SET status = 'stopped',
             ended_at = COALESCE(ended_at, ?),
             last_heartbeat_at = ?
         WHERE task_id = ?
           AND status IN ('starting','running','waiting_input')`
      )
      .run(now, now, task.id);
    for (const session of sessions) {
      const alive = await hasSession(session.tmux_socket_path, session.tmux_session_name);
      if (alive) {
        await killSession(session.tmux_socket_path, session.tmux_session_name);
      }
    }
    projectDb.prepare("DELETE FROM task_sessions WHERE task_id = ?").run(task.id);

    if (!isSafeTaskWorkspacePath(task.workspace_path, project.base_path)) {
      throw new Error("Unsafe task workspace path; refusing to reset outside task workspace directory");
    }

    let sourcePath = project.base_path;
    if (task.parent_plan_task_id) {
      const parentPlanTask = parentPlanTaskForUser(projectDb, task);
      if (!parentPlanTask) {
        throw new Error("Parent plan task not found");
      }
      sourcePath = parentPlanTask.workspace_path;
    }
    const baseCommitSha = await getHeadCommitSha(sourcePath);

    await fs.promises.rm(task.workspace_path, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 150
    });
    await fs.promises.mkdir(task.workspace_path, { recursive: true });

    const latestTask = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
    const updatedAt = nowIso();
    projectDb.transaction(() => {
      projectDb.prepare(
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
        projectDb,
        taskId: task.id,
        fromStatus: latestTask.status,
        toStatus: "queued",
        reason: "task_rerun_reset",
        actorUserId: req.user.id
      });
    })();

    const updated = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      eventType: "task.rerun",
      database: projectDb,
      payload: {
        previousStatus: latestTask.status
      }
    });
    kickTaskQueueProcessing();
    const refreshedTask = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
    res.json({ task: serializeTask(projectDb, refreshedTask), session: serializeSession(latestSession(projectDb, task.id)) });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to re-run task") });
  }
});

tasksRouter.post("/tasks/:taskId/merge", async (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "read" },
    res
  );
  if (!scopedTask) return;
  const { task, project, projectDb } = scopedTask;
  if (task.status !== "merge_ready") {
    res.status(409).json({ error: "Task must be merge_ready before merge" });
    return;
  }

  const parentPlanTask = parentPlanTaskForUser(projectDb, task);
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
    projectDb.prepare(
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
        projectDb.transaction(() => {
          projectDb.prepare(
            "UPDATE merge_records SET status = 'conflict', conflict_summary = ?, completed_at = ? WHERE id = ?"
          ).run(conflictSummary || "conflicts detected", completedAt, mergeRecordId);
          projectDb.prepare("UPDATE tasks SET status = 'merge_conflict', updated_at = ? WHERE id = ?").run(completedAt, task.id);
          recordTaskTransition({
            projectDb,
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
          database: projectDb,
          payload: {
            conflictFiles: mergeResult.conflictFiles
          }
        });
      } else {
        projectDb.transaction(() => {
          projectDb.prepare(
            "UPDATE merge_records SET status = 'merged', merge_commit_sha = ?, completed_at = ? WHERE id = ?"
          ).run(mergeResult.mergeCommitSha, completedAt, mergeRecordId);
          projectDb.prepare(
            "UPDATE tasks SET status = 'merged', merged_at = ?, merged_by_user_id = ?, head_commit_sha = ?, updated_at = ? WHERE id = ?"
          ).run(completedAt, req.user.id, mergeResult.mergeCommitSha, completedAt, task.id);
          recordTaskTransition({
            projectDb,
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
      projectDb.prepare("UPDATE merge_records SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?").run(
        String(error?.message ?? "merge failed"),
        completedAt,
        mergeRecordId
      );
      throw error;
    }

    const updatedTask = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow;
    const mergeRecords = projectDb
      .prepare("SELECT * FROM merge_records WHERE task_id = ? ORDER BY created_at DESC")
      .all(task.id) as MergeRecordRow[];
    res.json({ task: serializeTask(projectDb, updatedTask), mergeRecords: mergeRecords.map(serializeMergeRecord) });
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
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "read" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;
  const mergeRecords = projectDb
    .prepare("SELECT * FROM merge_records WHERE task_id = ? ORDER BY created_at DESC")
    .all(task.id) as MergeRecordRow[];
  res.json({ mergeRecords: mergeRecords.map(serializeMergeRecord) });
});

tasksRouter.get("/tasks/:taskId/ide", async (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;

  let gitStatus: Awaited<ReturnType<typeof getWorkspaceGitStatus>> | null = null;
  try {
    gitStatus = await getWorkspaceGitStatusCached(task.workspace_path);
  } catch {
    gitStatus = null;
  }

  res.json({
    ide: serializeIde(latestIde(projectDb, task.id)),
    gitStatus
  });
});

tasksRouter.post("/tasks/:taskId/ide/start", async (req, res) => {
  const routeStartedAt = process.hrtime.bigint();
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;

  if (!fs.existsSync(task.workspace_path)) {
    res.status(409).json({ error: "Task workspace folder is missing" });
    return;
  }

  const current = latestIde(projectDb, task.id);
  if (current && current.status === "running" && ideSessionRunning(task.id)) {
    const launchUrlStartedAt = process.hrtime.bigint();
    const launchUrl = await buildIdeLaunchUrl(projectDb, task, current.id);
    logRouteStage("/tasks/:taskId/ide/start", "reuse-running", launchUrlStartedAt, { taskId: task.id });
    res.json({ ide: serializeIde(current), launchUrl });
    return;
  }

  let launched: Awaited<ReturnType<typeof startIdeSession>>;
  const startIdeSessionStartedAt = process.hrtime.bigint();
  try {
    launched = await startIdeSession({
      taskId: task.id,
      workspacePath: task.workspace_path
    });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to start IDE session") });
    return;
  }
  logRouteStage("/tasks/:taskId/ide/start", "start-ide-session", startIdeSessionStartedAt, {
    taskId: task.id,
    provider: launched.provider
  });

  const now = nowIso();
  const ideId = makeId();
  projectDb.transaction(() => {
    if (current && current.status !== "stopped" && current.status !== "failed") {
      projectDb.prepare("UPDATE ide_instances SET status = 'stopped', ended_at = ?, last_heartbeat_at = ? WHERE id = ?").run(
        now,
        now,
        current.id
      );
    }
    projectDb.prepare(
      `INSERT INTO ide_instances (
        id, task_id, provider, url, access_token_hash, status, started_at, ended_at, last_heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, ?)`
    ).run(ideId, task.id, launched.provider, launched.url, hashToken("pending"), now, now);
  })();

  const launchUrlStartedAt = process.hrtime.bigint();
  const launchUrl = await buildIdeLaunchUrl(projectDb, task, ideId);
  logRouteStage("/tasks/:taskId/ide/start", "build-launch-url", launchUrlStartedAt, { taskId: task.id });
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "ide.started",
    database: projectDb,
    payload: {
      ideId,
      provider: launched.provider,
      url: launched.url
    }
  });

  const ide = projectDb.prepare("SELECT * FROM ide_instances WHERE id = ?").get(ideId) as IdeInstanceRow | undefined;
  res.json({ ide: serializeIde(ide), launchUrl });
  logRouteStage("/tasks/:taskId/ide/start", "response", routeStartedAt, { taskId: task.id });
});

tasksRouter.post("/tasks/:taskId/ide/token", async (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "write" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;

  const ide = latestIde(projectDb, task.id);
  if (!ide || !["starting", "running"].includes(ide.status)) {
    res.status(409).json({ error: "No active IDE instance for task" });
    return;
  }
  if (!ideSessionRunning(task.id)) {
    projectDb.prepare("UPDATE ide_instances SET status = 'failed', ended_at = ?, last_heartbeat_at = ? WHERE id = ?").run(nowIso(), nowIso(), ide.id);
    res.status(409).json({ error: "IDE runtime is not available" });
    return;
  }

  const launchUrl = await buildIdeLaunchUrl(projectDb, task, ide.id);
  res.json({ ide: serializeIde(ide), launchUrl });
});

tasksRouter.post("/tasks/:taskId/ide/stop", (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "read" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;

  const ide = latestIde(projectDb, task.id);
  if (!ide || !["starting", "running"].includes(ide.status)) {
    stopIdeSession(task.id);
    res.json({ ide: null, stopped: false });
    return;
  }

  stopIdeSession(task.id);
  const now = nowIso();
  projectDb.prepare("UPDATE ide_instances SET status = 'stopped', ended_at = ?, last_heartbeat_at = ? WHERE id = ?").run(now, now, ide.id);
  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "ide.stopped",
    database: projectDb,
    payload: {
      ideId: ide.id
    }
  });

  const updated = projectDb.prepare("SELECT * FROM ide_instances WHERE id = ?").get(ide.id) as IdeInstanceRow | undefined;
  res.json({ ide: serializeIde(updated) });
});

tasksRouter.get("/tasks/:taskId/ide/view", async (req, res) => {
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "read" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;

  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token) {
    res.status(401).send("Missing IDE token");
    return;
  }

  const ide = latestIde(projectDb, task.id);
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
  const scopedTask = getTaskAccessOrRespond(
    { taskId: req.params.taskId, userId: req.user.id, notFoundMessage: "Task not found", intent: "read" },
    res
  );
  if (!scopedTask) return;
  const { task, projectDb } = scopedTask;

  const ide = latestIde(projectDb, task.id);
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
