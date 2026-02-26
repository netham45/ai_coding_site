import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { db as appDb, resolveProjectDatabase } from "../db/index.js";
import { approvePlan, extractPlan } from "../application/cliServices.js";
import type { PlanOrchestrationStateRow, PlanRevisionRow, TaskRow } from "../types.js";
import { nowIso } from "../utils/time.js";
import { recordEvent } from "./events.js";
import {
  enqueueOrchestrationJob,
  kickOrchestrationJobQueueProcessing,
  registerOrchestrationJobHandler,
  type OrchestrationJobType
} from "./orchestration/jobQueue.js";

const PLAN_OUTPUT_RELATIVE_PATH = ".ai-plan/latest-plan.yaml";
const PLAN_LOCK_TTL_MS = 3 * 60 * 1000;
const MAX_PLANS_PER_PASS = 8;
const PLAN_ORCHESTRATION_JOB_TYPE: OrchestrationJobType = "plan_orchestration_pass";
const PLAN_ORCHESTRATION_IDEMPOTENCY_KEY = "plan-orchestration:global";

type EligiblePlanRow = {
  id: string;
  project_id: string;
  workspace_path: string;
  created_by_user_id: string;
};

let running = false;
let planJobRegistered = false;

function planOutputFilePath(workspacePath: string): string {
  return path.join(workspacePath, PLAN_OUTPUT_RELATIVE_PATH);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedPlanText(raw: string): string {
  return `${raw.trim()}\n`;
}

function readPlanFile(workspacePath: string): { raw: string; normalized: string; sha256: string } | null {
  const filePath = planOutputFilePath(workspacePath);
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return null;
    }
    const normalized = normalizedPlanText(raw);
    return {
      raw,
      normalized,
      sha256: sha256Text(normalized)
    };
  } catch {
    return null;
  }
}

function getState(projectDb: Database.Database, planTaskId: string): PlanOrchestrationStateRow | undefined {
  return projectDb
    .prepare("SELECT * FROM plan_orchestration_state WHERE plan_task_id = ?")
    .get(planTaskId) as PlanOrchestrationStateRow | undefined;
}

function ensureStateRow(projectDb: Database.Database, planTaskId: string): void {
  const now = nowIso();
  projectDb.prepare(
    `INSERT INTO plan_orchestration_state (plan_task_id, created_at, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(plan_task_id) DO NOTHING`
  ).run(planTaskId, now, now);
}

function claimPlanLock(projectDb: Database.Database, planTaskId: string, lockToken: string): boolean {
  ensureStateRow(projectDb, planTaskId);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + PLAN_LOCK_TTL_MS).toISOString();
  const result = projectDb.prepare(
    `UPDATE plan_orchestration_state
     SET lock_token = ?, lock_expires_at = ?, updated_at = ?
     WHERE plan_task_id = ?
       AND (
         lock_token IS NULL
         OR lock_expires_at IS NULL
         OR lock_expires_at <= ?
         OR lock_token = ?
       )`
  ).run(lockToken, expiresAt, now, planTaskId, now, lockToken);
  return result.changes > 0;
}

function releasePlanLock(projectDb: Database.Database, planTaskId: string, lockToken: string): void {
  projectDb.prepare(
    `UPDATE plan_orchestration_state
     SET lock_token = NULL, lock_expires_at = NULL, updated_at = ?
     WHERE plan_task_id = ? AND lock_token = ?`
  ).run(nowIso(), planTaskId, lockToken);
}

function markOrchestrationFailure(
  projectDb: Database.Database,
  planTaskId: string,
  outputSha256: string,
  message: string
): void {
  const now = nowIso();
  projectDb.prepare(
    `UPDATE plan_orchestration_state
     SET
       last_output_sha256 = ?,
       last_failed_output_sha256 = ?,
       last_error = ?,
       last_error_at = ?,
       updated_at = ?
     WHERE plan_task_id = ?`
  ).run(outputSha256, outputSha256, message, now, now, planTaskId);
}

function markExtraction(
  projectDb: Database.Database,
  planTaskId: string,
  outputSha256: string,
  revisionId: string
): void {
  const now = nowIso();
  projectDb.prepare(
    `UPDATE plan_orchestration_state
     SET
       last_output_sha256 = ?,
       last_extracted_revision_id = ?,
       last_error = NULL,
       last_error_at = NULL,
       updated_at = ?
     WHERE plan_task_id = ?`
  ).run(outputSha256, revisionId, now, planTaskId);
}

function markApproval(
  projectDb: Database.Database,
  planTaskId: string,
  outputSha256: string,
  revisionId: string
): void {
  const now = nowIso();
  projectDb.prepare(
    `UPDATE plan_orchestration_state
     SET
       last_output_sha256 = ?,
       last_approved_revision_id = ?,
       last_approved_output_sha256 = ?,
       last_failed_output_sha256 = NULL,
       last_error = NULL,
       last_error_at = NULL,
       updated_at = ?
     WHERE plan_task_id = ?`
  ).run(outputSha256, revisionId, outputSha256, now, planTaskId);
}

function latestRevisionWithStatus(projectDb: Database.Database, planTaskId: string, status: PlanRevisionRow["status"]): PlanRevisionRow | undefined {
  return projectDb
    .prepare(
      `SELECT *
       FROM plan_revisions
       WHERE plan_task_id = ? AND status = ?
       ORDER BY revision_number DESC
       LIMIT 1`
    )
    .get(planTaskId, status) as PlanRevisionRow | undefined;
}

function latestPlanTask(projectDb: Database.Database, planTaskId: string): TaskRow | undefined {
  return projectDb.prepare("SELECT * FROM tasks WHERE id = ? AND mode = 'plan'").get(planTaskId) as TaskRow | undefined;
}

async function orchestrateOnePlan(params: {
  projectDb: Database.Database;
  plan: EligiblePlanRow;
  output: { raw: string; normalized: string; sha256: string };
}): Promise<void> {
  const { projectDb, plan, output } = params;
  const state = getState(projectDb, plan.id);
  if (state?.last_approved_output_sha256 === output.sha256) {
    return;
  }

  const livePlan = latestPlanTask(projectDb, plan.id);
  if (!livePlan || livePlan.status !== "waiting_input" || !livePlan.auto_start) {
    return;
  }

  let proposedRevision = latestRevisionWithStatus(projectDb, plan.id, "proposed");
  let approvedRevision = latestRevisionWithStatus(projectDb, plan.id, "approved");

  if (!proposedRevision) {
    if (state?.last_failed_output_sha256 && state.last_failed_output_sha256 !== output.sha256) {
      recordEvent({
        projectId: plan.project_id,
        taskId: plan.id,
        eventType: "plan.orchestration.retry.started",
        payload: {
          previousFailedOutputSha256: state.last_failed_output_sha256,
          outputSha256: output.sha256,
          lastError: state.last_error,
          lastErrorAt: state.last_error_at
        },
        database: projectDb
      });
    }
    if (approvedRevision && sha256Text(normalizedPlanText(approvedRevision.raw_output)) === output.sha256) {
      markApproval(projectDb, plan.id, output.sha256, approvedRevision.id);
      return;
    }
    if (state?.last_failed_output_sha256 === output.sha256) {
      return;
    }

    try {
      const extracted = await extractPlan({
        userId: plan.created_by_user_id,
        planId: plan.id
      });
      markExtraction(projectDb, plan.id, output.sha256, extracted.revisionId);
      recordEvent({
        projectId: plan.project_id,
        taskId: plan.id,
        eventType: "plan.orchestration.auto_extract.succeeded",
        payload: {
          revisionId: extracted.revisionId,
          revisionNumber: extracted.revisionNumber,
          outputSha256: output.sha256
        },
        database: projectDb
      });
    } catch (error: any) {
      const message = String(error?.message ?? "plan extraction failed");
      markOrchestrationFailure(projectDb, plan.id, output.sha256, message);
      recordEvent({
        projectId: plan.project_id,
        taskId: plan.id,
        eventType: "plan.orchestration.auto_extract.failed",
        payload: { outputSha256: output.sha256, error: message },
        database: projectDb
      });
      return;
    }

    proposedRevision = latestRevisionWithStatus(projectDb, plan.id, "proposed");
    approvedRevision = latestRevisionWithStatus(projectDb, plan.id, "approved");
  }

  if (proposedRevision) {
    try {
      await approvePlan({
        userId: plan.created_by_user_id,
        planId: plan.id
      });
    } catch (error: any) {
      const message = String(error?.message ?? "plan approval failed");
      markOrchestrationFailure(projectDb, plan.id, output.sha256, message);
      recordEvent({
        projectId: plan.project_id,
        taskId: plan.id,
        eventType: "plan.orchestration.auto_approve.failed",
        payload: { outputSha256: output.sha256, error: message },
        database: projectDb
      });
      return;
    }
  }

  approvedRevision = latestRevisionWithStatus(projectDb, plan.id, "approved");
  if (approvedRevision && sha256Text(normalizedPlanText(approvedRevision.raw_output)) === output.sha256) {
    markApproval(projectDb, plan.id, output.sha256, approvedRevision.id);
    recordEvent({
      projectId: plan.project_id,
      taskId: plan.id,
      eventType: "plan.orchestration.auto_approve.succeeded",
      payload: {
        revisionId: approvedRevision.id,
        revisionNumber: approvedRevision.revision_number,
        outputSha256: output.sha256
      },
      database: projectDb
    });
  }
}

async function processPlanOrchestrationPass(): Promise<void> {
  const projects = appDb
    .prepare("SELECT id, base_path FROM projects ORDER BY created_at ASC")
    .all() as Array<{ id: string; base_path: string }>;

  const candidates: Array<{
    projectId: string;
    basePath: string;
    plan: EligiblePlanRow;
    output: { raw: string; normalized: string; sha256: string };
  }> = [];

  for (const project of projects) {
    const scoped = resolveProjectDatabase({
      appDb,
      projectId: project.id,
      basePath: project.base_path,
      intent: "write"
    });
    const rows = scoped.database
      .prepare(
        `SELECT id, project_id, workspace_path, created_by_user_id
         FROM tasks
         WHERE project_id = ?
           AND mode = 'plan'
           AND auto_start = 1
           AND status = 'waiting_input'
         ORDER BY created_at ASC`
      )
      .all(project.id) as EligiblePlanRow[];
    for (const row of rows) {
      const output = readPlanFile(row.workspace_path);
      if (!output) {
        continue;
      }
      candidates.push({
        projectId: project.id,
        basePath: project.base_path,
        plan: row,
        output
      });
    }
  }

  if (!candidates.length) {
    return;
  }

  candidates.sort((a, b) => a.plan.id.localeCompare(b.plan.id));
  const selected = candidates.slice(0, MAX_PLANS_PER_PASS);

  await Promise.allSettled(
    selected.map(async (candidate) => {
      const scoped = resolveProjectDatabase({
        appDb,
        projectId: candidate.projectId,
        basePath: candidate.basePath,
        intent: "write"
      });
      const lockToken = randomUUID();
      if (!claimPlanLock(scoped.database, candidate.plan.id, lockToken)) {
        return;
      }
      try {
        await orchestrateOnePlan({
          projectDb: scoped.database,
          plan: candidate.plan,
          output: candidate.output
        });
      } finally {
        releasePlanLock(scoped.database, candidate.plan.id, lockToken);
      }
    })
  );
}

async function runPlanOrchestrationPass(): Promise<void> {
  if (running) {
    return;
  }
  running = true;
  try {
    await processPlanOrchestrationPass();
  } finally {
    running = false;
  }
}

export function kickPlanOrchestrationProcessing(): void {
  const projects = appDb
    .prepare("SELECT id, base_path FROM projects ORDER BY created_at ASC")
    .all() as Array<{ id: string; base_path: string }>;
  for (const project of projects) {
    const scoped = resolveProjectDatabase({
      appDb,
      projectId: project.id,
      basePath: project.base_path,
      intent: "write"
    });
    enqueueOrchestrationJob({
      projectId: project.id,
      jobType: PLAN_ORCHESTRATION_JOB_TYPE,
      idempotencyKey: `${PLAN_ORCHESTRATION_IDEMPOTENCY_KEY}:${project.id}`,
      debounceMs: 400,
      dedupeWindowMs: 2_500,
      database: scoped.database
    });
  }
  kickOrchestrationJobQueueProcessing();
}

export function startPlanOrchestrationWorker(): void {
  if (!planJobRegistered) {
    registerOrchestrationJobHandler(PLAN_ORCHESTRATION_JOB_TYPE, async () => {
      await runPlanOrchestrationPass();
    });
    planJobRegistered = true;
  }
  kickPlanOrchestrationProcessing();
}

export async function runPlanOrchestrationPassForTests(): Promise<void> {
  await runPlanOrchestrationPass();
}
