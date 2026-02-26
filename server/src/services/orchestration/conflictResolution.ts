import type { TaskRow } from "../../types.js";

export const INTENT_PRESERVING_CONFLICT_PROMPT_PATH = "prompts/intent-preserving-conflict-resolution.md";

export type MergeGateCheckCode =
  | "task_status_merge_ready"
  | "dependencies_merged"
  | "workspace_clean"
  | "plan_children_merged"
  | "plan_synthesis_passed"
  | "plan_verification_passed";

export type MergeGateCheck = {
  code: MergeGateCheckCode;
  required: boolean;
  passed: boolean;
  detail: string;
};

export type ParentCompletionGuardState = {
  synthesisPassed: boolean;
  verificationPassed: boolean;
};

export type ConflictResolutionArtifact = {
  prompt_template_path: string;
  inputs: {
    parent_spec: string;
    child_spec: string;
    conflicting_hunks: Array<{ file: string; summary: string }>;
    verification_constraints: string[];
    merge_context: Record<string, string | null>;
  };
  conflict_resolution: {
    patch_plan: Array<{
      file: string;
      strategy: string;
      intent_justification: string;
      verification: string[];
    }>;
    intent_justification: string;
    merge_gate_checklist: MergeGateCheck[];
    unresolved_conflicts: Array<{ file: string; reason: string }>;
    escalation: {
      required: boolean;
      reason: string;
      retry_policy: {
        mode: "manual_fix_then_retry";
        max_attempts: number;
      };
    };
  };
};

function compact(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .slice(0, 500);
}

function summarizeTaskSpec(task: TaskRow | undefined, fallbackLabel: string): string {
  if (!task) return `${fallbackLabel}: unavailable`;
  const prompt = compact(task.task_prompt);
  const result = compact(task.result);
  const lines = [`title=${task.title || "(untitled)"}`, `mode=${task.mode}`];
  if (prompt) lines.push(`prompt=${prompt}`);
  if (result) lines.push(`result=${result}`);
  return lines.join(" | ");
}

export function buildMergeGateChecklist(params: {
  task: Pick<TaskRow, "mode" | "status">;
  hasBlockingDependencies: boolean;
  hasPendingChildren: boolean;
  workspaceClean: boolean;
  parentGuards: ParentCompletionGuardState;
}): MergeGateCheck[] {
  const checks: MergeGateCheck[] = [
    {
      code: "task_status_merge_ready",
      required: true,
      passed: params.task.status === "merge_ready",
      detail: "Node must be merge_ready before merge."
    },
    {
      code: "dependencies_merged",
      required: true,
      passed: !params.hasBlockingDependencies,
      detail: "All declared dependencies must be merged."
    },
    {
      code: "workspace_clean",
      required: true,
      passed: params.workspaceClean,
      detail: "Workspace must have no untracked, staged, unstaged, or conflicted files."
    },
    {
      code: "plan_children_merged",
      required: params.task.mode === "plan",
      passed: params.task.mode !== "plan" || !params.hasPendingChildren,
      detail: "Plan children must be merged before parent merge."
    },
    {
      code: "plan_synthesis_passed",
      required: params.task.mode === "plan",
      passed: params.task.mode !== "plan" || params.parentGuards.synthesisPassed,
      detail: "Plan merge requires synthesis pass."
    },
    {
      code: "plan_verification_passed",
      required: params.task.mode === "plan",
      passed: params.task.mode !== "plan" || params.parentGuards.verificationPassed,
      detail: "Plan merge requires verification pass."
    }
  ];
  return checks;
}

export function requiredMergeGatesPassed(checklist: MergeGateCheck[]): boolean {
  return checklist.every((check) => !check.required || check.passed);
}

export function describeFailedMergeGates(checklist: MergeGateCheck[]): string {
  const failed = checklist.filter((check) => check.required && !check.passed);
  if (!failed.length) return "";
  return failed.map((check) => `${check.code}: ${check.detail}`).join("; ");
}

export function buildConflictResolutionArtifact(params: {
  task: TaskRow;
  parentTask?: TaskRow;
  conflictFiles: string[];
  mergeGateChecklist: MergeGateCheck[];
  mergeTargetBranch: string;
  sourceCommitSha: string;
  targetBaseCommitSha: string;
}): ConflictResolutionArtifact {
  const verificationConstraints = params.mergeGateChecklist
    .filter((check) => check.required)
    .map((check) => `${check.code}=${check.passed ? "pass" : "fail"}`);
  const patchPlanFiles = params.conflictFiles.length > 0 ? params.conflictFiles : ["(unknown)"];
  const unresolvedConflicts = patchPlanFiles.map((file) => ({
    file,
    reason: "Manual intent-preserving reconciliation required before retry."
  }));

  return {
    prompt_template_path: INTENT_PRESERVING_CONFLICT_PROMPT_PATH,
    inputs: {
      parent_spec: summarizeTaskSpec(params.parentTask, "parent_spec"),
      child_spec: summarizeTaskSpec(params.task, "child_spec"),
      conflicting_hunks: patchPlanFiles.map((file) => ({
        file,
        summary: "Conflict detected during merge attempt; preserve parent and child intent while restoring invariants."
      })),
      verification_constraints: verificationConstraints,
      merge_context: {
        task_id: params.task.id,
        task_mode: params.task.mode,
        merge_target_branch: params.mergeTargetBranch,
        source_commit_sha: params.sourceCommitSha,
        target_base_commit_sha: params.targetBaseCommitSha
      }
    },
    conflict_resolution: {
      patch_plan: patchPlanFiles.map((file) => ({
        file,
        strategy: "Reconcile conflicting hunks by keeping parent invariants and preserving child stage intent.",
        intent_justification:
          "Plan maintains parent contract while retaining child-delivered behavior, then re-validates merge gates.",
        verification: [
          "Re-run required checks/tests for touched files.",
          "Confirm no unresolved merge markers remain.",
          "Re-attempt merge only after all merge gates pass."
        ]
      })),
      intent_justification:
        "Escalate conflicts to manual resolution when deterministic auto-preservation cannot be proven safely.",
      merge_gate_checklist: params.mergeGateChecklist,
      unresolved_conflicts: unresolvedConflicts,
      escalation: {
        required: true,
        reason: "Automatic resolution was not attempted to avoid violating parent or child intent.",
        retry_policy: {
          mode: "manual_fix_then_retry",
          max_attempts: 3
        }
      }
    }
  };
}
