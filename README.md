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
- [Usage flow](#usage-flow)
- [API overview](#api-overview)
- [Repository layout](#repository-layout)
- [Troubleshooting](#troubleshooting)
- [Development notes](#development-notes)

## Architecture

- `server/`: Express + TypeScript API, SQLite persistence, task runtime orchestration.
- `web/`: React + Vite + Chakra UI frontend.
- `data/app.sqlite`: global runtime database (`users`, `user_settings`, `projects`, `project_members`).
- `repos/<slug>/base/.ai-coding/project.sqlite`: per-project database for tasks/plans/sessions/events/IDE/merge state and project prompt/config.
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

Example:

```bash
HOST=0.0.0.0
PORT=3001
TERMINAL_TOKEN_SECRET=replace-with-long-random-secret
TERMINAL_TOKEN_TTL_SECONDS=300
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

## Development notes

- SQLite is initialized automatically on startup with WAL mode for app DB and each project DB.
- Ownership invariants:
  - Single source of truth per table (global tables in app DB, project-local tables in project DB).
  - No cross-file foreign keys between app DB and project DB.
  - Cross-DB linkage is by IDs only; integrity is enforced in application logic.
- The AI command template must include `{prompt}` if you want prompt injection into command args.
- Shell metacharacters in `aiCommand` are blocked by validation.
