import type Database from "better-sqlite3";
import type { WorkflowRunRow, WorkflowStageRunRow } from "../types.js";
import type { DeterministicWorkflowCheck } from "./workflowChecks.js";
import { runDeterministicChecksForStageRun } from "./workflowChecks.js";
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
  deterministicChecks: DeterministicWorkflowCheck[];
};

export type WorkflowEngineHandleEventInput = {
  db: Database.Database;
  workflowRunId: string;
  eventType:
    | "workflow.node.merged"
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

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return strings.length === value.length ? strings : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readComparator(value: unknown): "eq" | "gte" | "lte" {
  return value === "gte" || value === "lte" ? value : "eq";
}

function parseDeterministicCheck(entry: unknown): DeterministicWorkflowCheck | null {
  if (!entry || typeof entry !== "object") return null;
  const row = entry as Record<string, unknown>;
  const type = readString(row.type);
  const name = readString(row.name);
  if (!type || !name) return null;

  if (type === "file_created") {
    const relativePath = readString(row.relativePath);
    if (!relativePath) return null;
    return {
      type,
      name,
      relativePath,
      baselineExists: typeof row.baselineExists === "boolean" ? row.baselineExists : undefined,
      since: readString(row.since) ?? undefined
    };
  }
  if (type === "file_exists") {
    const relativePath = readString(row.relativePath);
    return relativePath ? { type, name, relativePath } : null;
  }
  if (type === "file_modified_within") {
    const relativePath = readString(row.relativePath);
    const withinSeconds = readNumber(row.withinSeconds);
    if (!relativePath || withinSeconds === null) return null;
    return {
      type,
      name,
      relativePath,
      withinSeconds,
      now: readString(row.now) ?? undefined
    };
  }
  if (type === "line_present_in_file") {
    const relativePath = readString(row.relativePath);
    const line = readString(row.line);
    if (!relativePath || !line) return null;
    return {
      type,
      name,
      relativePath,
      line,
      caseSensitive: typeof row.caseSensitive === "boolean" ? row.caseSensitive : undefined
    };
  }
  if (type === "json_path_equals") {
    const relativePath = readString(row.relativePath);
    const jsonPath = readString(row.jsonPath);
    if (!relativePath || !jsonPath) return null;
    return {
      type,
      name,
      relativePath,
      jsonPath,
      expected: row.expected
    };
  }
  if (type === "command_exit_code") {
    const command = readStringArray(row.command);
    const expectedExitCode = readNumber(row.expectedExitCode);
    if (!command || expectedExitCode === null) return null;
    return {
      type,
      name,
      command,
      expectedExitCode,
      cwdRelative: readString(row.cwdRelative) ?? undefined,
      timeoutMs: readNumber(row.timeoutMs) ?? undefined
    };
  }
  if (type === "stage_complete") {
    const stageRunId = readString(row.stageRunId);
    if (!stageRunId) return null;
    const expectedStatus = row.expectedStatus;
    const validExpected = expectedStatus === "succeeded" || expectedStatus === "failed" || expectedStatus === "skipped"
      || expectedStatus === "cancelled"
      ? expectedStatus
      : undefined;
    return {
      type,
      name,
      stageRunId,
      expectedStatus: validExpected
    };
  }
  if (type === "node_merged") {
    const nodeId = readString(row.nodeId);
    return nodeId ? { type, name, nodeId } : null;
  }
  if (type === "child_nodes_created_count") {
    const parentNodeId = readString(row.parentNodeId);
    const expectedCount = readNumber(row.expectedCount);
    if (!parentNodeId || expectedCount === null) return null;
    return {
      type,
      name,
      parentNodeId,
      expectedCount,
      comparator: readComparator(row.comparator)
    };
  }
  return null;
}

function normalizeDeterministicChecks(raw: unknown): DeterministicWorkflowCheck[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseDeterministicCheck).filter((entry): entry is DeterministicWorkflowCheck => Boolean(entry));
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
          maxAttempts: normalizeMaxAttempts(row.max_attempts ?? row.maxAttempts),
          deterministicChecks: normalizeDeterministicChecks(
            row.deterministic_checks ?? row.deterministicChecks ?? row.checks
          )
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
      current = { key: "", dependsOn: [], maxAttempts: 1, deterministicChecks: [] };
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

function runWorkspacePath(db: Database.Database, run: WorkflowRunRow): string {
  if (!run.task_id) return process.cwd();
  const row = db.prepare("SELECT workspace_path FROM tasks WHERE id = ? LIMIT 1").get(run.task_id) as
    | { workspace_path: string }
    | undefined;
  return row?.workspace_path || process.cwd();
}

function deterministicCheckGate(params: {
  db: Database.Database;
  run: WorkflowRunRow;
  stageRunId: string;
  checks: DeterministicWorkflowCheck[];
}): { passed: true; failedCheckNames: [] } | { passed: false; failedCheckNames: string[] } {
  if (params.checks.length === 0) {
    return { passed: true, failedCheckNames: [] };
  }
  const evaluated = runDeterministicChecksForStageRun({
    db: params.db,
    workflowStageRunId: params.stageRunId,
    workspacePath: runWorkspacePath(params.db, params.run),
    checks: params.checks
  });
  if (evaluated.allPassed) {
    return { passed: true, failedCheckNames: [] };
  }
  return {
    passed: false,
    failedCheckNames: evaluated.checkResults.filter((row) => row.status !== "pass").map((row) => row.check_name)
  };
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

function hasDuplicateRunEventByIdempotency(
  db: Database.Database,
  params: { workflowRunId: string; eventType: string; idempotencyKey: string }
): boolean {
  const events = db
    .prepare("SELECT event_type, payload FROM workflow_events WHERE workflow_run_id = ? ORDER BY created_at ASC")
    .all(params.workflowRunId) as Array<{ event_type: string; payload: string }>;
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
      const checks = definitionForStage?.deterministicChecks ?? [];
      const checkGate = deterministicCheckGate({
        db: params.db,
        run,
        stageRunId: pending.id,
        checks
      });
      if (unresolved.length === 0 && checkGate.passed) continue;
      if (
        createLifecycleEventIfChanged(params.db, {
          workflowRunId: run.id,
          stageRunId: pending.id,
          state: "blocked",
          reason: unresolved.length > 0 ? "dependency_gate" : "deterministic_checks_pending",
          extra: {
            unresolvedDependsOn: unresolved,
            failedChecks: checkGate.failedCheckNames
          }
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
    const checks = definitionForStage?.deterministicChecks ?? [];
    const checkGate = deterministicCheckGate({
      db: params.db,
      run,
      stageRunId: pending.id,
      checks
    });
    if (unresolved.length === 0 && checkGate.passed) continue;
    if (
      createLifecycleEventIfChanged(params.db, {
        workflowRunId: run.id,
        stageRunId: pending.id,
        state: "blocked",
        reason: unresolved.length > 0 ? "dependency_gate" : "deterministic_checks_pending",
        extra: {
          unresolvedDependsOn: unresolved,
          failedChecks: checkGate.failedCheckNames
        }
      })
    ) {
      progressed = true;
    }
  }

  for (const pending of incomplete.sort((a, b) => a.ordinal - b.ordinal)) {
    const definitionForStage = definitionsByKey.get(pending.stage_key);
    const deps = definitionForStage?.dependsOn ?? [];
    const unresolved = deps.filter((depKey) => byKey.get(depKey)?.status !== "succeeded");
    if (unresolved.length > 0) continue;
    const checks = definitionForStage?.deterministicChecks ?? [];
    const checkGate = deterministicCheckGate({
      db: params.db,
      run,
      stageRunId: pending.id,
      checks
    });
    if (!checkGate.passed) continue;

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
  const parsedStages = parseStageDefinitions(definition.definition_yaml);
  const stageDefinitions = stageDefinitionByKey(parsedStages);
  const stageRuns = listWorkflowStageRunsByRun(input.db, run.id);
  const requiresStageRun = input.eventType !== "workflow.node.merged";
  const stageRun = requiresStageRun ? findStageRun(stageRuns, { stageRunId: input.stageRunId, stageKey: input.stageKey }) : null;
  if (requiresStageRun && !stageRun) {
    throw new Error("event requires a valid stageRunId or stageKey");
  }
  if (stageRun && stageRun.workflow_run_id !== run.id) {
    throw new Error(`stage run ${stageRun.id} does not belong to workflow run ${run.id}`);
  }

  if (input.idempotencyKey) {
    const duplicate = stageRun
      ? hasDuplicateEventByIdempotency(input.db, {
        stageRunId: stageRun.id,
        eventType: input.eventType,
        idempotencyKey: input.idempotencyKey
      })
      : hasDuplicateRunEventByIdempotency(input.db, {
        workflowRunId: run.id,
        eventType: input.eventType,
        idempotencyKey: input.idempotencyKey
      });
    if (duplicate) {
      return { run: getWorkflowRunById(input.db, input.workflowRunId)!, applied: false, idempotent: true };
    }
  }

  createWorkflowEvent(input.db, {
    id: input.eventId,
    workflowRunId: run.id,
    workflowStageRunId: stageRun?.id,
    eventType: input.eventType,
    payload: {
      ...(input.payload ?? {}),
      idempotencyKey: input.idempotencyKey ?? null
    }
  });

  let applied = false;

  if (input.eventType === "workflow.node.merged") {
    applied = true;
  } else if (input.eventType === "workflow.stage.waiting_input" && stageRun?.status === "running") {
    applied = createLifecycleEventIfChanged(input.db, {
      workflowRunId: run.id,
      stageRunId: stageRun.id,
      state: "waiting_input",
      reason: "runtime_requested_input"
    });
  } else if (input.eventType === "workflow.stage.input_received" && stageRun?.status === "running") {
    applied = createLifecycleEventIfChanged(input.db, {
      workflowRunId: run.id,
      stageRunId: stageRun.id,
      state: "running",
      reason: "input_received"
    });
  } else if (input.eventType === "workflow.stage.verifying" && stageRun?.status === "running") {
    applied = createLifecycleEventIfChanged(input.db, {
      workflowRunId: run.id,
      stageRunId: stageRun.id,
      state: "verifying",
      reason: "verification_started"
    });
  } else if (input.eventType === "workflow.stage.verify_succeeded" && stageRun?.status === "running") {
    transitionWorkflowStageRunStatus(input.db, {
      stageRunId: stageRun.id,
      toStatus: "succeeded",
      reason: "verification_passed"
    });
    applied = true;
  } else if (input.eventType === "workflow.stage.verify_failed" && stageRun?.status === "running") {
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
