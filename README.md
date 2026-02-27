# AI Coding Site

AI Coding Site is a local-first web app for running AI coding tasks against Git repositories in isolated workspaces, with:

- project management and repository cloning
- execution tasks and plan tasks
- tmux-backed runtime control (start/input/stop/rerun)
- browser terminal streaming over WebSocket
- browser IDE sessions via `code-server` or `openvscode-server`
- merge/cancel workflow with merge audit records

## Table of Contents

- [Architecture](#architecture)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the app](#running-the-app)
- [CLI usage](#cli-usage)
- [Plan automation](#plan-automation)
- [Usage flow](#usage-flow)
- [API overview](#api-overview)
- [Repository layout](#repository-layout)
- [Backup and recovery](#backup-and-recovery)
- [Troubleshooting](#troubleshooting)
- [Development notes](#development-notes)

## Architecture

- `server/`: Express + TypeScript API, SQLite persistence, task runtime orchestration.
- `web/`: React + Vite + Chakra UI frontend.
- `data/app.sqlite`: runtime database created automatically.
- `repos/`: cloned project bases and per-task workspaces.

Runtime model:

- Each task runs in its own tmux session.
- Terminal output is captured and streamed to the frontend via `WS /ws/tasks/:taskId/terminal`.
- IDE sessions run locally and are exposed through API proxy routes (`/api/tasks/:taskId/ide/proxy/...` and `/api/projects/:projectId/ide/proxy/...`).
- A queue worker auto-starts unblocked queued tasks.

## Features

- Projects
  - Create/list/update projects
  - Clone repository base branch into `repos/<slug>/base`
  - Search project files for `@file` prompt mentions
  - Launch project-level IDE session
- Tasks (execution mode)
  - Create task workspaces from project base
  - Track dependencies between tasks
  - Start, send input, stop, rerun task runtimes
  - Pull latest base branch into task branch
  - Mark merge-ready, merge, cancel
  - Store task summaries/results and merge records
- Plans (plan mode)
  - Create plan tasks that output structured YAML
  - Extract and validate plan revisions
  - Regenerate with feedback
  - Approve plan revisions to create execution tasks
  - Auto-orchestrate extract + approve when `auto_start` is enabled and plan is `waiting_input`
- Terminal and IDE
  - xterm.js terminal with reconnect behavior
  - Tokenized terminal and IDE access URLs
  - IDE provider auto-detection (`code-server` first, fallback `openvscode-server`)
- Settings
  - User-level default AI command template (for example `codex --yolo {prompt}`)

## Requirements

Required:

- Node.js 18+
- npm 9+
- Git installed and available in `PATH`
- tmux installed and available in `PATH`
- Linux/macOS shell tools: `which`, `ps`, `ss`

Recommended:

- `code-server` or `openvscode-server` in `PATH` for in-browser IDE panes

Notes:

- This project is best run on Linux/macOS or WSL2.
- On Windows without WSL, tmux and some shell utilities are typically unavailable.

## Installation

1. Clone the repository.
2. Install workspace dependencies:

```bash
npm install
```

3. (Optional but recommended) Install an IDE provider:

```bash
# Option A
code-server --version

# Option B
openvscode-server --version
```

4. Confirm required runtime tools:

```bash
node -v
npm -v
git --version
tmux -V
```

### System package installation examples

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y git tmux iproute2 procps
```

macOS (Homebrew):

```bash
brew install git tmux
```

## Configuration

Server environment variables:

- `HOST`: bind host for API server. Default: `0.0.0.0`
- `PORT`: API port. Default: `3001`
- `TERMINAL_TOKEN_SECRET`: HMAC secret for terminal WS tokens. Default: `dev-terminal-secret`
- `TERMINAL_TOKEN_TTL_SECONDS`: terminal token TTL in seconds. Default: `300`
- `AI_CODING_DATA_ROOT`: override app DB root. Default: `<workspace>/data`
- `AI_CODING_REPOS_ROOT`: override repos root. Default: `<workspace>/repos`
- `AI_CODING_PROFILER_ENABLED`: enable diagnostics profiler (`1`/`true`). Default: disabled
- `AI_CODING_PROFILER_OUTPUT_DIR`: profiler output directory. Default: `<data-root>/profiles`
- `AI_CODING_PROFILER_LAG_THRESHOLD_MS`: event loop lag threshold for stall snapshots. Default: `750`
- `AI_CODING_PROFILER_POLL_INTERVAL_MS`: poll interval for lag detection. Default: `250`
- `AI_CODING_PROFILER_CPU_MS`: default CPU profile duration (ms). Default: `10000`
- `AI_CODING_PROFILER_STALL_COOLDOWN_MS`: minimum gap between auto stall snapshots. Default: `30000`
- `AI_CODING_PROFILER_SIGNALS_ENABLED`: enable `SIGUSR1`/`SIGUSR2` capture hooks. Default: enabled
- `AI_CODING_DEP_GRAPH_CACHE_TTL_MS`: cache window for dependency graph diagnostics in milliseconds. Default: `3000`
- `AI_CODING_DB_TRACE_ENABLED`: enable per-statement sqlite tracing wrapper. Default: disabled
- `AI_CODING_GIT_STATUS_CACHE_TTL_MS`: cache TTL for workspace git status reads in milliseconds. Default: `5000`
- `AI_CODING_TASK_DETAIL_INCLUDE_GIT_DEFAULT`: include git status by default on `GET /api/tasks/:taskId`. Default: disabled
- `AI_CODING_TASK_DETAIL_INCLUDE_HEAVY_DEFAULT`: include completion artifact payloads by default on `GET /api/tasks/:taskId`. Default: disabled
- `AI_CODING_PLAN_DETAIL_INCLUDE_HEAVY_DEFAULT`: include completion artifact payloads by default on `GET /api/plans/:planId`. Default: disabled
- `AI_CODING_LOG_QUEUE_MAX_LINES`: max queued lines per backend log stream before dropping. Default: `50000`

Example:

```bash
HOST=0.0.0.0
PORT=3001
TERMINAL_TOKEN_SECRET=replace-with-long-random-secret
TERMINAL_TOKEN_TTL_SECONDS=300
AI_CODING_PROFILER_ENABLED=1
```

Important behavior:

- No `.env` loader is wired by default. Export env vars in your shell (or use your process manager).
- Authentication is local-development style by default:
  - if `x-user-id` header is missing, server falls back to a local seeded user.

## Running the app

### Development

Start API server:

```bash
npm run dev -w server
```

Start frontend (new terminal):

```bash
npm run dev -w web
```

Or run just backend from workspace root:

```bash
npm run dev
```

URLs:

- API: `http://localhost:3001`
- Web: `http://localhost:5173`

Vite dev server proxies:

- `/api` -> `http://localhost:3001`
- `/ws` -> `ws://localhost:3001`

### Production build

Build both packages:

```bash
npm run build
```

Start server build:

```bash
npm run start -w server
```

When `web/dist` exists, the server also serves the frontend for non-API routes.

## CLI usage

Run CLI commands from the repository root:

```bash
npm run cli -w server -- <command>
```

Common commands:

```bash
# List execution tasks (all projects)
npm run cli -w server -- tasks all --json

# List active execution tasks scoped to a project/plan
npm run cli -w server -- tasks active --project-id <projectId> --plan-id <planId> --json

# Task summary/details with optional scope filters
npm run cli -w server -- tasks summary <taskId> --project-id <projectId> --plan-id <planId> --json
npm run cli -w server -- tasks details <taskId> --project-id <projectId> --json
npm run cli -w server -- info <taskId> --project-id <projectId> --plan-id <planId> --json

# Plan listing/review
npm run cli -w server -- plans list --project-id <projectId> --plan-id <planId> --json
npm run cli -w server -- plans review <planId> --json
npm run cli -w server -- review plan <planId> --json

# Merge workflows (task + plan)
npm run cli -w server -- ready_merge task <taskId> --json
npm run cli -w server -- ready_merge plan <planId> --json
npm run cli -w server -- merge task <taskId> --json
npm run cli -w server -- merge plan <planId> --json

# Plan automation options
npm run cli -w server -- plans create --project <projectId> --title "Plan" --prompt "..." --auto-start --auto-merge-on-complete
npm run cli -w server -- plans approve <planId> --auto-merge-item-keys task_a,task_b --auto-start --auto-merge-on-complete
```

For the complete command list, run:

```bash
npm run cli -w server -- --help
```

## Plan automation

Automation uses the plan output file at `.ai-plan/latest-plan.yaml` and runs in passes.

- A plan is auto-processed only when:
  - `mode = plan`
  - `auto_start = true`
  - `status = waiting_input`
  - plan YAML file exists and is non-empty
- Auto-processing runs extract then approve, deduped by output hash.
- If extraction/approval fails, it retries only after plan output changes.
- Approving from an auto-start plan defaults execution child tasks to `auto_merge=true`.

YAML contract highlights:

- Top-level `tasks:` list is required (`items:` is accepted for compatibility).
- Optional top-level defaults:
  - `auto_start`
  - `auto_merge_on_complete`
  - `auto_merge_item_keys`
- Item types:
  - `execution_task` supports `auto_merge`
  - `sub_plan` supports `auto_start` and `auto_merge_on_complete`

Full operational details, migration notes, state machine, and rollout checklist:

- `docs/plan-automation-model.md`

## Usage flow

1. Open the app and create a project with repository URL and default branch.
2. Wait until project clone status becomes `ready`.
3. Create either:
   - an execution task, or
   - a plan task (then extract/approve plan items into execution tasks).
4. Open a task:
   - runtime and IDE attempt to auto-start
   - use Terminal and IDE tabs to work with the agent session
5. For finished work:
   - pull base branch updates if needed
   - mark task merge-ready
   - merge and review merge records

## API overview

Health:

- `GET /api/health`
  - includes `diagnostics.projectDb` open/validation/migration failure counters
  - includes `diagnostics.migration` status counts from `project_data_migrations`

Projects:

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:projectId`
- `PATCH /api/projects/:projectId`
- `GET /api/projects/:projectId/files`
- `POST /api/projects/:projectId/ide/start`
- `POST /api/projects/:projectId/ide/stop`
- `GET /api/projects/:projectId/ide/view?token=...`
- `ANY /api/projects/:projectId/ide/proxy/*`

Tasks:

- `GET /api/projects/:projectId/tasks`
- `POST /api/projects/:projectId/tasks`
- `GET /api/tasks/:taskId`
- `PATCH /api/tasks/:taskId`
- `POST /api/tasks/:taskId/start`
- `POST /api/tasks/:taskId/input`
- `POST /api/tasks/:taskId/stop`
- `POST /api/tasks/:taskId/rerun`
- `POST /api/tasks/:taskId/pull-main`
- `POST /api/tasks/:taskId/mark-merge-ready`
- `POST /api/tasks/:taskId/cancel`
- `POST /api/tasks/:taskId/merge`
- `GET /api/tasks/:taskId/merge-records`
- `GET /api/tasks/:taskId/terminal-token`
- `GET /api/tasks/:taskId/ide`
- `POST /api/tasks/:taskId/ide/start`
- `POST /api/tasks/:taskId/ide/token`
- `POST /api/tasks/:taskId/ide/stop`
- `GET /api/tasks/:taskId/ide/view?token=...`
- `ANY /api/tasks/:taskId/ide/proxy/*`

Plans:

- `POST /api/projects/:projectId/plans`
- `GET /api/plans/:planId`
- `POST /api/plans/:planId/extract`
- `POST /api/plans/:planId/regenerate`
- `POST /api/plans/:planId/approve`

Settings:

- `GET /api/users/me/settings`
- `PATCH /api/users/me/settings`

WebSocket:

- `WS /ws/tasks/:taskId/terminal?token=...`

## Repository layout

```text
.
├── server/
│   ├── src/
│   │   ├── routes/        # Projects, tasks, plans, settings APIs
│   │   ├── services/      # Runtime, git, IDE, queue, prompt composition
│   │   ├── ws/            # Terminal + IDE websocket gateways
│   │   └── db/            # SQLite init/migrations
├── web/
│   └── src/
│       ├── pages/         # Projects, project detail, task detail, settings
│       ├── components/    # App shell + task sidebar
│       └── api/           # frontend API client and types
├── docs/                  # implementation phase notes and ADRs
├── repos/                 # cloned project bases and task workspaces (runtime)
└── data/                  # sqlite database (runtime)
```

## Backup and recovery

- Runbook: `docs/backup-and-recovery.md`

## Troubleshooting

- `tmux: command not found`
  - Install tmux and restart the server.
- `No IDE provider found. Install code-server or openvscode-server.`
  - Install one provider or use terminal-only workflow.
- Terminal does not connect
  - Ensure API server is running and `TERMINAL_TOKEN_SECRET` is stable.
  - Check browser can reach `/ws/...` through Vite proxy or direct server.
- Project stays in clone `failed`
  - Verify repository URL and git access credentials.
- Task stays `queued`
  - Check dependency tasks; queued tasks with unmet dependencies do not start.
- Port conflicts
  - Set a different `PORT` for server or free `3001`/`5173`.
- Diagnose deadlock/loop behavior with profiler
  - Start with profiling enabled: `npm run dev:profile -w server` (or `npm run start:profile -w server`).
  - Snapshot stalled state: `kill -USR1 <server-pid>` writes a `.snapshot.json` file.
  - Capture CPU loop profile: `kill -USR2 <server-pid>` writes a `.cpuprofile` file.
  - You can also trigger via API:
    - `POST /api/debug/profiler/snapshot` body: `{ \"reason\": \"manual\" }`
    - `POST /api/debug/profiler/cpu` body: `{ \"reason\": \"manual\", \"durationMs\": 15000 }`
    - `GET /api/debug/profiler/status`
  - Output files are under `data/profiles` by default. Open `.cpuprofile` in Chrome DevTools Performance panel.

## Development notes

- SQLite is initialized automatically on startup with WAL mode.
- Runtime state is persisted in `task_sessions`, `task_state_transitions`, and `ide_instances`.
- The AI command template must include `{prompt}` if you want prompt injection into command args.
- Shell metacharacters in `aiCommand` are blocked by validation.
