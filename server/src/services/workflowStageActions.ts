import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { parsePlanYaml } from "./planParser.js";
import { buildInitialNodeMetadata, serializeNodeMetadata } from "./orchestration/metadata.js";
import { validateProposedNodeGraph } from "./orchestration/dependencyGraph.js";
import {
  createWorkflowEvent,
  getWorkflowRunById,
  getWorkflowStageRunById,
  listWorkflowEventsByStageRun,
  transitionWorkflowStageRunStatus
} from "./workflowRepository.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";
import type { NodeDependencyRef, NodeTier, TaskMode, TaskRow } from "../types.js";

export type WorkflowStageActionType =
  | "run_command"
  | "task_runtime_prompt"
  | "create_child_nodes_from_plan_yaml"
  | "review_child_nodes"
  | "no_op";

export type StructuredActionFailureReason = {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
};

type StageActionContext = {
  db: Database.Database;
  workflowRunId: string;
  stageRunId: string;
  idempotencyKey: string;
};

export type WorkflowStageActionHandlers = {
  runCommand?: (input: Record<string, unknown>, context: StageActionContext) => unknown | Promise<unknown>;
  taskRuntimePrompt?: (input: Record<string, unknown>, context: StageActionContext) => unknown | Promise<unknown>;
  createChildNodesFromPlanYaml?: (input: Record<string, unknown>, context: StageActionContext) => unknown | Promise<unknown>;
  reviewChildNodes?: (input: Record<string, unknown>, context: StageActionContext) => unknown | Promise<unknown>;
  noOp?: (input: Record<string, unknown>, context: StageActionContext) => unknown | Promise<unknown>;
};

export type ExecuteWorkflowStageActionInput = {
  db: Database.Database;
  workflowRunId: string;
  stageRunId: string;
  actionType: WorkflowStageActionType;
  actionInput?: Record<string, unknown>;
  idempotencyKey?: string;
  handlers?: WorkflowStageActionHandlers;
};

export type ExecuteWorkflowStageActionResult = {
  status: "succeeded" | "failed";
  idempotent: boolean;
  workflowRunId: string;
  stageRunId: string;
  actionType: WorkflowStageActionType;
  idempotencyKey: string;
  result?: unknown;
  reason?: StructuredActionFailureReason;
};

class StageActionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(message: string, options: { code: string; retryable?: boolean; details?: unknown }) {
    super(message);
    this.name = "StageActionError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

function normalizeInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  return input ?? {};
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function defaultIdempotencyKey(actionType: WorkflowStageActionType, stageRunId: string, actionInput: Record<string, unknown>): string {
  const digest = createHash("sha256").update(stableStringify({ actionType, stageRunId, actionInput })).digest("hex");
  return `workflow_stage_action:${stageRunId}:${digest}`;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function reasonFromUnknown(error: unknown): StructuredActionFailureReason {
  if (error instanceof StageActionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details
    };
  }
  if (error instanceof Error) {
    return {
      code: "unexpected_error",
      message: error.message,
      retryable: false
    };
  }
  return {
    code: "unexpected_error",
    message: "Unexpected non-error failure",
    retryable: false,
    details: { value: error }
  };
}

function parseStringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new StageActionError(`Missing required string field: ${key}`, { code: "invalid_input", retryable: false });
  }
  return value;
}

function runCommandDefault(input: Record<string, unknown>): Record<string, unknown> {
  const command = parseStringField(input, "command");
  const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : undefined;
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
    ? input.timeoutMs
    : 60_000;
  const envInput = input.env;
  const env = typeof envInput === "object" && envInput !== null && !Array.isArray(envInput)
    ? Object.entries(envInput).reduce<Record<string, string>>((acc, [k, v]) => {
      if (typeof v === "string") acc[k] = v;
      return acc;
    }, {})
    : {};

  const result = spawnSync("bash", ["-lc", command], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  });

  if (result.error) {
    throw new StageActionError(result.error.message, {
      code: result.error.name === "ETIMEDOUT" ? "command_timeout" : "command_spawn_error",
      retryable: result.error.name === "ETIMEDOUT",
      details: { command, cwd }
    });
  }

  const output = {
    command,
    cwd: cwd ?? null,
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
  if ((result.status ?? 1) !== 0) {
    throw new StageActionError(`Command exited with status ${String(result.status ?? "unknown")}`, {
      code: "command_failed",
      retryable: false,
      details: output
    });
  }
  return output;
}

function taskRuntimePromptDefault(input: Record<string, unknown>): Record<string, unknown> {
  const taskId = parseStringField(input, "taskId");
  const prompt = parseStringField(input, "prompt");
  return {
    taskId,
    accepted: true,
    promptLength: prompt.length
  };
}

function projectTaskById(db: Database.Database, taskId: string): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ? LIMIT 1").get(taskId) as TaskRow | undefined;
}

function createChildNodesFromPlanYamlDefault(input: Record<string, unknown>, context: StageActionContext): Record<string, unknown> {
  const workflowRun = getWorkflowRunById(context.db, context.workflowRunId);
  if (!workflowRun) {
    throw new StageActionError(`Workflow run not found: ${context.workflowRunId}`, {
      code: "workflow_run_not_found",
      retryable: false
    });
  }

  const parentTaskIdInput = typeof input.parentTaskId === "string" && input.parentTaskId.trim()
    ? input.parentTaskId.trim()
    : workflowRun.task_id;
  if (!parentTaskIdInput) {
    throw new StageActionError("Workflow run does not have parent task context", {
      code: "missing_parent_task_context",
      retryable: false
    });
  }
  const parentTask = projectTaskById(context.db, parentTaskIdInput);
  if (!parentTask) {
    throw new StageActionError(`Parent task not found: ${parentTaskIdInput}`, {
      code: "parent_task_not_found",
      retryable: false
    });
  }

  const planPath = typeof input.planPath === "string" && input.planPath.trim() ? input.planPath.trim() : ".ai-plan/latest-plan.yaml";
  const absolutePlanPath = path.isAbsolute(planPath) ? planPath : path.join(parentTask.workspace_path, planPath);

  let yamlText = "";
  try {
    yamlText = fs.readFileSync(absolutePlanPath, "utf8");
  } catch (error: any) {
    throw new StageActionError(`Unable to read plan YAML: ${absolutePlanPath}`, {
      code: "plan_yaml_read_error",
      retryable: true,
      details: { planPath: absolutePlanPath, error: String(error?.message ?? "read_failed") }
    });
  }

  let parsed;
  try {
    parsed = parsePlanYaml(yamlText);
  } catch (error: any) {
    throw new StageActionError(String(error?.message ?? "Unable to parse plan YAML"), {
      code: "parse_error",
      retryable: true
    });
  }

  const nodesByItemKey = new Map(parsed.tasks.map((task) => [task.itemKey.toLowerCase(), { id: makeId(), task }]));
  const missingDeps = new Set<string>();
  const proposedNodes = parsed.tasks.map((task) => {
    const mapped = nodesByItemKey.get(task.itemKey.toLowerCase())!;
    const dependencies: NodeDependencyRef[] = task.dependsOnItemKeys.flatMap((itemKey) => {
      const dep = nodesByItemKey.get(itemKey.toLowerCase());
      if (!dep) {
        missingDeps.add(itemKey);
        return [];
      }
      return [{
        id: dep.id,
        tier: dep.task.itemType === "sub_plan" ? "plan" : "exec",
        reason: `plan_item:${itemKey}`
      }];
    });
    const tier: NodeTier = task.itemType === "sub_plan" ? "plan" : "exec";
    return {
      id: mapped.id,
      tier,
      dependencies
    };
  });
  if (missingDeps.size > 0) {
    throw new StageActionError(`Plan contains unknown dependency item key(s): ${[...missingDeps].join(", ")}`, {
      code: "validation_error",
      retryable: false,
      details: { missingDependencies: [...missingDeps] }
    });
  }
  try {
    validateProposedNodeGraph({
      projectDb: context.db,
      projectId: workflowRun.project_id,
      proposedNodes
    });
  } catch (error: any) {
    throw new StageActionError(String(error?.message ?? "Invalid dependency graph"), {
      code: "validation_error",
      retryable: false
    });
  }

  const createdAt = nowIso();
  const children = parsed.tasks.map((task) => {
    const mapped = nodesByItemKey.get(task.itemKey.toLowerCase())!;
    const mode: TaskMode = task.itemType === "sub_plan" ? "plan" : "execution";
    const tier: NodeTier = mode === "plan" ? "plan" : "exec";
    const dependencyTaskIds = task.dependsOnItemKeys
      .map((itemKey) => nodesByItemKey.get(itemKey.toLowerCase())?.id)
      .filter((value): value is string => typeof value === "string");
    return {
      id: mapped.id,
      itemKey: task.itemKey,
      title: task.title,
      prompt: task.prompt,
      mode,
      tier,
      dependencyTaskIds
    };
  });

  context.db.transaction(() => {
    for (const child of children) {
      const metadataJson = serializeNodeMetadata(
        buildInitialNodeMetadata({
          task: {
            id: child.id,
            project_id: parentTask.project_id,
            mode: child.mode,
            metadata_json: null,
            auto_merge: 0,
            auto_start: 0,
            auto_merge_on_complete: 0,
            parent_plan_task_id: parentTask.id,
            source_plan_revision_id: null,
            source_plan_item_key: child.itemKey
          },
          dependencyTaskIds: child.dependencyTaskIds,
          tier: child.tier
        })
      );
      context.db.prepare(
        `INSERT INTO tasks (
          id, project_id, title, task_prompt, result, effective_prompt, ai_command,
          auto_merge, auto_start, auto_merge_on_complete, metadata_json,
          mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
          status, workspace_path, base_commit_sha_at_create, head_commit_sha,
          cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', ?, ?, 0, 0, 0, ?, ?, ?, NULL, ?, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
      ).run(
        child.id,
        parentTask.project_id,
        child.title,
        child.prompt,
        child.prompt,
        parentTask.ai_command,
        metadataJson,
        child.mode,
        parentTask.id,
        child.itemKey,
        path.join(path.dirname(parentTask.workspace_path), "tasks", child.id),
        parentTask.head_commit_sha ?? parentTask.base_commit_sha_at_create,
        parentTask.created_by_user_id,
        createdAt,
        createdAt
      );
      context.db.prepare(
        `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
         VALUES (?, ?, 'null', 'queued', 'task_created_from_workflow_plan_ingest', ?, ?)`
      ).run(makeId(), child.id, parentTask.created_by_user_id, createdAt);
      for (const dependencyTaskId of child.dependencyTaskIds) {
        context.db.prepare("INSERT INTO task_dependencies (task_id, dependency_task_id, created_at) VALUES (?, ?, ?)").run(
          child.id,
          dependencyTaskId,
          createdAt
        );
      }
    }
  })();

  const artifact = {
    parentTaskId: parentTask.id,
    planPath,
    createdChildCount: children.length,
    children: children.map((child) => ({
      taskId: child.id,
      itemKey: child.itemKey,
      mode: child.mode,
      dependsOnTaskIds: child.dependencyTaskIds
    }))
  };
  createWorkflowEvent(context.db, {
    workflowRunId: context.workflowRunId,
    workflowStageRunId: context.stageRunId,
    eventType: "workflow.stage.action.child_nodes_created",
    payload: artifact
  });

  return artifact;
}

function reviewChildNodesDefault(input: Record<string, unknown>, context: StageActionContext): Record<string, unknown> {
  const childNodesInput = input.childNodes;
  let childNodes = Array.isArray(childNodesInput) ? childNodesInput : null;
  if (!childNodes) {
    const workflowRun = getWorkflowRunById(context.db, context.workflowRunId);
    if (!workflowRun?.task_id) {
      throw new StageActionError("Workflow run does not have parent task context", {
        code: "missing_parent_task_context",
        retryable: false
      });
    }
    childNodes = context.db
      .prepare("SELECT id, status FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
      .all(workflowRun.task_id) as Array<{ id: string; status: string }>;
  }
  const statuses = childNodes
    .map((row) => (typeof row === "object" && row !== null ? (row as { status?: unknown }).status : null))
    .filter((status): status is string => typeof status === "string");
  const failingCount = statuses.filter((status) => status === "failed" || status === "merge_conflict" || status === "cancelled").length;
  const incompleteCount = statuses.filter((status) => status !== "merged").length;
  return {
    reviewedCount: childNodes.length,
    failingCount,
    incompleteCount,
    approved: failingCount === 0 && incompleteCount === 0
  };
}

function noOpDefault(input: Record<string, unknown>): Record<string, unknown> {
  const message = typeof input.message === "string" ? input.message : "no-op";
  return { ok: true, message };
}

function resolveExistingOutcome(params: {
  db: Database.Database;
  stageRunId: string;
  actionType: WorkflowStageActionType;
  idempotencyKey: string;
}): ExecuteWorkflowStageActionResult | null {
  const events = listWorkflowEventsByStageRun(params.db, params.stageRunId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.event_type !== "workflow.stage.action.completed" && event.event_type !== "workflow.stage.action.failed") {
      continue;
    }
    const payload = safeParseJson(event.payload) as {
      actionType?: unknown;
      idempotencyKey?: unknown;
      result?: unknown;
      reason?: unknown;
    } | null;
    if (!payload) continue;
    if (payload.actionType !== params.actionType || payload.idempotencyKey !== params.idempotencyKey) continue;
    if (event.event_type === "workflow.stage.action.completed") {
      return {
        status: "succeeded",
        idempotent: true,
        workflowRunId: event.workflow_run_id ?? "",
        stageRunId: params.stageRunId,
        actionType: params.actionType,
        idempotencyKey: params.idempotencyKey,
        result: payload.result
      };
    }
    return {
      status: "failed",
      idempotent: true,
      workflowRunId: event.workflow_run_id ?? "",
      stageRunId: params.stageRunId,
      actionType: params.actionType,
      idempotencyKey: params.idempotencyKey,
      reason: (payload.reason ?? {
        code: "unknown_failure",
        message: "Previous failed action had no structured reason",
        retryable: false
      }) as StructuredActionFailureReason
    };
  }
  return null;
}

async function executeByType(
  actionType: WorkflowStageActionType,
  actionInput: Record<string, unknown>,
  handlers: WorkflowStageActionHandlers,
  context: StageActionContext
): Promise<unknown> {
  if (actionType === "run_command") {
    return handlers.runCommand ? await handlers.runCommand(actionInput, context) : runCommandDefault(actionInput);
  }
  if (actionType === "task_runtime_prompt") {
    return handlers.taskRuntimePrompt ? await handlers.taskRuntimePrompt(actionInput, context) : taskRuntimePromptDefault(actionInput);
  }
  if (actionType === "create_child_nodes_from_plan_yaml") {
    return handlers.createChildNodesFromPlanYaml
      ? await handlers.createChildNodesFromPlanYaml(actionInput, context)
      : createChildNodesFromPlanYamlDefault(actionInput, context);
  }
  if (actionType === "review_child_nodes") {
    return handlers.reviewChildNodes ? await handlers.reviewChildNodes(actionInput, context) : reviewChildNodesDefault(actionInput, context);
  }
  return handlers.noOp ? await handlers.noOp(actionInput, context) : noOpDefault(actionInput);
}

export async function executeWorkflowStageAction(input: ExecuteWorkflowStageActionInput): Promise<ExecuteWorkflowStageActionResult> {
  const stageRun = getWorkflowStageRunById(input.db, input.stageRunId);
  if (!stageRun) {
    const reason: StructuredActionFailureReason = {
      code: "stage_run_not_found",
      message: `Workflow stage run not found: ${input.stageRunId}`,
      retryable: false
    };
    return {
      status: "failed",
      idempotent: false,
      workflowRunId: input.workflowRunId,
      stageRunId: input.stageRunId,
      actionType: input.actionType,
      idempotencyKey: input.idempotencyKey ?? "",
      reason
    };
  }
  if (stageRun.workflow_run_id !== input.workflowRunId) {
    const reason: StructuredActionFailureReason = {
      code: "workflow_run_mismatch",
      message: `Stage run ${input.stageRunId} does not belong to workflow run ${input.workflowRunId}`,
      retryable: false
    };
    return {
      status: "failed",
      idempotent: false,
      workflowRunId: input.workflowRunId,
      stageRunId: input.stageRunId,
      actionType: input.actionType,
      idempotencyKey: input.idempotencyKey ?? "",
      reason
    };
  }

  const actionInput = normalizeInput(input.actionInput);
  const idempotencyKey = input.idempotencyKey ?? defaultIdempotencyKey(input.actionType, input.stageRunId, actionInput);
  const existing = resolveExistingOutcome({
    db: input.db,
    stageRunId: input.stageRunId,
    actionType: input.actionType,
    idempotencyKey
  });
  if (existing) {
    return {
      ...existing,
      workflowRunId: input.workflowRunId,
      stageRunId: input.stageRunId
    };
  }

  if (stageRun.status === "pending") {
    transitionWorkflowStageRunStatus(input.db, {
      stageRunId: input.stageRunId,
      toStatus: "running",
      reason: "stage_action_execution_started",
      payload: { actionType: input.actionType, idempotencyKey }
    });
  } else if (stageRun.status !== "running") {
    const reason: StructuredActionFailureReason = {
      code: "stage_not_runnable",
      message: `Stage run ${input.stageRunId} has terminal status ${stageRun.status}`,
      retryable: false,
      details: { status: stageRun.status }
    };
    createWorkflowEvent(input.db, {
      workflowRunId: input.workflowRunId,
      workflowStageRunId: input.stageRunId,
      eventType: "workflow.stage.action.failed",
      payload: {
        actionType: input.actionType,
        idempotencyKey,
        reason
      }
    });
    return {
      status: "failed",
      idempotent: false,
      workflowRunId: input.workflowRunId,
      stageRunId: input.stageRunId,
      actionType: input.actionType,
      idempotencyKey,
      reason
    };
  }

  createWorkflowEvent(input.db, {
    workflowRunId: input.workflowRunId,
    workflowStageRunId: input.stageRunId,
    eventType: "workflow.stage.action.started",
    payload: {
      actionType: input.actionType,
      idempotencyKey,
      input: actionInput
    }
  });

  const handlers = input.handlers ?? {};
  const context: StageActionContext = {
    db: input.db,
    workflowRunId: input.workflowRunId,
    stageRunId: input.stageRunId,
    idempotencyKey
  };

  try {
    const result = await executeByType(input.actionType, actionInput, handlers, context);
    transitionWorkflowStageRunStatus(input.db, {
      stageRunId: input.stageRunId,
      toStatus: "succeeded",
      reason: "stage_action_execution_succeeded",
      payload: { actionType: input.actionType, idempotencyKey }
    });
    createWorkflowEvent(input.db, {
      workflowRunId: input.workflowRunId,
      workflowStageRunId: input.stageRunId,
      eventType: "workflow.stage.action.completed",
      payload: {
        actionType: input.actionType,
        idempotencyKey,
        result
      }
    });
    return {
      status: "succeeded",
      idempotent: false,
      workflowRunId: input.workflowRunId,
      stageRunId: input.stageRunId,
      actionType: input.actionType,
      idempotencyKey,
      result
    };
  } catch (error) {
    const reason = reasonFromUnknown(error);
    transitionWorkflowStageRunStatus(input.db, {
      stageRunId: input.stageRunId,
      toStatus: "failed",
      reason: "stage_action_execution_failed",
      payload: { actionType: input.actionType, idempotencyKey, failureCode: reason.code }
    });
    createWorkflowEvent(input.db, {
      workflowRunId: input.workflowRunId,
      workflowStageRunId: input.stageRunId,
      eventType: "workflow.stage.action.failed",
      payload: {
        actionType: input.actionType,
        idempotencyKey,
        reason
      }
    });
    return {
      status: "failed",
      idempotent: false,
      workflowRunId: input.workflowRunId,
      stageRunId: input.stageRunId,
      actionType: input.actionType,
      idempotencyKey,
      reason
    };
  }
}
