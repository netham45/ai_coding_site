import { createHash } from "node:crypto";

export type OrchestrationHookName =
  | "on_node_created"
  | "on_child_attached"
  | "on_dependency_added"
  | "on_status_changed"
  | "on_node_output_updated"
  | "on_merge_completed"
  | "on_merge_failed"
  | "on_timer_tick";

export type OrchestrationJobRequest = {
  jobType: "task_queue_dispatch" | "plan_orchestration_pass" | "evaluate_readiness" | "decompose";
  idempotencyKey: string;
  debounceMs?: number;
  dedupeWindowMs?: number;
  projectId?: string | null;
  taskId?: string | null;
  payload?: Record<string, unknown>;
};

type EventContext = {
  eventType: string;
  projectId?: string | null;
  taskId?: string | null;
  payload?: unknown;
};

const DEFAULT_DEBOUNCE_MS = 600;
const DEFAULT_DEDUPE_WINDOW_MS = 3_000;
const TIMER_TICK_DEBOUNCE_MS = 1_000;
const TIMER_TICK_DEDUPE_MS = 8_000;
const OUTPUT_UPDATE_DEBOUNCE_MS = 1_500;
const OUTPUT_UPDATE_DEDUPE_MS = 6_000;

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stableValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function buildKey(seed: string, context: EventContext): string {
  return digest(
    [
      seed,
      context.projectId ?? "global",
      context.taskId ?? "",
      context.eventType,
      stableValue(context.payload)
    ].join("|")
  );
}

function jobsForHook(hookName: OrchestrationHookName, context: EventContext): OrchestrationJobRequest[] {
  const taskScopedJobs: OrchestrationJobRequest[] =
    context.taskId && context.projectId
      ? [
          {
            jobType: "evaluate_readiness",
            idempotencyKey: buildKey(`hook:${hookName}:readiness`, context),
            debounceMs: DEFAULT_DEBOUNCE_MS,
            dedupeWindowMs: DEFAULT_DEDUPE_WINDOW_MS,
            projectId: context.projectId,
            taskId: context.taskId,
            payload: { hookName, eventType: context.eventType }
          }
        ]
      : [];

  if (hookName === "on_node_created" && context.taskId && context.projectId) {
    taskScopedJobs.push({
      jobType: "decompose",
      idempotencyKey: buildKey(`hook:${hookName}:decompose`, context),
      debounceMs: DEFAULT_DEBOUNCE_MS,
      dedupeWindowMs: DEFAULT_DEDUPE_WINDOW_MS,
      projectId: context.projectId,
      taskId: context.taskId,
      payload: { hookName, eventType: context.eventType, autoMode: true }
    });
  }

  if (hookName === "on_timer_tick") {
    return [
      {
        jobType: "task_queue_dispatch",
        idempotencyKey: buildKey("timer:task", context),
        debounceMs: TIMER_TICK_DEBOUNCE_MS,
        dedupeWindowMs: TIMER_TICK_DEDUPE_MS,
        projectId: context.projectId ?? null,
        taskId: context.taskId ?? null,
        payload: { hookName, eventType: context.eventType }
      },
      {
        jobType: "plan_orchestration_pass",
        idempotencyKey: buildKey("timer:plan", context),
        debounceMs: TIMER_TICK_DEBOUNCE_MS,
        dedupeWindowMs: TIMER_TICK_DEDUPE_MS,
        projectId: context.projectId ?? null,
        taskId: context.taskId ?? null,
        payload: { hookName, eventType: context.eventType }
      },
      ...taskScopedJobs
    ];
  }

  if (hookName === "on_node_output_updated") {
    const payloadObj = (context.payload && typeof context.payload === "object" ? (context.payload as Record<string, unknown>) : null) ?? {};
    const outputHash = typeof payloadObj.outputHash === "string" ? payloadObj.outputHash : stableValue(context.payload);
    const source = typeof payloadObj.source === "string" ? payloadObj.source : "unknown";
    return [
      {
        jobType: "task_queue_dispatch",
        idempotencyKey: buildKey(`hook:${hookName}:task:${source}:${outputHash}`, context),
        debounceMs: OUTPUT_UPDATE_DEBOUNCE_MS,
        dedupeWindowMs: OUTPUT_UPDATE_DEDUPE_MS,
        projectId: context.projectId ?? null,
        taskId: context.taskId ?? null,
        payload: { hookName, eventType: context.eventType, outputHash, source }
      },
      {
        jobType: "plan_orchestration_pass",
        idempotencyKey: buildKey(`hook:${hookName}:plan:${source}:${outputHash}`, context),
        debounceMs: OUTPUT_UPDATE_DEBOUNCE_MS,
        dedupeWindowMs: OUTPUT_UPDATE_DEDUPE_MS,
        projectId: context.projectId ?? null,
        taskId: context.taskId ?? null,
        payload: { hookName, eventType: context.eventType, outputHash, source }
      }
    ];
  }

  return [
    {
      jobType: "task_queue_dispatch",
      idempotencyKey: buildKey(`hook:${hookName}:task`, context),
      debounceMs: DEFAULT_DEBOUNCE_MS,
      dedupeWindowMs: DEFAULT_DEDUPE_WINDOW_MS,
      projectId: context.projectId ?? null,
      taskId: context.taskId ?? null,
      payload: { hookName, eventType: context.eventType }
    },
    {
      jobType: "plan_orchestration_pass",
      idempotencyKey: buildKey(`hook:${hookName}:plan`, context),
      debounceMs: DEFAULT_DEBOUNCE_MS,
      dedupeWindowMs: DEFAULT_DEDUPE_WINDOW_MS,
      projectId: context.projectId ?? null,
      taskId: context.taskId ?? null,
      payload: { hookName, eventType: context.eventType }
    },
    ...taskScopedJobs
  ];
}

function mapEventToHooks(eventType: string): OrchestrationHookName[] {
  if (eventType.startsWith("orchestration.job.")) return [];
  if (eventType === "orchestration.timer.tick") return ["on_timer_tick"];
  if (eventType === "task.created" || eventType === "plan.created") return ["on_node_created"];
  if (eventType === "plan.approved") return ["on_child_attached", "on_dependency_added"];
  if (eventType === "task.status_changed") return ["on_status_changed"];
  if (
    eventType === "task.summary.captured" ||
    eventType === "plan.revision.extracted" ||
    eventType === "task.output.material_changed"
  ) {
    return ["on_node_output_updated"];
  }
  if (eventType === "task.merged" || eventType === "plan.merged" || eventType === "task.auto_merge.merged") {
    return ["on_merge_completed"];
  }
  if (
    eventType === "task.merge_conflict" ||
    eventType === "plan.merge_conflict" ||
    eventType === "task.auto_merge.failed" ||
    eventType === "plan.auto_merge_on_complete.failed"
  ) {
    return ["on_merge_failed"];
  }
  return [];
}

export function deriveOrchestrationJobsFromEvent(context: EventContext): OrchestrationJobRequest[] {
  const hooks = mapEventToHooks(context.eventType);
  if (!hooks.length) return [];
  const out: OrchestrationJobRequest[] = [];
  for (const hookName of hooks) {
    out.push(...jobsForHook(hookName, context));
  }
  return out;
}
