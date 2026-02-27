import type Database from "better-sqlite3";
import type { WorkflowDefinitionRow, WorkflowRunRow } from "../types.js";
import { startWorkflowRun } from "./workflowEngine.js";
import {
  createWorkflowDefinition,
  createWorkflowRun,
  getWorkflowRunById
} from "./workflowRepository.js";

export type BuiltinWorkflowTier = "epoch" | "phase" | "plan";

const BUILTIN_WORKFLOW_VERSION = 1;

const BUILTIN_WORKFLOW_DEFINITION_YAML = `version: 1
stages:
  - id: generate_plan_yaml
    max_attempts: 1
  - id: ingest_child_nodes
    depends_on: [generate_plan_yaml]
    max_attempts: 3
  - id: wait_for_child_completion
    depends_on: [ingest_child_nodes]
    max_attempts: 1
`;

export function builtinWorkflowNameForTier(tier: BuiltinWorkflowTier): string {
  return `builtin.${tier}.workflow`;
}

function findDefinitionByName(
  db: Database.Database,
  params: { projectId: string; name: string }
): WorkflowDefinitionRow | undefined {
  return db
    .prepare(
      `SELECT *
       FROM workflow_definitions
       WHERE project_id = ? AND name = ?
       ORDER BY version DESC, created_at DESC
       LIMIT 1`
    )
    .get(params.projectId, params.name) as WorkflowDefinitionRow | undefined;
}

function ensureBuiltinDefinition(params: {
  db: Database.Database;
  projectId: string;
  tier: BuiltinWorkflowTier;
  createdByUserId: string;
}): WorkflowDefinitionRow {
  const name = builtinWorkflowNameForTier(params.tier);
  const existing = findDefinitionByName(params.db, { projectId: params.projectId, name });
  if (existing) {
    return existing;
  }
  return createWorkflowDefinition(params.db, {
    projectId: params.projectId,
    name,
    version: BUILTIN_WORKFLOW_VERSION,
    definitionYaml: BUILTIN_WORKFLOW_DEFINITION_YAML,
    createdByUserId: params.createdByUserId
  });
}

export function ensureBuiltinWorkflowDefinitionForTier(params: {
  db: Database.Database;
  projectId: string;
  tier: BuiltinWorkflowTier;
  createdByUserId: string;
}): WorkflowDefinitionRow {
  return ensureBuiltinDefinition(params);
}

function activeWorkflowRunForTask(db: Database.Database, taskId: string): WorkflowRunRow | undefined {
  return db
    .prepare(
      `SELECT *
       FROM workflow_runs
       WHERE task_id = ?
         AND status IN ('queued', 'running')
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(taskId) as WorkflowRunRow | undefined;
}

export function startBuiltinWorkflowForTierTask(params: {
  db: Database.Database;
  projectId: string;
  taskId: string;
  tier: BuiltinWorkflowTier;
  createdByUserId: string;
}): WorkflowRunRow {
  const existing = activeWorkflowRunForTask(params.db, params.taskId);
  if (existing) {
    return startWorkflowRun({ db: params.db, workflowRunId: existing.id });
  }

  const definition = ensureBuiltinDefinition({
    db: params.db,
    projectId: params.projectId,
    tier: params.tier,
    createdByUserId: params.createdByUserId
  });
  const run = createWorkflowRun(params.db, {
    workflowDefinitionId: definition.id,
    projectId: params.projectId,
    taskId: params.taskId,
    status: "queued"
  });
  startWorkflowRun({ db: params.db, workflowRunId: run.id });
  return getWorkflowRunById(params.db, run.id)!;
}
