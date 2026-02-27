import type Database from "better-sqlite3";
import type { WorkflowDefinitionRow, WorkflowRunRow } from "../types.js";
import { startWorkflowRun, tickWorkflowRun } from "./workflowEngine.js";
import {
  createWorkflowDefinition,
  createWorkflowRun,
  getWorkflowRunById,
  listWorkflowStageRunsByRun
} from "./workflowRepository.js";
import { executeWorkflowStageAction, type WorkflowStageActionType } from "./workflowStageActions.js";

const DEFAULT_EXEC_WORKFLOW_NAME = "task_exec_default";
const DEFAULT_EXEC_WORKFLOW_VERSION = 1;
const MAX_AUTORUN_PASSES = 16;

const DEFAULT_EXEC_WORKFLOW_DEFINITION = JSON.stringify({
  version: 1,
  stages: [
    { id: "run_command", max_attempts: 1 },
    { id: "review", depends_on: ["run_command"], max_attempts: 1 },
    { id: "return_result", depends_on: ["review"], max_attempts: 1 }
  ]
});

export const DEFAULT_EXEC_WORKFLOW = {
  name: DEFAULT_EXEC_WORKFLOW_NAME,
  version: DEFAULT_EXEC_WORKFLOW_VERSION,
  definition: DEFAULT_EXEC_WORKFLOW_DEFINITION
} as const;

type EnsureDefaultExecWorkflowInput = {
  db: Database.Database;
  projectId: string;
  taskId: string;
  createdByUserId: string;
};

function findDefaultDefinition(db: Database.Database, projectId: string): WorkflowDefinitionRow | undefined {
  return db
    .prepare(
      `SELECT *
       FROM workflow_definitions
       WHERE project_id = ? AND name = ? AND version = ?
       LIMIT 1`
    )
    .get(projectId, DEFAULT_EXEC_WORKFLOW_NAME, DEFAULT_EXEC_WORKFLOW_VERSION) as WorkflowDefinitionRow | undefined;
}

function ensureDefaultDefinition(params: { db: Database.Database; projectId: string; createdByUserId: string }): WorkflowDefinitionRow {
  const existing = findDefaultDefinition(params.db, params.projectId);
  if (existing) return existing;
  return createWorkflowDefinition(params.db, {
    projectId: params.projectId,
    name: DEFAULT_EXEC_WORKFLOW_NAME,
    version: DEFAULT_EXEC_WORKFLOW_VERSION,
    definitionYaml: DEFAULT_EXEC_WORKFLOW_DEFINITION,
    createdByUserId: params.createdByUserId
  });
}

export function ensureDefaultExecWorkflowDefinition(params: {
  db: Database.Database;
  projectId: string;
  createdByUserId: string;
}): WorkflowDefinitionRow {
  return ensureDefaultDefinition(params);
}

function findRunForTaskAndDefinition(db: Database.Database, taskId: string, workflowDefinitionId: string): WorkflowRunRow | undefined {
  return db
    .prepare(
      `SELECT *
       FROM workflow_runs
       WHERE task_id = ? AND workflow_definition_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(taskId, workflowDefinitionId) as WorkflowRunRow | undefined;
}

function resolveStageAction(stageKey: string): { actionType: WorkflowStageActionType; actionInput?: Record<string, unknown> } {
  if (stageKey === "run_command") {
    return {
      actionType: "run_command",
      actionInput: { command: "true" }
    };
  }
  if (stageKey === "review") {
    return {
      actionType: "no_op",
      actionInput: { message: "auto_review" }
    };
  }
  if (stageKey === "return_result") {
    return {
      actionType: "no_op",
      actionInput: { message: "auto_return_result" }
    };
  }
  return {
    actionType: "no_op",
    actionInput: { message: `auto_unknown_stage:${stageKey}` }
  };
}

async function autoProgressRunToTerminal(db: Database.Database, workflowRunId: string): Promise<WorkflowRunRow> {
  for (let pass = 0; pass < MAX_AUTORUN_PASSES; pass += 1) {
    const current = getWorkflowRunById(db, workflowRunId);
    if (!current) {
      throw new Error(`workflow run not found: ${workflowRunId}`);
    }
    if (current.status === "succeeded" || current.status === "failed" || current.status === "cancelled") {
      return current;
    }

    const stageRuns = listWorkflowStageRunsByRun(db, current.id);
    const running = stageRuns.find((stage) => stage.status === "running");
    if (!running) {
      const ticked = tickWorkflowRun({ db, workflowRunId: current.id });
      if (!ticked.progressed) return ticked.run;
      continue;
    }

    const resolved = resolveStageAction(running.stage_key);
    await executeWorkflowStageAction({
      db,
      workflowRunId: current.id,
      stageRunId: running.id,
      actionType: resolved.actionType,
      actionInput: resolved.actionInput,
      idempotencyKey: `default_exec:${current.id}:${running.id}:${resolved.actionType}`
    });
    tickWorkflowRun({ db, workflowRunId: current.id });
  }
  return getWorkflowRunById(db, workflowRunId)!;
}

export async function ensureDefaultExecWorkflowForTask(params: EnsureDefaultExecWorkflowInput): Promise<WorkflowRunRow> {
  const definition = ensureDefaultDefinition({
    db: params.db,
    projectId: params.projectId,
    createdByUserId: params.createdByUserId
  });
  const existingRun = findRunForTaskAndDefinition(params.db, params.taskId, definition.id);
  if (existingRun) {
    return autoProgressRunToTerminal(params.db, existingRun.id);
  }

  const run = createWorkflowRun(params.db, {
    workflowDefinitionId: definition.id,
    projectId: params.projectId,
    taskId: params.taskId
  });
  startWorkflowRun({ db: params.db, workflowRunId: run.id });
  return autoProgressRunToTerminal(params.db, run.id);
}
