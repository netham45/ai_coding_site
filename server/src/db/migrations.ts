export const baselineMigration = `
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
  project_prompt TEXT NOT NULL DEFAULT '',
  project_rules TEXT NOT NULL DEFAULT '',
  coding_standard TEXT NOT NULL DEFAULT '',
  coding_standard_other TEXT NOT NULL DEFAULT '',
  project_other TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  task_prompt TEXT NOT NULL,
  effective_prompt TEXT NOT NULL,
  ai_command TEXT NOT NULL DEFAULT 'codex --yolo {prompt}',
  status TEXT NOT NULL CHECK (status IN ('queued','in_progress','waiting_input','merge_ready','merged','cancelled','failed','merge_conflict')),
  workspace_path TEXT NOT NULL,
  base_commit_sha_at_create TEXT NOT NULL,
  head_commit_sha TEXT,
  cancel_reason TEXT,
  merged_at TEXT,
  merged_by_user_id TEXT REFERENCES users(id),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

CREATE TABLE IF NOT EXISTS task_state_transitions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
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
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
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
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_commit_sha TEXT NOT NULL,
  target_base_commit_sha TEXT NOT NULL,
  merge_commit_sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','merged','conflict','failed')),
  conflict_summary TEXT,
  error_message TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_merge_records_task_id ON merge_records(task_id);
CREATE INDEX IF NOT EXISTS idx_merge_records_status ON merge_records(status);

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
