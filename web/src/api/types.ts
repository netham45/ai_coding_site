export type Project = {
  id: string;
  name: string;
  slug: string;
  repoUrl: string;
  defaultBranch: string;
  basePath: string;
  projectPrompt: string;
  projectRules: string;
  codingStandard: string;
  codingStandardOther: string;
  projectOther: string;
  cloneStatus: "pending" | "cloning" | "ready" | "failed";
  cloneError: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskStatus =
  | "queued"
  | "in_progress"
  | "waiting_input"
  | "awaiting_children"
  | "merge_ready"
  | "merged"
  | "cancelled"
  | "failed"
  | "merge_conflict";

export type TaskMode = "execution" | "plan";

export type CompletionEvidence = {
  child_task_id: string;
  artifact_ref: string;
  snippet: string;
  repo_path: string | null;
  module_ref: string | null;
  test_ref: string | null;
};

export type CompletionCoverageRow = {
  requirement_id: string;
  requirement_text: string;
  coverage_status: "covered" | "partial" | "uncovered";
  evidence: CompletionEvidence[];
  gap_reason: string | null;
};

export type SynthesisArtifact = {
  template: { id: string; path: string };
  summary: string;
  coverage_matrix: CompletionCoverageRow[];
  uncovered_requirements: string[];
  generated_at: string;
};

export type VerificationArtifact = {
  template: { id: string; path: string };
  verdict: "pass" | "fail";
  failing_requirements: string[];
  reasons: string[];
  delta_plan_enqueued: boolean;
  budget_exhausted: boolean;
  generated_at: string;
};

export type DeltaLoopHistoryEntry = {
  generated_at: string;
  verdict: "pass" | "fail";
  reasons: string[];
  failing_requirements: string[];
  delta_plan_enqueued: boolean;
  budget_exhausted: boolean;
  verification_artifact_event_id: string;
  synthesis_artifact_event_id?: string;
};

export type CompletionSummary = {
  synthesisArtifactEventId: string | null;
  verificationArtifactEventId: string | null;
  verificationVerdict: "pass" | "fail" | null;
  summary: string | null;
  synthesisArtifact: SynthesisArtifact | null;
  verificationArtifact: VerificationArtifact | null;
  deltaLoopHistory: DeltaLoopHistoryEntry[];
};

export type Task = {
  id: string;
  projectId: string;
  title: string;
  taskPrompt: string;
  result: string;
  effectivePrompt: string;
  aiCommand: string;
  autoMerge: boolean;
  autoStart: boolean;
  autoMergeOnComplete: boolean;
  mode: TaskMode;
  parentPlanTaskId: string | null;
  sourcePlanRevisionId: string | null;
  sourcePlanItemKey: string | null;
  status: TaskStatus;
  workspacePath: string;
  baseCommitShaAtCreate: string;
  headCommitSha: string | null;
  cancelReason: string | null;
  mergedAt: string | null;
  mergedByUserId: string | null;
  dependencyTaskIds: string[];
  blockedByTaskIds: string[];
  isBlocked: boolean;
  completion?: CompletionSummary;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type PlanRevisionItem = {
  id: string;
  itemKey: string;
  itemType: "execution_task" | "sub_plan";
  title: string;
  prompt: string;
  ordinal: number;
  dependsOnItemKeys: string[];
};

export type PlanRevision = {
  id: string;
  planTaskId: string;
  revisionNumber: number;
  status: "proposed" | "approved" | "superseded" | "feedback_requested" | "parse_failed";
  feedback: string | null;
  rawOutput: string;
  parseError: string | null;
  createdByUserId: string;
  createdAt: string;
  approvedAt: string | null;
  items: PlanRevisionItem[];
};

export type TaskTransition = {
  id: string;
  taskId: string;
  fromStatus: string;
  toStatus: string;
  reason: string;
  actorUserId: string | null;
  createdAt: string;
};

export type TaskSession = {
  id: string;
  taskId: string;
  tmuxSessionName: string;
  tmuxSocketPath: string;
  paneId: string | null;
  detectedTool: string | null;
  backendCommand: string;
  status: "starting" | "running" | "waiting_input" | "stopped" | "crashed" | "failed";
  startedAt: string;
  endedAt: string | null;
  lastHeartbeatAt: string | null;
  lastOutput: string;
  exitCode: number | null;
  failureReason: string | null;
};

export type IdeInstance = {
  id: string;
  taskId: string;
  provider: "openvscode_server" | "code_server";
  url: string;
  status: "starting" | "running" | "stopped" | "failed";
  startedAt: string | null;
  endedAt: string | null;
  lastHeartbeatAt: string | null;
};

export type GitStatusSummary = {
  branch: string;
  ahead: number;
  behind: number;
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  conflicted: number;
  untracked: number;
  staged: number;
  unstaged: number;
  clean: boolean;
};

export type MergeRecord = {
  id: string;
  taskId: string;
  projectId: string;
  sourceCommitSha: string;
  targetBaseCommitSha: string;
  mergeCommitSha: string | null;
  status: "pending" | "merged" | "conflict" | "failed";
  conflictSummary: string | null;
  errorMessage: string | null;
  createdByUserId: string;
  createdAt: string;
  completedAt: string | null;
};

export type UserSettings = {
  userId: string;
  defaultAiCommand: string;
  defaultAiCommands: string[];
  createdAt: string;
  updatedAt: string;
};
