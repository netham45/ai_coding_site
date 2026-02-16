# AI Coding Web View: Phased Implementation Plan

## 1. Scope and Product Goals

Build a web app where users manage:

- **Projects**: base git repositories cloned from a remote URL.
- **Tasks**: isolated working clones of a project's base repo.
- **AI sessions**: interactive coding sessions in `tmux` (Codex, Claude Code, others).
- **Live views**: terminal stream in `xterm.js` and browser IDE for each task workspace.
- **Task outcomes**: merge back to base repo, or cancel, with full audit/history.
- **User settings**: SSH keys for private repo/tool access and AI command defaults.

Primary filesystem layout:

- `repos/<project_slug>/base/`
- `repos/<project_slug>/tasks/<task_id>/`

## 2. Non-Functional Requirements

- Multi-user safe authorization (project/task scoped access control).
- Crash resilience (service restart should not lose task/session metadata).
- Deterministic task state machine and event logging.
- Merge auditability (who merged, when, what commit, conflict details).
- Secure handling of untrusted repos (no implicit hook execution).
- Horizontal-ready architecture (API + worker + ws gateway separated).

## 3. Target Architecture

Components:

1. **Web Frontend** (React + Chakra UI)
2. **API Service** (REST + auth + orchestration APIs)
3. **Task Runtime Worker** (tmux/session lifecycle and backend adapters)
4. **WebSocket Gateway** (terminal stream + input for xterm.js)
5. **IDE Gateway** (OpenVSCode Server/code-server per task)
6. **SQLite** (source of truth for entities and events)
7. **Filesystem storage** (project base and task clones)

High-level flow:

1. User creates project -> API validates URL -> clone into base path.
2. User creates task -> clone base into task path -> create task session metadata.
3. User starts task -> worker launches tmux + backend adapter command.
4. UI connects websocket -> attaches to task tmux stream.
5. User merges/cancels -> API executes git workflow and updates task state.

Frontend baseline:

1. React app with Chakra UI as the component system.
2. Chakra theme tokens for colors, typography, spacing, and status semantics.
3. React Router for app routing (projects, tasks, task detail views, settings).
4. Data fetching with a React query layer (or equivalent) for API + websocket status state.

## 4. Core Domain Model (Object Level)

### 4.1 Project Object

```json
{
  "id": "string(uuid)",
  "name": "string",
  "slug": "string",
  "repo_url": "string",
  "default_branch": "string",
  "base_path": "string",
  "clone_ssh_key_id": "string(uuid)|null",
  "project_prompt": "string",
  "clone_status": "pending|cloning|ready|failed",
  "clone_error": "string|null",
  "created_by_user_id": "string(uuid)",
  "created_at": "string(iso8601_utc)",
  "updated_at": "string(iso8601_utc)"
}
```

### 4.2 Task Object

```json
{
  "id": "string(uuid)",
  "project_id": "string(uuid)",
  "title": "string",
  "task_prompt": "string",
  "effective_prompt": "string",
  "ai_command": "string (default: \"codex --yolo\")",
  "ssh_key_id": "string(uuid)|null",
  "status": "queued|in_progress|waiting_input|merge_ready|merged|cancelled|failed|merge_conflict",
  "workspace_path": "string",
  "base_commit_sha_at_create": "string",
  "head_commit_sha": "string|null",
  "cancel_reason": "string|null",
  "merged_at": "string(iso8601_utc)|null",
  "merged_by_user_id": "string(uuid)|null",
  "created_by_user_id": "string(uuid)",
  "created_at": "string(iso8601_utc)",
  "updated_at": "string(iso8601_utc)"
}
```

### 4.3 Session Object

```json
{
  "id": "string(uuid)",
  "task_id": "string(uuid)",
  "tmux_session_name": "string",
  "tmux_socket_path": "string",
  "pane_id": "string",
  "detected_tool": "string|null",
  "ssh_key_id": "string(uuid)|null",
  "backend_command": "string",
  "status": "starting|running|waiting_input|stopped|crashed|failed",
  "started_at": "string(iso8601_utc)",
  "ended_at": "string(iso8601_utc)|null",
  "last_heartbeat_at": "string(iso8601_utc)|null",
  "exit_code": "int|null",
  "failure_reason": "string|null"
}
```

### 4.4 User Settings Object

```json
{
  "user_id": "string(uuid)",
  "default_ai_command": "string (default: \"codex --yolo\")",
  "default_ssh_key_id": "string(uuid)|null",
  "created_at": "string(iso8601_utc)",
  "updated_at": "string(iso8601_utc)"
}
```

### 4.5 User SSH Key Object

```json
{
  "id": "string(uuid)",
  "user_id": "string(uuid)",
  "name": "string",
  "public_key": "string",
  "private_key_encrypted": "string",
  "passphrase_encrypted": "string|null",
  "fingerprint": "string",
  "created_at": "string(iso8601_utc)",
  "updated_at": "string(iso8601_utc)"
}
```

### 4.6 Merge Record Object

```json
{
  "id": "string(uuid)",
  "task_id": "string(uuid)",
  "project_id": "string(uuid)",
  "source_commit_sha": "string",
  "target_base_commit_sha": "string",
  "merge_commit_sha": "string|null",
  "status": "pending|merged|conflict|failed",
  "conflict_summary": "string|null",
  "created_by_user_id": "string(uuid)",
  "created_at": "string(iso8601_utc)",
  "completed_at": "string(iso8601_utc)|null"
}
```

### 4.7 Event Object

```json
{
  "id": "string(uuid)",
  "project_id": "string(uuid)|null",
  "task_id": "string(uuid)|null",
  "session_id": "string(uuid)|null",
  "event_type": "string",
  "payload": "json_text",
  "created_at": "string(iso8601_utc)"
}
```

## 5. Database Schema (Table Level, SQLite)

SQLite conventions used in this plan:

- IDs are `TEXT` (UUID strings generated in app layer).
- Timestamps are `TEXT` in ISO8601 UTC.
- JSON payloads are `TEXT` (validated in app layer, queried with SQLite JSON functions if needed).
- Enable `PRAGMA foreign_keys = ON`.
- Enable WAL mode for concurrency: `PRAGMA journal_mode = WAL`.
- Keep write transactions short; route all writes through a single API process in MVP.

### 5.1 `users`

- `id text primary key`
- `email text unique not null`
- `display_name text not null`
- `created_at text not null`
- `updated_at text not null`

### 5.2 `user_settings`

- `user_id text primary key references users(id) on delete cascade`
- `default_ai_command text not null default 'codex --yolo'`
- `default_ssh_key_id text null references user_ssh_keys(id) on delete set null`
- `created_at text not null`
- `updated_at text not null`

Migration note:

- Create `user_ssh_keys` before `user_settings` so FK targets exist at migration time.

### 5.3 `user_ssh_keys`

- `id text primary key`
- `user_id text not null references users(id) on delete cascade`
- `name text not null`
- `public_key text not null`
- `private_key_encrypted text not null`
- `passphrase_encrypted text null`
- `fingerprint text not null`
- `created_at text not null`
- `updated_at text not null`
- `unique (user_id, name)`
- `unique (user_id, fingerprint)`

Indexes:

- `idx_user_ssh_keys_user_id`

### 5.4 `projects`

- `id text primary key`
- `name text not null`
- `slug text unique not null`
- `repo_url text not null`
- `default_branch text not null`
- `base_path text not null`
- `clone_ssh_key_id text null references user_ssh_keys(id) on delete set null`
- `project_prompt text not null default ''`
- `clone_status text not null check (clone_status in ('pending','cloning','ready','failed'))`
- `clone_error text null`
- `created_by_user_id text not null references users(id)`
- `created_at text not null`
- `updated_at text not null`

Indexes:

- `idx_projects_created_by_user_id`
- `idx_projects_clone_status`

### 5.5 `project_members`

- `project_id text not null references projects(id) on delete cascade`
- `user_id text not null references users(id) on delete cascade`
- `role text not null check (role in ('owner','editor','viewer'))`
- `created_at text not null`
- `primary key (project_id, user_id)`

### 5.6 `tasks`

- `id text primary key`
- `project_id text not null references projects(id) on delete cascade`
- `title text not null`
- `task_prompt text not null`
- `effective_prompt text not null`
- `ai_command text not null default 'codex --yolo'`
- `ssh_key_id text null references user_ssh_keys(id) on delete set null`
- `status text not null check (status in ('queued','in_progress','waiting_input','merge_ready','merged','cancelled','failed','merge_conflict'))`
- `workspace_path text not null`
- `base_commit_sha_at_create text not null`
- `head_commit_sha text null`
- `cancel_reason text null`
- `merged_at text null`
- `merged_by_user_id text null references users(id)`
- `created_by_user_id text not null references users(id)`
- `created_at text not null`
- `updated_at text not null`

Indexes:

- `idx_tasks_project_id`
- `idx_tasks_status`
- `idx_tasks_created_at`

### 5.7 `task_sessions`

- `id text primary key`
- `task_id text not null references tasks(id) on delete cascade`
- `tmux_session_name text not null unique`
- `tmux_socket_path text not null`
- `pane_id text null`
- `detected_tool text null`
- `ssh_key_id text null references user_ssh_keys(id) on delete set null`
- `backend_command text not null`
- `status text not null check (status in ('starting','running','waiting_input','stopped','crashed','failed'))`
- `started_at text not null`
- `ended_at text null`
- `last_heartbeat_at text null`
- `exit_code int null`
- `failure_reason text null`

Indexes:

- `idx_task_sessions_task_id`
- `idx_task_sessions_status`

### 5.8 `task_state_transitions`

- `id text primary key`
- `task_id text not null references tasks(id) on delete cascade`
- `from_status text not null`
- `to_status text not null`
- `reason text not null`
- `actor_user_id text null references users(id)`
- `created_at text not null`

Indexes:

- `idx_task_state_transitions_task_id`
- `idx_task_state_transitions_created_at`

### 5.9 `merge_records`

- `id text primary key`
- `task_id text not null references tasks(id) on delete cascade`
- `project_id text not null references projects(id) on delete cascade`
- `source_commit_sha text not null`
- `target_base_commit_sha text not null`
- `merge_commit_sha text null`
- `status text not null check (status in ('pending','merged','conflict','failed'))`
- `conflict_summary text null`
- `error_message text null`
- `created_by_user_id text not null references users(id)`
- `created_at text not null`
- `completed_at text null`

Indexes:

- `idx_merge_records_task_id`
- `idx_merge_records_status`

### 5.10 `events`

- `id text primary key`
- `project_id text null references projects(id) on delete cascade`
- `task_id text null references tasks(id) on delete cascade`
- `session_id text null references task_sessions(id) on delete cascade`
- `event_type text not null`
- `payload text not null default '{}'`
- `created_at text not null`

Indexes:

- `idx_events_project_id`
- `idx_events_task_id`
- `idx_events_session_id`
- `idx_events_created_at`
- `idx_events_event_type`

### 5.11 `ide_instances`

- `id text primary key`
- `task_id text not null references tasks(id) on delete cascade`
- `provider text not null check (provider in ('openvscode_server','code_server'))`
- `url text not null`
- `access_token_hash text not null`
- `status text not null check (status in ('starting','running','stopped','failed'))`
- `started_at text null`
- `ended_at text null`
- `last_heartbeat_at text null`

Indexes:

- `idx_ide_instances_task_id`
- `idx_ide_instances_status`

## 6. State Machines

### 6.1 Task State Transitions

Allowed transitions:

- `queued -> in_progress` (worker started session)
- `in_progress -> waiting_input` (backend paused/awaiting instruction)
- `waiting_input -> in_progress` (user sent input/resume)
- `in_progress -> merge_ready` (task complete, changes ready)
- `waiting_input -> merge_ready` (user marked complete or backend finished)
- `merge_ready -> merged` (merge success)
- `merge_ready -> merge_conflict` (merge conflict)
- `merge_conflict -> in_progress` (user/AI resolves conflict in task workspace)
- `queued|in_progress|waiting_input|merge_ready|merge_conflict -> cancelled`
- `any_non_terminal -> failed`

Terminal states:

- `merged`
- `cancelled`
- `failed`

### 6.2 Session States

- `starting -> running`
- `running -> waiting_input`
- `waiting_input -> running`
- `running|waiting_input -> stopped` (normal finish)
- `starting|running|waiting_input -> crashed|failed`

## 7. API Contract (Initial)

### 7.1 Projects

- `POST /api/projects`
  - body: `{name, repoUrl, projectPrompt, defaultBranch?, cloneSshKeyId?}`
  - action: create row + enqueue clone job
  - returns: `project`
- `GET /api/projects`
- `GET /api/projects/:projectId`
- `PATCH /api/projects/:projectId`
  - update `name`, `project_prompt`

### 7.2 Tasks

- `POST /api/projects/:projectId/tasks`
  - body: `{title, taskPrompt, aiCommand?, sshKeyId?}`
  - action: clone base to workspace, create task row
  - note: `aiCommand` defaults to user setting, fallback `codex --yolo`
- `GET /api/projects/:projectId/tasks`
- `GET /api/tasks/:taskId`
- `PATCH /api/tasks/:taskId`
  - body: `{aiCommand?, sshKeyId?}` (allowed before task start)
- `POST /api/tasks/:taskId/start`
- `POST /api/tasks/:taskId/input`
  - body: `{text}`
- `POST /api/tasks/:taskId/cancel`
  - body: `{reason}`
- `POST /api/tasks/:taskId/mark-merge-ready`

### 7.3 Merge

- `POST /api/tasks/:taskId/merge`
  - action: run merge workflow and write `merge_records`
- `GET /api/tasks/:taskId/merge-records`

### 7.4 Terminal + IDE

- `GET /api/tasks/:taskId/terminal-token`
  - returns short-lived ws token
- `WS /ws/tasks/:taskId/terminal?token=...`
- `POST /api/tasks/:taskId/ide/start`
- `POST /api/tasks/:taskId/ide/stop`
- `GET /api/tasks/:taskId/ide`

### 7.5 User Settings and SSH Keys

- `GET /api/users/me/settings`
- `PATCH /api/users/me/settings`
  - body: `{defaultAiCommand?, defaultSshKeyId?}`
- `GET /api/users/me/ssh-keys`
- `POST /api/users/me/ssh-keys`
  - body: `{name, publicKey, privateKey, passphrase?}`
- `DELETE /api/users/me/ssh-keys/:sshKeyId`

## 8. Git Workflow Design

### 8.1 Project creation

1. Validate URL (allowed schemes and optional allowlist policy).
2. `git clone --origin origin <repo_url> repos/<slug>/base`
3. Checkout default branch and fetch.
4. Store current `HEAD` as baseline in project metadata event.
5. If `clone_ssh_key_id` is set, clone via per-command SSH config using that key.

### 8.2 Task creation

1. Read base `HEAD` commit.
2. Clone local base path into task workspace:
   - `git clone repos/<slug>/base repos/<slug>/tasks/<task_id>`
3. Create task branch in workspace: `task/<task_id>`.
4. Store `base_commit_sha_at_create`.
5. Resolve `ai_command` from task input, user default, or fallback `codex --yolo`.

### 8.3 Merge task back to base

1. Ensure task status is `merge_ready`.
2. Fetch latest base in `repos/<slug>/base`.
3. In base repo create temp merge branch: `merge/task-<task_id>-<timestamp>`.
4. Add task repo as temporary remote or patch source.
5. Attempt merge of task commit(s).
6. On success:
   - Commit merge if needed.
   - Fast-forward or merge into default branch.
   - Record `merge_commit_sha`.
   - Task -> `merged`.
7. On conflict:
   - Record conflict files summary.
   - Task -> `merge_conflict`.
8. Persist all commands and outcomes in events table.

## 9. Security Model

- AuthN: session/JWT.
- AuthZ: every project/task endpoint validates membership and role.
- Ws token is short-lived, signed, scoped to single task and user.
- No direct shell execution from raw user input.
- Validate/sanitize `ai_command` with strict command policy (deny shell metacharacter passthrough; execute argv form).
- Disable git hooks by policy for cloned untrusted repos where possible.
- Sanitize and validate filesystem paths; never trust client-provided paths.
- Rate limit terminal ws connections and task input endpoints.
- Encrypt SSH private keys at rest; decrypt only in-memory for command execution windows.
- Never return private keys from API responses.

## 10. Phase-by-Phase Detailed Plan

## Phase 0: Specification and Foundations

Goals:

- Lock domain, state machine, git semantics, security baseline.

Deliverables:

- ADRs for architecture, git merge strategy, backend adapter contract.
- OpenAPI draft for all endpoints.
- ERD for DB schema above.

Tasks:

1. Finalize task lifecycle and event taxonomy.
2. Decide runtime topology: single-node vs split services.
3. Define backend adapter interface (CLI invocation, prompt injection, io model).
4. Define log/event retention and cleanup policies.

Acceptance:

- Written specs approved and no unresolved state-transition ambiguity.

## Phase 1: Project Management (Clone Base Repo)

Goals:

- Create/list/update projects.
- Clone remote repository into base directory.

DB changes:

- Create `projects`, `project_members`, `events` (+ `users` if not existing) using SQLite DDL.
- Create `user_settings` and `user_ssh_keys` tables in SQLite.
- Initialize SQLite pragmas (`foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout`).

Backend tasks:

1. `POST /projects` with URL validation and unique slug generation.
2. Async clone worker path (or sync with timeout in MVP).
3. Track `clone_status` + `clone_error`.
4. Write project creation and clone events.
5. Build user settings endpoints for default AI command and default SSH key.
6. Build SSH key CRUD endpoints with encryption-at-rest.

Frontend tasks:

1. Bootstrap React app shell with Chakra providers, theme, layout primitives.
2. Build project create form (`name`, `repo URL`, `project prompt`, optional clone SSH key) with Chakra form controls and validation.
3. Build project list with clone status/error badges using Chakra table/list components.
4. Build settings page for SSH key management and default AI command (`codex --yolo` prefilled).

Acceptance:

- Creating a project from valid URL results in `clone_status=ready` and base repo exists.
- Invalid URL or clone failure is captured and shown.

## Phase 2: Task Creation (Workspace Clone + Prompt Composition)

Goals:

- Create tasks as isolated clones.
- Persist prompt composition and task metadata.

DB changes:

- Create `tasks`, `task_state_transitions` in SQLite.

Backend tasks:

1. `POST /projects/:id/tasks` clones base repo to task path.
2. Set `effective_prompt = project_prompt + "\n\n" + task_prompt`.
3. Capture `base_commit_sha_at_create`.
4. Initialize task state transition: `null -> queued`.
5. Persist `ai_command` and `ssh_key_id` on task creation (`ai_command` default `codex --yolo`).

Frontend tasks:

1. Build task create form with AI command input (default prefilled to `codex --yolo`) and SSH key selector.
2. Build task detail page showing prompt blocks and status timeline using Chakra cards/steps/badges.

Acceptance:

- Task folder exists and is a valid git repo.
- Effective prompt persists exactly and is retrievable.

## Phase 3: Task Runtime (tmux + Backend Adapters)

Goals:

- Start and manage interactive AI coding sessions per task.

DB changes:

- Create `task_sessions` in SQLite.

Backend tasks:

1. Implement adapter interface:
   - `buildCommand(task.ai_command, effectivePrompt)`
   - `parseLifecycleSignals(output)`
   - `supportsInteractiveInput`
2. Implement command resolver to classify tool (`codex`, `claude`, `custom`) from `ai_command`.
3. Implement first execution path with default `codex --yolo`.
4. Inject task-specific SSH key material into runtime environment when configured.
5. Worker starts `tmux` session per task:
   - stable name: `task_<task_id>`
   - dedicated socket path
6. Write heartbeat process and crash detection.
7. Map runtime events to task/session states.

Frontend tasks:

1. Build task controls (start/send input/stop) as Chakra button groups and input areas.
2. Build session status card with backend info and timestamps using Chakra stat components.

Acceptance:

- Starting a task creates running tmux session and updates DB.
- Service restart can reconnect/rediscover running sessions.

## Phase 4: Terminal Streaming (WebSocket + xterm.js)

Goals:

- Real-time terminal output/input for each task.

DB changes:

- No new required tables; ensure `events` capture ws attach/detach.
- Add index tuning for high-cardinality terminal events (`task_id`, `created_at`).

Backend tasks:

1. Terminal token issuance endpoint.
2. Ws gateway:
   - auth token verify
   - attach to tmux pane output
   - write input to pane
3. Reconnect strategy (client retries, server idempotent attach).
4. Backpressure and chunking logic for high-volume output.

Frontend tasks:

1. Integrate xterm.js in a Chakra panel with reconnect and fit behavior.
2. Render connection status and session attach errors using Chakra alerts/toasts.

Acceptance:

- User can type in web terminal and see live backend response.
- Disconnection/reconnection keeps session continuity.

## Phase 5: Browser IDE Integration (Per-Task Workspace)

Goals:

- Expose code editor in browser for task workspace with git diff tools.

DB changes:

- Create `ide_instances` in SQLite.

Backend tasks:

1. Implement IDE launcher service for each task workspace.
2. Tokenize access; never expose raw local paths.
3. Health checks and restart policy.
4. Stop/cleanup behavior tied to task lifecycle.

Frontend tasks:

1. Embed IDE iframe/view with Chakra loading and error states.
2. Toggle between Terminal and IDE panes using Chakra tabs/segmented controls.
3. Show quick git status from API in Chakra status components.

Acceptance:

- Opening IDE for a task shows workspace files and source control changes.

## Phase 6: Merge and Cancel Workflows

Goals:

- Reliable merge back into project base and explicit cancellation.

DB changes:

- Create `merge_records` in SQLite.
- Extend events and task transitions usage.

Backend tasks:

1. `POST /tasks/:id/cancel` with guarded transitions.
2. `POST /tasks/:id/merge` with locking:
   - prevent concurrent merges for same project
3. Persist merge outcome and conflict details.
4. Update base repo pointer and emit merge events.

Frontend tasks:

1. Build merge and cancel actions with Chakra modals/drawers for confirmation.
2. Build conflict UX (file list, reopen in IDE, move task back to in-progress) using Chakra list and action panels.
3. Build audit panel showing merge history with Chakra table/timeline patterns.

Acceptance:

- Merge success updates task to `merged` with merge record.
- Conflicts set `merge_conflict` with actionable info.
- Cancelled tasks remain visible with reason.

## Phase 7: Hardening, Observability, and Production Readiness

Goals:

- Operational reliability and test coverage.

DB changes:

- Optional event archiving/compaction tables for SQLite (`events_archive`).
- Additional covering indexes based on observed query plans.

Backend tasks:

1. Structured logging, trace IDs, metrics (session uptime, ws errors, merge failures).
2. Cleanup jobs:
   - stale task sessions
   - old IDE instances
   - optional archived workspaces
3. Quotas:
   - max tasks/project
   - max concurrent sessions/user
   - disk usage limits
4. Retry/circuit-breaker around external backend commands.

Frontend tasks:

1. Build admin/diagnostics view (task events, runtime health) in React + Chakra.
2. Add standardized Chakra error surfaces and retry controls.

Testing plan:

1. Unit tests for state transition guards.
2. Integration tests for git clone/merge/conflict flows.
3. E2E tests for ws terminal attach/input/reconnect.
4. Security tests for authorization boundaries.
5. SQLite contention tests under concurrent session/event writes.

Acceptance:

- SLO defined and measured.
- No critical auth or state integrity gaps in test suite.

## 11. Implementation Milestones and Suggested Timeline

1. Milestone A (Weeks 1-2): Phases 0-1 complete.
2. Milestone B (Weeks 3-4): Phase 2 complete.
3. Milestone C (Weeks 5-7): Phases 3-4 complete (core AI session value).
4. Milestone D (Weeks 8-9): Phase 5 complete.
5. Milestone E (Weeks 10-11): Phase 6 complete.
6. Milestone F (Weeks 12+): Phase 7 hardening and rollout.

## 12. Open Decisions You Should Lock Early

1. Single-tenant vs multi-tenant user model.
2. Exact command adapter contract for CLI tools (Codex/Claude/custom).
3. Command policy and validation rules for user-supplied `ai_command`.
4. Merge strategy default (merge commit vs squash) and conflict resolution policy.
5. IDE runtime strategy (one container/process per task vs pooled).
6. Retention policy for task workspaces after merge/cancel.

## 13. SQLite Operations and Migration Strategy

SQLite runtime settings:

1. Use one DB file per deployment, e.g. `data/app.db`.
2. Set at startup:
   - `PRAGMA foreign_keys = ON;`
   - `PRAGMA journal_mode = WAL;`
   - `PRAGMA synchronous = NORMAL;`
   - `PRAGMA busy_timeout = 5000;`
3. Run periodic `PRAGMA optimize;`.
4. Run `VACUUM` during maintenance windows.

Migration strategy:

1. Use versioned SQL migrations (`0001_init.sql`, `0002_tasks.sql`, ...).
2. Track versions in a `schema_migrations` table:
   - `version text primary key`
   - `applied_at text not null`
3. Enforce forward-only migrations in production.
4. Store timestamps in ISO8601 UTC generated by app layer for consistency.
5. Store encryption key configuration outside the DB (env/secret manager), never in SQLite.

Scale trigger for PostgreSQL migration:

1. Sustained write lock contention despite WAL and busy timeout tuning.
2. Need for multi-node active writers.
3. Events table growth causing unacceptable query latency.
