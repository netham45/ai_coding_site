import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type Database from "better-sqlite3";
import { parsePlanYaml } from "./planParser.js";
import {
  createWorkflowEvent,
  getWorkflowStageRunById,
  listWorkflowEventsByStageRun,
  transitionWorkflowStageRunStatus
} from "./workflowRepository.js";

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

function createChildNodesFromPlanYamlDefault(input: Record<string, unknown>): Record<string, unknown> {
  const yaml = parseStringField(input, "yaml");
  const parsed = parsePlanYaml(yaml);
  return {
    createdChildCount: parsed.tasks.length,
    itemKeys: parsed.tasks.map((task) => task.itemKey)
  };
}

function reviewChildNodesDefault(input: Record<string, unknown>): Record<string, unknown> {
  const childNodesInput = input.childNodes;
  const childNodes = Array.isArray(childNodesInput) ? childNodesInput : [];
  const statuses = childNodes
    .map((row) => (typeof row === "object" && row !== null ? (row as { status?: unknown }).status : null))
    .filter((status): status is string => typeof status === "string");
  const failingCount = statuses.filter((status) => status === "failed" || status === "merge_conflict").length;
  return {
    reviewedCount: childNodes.length,
    failingCount,
    approved: failingCount === 0
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
      : createChildNodesFromPlanYamlDefault(actionInput);
  }
  if (actionType === "review_child_nodes") {
    return handlers.reviewChildNodes ? await handlers.reviewChildNodes(actionInput, context) : reviewChildNodesDefault(actionInput);
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
