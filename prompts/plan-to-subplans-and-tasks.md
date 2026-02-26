# Plan -> Sub-Plans and Tasks Template

Use this template when decomposing a single Plan node into a DAG of `sub_plan` and `execution_task` items.

## Include Shared Section

Include `prompts/shared-input-output.md`.

## Inputs Required For This Template

- Plan node context (`node.id`, `node.tier=plan`, `node.parent_id`, `node.children_ids`, `node.status`).
- Parent plan lineage depth (integer) and `max_sub_plan_recursion_depth` (currently `6`).
- Merge target context for each candidate item (workspace/branch or equivalent merge target identity).
- Constraints from parser/materializer behavior:
  - YAML must parse via `server/src/services/planParser.ts`.
  - Materialization constraints must satisfy `server/src/application/cliServices.ts` approval checks.

## Decision Rules For `item_type`

Choose `item_type` deterministically per item:

1. Set `item_type: sub_plan` only if the item itself requires additional planning/orchestration rounds, independent review/approval, or staged child DAG expansion.
2. Set `item_type: execution_task` for directly executable engineering work that can be completed in one task runtime.
3. If uncertain, default to `execution_task`.
4. Never use both automation models on one item:
- `execution_task` may set `auto_merge` only.
- `sub_plan` may set `auto_start` and/or `auto_merge_on_complete` only.
5. Enforce depth guard before emitting `sub_plan`:
- `next_depth = parent_depth + 1` (or `0` when targeting root/no parent plan).
- If `next_depth > max_sub_plan_recursion_depth`, emit as `execution_task` instead and record risk/escalation in structured payload.

## YAML Output Contract (Parser-Compatible)

Emit YAML in a fenced block with top-level `tasks:` (or `items:` for compatibility).

Top-level defaults (required in this template output):

- `auto_start: <bool>` default for all `sub_plan` items that do not override.
- `auto_merge_on_complete: <bool>` default for all `sub_plan` items that do not override.
- `auto_merge_item_keys: [<item_key>, ...]` execution items eligible for auto-merge by default.

Each item MUST include:

- `id` (item key; unique, stable, non-empty)
- `title`
- `prompt` (non-empty; may use block scalar)
- `item_type` (`execution_task` or `sub_plan`)
- `depends_on` (explicit list, `[]` when none)

Item-level automation fields:

- `execution_task`: optional `auto_merge: true|false`; must not set `auto_start` or `auto_merge_on_complete`.
- `sub_plan`: optional `auto_start: true|false`, `auto_merge_on_complete: true|false`; must not set `auto_merge`.

## Dependency and Topology Safeguards

Before finalizing output, validate and only emit a DAG that satisfies all checks:

1. No self-dependencies.
2. No unknown dependencies (every `depends_on` key exists in emitted items).
3. No cycles.
4. Dependency edges must remain within compatible parent-plan/merge-target topology boundaries so approval does not fail.
5. Use stable, lowercase-friendly item keys to prevent alias drift.

## Required Structured Payload Additions

In addition to `docs/architecture/prompt-contract.md`, include these fields:

```yaml
plan_decomposition:
  parent_plan_id: string
  parent_depth: number
  max_sub_plan_recursion_depth: 6
  defaults:
    auto_start: boolean
    auto_merge_on_complete: boolean
    auto_merge_item_keys:
      - string
  items:
    - item_key: string
      item_type: execution_task | sub_plan
      depends_on:
        - string
      topology_scope:
        parent_plan_id: string | null
        merge_target: string
      automation:
        auto_merge: boolean
        auto_start: boolean
        auto_merge_on_complete: boolean
      idempotency:
        decomposition_fingerprint: string
```

`decomposition_fingerprint` must be deterministic from normalized inputs (parent plan id, item key, normalized prompt intent, dependency set, item type, automation flags).

## Output

Return all three sections:

1. Natural-language rationale
2. Structured payload (prompt-contract compliant + `plan_decomposition` extension)
3. Parser-compatible YAML task list
