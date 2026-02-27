export type CloneStatus = "pending" | "cloning" | "ready" | "failed";

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
export type NodeTier = "epoch" | "phase" | "plan" | "task" | "exec";
export type UserNodeTier = "epoch" | "phase" | "plan" | "task";

export type NodeDependencyRef = {
  id: string;
  tier?: NodeTier;
  reason?: string;
};

export type NodeMetadata = {
  schema_version: 1;
  tier: NodeTier;
  lifecycle?: {
    synthesis_passed?: boolean;
    verification_passed?: boolean;
    last_transition_reason_code?: string;
  };
  orchestration?: {
    auto_merge?: boolean;
    auto_start?: boolean;
    auto_merge_on_complete?: boolean;
    hints?: string[];
  };
  budgets?: {
    max_retries?: number;
    max_replans?: number;
    max_children?: number;
    token_budget?: number;
  };
  idempotency?: {
    fingerprint?: string;
    decomposition_fingerprint?: string;
    gap_hash?: string;
  };
  dependencies?: {
    same_tier?: NodeDependencyRef[];
    cross_tier?: NodeDependencyRef[];
  };
  custom?: Record<string, unknown>;
};

export type AppProjectRow = {
  id: string;
  name: string;
  slug: string;
  repo_url: string;
  default_branch: string;
  base_path: string;
  clone_status: CloneStatus;
  clone_error: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
};

export type ProjectConfigFields = {
  project_prompt: string;
  project_rules: string;
  coding_standard: string;
  coding_standard_other: string;
  project_other: string;
};

export type ProjectRow = AppProjectRow & ProjectConfigFields;

export type TaskRow = {
  id: string;
  project_id: string;
  title: string;
  task_prompt: string;
  result: string;
  effective_prompt: string;
  ai_command: string;
  auto_merge: number;
  auto_start: number;
  auto_merge_on_complete: number;
  metadata_json?: string | null;
  mode: TaskMode;
  parent_plan_task_id: string | null;
  source_plan_revision_id: string | null;
  source_plan_item_key: string | null;
  status: TaskStatus;
  workspace_path: string;
  base_commit_sha_at_create: string;
  head_commit_sha: string | null;
  cancel_reason: string | null;
  merged_at: string | null;
  merged_by_user_id: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
};

export type TaskDependencyRow = {
  task_id: string;
  dependency_task_id: string;
  created_at: string;
};

export type TaskTransitionRow = {
  id: string;
  task_id: string;
  from_status: string;
  to_status: string;
  reason: string;
  actor_user_id: string | null;
  created_at: string;
};

export type TaskSessionStatus = "starting" | "running" | "waiting_input" | "stopped" | "crashed" | "failed";

export type TaskSessionRow = {
  id: string;
  task_id: string;
  tmux_session_name: string;
  tmux_socket_path: string;
  pane_id: string | null;
  detected_tool: string | null;
  backend_command: string;
  status: TaskSessionStatus;
  started_at: string;
  ended_at: string | null;
  last_heartbeat_at: string | null;
  last_output: string;
  exit_code: number | null;
  failure_reason: string | null;
};

export type UserRow = {
  id: string;
  email: string;
  display_name: string;
  created_at: string;
  updated_at: string;
};

export type UserSettingsRow = {
  user_id: string;
  default_ai_command: string;
  default_ai_commands: string;
  created_at: string;
  updated_at: string;
};

export type IdeInstanceStatus = "starting" | "running" | "stopped" | "failed";
export type IdeProvider = "openvscode_server" | "code_server";

export type IdeInstanceRow = {
  id: string;
  task_id: string;
  provider: IdeProvider;
  url: string;
  access_token_hash: string;
  status: IdeInstanceStatus;
  started_at: string | null;
  ended_at: string | null;
  last_heartbeat_at: string | null;
};

export type MergeRecordStatus = "pending" | "merged" | "conflict" | "failed";

export type MergeRecordRow = {
  id: string;
  task_id: string;
  project_id: string;
  source_commit_sha: string;
  target_base_commit_sha: string;
  merge_commit_sha: string | null;
  status: MergeRecordStatus;
  conflict_summary: string | null;
  error_message: string | null;
  created_by_user_id: string;
  created_at: string;
  completed_at: string | null;
};

export type PlanRevisionStatus = "proposed" | "approved" | "superseded" | "feedback_requested" | "parse_failed";

export type PlanRevisionRow = {
  id: string;
  plan_task_id: string;
  revision_number: number;
  status: PlanRevisionStatus;
  feedback: string | null;
  raw_output: string;
  parse_error: string | null;
  created_by_user_id: string;
  created_at: string;
  approved_at: string | null;
};

export type PlanRevisionItemRow = {
  id: string;
  revision_id: string;
  item_key: string;
  item_type: PlanRevisionItemType;
  title: string;
  prompt: string;
  ordinal: number;
  created_at: string;
};

export type PlanRevisionItemType = "execution_task" | "sub_plan";

export type PlanRevisionItemDependencyRow = {
  revision_item_id: string;
  depends_on_item_key: string;
};

export type PlanOrchestrationStateRow = {
  plan_task_id: string;
  lock_token: string | null;
  lock_expires_at: string | null;
  last_output_sha256: string | null;
  last_extracted_revision_id: string | null;
  last_approved_revision_id: string | null;
  last_approved_output_sha256: string | null;
  last_failed_output_sha256: string | null;
  last_error: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
};
