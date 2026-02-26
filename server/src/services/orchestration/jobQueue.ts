import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { db as appDb, resolveProjectDatabase } from "../../db/index.js";
import { runInKeyedAsyncWorker } from "../asyncWorker.js";
import { nowIso } from "../../utils/time.js";

const JOB_EVENT_TYPE = "orchestration.job.pending";
const JOB_DONE_EVENT_TYPE = "orchestration.job.completed";
const JOB_POLL_INTERVAL_MS = 1_000;
const JOB_TIMER_TICK_MS = 10_000;
const MAX_JOBS_PER_PROJECT_PASS = 32;

export type OrchestrationJobType =
  | "task_queue_dispatch"
  | "plan_orchestration_pass"
  | "evaluate_readiness"
  | "decompose"
  | "re_review"
  | "delta_plan"
  | "synthesize"
  | "verify";

type PendingJobPayload = {
  schemaVersion: 1;
  jobType: OrchestrationJobType;
  idempotencyKey: string;
  dedupeWindowMs: number;
  debounceMs: number;
  bucketStartMs: number;
  enqueuedAt: string;
  notBefore: string;
  hintProjectId?: string | null;
  hintTaskId?: string | null;
  metadata?: Record<string, unknown>;
};

type PendingJobEventRow = {
  id: string;
  project_id: string | null;
  task_id: string | null;
  payload: string;
  created_at: string;
};

type JobHandlerContext = {
  projectId: string;
  basePath: string;
  projectDb: Database.Database;
  pendingEventId: string;
  payload: PendingJobPayload;
};

type JobHandler = (context: JobHandlerContext) => Promise<void>;

const jobHandlers = new Map<OrchestrationJobType, JobHandler>();
const processedPassEvents = new Set<string>();
let running = false;
let pollInterval: NodeJS.Timeout | null = null;
let timerTickInterval: NodeJS.Timeout | null = null;

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function eventIdForPendingJob(params: { jobType: OrchestrationJobType; idempotencyKey: string; bucketStartMs: number }): string {
  return digest(`orchestration.job.pending|${params.jobType}|${params.idempotencyKey}|${params.bucketStartMs}`);
}

function eventIdForCompletedJob(pendingEventId: string): string {
  return digest(`orchestration.job.completed|${pendingEventId}`);
}

function parsePendingPayload(raw: string): PendingJobPayload | null {
  try {
    const parsed = JSON.parse(raw) as PendingJobPayload;
    if (!parsed || parsed.schemaVersion !== 1) return null;
    if (!parsed.jobType || !parsed.idempotencyKey || !parsed.notBefore) return null;
    return parsed;
  } catch {
    return null;
  }
}

function completedEventExists(projectDb: Database.Database, pendingEventId: string): boolean {
  const row = projectDb
    .prepare("SELECT id FROM events WHERE id = ? LIMIT 1")
    .get(eventIdForCompletedJob(pendingEventId)) as { id: string } | undefined;
  return Boolean(row?.id);
}

function markCompleted(params: {
  projectDb: Database.Database;
  pendingEventId: string;
  projectId: string | null;
  taskId: string | null;
  status: "succeeded" | "failed" | "skipped";
  message?: string;
}): void {
  const payload = {
    pendingEventId: params.pendingEventId,
    status: params.status,
    message: params.message ?? null,
    completedAt: nowIso()
  };
  params.projectDb
    .prepare(
      `INSERT OR IGNORE INTO events (id, project_id, task_id, session_id, event_type, payload, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?)`
    )
    .run(
      eventIdForCompletedJob(params.pendingEventId),
      params.projectId,
      params.taskId,
      JOB_DONE_EVENT_TYPE,
      JSON.stringify(payload),
      nowIso()
    );
  params.projectDb.prepare("DELETE FROM events WHERE id = ?").run(params.pendingEventId);
}

export function registerOrchestrationJobHandler(jobType: OrchestrationJobType, handler: JobHandler): void {
  jobHandlers.set(jobType, handler);
}

export function enqueueOrchestrationJob(params: {
  projectId?: string | null;
  taskId?: string | null;
  jobType: OrchestrationJobType;
  idempotencyKey: string;
  debounceMs?: number;
  dedupeWindowMs?: number;
  metadata?: Record<string, unknown>;
  database?: Database.Database;
}): { pendingEventId: string } {
  const projectDb = params.database ?? appDb;
  const dedupeWindowMs = Math.max(250, params.dedupeWindowMs ?? 2_000);
  const debounceMs = Math.max(0, params.debounceMs ?? 500);
  const now = Date.now();
  const bucketStartMs = Math.floor(now / dedupeWindowMs) * dedupeWindowMs;
  const pendingEventId = eventIdForPendingJob({
    jobType: params.jobType,
    idempotencyKey: params.idempotencyKey,
    bucketStartMs
  });

  const payload: PendingJobPayload = {
    schemaVersion: 1,
    jobType: params.jobType,
    idempotencyKey: params.idempotencyKey,
    dedupeWindowMs,
    debounceMs,
    bucketStartMs,
    enqueuedAt: new Date(now).toISOString(),
    notBefore: new Date(now + debounceMs).toISOString(),
    hintProjectId: params.projectId ?? null,
    hintTaskId: params.taskId ?? null,
    metadata: params.metadata
  };

  projectDb
    .prepare(
      `INSERT INTO events (id, project_id, task_id, session_id, event_type, payload, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         payload = excluded.payload,
         created_at = excluded.created_at`
    )
    .run(
      pendingEventId,
      params.projectId ?? null,
      params.taskId ?? null,
      JOB_EVENT_TYPE,
      JSON.stringify(payload),
      nowIso()
    );

  return { pendingEventId };
}

async function processProjectJobs(params: { projectId: string; basePath: string }): Promise<void> {
  const scoped = resolveProjectDatabase({
    appDb,
    projectId: params.projectId,
    basePath: params.basePath,
    intent: "write"
  });
  const projectDb = scoped.database;
  const pendingRows = projectDb
    .prepare(
      `SELECT id, project_id, task_id, payload, created_at
       FROM events
       WHERE event_type = ?
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(JOB_EVENT_TYPE, MAX_JOBS_PER_PROJECT_PASS) as PendingJobEventRow[];

  for (const row of pendingRows) {
    if (processedPassEvents.has(row.id)) continue;
    processedPassEvents.add(row.id);
    const payload = parsePendingPayload(row.payload);
    if (!payload) {
      markCompleted({
        projectDb,
        pendingEventId: row.id,
        projectId: row.project_id,
        taskId: row.task_id,
        status: "skipped",
        message: "invalid payload"
      });
      continue;
    }
    if (completedEventExists(projectDb, row.id)) {
      continue;
    }
    if (Date.parse(payload.notBefore) > Date.now()) {
      continue;
    }

    const handler = jobHandlers.get(payload.jobType);
    if (!handler) {
      markCompleted({
        projectDb,
        pendingEventId: row.id,
        projectId: row.project_id,
        taskId: row.task_id,
        status: "skipped",
        message: `no handler for ${payload.jobType}`
      });
      continue;
    }

    await runInKeyedAsyncWorker(`orchestration-job:${row.id}`, async () => {
      try {
        await handler({
          projectId: params.projectId,
          basePath: params.basePath,
          projectDb,
          pendingEventId: row.id,
          payload
        });
        markCompleted({
          projectDb,
          pendingEventId: row.id,
          projectId: row.project_id,
          taskId: row.task_id,
          status: "succeeded"
        });
      } catch (error: any) {
        markCompleted({
          projectDb,
          pendingEventId: row.id,
          projectId: row.project_id,
          taskId: row.task_id,
          status: "failed",
          message: String(error?.message ?? "orchestration job failed")
        });
      }
    });
  }
}

async function processJobsPass(): Promise<void> {
  const projects = appDb
    .prepare("SELECT id, base_path FROM projects ORDER BY created_at ASC")
    .all() as Array<{ id: string; base_path: string }>;

  await Promise.allSettled(
    projects.map((project) =>
      processProjectJobs({
        projectId: project.id,
        basePath: project.base_path
      })
    )
  );
}

async function runJobQueuePass(): Promise<void> {
  if (running) return;
  running = true;
  processedPassEvents.clear();
  try {
    await processJobsPass();
  } finally {
    running = false;
  }
}

export function kickOrchestrationJobQueueProcessing(): void {
  void runJobQueuePass();
}

export function startOrchestrationJobQueueWorker(): void {
  if (pollInterval) return;

  void runJobQueuePass();
  pollInterval = setInterval(() => {
    void runJobQueuePass();
  }, JOB_POLL_INTERVAL_MS);

  timerTickInterval = setInterval(() => {
    const timerBucket = Math.floor(Date.now() / JOB_TIMER_TICK_MS);
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
        jobType: "task_queue_dispatch",
        idempotencyKey: `timer_tick:task_queue:${project.id}:${timerBucket}`,
        debounceMs: 1_000,
        dedupeWindowMs: JOB_TIMER_TICK_MS,
        metadata: { hookName: "on_timer_tick", timerBucket },
        database: scoped.database
      });
      enqueueOrchestrationJob({
        projectId: project.id,
        jobType: "plan_orchestration_pass",
        idempotencyKey: `timer_tick:plan_orchestrator:${project.id}:${timerBucket}`,
        debounceMs: 1_000,
        dedupeWindowMs: JOB_TIMER_TICK_MS,
        metadata: { hookName: "on_timer_tick", timerBucket },
        database: scoped.database
      });
    }
    void runJobQueuePass();
  }, JOB_TIMER_TICK_MS);
}

export async function runOrchestrationJobQueuePassForTests(): Promise<void> {
  await runJobQueuePass();
}

export function resetOrchestrationJobQueueForTests(): void {
  running = false;
  processedPassEvents.clear();
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (timerTickInterval) {
    clearInterval(timerTickInterval);
    timerTickInterval = null;
  }
  jobHandlers.clear();
}
