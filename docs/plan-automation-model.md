# Plan Automation Model, YAML Contract, and Rollout Guide

This document covers the current plan automation behavior implemented in `server/src/services/planOrchestrator.ts`, `server/src/application/cliServices.ts`, and `server/src/services/planParser.ts`.

## User-facing summary

- Plan tasks can be fully automated when `auto_start=true`.
- Automation reads `.ai-plan/latest-plan.yaml` from the plan workspace.
- Extraction and approval are triggered only when the plan task is `waiting_input`.
- Approved plan items create child tasks with `task_dependencies` wired from YAML `depends_on`.
- When approving from an auto-start plan, execution children default to `auto_merge=true` unless overridden.

## Automation model

### Orchestration trigger conditions

A plan is eligible for orchestration only if all are true:

- `mode = plan`
- `auto_start = 1`
- `status = waiting_input`
- `.ai-plan/latest-plan.yaml` exists and is non-empty

The worker runs every 10 seconds, scans eligible plans, and processes up to 8 plans per pass.

### Idempotency and retries

- Output is normalized and hashed (`sha256`).
- If `last_approved_output_sha256` matches, orchestration skips.
- On extraction or approval failure, orchestration stores `last_failed_output_sha256`.
- Failed output is not retried until the plan file changes to a different hash.
- When hash changes after a failure, event `plan.orchestration.retry.started` is emitted before retry.

### Locking behavior

- Per-plan lock state is stored in `plan_orchestration_state`.
- Lock TTL is 3 minutes (`lock_token`, `lock_expires_at`).
- This protects concurrent workers within DB/lock scope.

## YAML contract

Planner output must be YAML with top-level `tasks:` (or legacy `items:`).

### Top-level fields

- `tasks:` (required list)
- `auto_start: true|false` (optional default for `sub_plan` items)
- `auto_merge_on_complete: true|false` (optional default for `sub_plan` items)
- `auto_merge_item_keys: [id1, id2]` or list form (optional default auto-merge set for `execution_task` items)

### Per-item required fields

- `id` unique key
- `title`
- `prompt`

### Per-item optional fields

- `item_type: execution_task | sub_plan` (default: `execution_task`)
- `depends_on: [other_ids]` or list form
- `auto_merge` (execution tasks only)
- `auto_start` and `auto_merge_on_complete` (sub-plan items only)

### Validation rules

- Every item must have `id` and non-empty `prompt`.
- Duplicate IDs are rejected.
- Unknown dependencies are rejected.
- Self-dependencies are rejected.
- Cycles are rejected across mixed item types.
- `execution_task` cannot set `auto_start` or `auto_merge_on_complete`.
- `sub_plan` cannot set `auto_merge`.

### Backward compatibility

Legacy task-only YAML remains valid:

- no `item_type`
- no automation fields
- simple `tasks` + `depends_on`

## CLI options (current)

Run from `/server`:

```bash
npm run cli -- --help
```

Relevant commands and flags:

- `plans create --project <projectId> --title <title> --prompt <prompt> [--ai-command <cmd>] [--auto-start] [--auto-merge-on-complete] [--parent-plan-id <planId>]`
- `plans approve <planId> [--auto-merge-item-keys a,b] [--auto-start] [--auto-merge-on-complete] [--parent-plan-id <planId>] [--task-edits-file path.json]`
- `plans extract <planId>`
- `plans review <planId>`

Behavior notes:

- `plans create --auto-start` sets orchestration eligibility for that plan task.
- `plans approve --auto-merge-item-keys` explicitly enables auto-merge for listed execution children.
- If parent plan has `auto_start=1`, execution children default to `auto_merge=true` even without explicit keys.
- `--auto-start` and `--auto-merge-on-complete` on `plans approve` control defaults for created sub-plan children.

## Task and plan state machine (practical)

Statuses:

- Shared task statuses: `queued`, `in_progress`, `waiting_input`, `awaiting_children`, `merge_ready`, `merge_conflict`, `merged`, `cancelled`, `failed`
- Session statuses: `starting`, `running`, `waiting_input`, `stopped`, `crashed`, `failed`

Common automation transitions:

- `queued -> in_progress`: queue/runtime starts runnable task
- `in_progress -> waiting_input`: runtime idle or user stop/input boundary
- `waiting_input -> awaiting_children` (plan): child tasks exist and not all merged
- `awaiting_children -> merge_ready` (plan): last child merged (`plan_children_merged_auto_merge_ready`)
- `merge_ready -> merged`: manual merge or plan auto-merge-on-complete
- `merge_ready -> merge_conflict`: merge conflict during merge attempt

Plan orchestration events to monitor:

- `plan.orchestration.auto_extract.succeeded`
- `plan.orchestration.auto_extract.failed`
- `plan.orchestration.auto_approve.succeeded`
- `plan.orchestration.auto_approve.failed`
- `plan.orchestration.retry.started`

Parent-plan completion events:

- `plan.awaiting_children`
- `plan.mark_merge_ready` (payload `auto: true` when automatic)
- `plan.auto_merge_on_complete.started`
- `plan.auto_merge_on_complete.failed`

## Migration notes

1. Gate change for auto-start orchestration:
- Previous assumptions that queued plans might be auto-processed are invalid.
- Plans must reach `waiting_input` for auto extraction/approval.

2. Execution child default merge behavior:
- New default ties to parent plan `auto_start`.
- If parent `auto_start=1`, created execution children default `auto_merge=1`.

3. Retry semantics:
- Parse/approval failures persist per output hash.
- Re-running orchestration with unchanged YAML will not retry.
- Update `.ai-plan/latest-plan.yaml` to trigger retry.

4. Topology enforcement:
- Dependencies crossing parent-plan or merge-target boundaries are rejected at approval time.

5. Recursion depth cap:
- Sub-plan recursion depth is limited to 6.

## Operational cautions

- Deduping/coalescing is process-local plus DB lock based; multi-process fairness still needs operational care.
- Keep planner output deterministic and ensure file write + fenced YAML output stay in sync.
- Invalid YAML can leave plans in a repeated waiting state until output changes.
- High churn can delay plans because orchestration processes only a capped batch per pass.

## Staged rollout checklist

### Stage 0: Baseline (manual)

- Create plan without `--auto-start`.
- Run `plans extract` and `plans approve` manually.
- Confirm child dependency graph and merge target topology.

### Stage 1: Canary plans

- Enable `--auto-start` only for low-risk projects.
- Verify plans do not auto-process while `queued`.
- Move plan to `waiting_input`, then confirm auto extract + auto approve events.

### Stage 2: Failure-path validation

- Introduce invalid YAML intentionally in canary.
- Confirm `plan.orchestration.auto_extract.failed`.
- Fix YAML and confirm `plan.orchestration.retry.started` then `...auto_approve.succeeded`.

### Stage 3: Nested plan validation

- Approve plans that create both `execution_task` and `sub_plan` items.
- Verify recursion depth is within limit and topology constraints are respected.
- Validate parent transitions to `awaiting_children` until children merge.

### Stage 4: Merge automation

- Enable `--auto-merge-on-complete` for select parent plans.
- Verify parent transitions to `merge_ready` when children finish.
- Confirm conflict path (`merge_conflict`) and manual recovery flow (`ready_merge plan <planId>`).

### Stage 5: Broad enablement

- Expand `--auto-start` usage project-by-project.
- Track orchestration failure rates and pass throughput.
- Keep rollback path ready: disable auto-start on new plans and use manual extract/approve.
