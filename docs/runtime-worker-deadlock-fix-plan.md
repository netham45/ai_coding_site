# Runtime Worker Deadlock Elimination Plan

## Context
A regression test now exists that reproduces the deadlock condition:
- `server/src/integration.test.ts` test name:
  - `start endpoint does not hang when a same-task runtime worker is already wedged`

This test currently fails by design (before fix) and must pass after this plan is implemented.

## Problem Statement
The current runtime execution path uses in-memory per-task keyed promise serialization (`runtime-task:<taskId>`) and allows API/CLI/background callers to await work directly behind the same key.

This creates a deadlock class:
1. One head job for a task key stalls indefinitely.
2. All later work for that task key queues behind it forever.
3. API endpoints awaiting that work hang.

This is architectural, not a timeout-tuning issue.

## Root Cause
The system conflates two concerns into one primitive:
1. Mutual exclusion for task runtime state.
2. Request/response execution path for long-running runtime operations.

Because request handlers call runtime worker functions directly and await completion, a stalled keyed worker head blocks request completion.

## Target Architecture
Replace direct keyed promise execution with a durable per-task command queue and task actor model:
1. Producers (API/CLI/queue/orchestration) enqueue commands only.
2. A single actor per task consumes commands in strict order.
3. Runtime state mutations are actor-owned only.
4. HTTP/CLI responses do not await runtime execution.

## Non-Negotiable Invariants
1. Exactly one active runtime command consumer per `task_id`.
2. Command ordering is deterministic per task.
3. Command queue state is durable and recoverable across process restarts.
4. Request handlers never block on runtime execution completion.
5. No synchronous re-entry from orchestration/queue into runtime execution.

## Data Model Changes

### New table: `runtime_commands`
Columns:
1. `id TEXT PRIMARY KEY`
2. `project_id TEXT NOT NULL`
3. `task_id TEXT NOT NULL`
4. `command_type TEXT NOT NULL CHECK (command_type IN ('start','input','pull_main','regenerate_plan'))`
5. `payload TEXT NOT NULL`
6. `idempotency_key TEXT NOT NULL`
7. `status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','canceled'))`
8. `attempt_count INTEGER NOT NULL DEFAULT 0`
9. `error TEXT NULL`
10. `created_at TEXT NOT NULL`
11. `started_at TEXT NULL`
12. `finished_at TEXT NULL`
13. `updated_at TEXT NOT NULL`

Indexes:
1. `UNIQUE(task_id, idempotency_key)`
2. `(status, created_at)`
3. `(task_id, status, created_at)`

### New table: `runtime_worker_leases`
Columns:
1. `task_id TEXT PRIMARY KEY`
2. `owner_id TEXT NOT NULL`
3. `lease_expires_at TEXT NOT NULL`
4. `updated_at TEXT NOT NULL`

Purpose:
- Enforce single active consumer per task with crash-safe lease expiry.

## Code Changes

### 1) Migrations and DB schema wiring
Files:
- `server/src/db/migrations.ts`
- `server/src/db/projectDb.ts`
- `server/src/db/projectDataMigration.ts`

Actions:
1. Add schema migration for new tables and indexes.
2. Ensure migration applies in monolith and project DB modes.
3. Backfill nothing (new empty tables).

Rationale:
- Persistence is required to break in-memory deadlock coupling.

### 2) Runtime command store
New files:
- `server/src/services/runtimeCommandTypes.ts`
- `server/src/services/runtimeCommandStore.ts`

APIs:
1. `enqueueRuntimeCommand(...)`
2. `claimNextRuntimeCommand(taskId, ownerId)`
3. `markRuntimeCommandRunning(...)`
4. `markRuntimeCommandSucceeded(...)`
5. `markRuntimeCommandFailed(...)`
6. `getRuntimeCommandById(...)`

Rationale:
- Centralize queue semantics, idempotency, and transactional correctness.

### 3) Task actor runtime consumer
New file:
- `server/src/services/runtimeActor.ts`

Responsibilities:
1. Acquire/renew task lease.
2. Claim queued commands in order.
3. Execute runtime primitive (`startTaskRuntime`, `sendTaskRuntimeInput`, etc.).
4. Persist command result and emit events.
5. Recover stale running commands when lease expires.

Rationale:
- Explicit single-writer ownership removes implicit lock chains.

### 4) Refactor runtime worker layer to enqueue-only
File:
- `server/src/services/runtimeWorker.ts`

Actions:
1. Replace direct `runInKeyedAsyncWorker` execution for runtime commands.
2. Convert exported entry points to enqueue command + trigger actor.
3. Return command metadata (`commandId`, `status`) instead of execution completion.

Rationale:
- Remove request blocking behind in-memory keyed tail.

### 5) Convert API/CLI endpoints to async command semantics
Files:
- `server/src/routes/tasks.ts`
- `server/src/application/cliServices.ts`

Actions:
1. `/tasks/:taskId/start` and `/tasks/:taskId/input` enqueue and return immediately (`202`).
2. Add command status endpoint (e.g., `/api/runtime-commands/:id`).
3. Update CLI output to include command IDs and status polling guidance.

Rationale:
- Request lifecycle decoupled from runtime execution lifecycle.

### 6) Remove synchronous runtime execution from background workers
Files:
- `server/src/services/queue.ts`
- Orchestration code paths that currently call runtime worker entry points.

Actions:
1. Queue/orchestration enqueue runtime commands only.
2. Do not await runtime execution from these workers.

Rationale:
- Prevent cross-subsystem wait cycles.

### 7) Restrict runtime state mutation to actor path
File:
- `server/src/services/runtime.ts`

Actions:
1. Keep low-level operations, but call only from actor pipeline.
2. Add guard/check to prevent direct request-path invocation.

Rationale:
- Single mutation owner reduces race and deadlock surface.

### 8) Startup and recovery integration
File:
- `server/src/index.ts`

Actions:
1. Start runtime actor manager at boot.
2. Recover stale leases and requeue/retry eligible commands.

Rationale:
- Guarantees progress after crash/restart.

## Deadlock Regression Test Strategy

### Existing definitive repro test
- `server/src/integration.test.ts`:
  - `start endpoint does not hang when a same-task runtime worker is already wedged`

Current behavior:
- Fails with request hang timeout.

Expected after fix:
- Passes because endpoint returns quickly with queued command response.

### Additional tests to add
1. Input endpoint equivalent deadlock repro (`/input` with wedged task key).
2. Cross-task isolation: wedged command for task A must not affect task B.
3. Actor recovery: stale lease expires and new actor continues processing.
4. Ordering guarantee: commands for same task execute in FIFO order.

## Rollout Plan

### Phase 1: Introduce command tables + actor behind feature flag
Flag:
- `RUNTIME_COMMAND_ACTOR_ENABLED=false` default initially.

Deliverables:
1. New schema and command store.
2. Actor implementation.
3. Enqueue path available but optional.

### Phase 2: Shadow mode in staging
1. Enable actor.
2. Keep legacy path as fallback.
3. Verify command progression and no hanging start/input requests.

### Phase 3: Production enablement
1. Enable actor path.
2. Monitor command backlog, failures, and latency.
3. Keep fast rollback via flag for one release window.

### Phase 4: Remove legacy keyed runtime execution path
1. Delete deadlock-prone keyed request execution route.
2. Keep `asyncWorker` for non-critical short-lived jobs only.

## Monitoring and Observability
Add structured metrics/log counters:
1. `runtime_command_enqueued_total`
2. `runtime_command_running_total`
3. `runtime_command_succeeded_total`
4. `runtime_command_failed_total`
5. `runtime_command_queue_depth`
6. `runtime_actor_lease_steal_total`
7. `runtime_command_end_to_end_latency_ms`

Alert conditions:
1. Queue depth sustained above threshold.
2. Running commands exceeding expected TTL.
3. Repeated lease stealing on same task.

## Acceptance Criteria
1. Deadlock repro test passes reliably.
2. `/start` and `/input` no longer hang when runtime execution is wedged.
3. Same-task command ordering preserved.
4. Process restart recovers queued/running commands without manual intervention.
5. No synchronous runtime execution in request handlers.

## Risks and Mitigations
1. Behavioral API change (`202` vs immediate completion).
   - Mitigation: explicit command status endpoint and client-side polling guidance.
2. Actor bugs may affect command progression.
   - Mitigation: lease-based recovery, retries, and integration tests.
3. Migration complexity with split persistence.
   - Mitigation: dual-mode migration tests in monolith and project DB.

## Implementation Order
1. Add schema + store + tests for queue semantics.
2. Implement actor and lease recovery.
3. Convert runtimeWorker to enqueue-only.
4. Convert routes/CLI to async command contract.
5. Convert queue/orchestration producers.
6. Enable flag in staging and validate deadlock repro passes.
7. Promote to production and remove legacy path.
