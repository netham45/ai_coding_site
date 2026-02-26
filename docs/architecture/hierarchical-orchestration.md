# Hierarchical Orchestration Baseline

## Purpose

Define a strict orchestration abstraction over existing primitives without adding new storage primitives.

Hierarchy:

- Epoch
- Phase
- Plan
- Task
- Exec

This hierarchy is metadata and conventions layered on top of existing `tasks`, `plan_revisions`, and orchestration state.

## Abstraction Mapping to Existing Runtime

No new database tables are introduced. Each hierarchy tier maps to existing records and fields.

| Tier | Runtime representation | Current storage/services |
| --- | --- | --- |
| Epoch | Metadata grouping of one or more phases across a project lifecycle | Stored in node metadata artifact and prompts; not a new table |
| Phase | Metadata grouping of plans/tasks under an epoch | Stored in node metadata artifact and prompts; not a new table |
| Plan | `tasks` row with `mode='plan'` plus revision rows | `tasks`, `plan_revisions`, `plan_revision_items`, `plan_revision_item_dependencies` |
| Task | `tasks` row with `mode='execution'` or `mode='plan'` for sub-plan nodes | `tasks`, `task_dependencies`, `task_state_transitions` |
| Exec | Active execution session for a task | `task_sessions`, runtime worker/session services |

## Canonical Node Metadata Contract

Each orchestration node (Epoch/Phase/Plan/Task/Exec) MUST carry this canonical metadata payload in prompt output artifacts and runtime handoffs:

```yaml
node:
  id: string
  tier: epoch | phase | plan | task | exec
  title: string
  status: queued | in_progress | waiting_input | awaiting_children | merge_ready | merged | cancelled | failed | merge_conflict
  parent:
    id: string | null
    tier: epoch | phase | plan | task | exec | null
  children:
    ids: [string]
  dependencies:
    ids: [string]
  idempotency:
    input_hash: string
    output_hash: string
    dedupe_key: string
    retry_count: number
    max_retries: number
  merge:
    strategy: manual | auto_merge
    auto_merge: boolean
    auto_merge_on_complete: boolean
    merge_target_ref: string
  iteration_budget:
    max_iterations: number
    max_replans: number
    stop_when:
      - string
  evidence:
    references:
      - type: file | commit | log | test | link
        ref: string
        note: string
```

Notes:

- `dependencies.ids` maps to `task_dependencies` for materialized tasks.
- Plan item dependency ids map through `plan_revision_items.item_key` and `plan_revision_item_dependencies`.
- `idempotency.output_hash` maps to orchestration dedupe (`plan_orchestration_state.last_approved_output_sha256` and related fields).
- `merge.*` maps to existing task fields (`auto_merge`, `auto_merge_on_complete`) and current merge flows.
- Epoch/Phase are represented as metadata labels over existing Plan/Task records until dedicated storage is needed.

## Service Consumption Points

The contract is consumed by existing services:

- `server/src/services/planParser.ts`
  - Parses planner output into strict structured plan items (`tasks`, ids, deps, item types, automation flags).
  - Validates missing prompts, unknown deps, and cycle constraints.
- `server/src/services/planOrchestrator.ts`
  - Uses idempotency hash + lock metadata to auto-extract and auto-approve once per distinct output.
  - Tracks failure/retry and approval state in `plan_orchestration_state`.
- `server/src/application/cliServices.ts`
  - `extractPlan`: converts raw runtime output into revision/item records.
  - `approvePlan`: materializes approved items into child tasks/sub-plans and dependency edges.
  - Planner prompt composition (`buildPlanTaskPrompt`) provides output requirements consumed by parser/orchestrator.

## Runtime Prompt Artifact Conventions

Prompt artifacts live in `/prompts`:

- One markdown file per runtime prompt template.
- Shared required input/output sections in dedicated shared docs.
- Strict machine-readable output schema contract defined in [prompt-contract.md](./prompt-contract.md).

Current prompt artifact index: [`/prompts/README.md`](../../prompts/README.md)

## Naming and File Conventions

- Directory: `/prompts`
- File naming: `<tier>-<action>.md` (kebab-case)
- Shared sections:
  - `prompts/shared-input-output.md`
- Suggested templates:
  - `prompts/plan-generate.md`
  - `prompts/plan-extract.md`
  - `prompts/plan-approve.md`
  - `prompts/task-execution.md`

## Rollout Constraints

- Do not add new storage primitives for Epoch/Phase.
- Persist only existing Plan/Task/session/revision/orchestration records.
- Enforce strict prompt IO schema at parser/approval boundaries before materializing children.
