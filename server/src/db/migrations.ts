export const appBaselineMigration = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_ai_command TEXT NOT NULL DEFAULT 'codex --yolo {prompt}',
  default_ai_commands TEXT NOT NULL DEFAULT '["codex --yolo {prompt}"]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  base_path TEXT NOT NULL,
  clone_status TEXT NOT NULL CHECK (clone_status IN ('pending','cloning','ready','failed')),
  clone_error TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_created_by_user_id ON projects(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_projects_clone_status ON projects(clone_status);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
`;

export const projectBaselineMigration = `
CREATE TABLE IF NOT EXISTS project_config (
  project_id TEXT PRIMARY KEY,
  project_prompt TEXT NOT NULL DEFAULT '',
  project_rules TEXT NOT NULL DEFAULT '',
  coding_standard TEXT NOT NULL DEFAULT '',
  coding_standard_other TEXT NOT NULL DEFAULT '',
  project_other TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  task_prompt TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT '',
  effective_prompt TEXT NOT NULL,
  ai_command TEXT NOT NULL DEFAULT 'codex --yolo {prompt}',
  auto_merge INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge IN (0,1)),
  auto_start INTEGER NOT NULL DEFAULT 0 CHECK (auto_start IN (0,1)),
  auto_merge_on_complete INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge_on_complete IN (0,1)),
  mode TEXT NOT NULL DEFAULT 'execution' CHECK (mode IN ('execution','plan')),
  parent_plan_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  source_plan_revision_id TEXT REFERENCES plan_revisions(id) ON DELETE SET NULL,
  source_plan_item_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','in_progress','waiting_input','awaiting_children','merge_ready','merged','cancelled','failed','merge_conflict')),
  workspace_path TEXT NOT NULL,
  base_commit_sha_at_create TEXT NOT NULL,
  head_commit_sha TEXT,
  cancel_reason TEXT,
  merged_at TEXT,
  merged_by_user_id TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_plan_task_id ON tasks(parent_plan_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_mode ON tasks(mode);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dependency_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, dependency_task_id),
  CHECK (task_id != dependency_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_task_id ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_dependency_task_id ON task_dependencies(dependency_task_id);

CREATE TABLE IF NOT EXISTS task_state_transitions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_state_transitions_task_id ON task_state_transitions(task_id);
CREATE INDEX IF NOT EXISTS idx_task_state_transitions_created_at ON task_state_transitions(created_at);

CREATE TABLE IF NOT EXISTS task_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tmux_session_name TEXT NOT NULL UNIQUE,
  tmux_socket_path TEXT NOT NULL,
  pane_id TEXT,
  detected_tool TEXT,
  backend_command TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting','running','waiting_input','stopped','crashed','failed')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_heartbeat_at TEXT,
  last_output TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_sessions_task_id ON task_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_task_sessions_status ON task_sessions(status);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES task_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_project_id ON events(project_id);
CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id);
CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);

CREATE TABLE IF NOT EXISTS merge_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  source_commit_sha TEXT NOT NULL,
  target_base_commit_sha TEXT NOT NULL,
  merge_commit_sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','merged','conflict','failed')),
  conflict_summary TEXT,
  error_message TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_merge_records_task_id ON merge_records(task_id);
CREATE INDEX IF NOT EXISTS idx_merge_records_status ON merge_records(status);

CREATE TABLE IF NOT EXISTS plan_revisions (
  id TEXT PRIMARY KEY,
  plan_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','superseded','feedback_requested','parse_failed')),
  feedback TEXT,
  raw_output TEXT NOT NULL DEFAULT '',
  parse_error TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_revisions_plan_task_number ON plan_revisions(plan_task_id, revision_number);
CREATE INDEX IF NOT EXISTS idx_plan_revisions_plan_task_id ON plan_revisions(plan_task_id);
CREATE INDEX IF NOT EXISTS idx_plan_revisions_status ON plan_revisions(status);

CREATE TABLE IF NOT EXISTS plan_revision_items (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'execution_task' CHECK (item_type IN ('execution_task','sub_plan')),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_revision_items_revision_item_key ON plan_revision_items(revision_id, item_key);
CREATE INDEX IF NOT EXISTS idx_plan_revision_items_revision_id ON plan_revision_items(revision_id);

CREATE TABLE IF NOT EXISTS plan_revision_item_dependencies (
  revision_item_id TEXT NOT NULL REFERENCES plan_revision_items(id) ON DELETE CASCADE,
  depends_on_item_key TEXT NOT NULL,
  PRIMARY KEY (revision_item_id, depends_on_item_key)
);
CREATE INDEX IF NOT EXISTS idx_plan_revision_item_dependencies_revision_item_id ON plan_revision_item_dependencies(revision_item_id);

CREATE TABLE IF NOT EXISTS plan_orchestration_state (
  plan_task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  lock_token TEXT,
  lock_expires_at TEXT,
  last_output_sha256 TEXT,
  last_extracted_revision_id TEXT REFERENCES plan_revisions(id) ON DELETE SET NULL,
  last_approved_revision_id TEXT REFERENCES plan_revisions(id) ON DELETE SET NULL,
  last_approved_output_sha256 TEXT,
  last_failed_output_sha256 TEXT,
  last_error TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_orchestration_state_lock_expires_at ON plan_orchestration_state(lock_expires_at);

CREATE TABLE IF NOT EXISTS ide_instances (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openvscode_server','code_server')),
  url TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting','running','stopped','failed')),
  started_at TEXT,
  ended_at TEXT,
  last_heartbeat_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ide_instances_task_id ON ide_instances(task_id);
CREATE INDEX IF NOT EXISTS idx_ide_instances_status ON ide_instances(status);
`;
