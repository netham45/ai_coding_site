# CLI Command Architecture and Reusable Modules

## Goal

Define a new CLI tool architecture that reuses existing backend business logic (database access, task/plan/project behaviors, runtime orchestration) rather than duplicating route code.

## Repository Findings

### 1) Database access layers

- App DB bootstrap and lifecycle:
  - `server/src/db/appDb.ts`
  - Initializes `app.sqlite`, applies app migrations, seeds local user/settings, triggers project data migration backfill.
- Project DB bootstrap and validation:
  - `server/src/db/projectDb.ts`
  - Creates/opens `data/projects/<projectId>/project.sqlite`, validates `project_metadata`, enforces schema version, maintains handle cache.
- DB backend routing (monolith vs project DB):
  - `server/src/db/splitPersistence.ts`
  - `resolveProjectDatabase()` chooses DB backend by phase/migration status with fallback behavior.
- SQL and schema ownership:
  - `server/src/db/migrations.ts`
  - App DB: users/settings/projects/memberships.
  - Project DB: project config, tasks, dependencies, transitions, sessions, plans, events, merge records, IDE instances.
- Instrumented SQLite adapter:
  - `server/src/db/sqlite.ts`
  - Uses `better-sqlite3`, standardized pragmas, and DB statement logging.

### 2) Task/Plan/Project models

- Row/type definitions:
  - `server/src/types.ts`
  - Central source of row models for `ProjectRow`, `TaskRow`, `PlanRevisionRow`, sessions, events, merge records, etc.
- Project lifecycle and config:
  - `server/src/routes/projects.ts`
  - Uses `cloneRepo`, `ensureProjectDb`, `getProjectConfig`, `upsertProjectConfig`.
- Task lifecycle:
  - `server/src/routes/tasks.ts`
  - Create/list/update/start/input/pull/merge-ready/cancel/merge APIs with dependency handling and transition/event writes.
- Plan lifecycle:
  - `server/src/routes/plans.ts`
  - Create plan tasks, extract/parse revisions, request feedback, approve into execution tasks.

### 3) Current CLI-like command patterns already in code

- Safe process invocation pattern:
  - `server/src/services/git.ts`, `server/src/services/tmux.ts`, `server/src/services/ide.ts`
  - Uses `execFile`/`spawn` with argv arrays (not shell strings), timeout controls, and controlled env.
- AI command policy:
  - `server/src/services/adapters.ts`
  - `buildCommand()` tokenizes `ai_command`, blocks shell metacharacters, replaces `{prompt}`.
- Non-interactive runtime/git env:
  - `server/src/services/runtime.ts`, `server/src/services/git.ts`
  - Sets `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=Never`.
- Serialized per-task execution:
  - `server/src/services/runtimeWorker.ts`, `server/src/services/asyncWorker.ts`
  - Keyed async workers avoid concurrent mutation races.

## Reusable Modules for a New CLI

Use directly:

- DB/bootstrap
  - `getAppDb`, `ensureLocalUser` (`server/src/db/appDb.ts`)
  - `resolveProjectDatabase` (`server/src/db/splitPersistence.ts`)
  - `ensureProjectDb`, `getProjectDb`, `getProjectConfig`, `upsertProjectConfig` (`server/src/db/projectDb.ts`)
- Runtime/task operations
  - `startTaskRuntime`, `sendTaskRuntimeInput`, `triggerAutoMergeIfEligible` (`server/src/services/runtime.ts`)
  - `startTaskRuntimeWorker`, `sendTaskRuntimeInputWorker` (`server/src/services/runtimeWorker.ts`)
  - `kickTaskQueueProcessing` (`server/src/services/queue.ts`)
- Git operations
  - `cloneRepo`, `cloneLocalBaseToWorkspace`, `createTaskBranch`, `getHeadCommitSha`, `getWorkspaceGitStatus`, merge helpers (`server/src/services/git.ts`)
- Prompt and plan parsing
  - `buildEffectivePrompt` (`server/src/services/promptBuilder.ts`)
  - `parsePlanOutput`, `parsePlanYaml` (`server/src/services/planParser.ts`)
- Audit/event stream
  - `recordEvent` (`server/src/services/events.ts`)
- Validation/utilities
  - `isValidRepoUrl` (`server/src/utils/validation.ts`)
  - `makeId`, `nowIso`, slug helpers.

Needs extraction before clean CLI reuse (currently route-scoped/private):

- `projectForUser`/membership lookups and project-scoped DB selection.
- Task dependency resolution and topology resolution helpers.
- Task/plan serialization helpers.
- Task/plan creation transaction blocks now embedded in route handlers.

## Proposed CLI Architecture

## Design principles

- CLI is a thin adapter.
- Application services own business rules and SQL transactions.
- No business logic in argument parser or command handlers.
- API routes and CLI call the same service entrypoints.

## Layers

1. CLI transport layer (`server/src/cli/*`)
- Parse args, flags, and output mode (`table`, `json`).
- Map CLI command -> application service call.
- Convert service errors to exit codes and stderr messages.

2. Application service layer (`server/src/application/*`) [new]
- Extract route-embedded domain logic into reusable units:
  - `projectService.ts`
  - `taskService.ts`
  - `planService.ts`
  - `settingsService.ts`
- Accept explicit context:
  - `actorUserId`
  - `projectId`/`taskId`
  - resolved DB handles (app/project DB as needed)
- Perform transactions, state transitions, event writes.

3. Infrastructure layer (existing, mostly keep as-is)
- `db/*`, `services/git.ts`, `services/runtime.ts`, `services/adapters.ts`, `services/tmux.ts`, `services/ide.ts`.

## CLI command tree (v1)

- `acs project create --name --repo-url --default-branch [--project-prompt ...]`
- `acs project list`
- `acs project get <projectId>`
- `acs project update <projectId> [--name ... --project-prompt ...]`
- `acs project files <projectId> [--query ... --limit ...]`

- `acs task create --project <projectId> --title --prompt [--ai-command ...] [--depends-on id,id] [--auto-merge]`
- `acs task list --project <projectId>`
- `acs task get <taskId>`
- `acs task update <taskId> [--ai-command ...]`
- `acs task start <taskId>`
- `acs task input <taskId> --text "..."`
- `acs task pull-main <taskId>`
- `acs task mark-merge-ready <taskId>`
- `acs task cancel <taskId> --reason "..."`
- `acs task merge <taskId>`

- `acs plan create --project <projectId> --title --prompt [--ai-command ...]`
- `acs plan get <planId>`
- `acs plan extract <planId>`
- `acs plan regenerate <planId> --feedback "..."`
- `acs plan approve <planId> [--auto-merge-item-keys a,b] [--task-edit-file path.json]`

- `acs settings get`
- `acs settings set-default-ai --command "..."`
- `acs settings set-default-ai-list --commands "cmd1,cmd2,..."`

- `acs runtime queue kick`
- `acs runtime heartbeat start` (optional; mostly server concern)

- `acs db health`
- `acs db migrate-backfill` (optional wrapper around existing backfill entrypoint)

## Error and exit-code contract

- `0`: success.
- `2`: invalid CLI arguments/validation.
- `3`: not found.
- `4`: conflict/precondition failed (maps current HTTP 409 domain errors).
- `5`: unavailable/corrupt project DB.
- `1`: unhandled/internal error.

## Output contract

- Default human output: concise table/summary.
- `--json`: stable machine-readable structure mirroring existing API payloads where possible.

## Implementation Plan (no logic duplication)

1. Create service extraction layer from routes.
- Move route-private logic into `application/*`.
- Keep route behavior unchanged by swapping handlers to call application services.

2. Add CLI entrypoint and parser.
- `server/src/cli/index.ts`
- Add npm script, for example `npm run cli -w server -- ...`.

3. Implement command handlers as thin adapters.
- Each command calls exactly one application service operation.
- Reuse existing infrastructure modules (`db/*`, `services/*`).

4. Add integration tests for CLI.
- Focus on parity with existing route behavior for create/start/input/extract/approve/merge flows.

## Duplication Risks to Avoid

- Re-implementing SQL queries from routes in CLI handlers.
- Re-implementing AI command parsing (`buildCommand`) in CLI.
- Re-implementing git/tmux process invocation wrappers.
- Divergent state transition/event semantics between API and CLI paths.

## Recommended Immediate Refactors for Reuse

- Extract from `routes/tasks.ts`:
  - task creation transaction + dependency resolution
  - start/input/pull/merge-ready/cancel/merge domain operations
- Extract from `routes/plans.ts`:
  - plan creation, extraction/parsing persistence, regenerate, approval task generation
- Extract from `routes/projects.ts`:
  - project create/clone + config update logic
- Keep HTTP-only concerns in routes:
  - request parsing/response shaping/status codes.
