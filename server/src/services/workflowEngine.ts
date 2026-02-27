import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { TaskRow, WorkflowRunRow, WorkflowStageRunRow } from "../types.js";
import {
  createWorkflowEvent,
  createWorkflowStageRun,
  getWorkflowDefinitionById,
  getWorkflowEventById,
  getWorkflowRunById,
  listWorkflowEventsByStageRun,
  listWorkflowStageRunsByRun,
  transitionWorkflowRunStatus,
  transitionWorkflowStageRunStatus
} from "./workflowRepository.js";

export type WorkflowStageLifecycleState = "blocked" | "ready" | "running" | "waiting_input" | "verifying";

export type WorkflowEngineStageDefinition = {
  key: string;
  dependsOn: string[];
  maxAttempts: number;
};

export type WorkflowEngineHandleEventInput = {
  db: Database.Database;
  workflowRunId: string;
  eventType:
    | "workflow.stage.waiting_input"
    | "workflow.stage.input_received"
    | "workflow.stage.verifying"
    | "workflow.stage.verify_succeeded"
    | "workflow.stage.verify_failed";
  stageRunId?: string;
  stageKey?: string;
  eventId?: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
};

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeDependsOn(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return trimmed
        .slice(1, -1)
        .split(",")
        .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    }
    return trimmed
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeMaxAttempts(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
    return Math.floor(raw);
  }
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  return 1;
}

function parseStageDefinitions(definitionYaml: string): WorkflowEngineStageDefinition[] {
  const asJson = safeParseJson(definitionYaml);
  if (asJson && typeof asJson === "object" && Array.isArray((asJson as { stages?: unknown[] }).stages)) {
    return ((asJson as { stages: unknown[] }).stages ?? [])
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const row = entry as Record<string, unknown>;
        const key = typeof row.id === "string" ? row.id : typeof row.key === "string" ? row.key : "";
        if (!key) return null;
        return {
          key,
          dependsOn: normalizeDependsOn(row.depends_on ?? row.dependsOn),
          maxAttempts: normalizeMaxAttempts(row.max_attempts ?? row.maxAttempts)
        } satisfies WorkflowEngineStageDefinition;
      })
      .filter((entry): entry is WorkflowEngineStageDefinition => Boolean(entry));
  }

  const lines = definitionYaml.split(/\r?\n/);
  const out: WorkflowEngineStageDefinition[] = [];
  let inStages = false;
  let current: WorkflowEngineStageDefinition | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!inStages) {
      if (line === "stages:" || line.startsWith("stages:")) inStages = true;
      continue;
    }
    if (line.startsWith("- ")) {
      if (current && current.key) out.push(current);
      current = { key: "", dependsOn: [], maxAttempts: 1 };
      const content = line.slice(2).trim();
      if (content.startsWith("id:")) current.key = content.slice(3).trim();
      if (content.startsWith("key:")) current.key = content.slice(4).trim();
      continue;
    }
    if (!current) continue;

    if (line.startsWith("id:")) {
      current.key = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("key:")) {
      current.key = line.slice(4).trim();
      continue;
    }
    if (line.startsWith("depends_on:")) {
      current.dependsOn = normalizeDependsOn(line.slice("depends_on:".length).trim());
      continue;
    }
    if (line.startsWith("dependsOn:")) {
      current.dependsOn = normalizeDependsOn(line.slice("dependsOn:".length).trim());
      continue;
    }
    if (line.startsWith("max_attempts:")) {
      current.maxAttempts = normalizeMaxAttempts(line.slice("max_attempts:".length).trim());
      continue;
    }
    if (line.startsWith("maxAttempts:")) {
      current.maxAttempts = normalizeMaxAttempts(line.slice("maxAttempts:".length).trim());
      continue;
    }
  }

  if (current && current.key) out.push(current);
  return out;
}

function latestLifecycleState(db: Database.Database, stageRunId: string): WorkflowStageLifecycleState | null {
  const events = listWorkflowEventsByStageRun(db, stageRunId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event_type !== "workflow.stage.lifecycle") continue;
    const payload = safeParseJson(events[i].payload) as { state?: unknown } | null;
    if (!payload || typeof payload.state !== "string") continue;
    return payload.state as WorkflowStageLifecycleState;
  }
  return null;
}

function stageAttemptCount(db: Database.Database, stageRunId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM workflow_events WHERE workflow_stage_run_id = ? AND event_type = 'workflow.stage.attempt.started'"
    )
    .get(stageRunId) as { count: number };
  return Number(row.count ?? 0);
}

function stageDefinitionByKey(definitions: WorkflowEngineStageDefinition[]): Map<string, WorkflowEngineStageDefinition> {
  return new Map(definitions.map((row) => [row.key, row]));
}

function workflowTask(db: Database.Database, run: WorkflowRunRow): TaskRow | null {
  if (!run.task_id) return null;
  return db.prepare("SELECT * FROM tasks WHERE id = ? LIMIT 1").get(run.task_id) as TaskRow | null;
}

function planYamlExists(task: TaskRow): boolean {
  const yamlPath = path.join(task.workspace_path, ".ai-plan", "latest-plan.yaml");
  try {
    const content = fs.readFileSync(yamlPath, "utf8").trim();
    return content.length > 0;
  } catch {
    return false;
  }
}

function unresolvedStageRules(db: Database.Database, run: WorkflowRunRow, stageKey: string): string[] {
  if (!run.task_id) return [];
  const task = workflowTask(db, run);
  if (!task) {
    return ["missing_parent_task"];
  }
  if (stageKey === "ingest_child_nodes" && !planYamlExists(task)) {
    return ["missing_plan_yaml"];
  }
  if (stageKey === "wait_for_child_completion") {
    const unresolved = db
      .prepare("SELECT id FROM tasks WHERE parent_plan_task_id = ? AND status != 'merged' ORDER BY created_at ASC")
      .all(task.id) as Array<{ id: string }>;
    if (unresolved.length > 0) {
      return unresolved.map((row) => `child_not_merged:${row.id}`);
    }
  }
  return [];
}

function createLifecycleEventIfChanged(
  db: Database.Database,
  params: {
    workflowRunId: string;
    stageRunId: string;
    state: WorkflowStageLifecycleState;
    reason: string;
    extra?: Record<string, unknown>;
  }
): boolean {
  const prior = latestLifecycleState(db, params.stageRunId);
  if (prior === params.state) return false;
  createWorkflowEvent(db, {
    workflowRunId: params.workflowRunId,
    workflowStageRunId: params.stageRunId,
    eventType: "workflow.stage.lifecycle",
    payload: {
      state: params.state,
      reason: params.reason,
      ...(params.extra ?? {})
    }
  });
  return true;
}

function findStageRun(stageRuns: WorkflowStageRunRow[], input: { stageRunId?: string; stageKey?: string }): WorkflowStageRunRow | null {
  if (input.stageRunId) {
    return stageRuns.find((row) => row.id === input.stageRunId) ?? null;
  }
  if (input.stageKey) {
    return stageRuns.find((row) => row.stage_key === input.stageKey) ?? null;
  }
  return null;
}

function ensureRunIsRunning(db: Database.Database, run: WorkflowRunRow): WorkflowRunRow {
  if (run.status === "queued") {
    return transitionWorkflowRunStatus(db, {
      runId: run.id,
      toStatus: "running",
      reason: "workflow_engine_start"
    });
  }
  return run;
}

function ensureStageRunsForDefinition(db: Database.Database, run: WorkflowRunRow, stages: WorkflowEngineStageDefinition[]): WorkflowStageRunRow[] {
  const existing = listWorkflowStageRunsByRun(db, run.id);
  if (existing.length > 0) return existing;
  for (let index = 0; index < stages.length; index += 1) {
    createWorkflowStageRun(db, {
      workflowRunId: run.id,
      stageKey: stages[index].key,
      ordinal: index + 1
    });
  }
  return listWorkflowStageRunsByRun(db, run.id);
}

function hasDuplicateEventByIdempotency(
  db: Database.Database,
  params: { stageRunId: string; eventType: string; idempotencyKey: string }
): boolean {
  const events = listWorkflowEventsByStageRun(db, params.stageRunId);
  return events.some((event) => {
    if (event.event_type !== params.eventType) return false;
    const payload = safeParseJson(event.payload) as { idempotencyKey?: unknown } | null;
    return payload?.idempotencyKey === params.idempotencyKey;
  });
}

export function startWorkflowRun(params: { db: Database.Database; workflowRunId: string }): WorkflowRunRow {
  const run = getWorkflowRunById(params.db, params.workflowRunId);
  if (!run) {
    throw new Error(`workflow run not found: ${params.workflowRunId}`);
  }
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
    return run;
  }

  const definition = getWorkflowDefinitionById(params.db, run.workflow_definition_id);
  if (!definition) {
    throw new Error(`workflow definition not found: ${run.workflow_definition_id}`);
  }
  const stages = parseStageDefinitions(definition.definition_yaml);
  ensureStageRunsForDefinition(params.db, run, stages);
  const runningRun = ensureRunIsRunning(params.db, run);
  tickWorkflowRun({ db: params.db, workflowRunId: runningRun.id });
  return getWorkflowRunById(params.db, runningRun.id)!;
}

export function tickWorkflowRun(params: { db: Database.Database; workflowRunId: string }): { run: WorkflowRunRow; progressed: boolean } {
  const run = getWorkflowRunById(params.db, params.workflowRunId);
  if (!run) {
    throw new Error(`workflow run not found: ${params.workflowRunId}`);
  }
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
    return { run, progressed: false };
  }

  const definition = getWorkflowDefinitionById(params.db, run.workflow_definition_id);
  if (!definition) {
    throw new Error(`workflow definition not found: ${run.workflow_definition_id}`);
  }
  const stageDefinitions = parseStageDefinitions(definition.definition_yaml);
  const stageRuns = ensureStageRunsForDefinition(params.db, run, stageDefinitions);
  const byKey = new Map(stageRuns.map((stage) => [stage.stage_key, stage]));
  const definitionsByKey = stageDefinitionByKey(stageDefinitions);

  const currentlyRunning = stageRuns.find((stage) => stage.status === "running");
  if (currentlyRunning) {
    let gatedStateChanged = false;
    for (const pending of stageRuns.filter((stage) => stage.status === "pending")) {
      const definitionForStage = definitionsByKey.get(pending.stage_key);
      const deps = definitionForStage?.dependsOn ?? [];
      const unresolved = deps.filter((depKey) => byKey.get(depKey)?.status !== "succeeded");
      const unresolvedRules = unresolvedStageRules(params.db, run, pending.stage_key);
      if (unresolved.length === 0 && unresolvedRules.length === 0) continue;
      if (
        createLifecycleEventIfChanged(params.db, {
          workflowRunId: run.id,
          stageRunId: pending.id,
          state: "blocked",
          reason: "dependency_gate",
          extra: { unresolvedDependsOn: unresolved, unresolvedStageRules: unresolvedRules }
        })
      ) {
        gatedStateChanged = true;
      }
    }
    return { run: getWorkflowRunById(params.db, run.id)!, progressed: gatedStateChanged };
  }

  const hasFailedStage = stageRuns.some((stage) => stage.status === "failed");
  if (hasFailedStage) {
    const failed = transitionWorkflowRunStatus(params.db, {
      runId: run.id,
      toStatus: "failed",
      reason: "workflow_stage_failed"
    });
    return { run: failed, progressed: true };
  }

  const incomplete = stageRuns.filter((stage) => stage.status === "pending");
  if (incomplete.length === 0) {
    const succeeded = transitionWorkflowRunStatus(params.db, {
      runId: run.id,
      toStatus: "succeeded",
      reason: "all_workflow_stages_terminal"
    });
    return { run: succeeded, progressed: true };
  }

  let progressed = false;
  for (const pending of incomplete.sort((a, b) => a.ordinal - b.ordinal)) {
    const definitionForStage = definitionsByKey.get(pending.stage_key);
    const deps = definitionForStage?.dependsOn ?? [];
    const unresolved = deps.filter((depKey) => byKey.get(depKey)?.status !== "succeeded");
    const unresolvedRules = unresolvedStageRules(params.db, run, pending.stage_key);
    if (unresolved.length === 0 && unresolvedRules.length === 0) continue;
    if (
      createLifecycleEventIfChanged(params.db, {
        workflowRunId: run.id,
        stageRunId: pending.id,
        state: "blocked",
        reason: "dependency_gate",
        extra: { unresolvedDependsOn: unresolved, unresolvedStageRules: unresolvedRules }
      })
    ) {
      progressed = true;
    }
  }

  for (const pending of incomplete.sort((a, b) => a.ordinal - b.ordinal)) {
    const definitionForStage = definitionsByKey.get(pending.stage_key);
    const deps = definitionForStage?.dependsOn ?? [];
    const unresolved = deps.filter((depKey) => byKey.get(depKey)?.status !== "succeeded");
    const unresolvedRules = unresolvedStageRules(params.db, run, pending.stage_key);
    if (unresolved.length > 0 || unresolvedRules.length > 0) continue;

    createLifecycleEventIfChanged(params.db, {
      workflowRunId: run.id,
      stageRunId: pending.id,
      state: "ready",
      reason: "dependency_gate_open"
    });
    transitionWorkflowStageRunStatus(params.db, {
      stageRunId: pending.id,
      toStatus: "running",
      reason: "workflow_engine_stage_started"
    });
    const attemptNumber = stageAttemptCount(params.db, pending.id) + 1;
    createWorkflowEvent(params.db, {
      workflowRunId: run.id,
      workflowStageRunId: pending.id,
      eventType: "workflow.stage.attempt.started",
      payload: { attempt: attemptNumber }
    });
    createLifecycleEventIfChanged(params.db, {
      workflowRunId: run.id,
      stageRunId: pending.id,
      state: "running",
      reason: "attempt_started",
      extra: { attempt: attemptNumber }
    });
    progressed = true;
    break;
  }

  return {
    run: getWorkflowRunById(params.db, run.id)!,
    progressed
  };
}

export function handleEvent(input: WorkflowEngineHandleEventInput): { run: WorkflowRunRow; applied: boolean; idempotent: boolean } {
  const run = getWorkflowRunById(input.db, input.workflowRunId);
  if (!run) {
    throw new Error(`workflow run not found: ${input.workflowRunId}`);
  }
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
    return { run, applied: false, idempotent: true };
  }
  if (input.eventId && getWorkflowEventById(input.db, input.eventId)) {
    return { run: getWorkflowRunById(input.db, input.workflowRunId)!, applied: false, idempotent: true };
  }

  const definition = getWorkflowDefinitionById(input.db, run.workflow_definition_id);
  if (!definition) {
    throw new Error(`workflow definition not found: ${run.workflow_definition_id}`);
  }
  const stageDefinitions = stageDefinitionByKey(parseStageDefinitions(definition.definition_yaml));
  const stageRuns = listWorkflowStageRunsByRun(input.db, run.id);
  const stageRun = findStageRun(stageRuns, { stageRunId: input.stageRunId, stageKey: input.stageKey });
  if (!stageRun) {
    throw new Error("event requires a valid stageRunId or stageKey");
  }
  if (stageRun.workflow_run_id !== run.id) {
    throw new Error(`stage run ${stageRun.id} does not belong to workflow run ${run.id}`);
  }

  if (input.idempotencyKey && hasDuplicateEventByIdempotency(input.db, {
    stageRunId: stageRun.id,
    eventType: input.eventType,
    idempotencyKey: input.idempotencyKey
  })) {
    return { run: getWorkflowRunById(input.db, input.workflowRunId)!, applied: false, idempotent: true };
  }

  createWorkflowEvent(input.db, {
    id: input.eventId,
    workflowRunId: run.id,
    workflowStageRunId: stageRun.id,
    eventType: input.eventType,
    payload: {
      ...(input.payload ?? {}),
      idempotencyKey: input.idempotencyKey ?? null
    }
  });

  let applied = false;

  if (input.eventType === "workflow.stage.waiting_input" && stageRun.status === "running") {
    applied = createLifecycleEventIfChanged(input.db, {
      workflowRunId: run.id,
      stageRunId: stageRun.id,
      state: "waiting_input",
      reason: "runtime_requested_input"
    });
  } else if (input.eventType === "workflow.stage.input_received" && stageRun.status === "running") {
    applied = createLifecycleEventIfChanged(input.db, {
      workflowRunId: run.id,
      stageRunId: stageRun.id,
      state: "running",
      reason: "input_received"
    });
  } else if (input.eventType === "workflow.stage.verifying" && stageRun.status === "running") {
    applied = createLifecycleEventIfChanged(input.db, {
      workflowRunId: run.id,
      stageRunId: stageRun.id,
      state: "verifying",
      reason: "verification_started"
    });
  } else if (input.eventType === "workflow.stage.verify_succeeded" && stageRun.status === "running") {
    transitionWorkflowStageRunStatus(input.db, {
      stageRunId: stageRun.id,
      toStatus: "succeeded",
      reason: "verification_passed"
    });
    applied = true;
  } else if (input.eventType === "workflow.stage.verify_failed" && stageRun.status === "running") {
    const definitionForStage = stageDefinitions.get(stageRun.stage_key);
    const maxAttempts = definitionForStage?.maxAttempts ?? 1;
    const retryable = input.payload?.retryable === true;
    const attempts = stageAttemptCount(input.db, stageRun.id);
    const nextAttempt = attempts + 1;
    if (retryable && nextAttempt <= maxAttempts) {
      createWorkflowEvent(input.db, {
        workflowRunId: run.id,
        workflowStageRunId: stageRun.id,
        eventType: "workflow.stage.retry_scheduled",
        payload: { retryable: true, nextAttempt, maxAttempts }
      });
      createWorkflowEvent(input.db, {
        workflowRunId: run.id,
        workflowStageRunId: stageRun.id,
        eventType: "workflow.stage.attempt.started",
        payload: { attempt: nextAttempt }
      });
      createLifecycleEventIfChanged(input.db, {
        workflowRunId: run.id,
        stageRunId: stageRun.id,
        state: "running",
        reason: "retry_attempt_started",
        extra: { attempt: nextAttempt, maxAttempts }
      });
      applied = true;
    } else {
      transitionWorkflowStageRunStatus(input.db, {
        stageRunId: stageRun.id,
        toStatus: "failed",
        reason: retryable ? "max_attempts_exhausted" : "verification_failed"
      });
      applied = true;
    }
  }

  const ticked = tickWorkflowRun({ db: input.db, workflowRunId: run.id });
  return {
    run: ticked.run,
    applied,
    idempotent: false
  };
}
