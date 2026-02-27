import type Database from "better-sqlite3";
import type { TaskMode, TaskRow, TaskStatus } from "../../types.js";

export type LifecycleState = "draft" | "ready" | "blocked" | "running" | "complete" | "failed" | "canceled";

export type TransitionGuardCode =
  | "invalid_transition"
  | "blocked_dependencies"
  | "blocked_children"
  | "parent_synthesis_required"
  | "parent_verification_required";

type ParentCompletionGuardState = {
  synthesisPassed: boolean;
  verificationPassed: boolean;
};

type TransitionDecision = {
  fromLifecycle: LifecycleState;
  toLifecycle: LifecycleState;
  allowed: boolean;
  code: TransitionGuardCode | null;
  message: string | null;
};

const ALLOWED_LIFECYCLE_TRANSITIONS: Record<LifecycleState, ReadonlySet<LifecycleState>> = {
  draft: new Set<LifecycleState>(["ready", "blocked", "running", "failed", "canceled"]),
  ready: new Set<LifecycleState>(["blocked", "running", "failed", "canceled"]),
  blocked: new Set<LifecycleState>(["ready", "running", "complete", "failed", "canceled"]),
  running: new Set<LifecycleState>(["ready", "blocked", "complete", "failed", "canceled"]),
  complete: new Set<LifecycleState>(["complete"]),
  failed: new Set<LifecycleState>(["ready", "blocked", "running", "canceled"]),
  canceled: new Set<LifecycleState>(["ready", "blocked"])
};

export function canTransitionLifecycle(from: LifecycleState, to: LifecycleState): boolean {
  return ALLOWED_LIFECYCLE_TRANSITIONS[from]?.has(to) ?? false;
}

function readMetadataLifecycleFlags(metadataJson: string | null | undefined): ParentCompletionGuardState {
  if (!metadataJson || !metadataJson.trim()) {
    return { synthesisPassed: false, verificationPassed: false };
  }
  try {
    const parsed = JSON.parse(metadataJson) as { lifecycle?: { synthesis_passed?: unknown; verification_passed?: unknown } };
    return {
      synthesisPassed: Boolean(parsed?.lifecycle?.synthesis_passed),
      verificationPassed: Boolean(parsed?.lifecycle?.verification_passed)
    };
  } catch {
    return { synthesisPassed: false, verificationPassed: false };
  }
}

export function legacyStatusToLifecycle(
  status: TaskStatus,
  options?: {
    hasBlockingDependencies?: boolean;
    hasPendingChildren?: boolean;
  }
): LifecycleState {
  switch (status) {
    case "queued":
      return options?.hasBlockingDependencies || options?.hasPendingChildren ? "blocked" : "ready";
    case "in_progress":
      return "running";
    case "waiting_input":
      return "blocked";
    case "awaiting_children":
      return "blocked";
    case "merge_ready":
      return "complete";
    case "merged":
      return "complete";
    case "failed":
      return "failed";
    case "merge_conflict":
      return "failed";
    case "cancelled":
      return "canceled";
    default: {
      const neverValue: never = status;
      throw new Error(`Unknown task status: ${String(neverValue)}`);
    }
  }
}

export function evaluateParentCompletionGuards(projectDb: Database.Database, task: Pick<TaskRow, "id" | "mode" | "metadata_json">): ParentCompletionGuardState {
  if (task.mode !== "plan") {
    return { synthesisPassed: true, verificationPassed: true };
  }
  const metadataFlags = readMetadataLifecycleFlags(task.metadata_json);
  if (metadataFlags.synthesisPassed && metadataFlags.verificationPassed) {
    return metadataFlags;
  }

  const revisionRows = projectDb
    .prepare("SELECT status FROM plan_revisions WHERE plan_task_id = ?")
    .all(task.id) as Array<{ status: string }>;
  const synthesizedFromRevisions = revisionRows.some((row) =>
    row.status === "proposed" || row.status === "approved" || row.status === "superseded" || row.status === "feedback_requested"
  );
  const verifiedFromRevisions = revisionRows.some((row) => row.status === "approved");
  return {
    synthesisPassed: metadataFlags.synthesisPassed || synthesizedFromRevisions,
    verificationPassed: metadataFlags.verificationPassed || verifiedFromRevisions
  };
}

function evaluateTransition(params: {
  mode: TaskMode;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  hasBlockingDependencies: boolean;
  hasPendingChildren: boolean;
  parentGuards: ParentCompletionGuardState;
}): TransitionDecision {
  const fromLifecycle = legacyStatusToLifecycle(params.fromStatus, {
    hasBlockingDependencies: params.hasBlockingDependencies,
    hasPendingChildren: params.hasPendingChildren
  });
  const toLifecycle = legacyStatusToLifecycle(params.toStatus, {
    hasBlockingDependencies: params.hasBlockingDependencies,
    hasPendingChildren: params.hasPendingChildren
  });

  if (params.fromStatus === params.toStatus) {
    return { fromLifecycle, toLifecycle, allowed: true, code: null, message: null };
  }
  if (params.fromStatus === "merge_ready" && params.toStatus === "merge_conflict") {
    return { fromLifecycle, toLifecycle, allowed: true, code: null, message: null };
  }
  if (params.fromStatus === "merge_conflict" && params.toStatus === "merge_ready") {
    return { fromLifecycle, toLifecycle, allowed: true, code: null, message: null };
  }
  if (fromLifecycle === toLifecycle) {
    return { fromLifecycle, toLifecycle, allowed: true, code: null, message: null };
  }

  const allowed = ALLOWED_LIFECYCLE_TRANSITIONS[fromLifecycle]?.has(toLifecycle) ?? false;
  if (!allowed) {
    return {
      fromLifecycle,
      toLifecycle,
      allowed: false,
      code: "invalid_transition",
      message: `Illegal transition: ${params.fromStatus} (${fromLifecycle}) -> ${params.toStatus} (${toLifecycle})`
    };
  }

  if (params.toStatus === "in_progress" && params.hasBlockingDependencies) {
    return {
      fromLifecycle,
      toLifecycle,
      allowed: false,
      code: "blocked_dependencies",
      message: "Task cannot enter running state while dependencies are unresolved"
    };
  }

  if ((params.toStatus === "merge_ready" || params.toStatus === "merged") && params.hasBlockingDependencies) {
    return {
      fromLifecycle,
      toLifecycle,
      allowed: false,
      code: "blocked_dependencies",
      message: "Task cannot complete while dependencies are unresolved"
    };
  }

  if (params.mode === "plan" && (params.toStatus === "merge_ready" || params.toStatus === "merged")) {
    if (params.hasPendingChildren) {
      return {
        fromLifecycle,
        toLifecycle,
        allowed: false,
        code: "blocked_children",
        message: "Plan cannot complete while child tasks are still unmerged"
      };
    }
    if (!params.parentGuards.synthesisPassed) {
      return {
        fromLifecycle,
        toLifecycle,
        allowed: false,
        code: "parent_synthesis_required",
        message: "Parent completion requires a successful synthesis pass"
      };
    }
    if (!params.parentGuards.verificationPassed) {
      return {
        fromLifecycle,
        toLifecycle,
        allowed: false,
        code: "parent_verification_required",
        message: "Parent completion requires a successful verification pass"
      };
    }
  }

  return { fromLifecycle, toLifecycle, allowed: true, code: null, message: null };
}

export function assertTaskStatusTransition(params: {
  mode: TaskMode;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  hasBlockingDependencies: boolean;
  hasPendingChildren: boolean;
  parentGuards: ParentCompletionGuardState;
}): { fromLifecycle: LifecycleState; toLifecycle: LifecycleState } {
  const decision = evaluateTransition(params);
  if (!decision.allowed) {
    const code = decision.code ?? "invalid_transition";
    throw new Error(`${code}: ${decision.message ?? "illegal transition"}`);
  }
  return {
    fromLifecycle: decision.fromLifecycle,
    toLifecycle: decision.toLifecycle
  };
}
