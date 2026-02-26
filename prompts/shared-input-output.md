# Shared Required Inputs and Outputs

## Required Inputs

- `node.id`
- `node.tier`
- `node.parent_id`
- `node.children_ids`
- `node.status`
- `context.project_id`
- `context.task_or_plan_id`
- `context.workspace_path`
- `constraints.iteration_budget`
- `constraints.idempotency`
- `constraints.merge_policy`

## Required Outputs

1. Natural-language rationale
2. Structured payload that includes:
   - `goals`
   - `non_goals`
   - `definition_of_done`
   - `deps`
   - `artifacts`
   - `risks`
   - `idempotency`
   - `bounded_iteration`
   - `auto_merge_guidance`

The structured payload must conform to `docs/architecture/prompt-contract.md`.
