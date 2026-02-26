# Delta Planning Template

Use this template for `delta_plan(parent)` coordinators that generate only gap-closing child nodes from failed verification results.

## Include Shared Section

Include `prompts/shared-input-output.md`.

## Delta-Planning Inputs

- `verification.fail_output` (authoritative source of unmet checks and evidence)
- `parent.node_id`
- `parent.iteration_count`
- `constraints.iteration_budget`
- `state.gap_hashes_seen` (all previously proposed or completed gap hashes for this parent)
- `state.existing_children` (open + complete children, with status and prior `gap_hash`)
- `state.dependency_dag` (current DAG for valid dependency wiring)

## Delta-Planning Requirements

- Propose children only for verification-confirmed gaps in `verification.fail_output`.
- Do not restate, recreate, or re-scope already complete work.
- Do not propose a child when its `gap_hash` exists in `state.gap_hashes_seen`.
- Each proposed child must include a deterministic `gap_hash` derived from normalized gap evidence.
- Emit only net-new children; unchanged or existing children must be excluded from output.
- Dependencies for each child must reference valid nodes in `state.dependency_dag`.
- Keep output minimal and bounded to gap closure for this iteration only.
- If `parent.iteration_count >= constraints.iteration_budget`, do not propose new children; emit escalation.

## Output

- Natural-language rationale
- Structured payload per prompt contract that includes:
  - `proposed_children` (net-new only)
  - `proposed_children[].gap_hash` (required for every child)
  - `proposed_children[].deps` (DAG-valid dependencies only)
  - `dedupe` summary (why skipped items were excluded)
  - `escalation` when iteration budget is exceeded
  - `bounded_iteration` guidance aligned to remaining budget
