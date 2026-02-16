# AI Coding Web View - Phase 1 to Phase 6

Implemented phases:

- Phase 1: Project management + base repo clone + user settings + SSH keys
- Phase 2: Task creation as isolated workspace clones + prompt composition + task metadata
- Phase 3: Task runtime with tmux sessions + adapter scaffolding + start/input/stop controls
- Phase 4: WebSocket terminal streaming with xterm.js
- Phase 5: IDE instance model + tokenized IDE launch URL + terminal/IDE pane toggle + quick git status + live VS Code session launch
- Phase 6: Merge/cancel workflow APIs + merge records + pull-main conflict helper + task info merge controls/audit

## Implemented backend

- SQLite pragmas enabled:
  - `foreign_keys = ON`
  - `journal_mode = WAL`
  - `busy_timeout = 5000`
- Tables:
  - `users`
  - `user_settings`
  - `user_ssh_keys`
  - `projects`
  - `project_members`
  - `tasks`
  - `task_state_transitions`
  - `task_sessions`
  - `events`
  - `ide_instances`
  - `merge_records`

### API endpoints

Projects:

- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/:projectId`
- `PATCH /api/projects/:projectId`

Tasks:

- `POST /api/projects/:projectId/tasks`
- `GET /api/projects/:projectId/tasks`
- `GET /api/tasks/:taskId`
- `PATCH /api/tasks/:taskId` (queued tasks only)
- `POST /api/tasks/:taskId/start`
- `POST /api/tasks/:taskId/input`
- `POST /api/tasks/:taskId/stop`
- `GET /api/tasks/:taskId/terminal-token`
- `GET /api/tasks/:taskId/ide`
- `POST /api/tasks/:taskId/ide/start`
- `POST /api/tasks/:taskId/ide/token`
- `POST /api/tasks/:taskId/ide/stop`
- `GET /api/tasks/:taskId/ide/view?token=...`
- `POST /api/tasks/:taskId/pull-main`
- `POST /api/tasks/:taskId/mark-merge-ready`
- `POST /api/tasks/:taskId/cancel`
- `POST /api/tasks/:taskId/merge`
- `GET /api/tasks/:taskId/merge-records`

Terminal websocket:

- `WS /ws/tasks/:taskId/terminal?token=...`

Settings:

- `GET /api/users/me/settings`
- `PATCH /api/users/me/settings`

SSH keys:

- `GET /api/users/me/ssh-keys`
- `POST /api/users/me/ssh-keys`
- `DELETE /api/users/me/ssh-keys/:sshKeyId`

## Phase 3 runtime behavior

- Adapter interface includes:
  - command build (`buildCommand`)
  - tool classification (`codex`, `claude`, `custom`)
  - lifecycle signal parsing from terminal output
- Task start creates tmux-backed `task_sessions` rows with:
  - stable session name: `task_<task_id>`
  - dedicated socket path (short path under `/tmp/ai-coding-site-tmux`)
- Heartbeat loop monitors active sessions and updates:
  - `task_sessions.status`
  - `task_sessions.last_heartbeat_at`
  - task status transitions on crash/stop/signals
- Startup recovery validates persisted active sessions and reconciles missing ones.

## Phase 4 terminal behavior

- Short-lived terminal token endpoint issues task-scoped ws credentials.
- Websocket gateway attaches to active tmux task session and streams pane output.
- Browser xterm terminal supports reconnect and fit behavior.

## Implemented frontend

- Chakra app shell + routes
- Projects page:
  - create project form
  - project list with clone status/error badges
- Project detail page:
  - create task form (`title`, `taskPrompt`, `aiCommand`, `sshKeyId`)
  - task list for project
- Task detail page:
  - task sidebar + tabbed content (`IDE`, `Terminal`, `Task Info`)
  - auto-start runtime + IDE on task open
  - fullscreen expand/collapse for IDE and terminal panes
  - task info actions (pull-main, mark merge-ready, merge, cancel)
  - task prompt/history and merge audit panel
- Settings page:
  - default AI command + default SSH key
  - SSH key CRUD

## Prerequisites

- Node.js 18+
- `git` available in PATH
- `tmux` available in PATH (Phase 3 runtime)
- `code-server` or `openvscode-server` available in PATH (Phase 5 IDE runtime)

## Setup

```bash
npm install
```

## Run

API:

```bash
npm run dev -w server
```

Web:

```bash
npm run dev -w web
```

- API: `http://0.0.0.0:3001`
- Web: `http://localhost:5173`

## Build

```bash
npm run build
```

## Environment variables

- `HOST`: API bind host (default `0.0.0.0`)
- `PORT`: API port (default `3001`)
- `SSH_ENCRYPTION_KEY`: key material used to encrypt SSH private keys at rest
  - local fallback: `dev-only-change-me`
  - set securely in non-dev environments
- `TERMINAL_TOKEN_SECRET`: HMAC key for websocket terminal tokens
- `TERMINAL_TOKEN_TTL_SECONDS`: terminal token lifetime in seconds (default `300`)

## Current MVP constraints

- Auth is simplified for local development (`x-user-id` optional).
- Runtime is in-process (no separate worker yet).
- Web terminal streaming is now implemented via xterm.js + websocket.
- IDE is exposed through API-path proxy routes (HTTP + websocket) on the app port.
