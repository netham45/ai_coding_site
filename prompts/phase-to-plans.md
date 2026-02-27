# Phase to Plans Template

Use this template for decomposing a `phase` node into `plan` children that can be reviewed, extracted, and approved.

## Include Shared Section

Include `prompts/shared-input-output.md`.

## Runtime Inputs

Provide all fields below as input context to the coordinator:

- `mode`: `initial` or `refine`
- `phase_spec`: scope, constraints, deliverables, success criteria for the current phase
- `epoch_goals`: parent epoch goals and non-goals
- `dependency_statuses`: upstream/downstream node ids, statuses, and blocking notes
- `previous_synthesis`: most recent decomposition rationale/output (required for `refine`)
- `previous_verification`: review findings, validation failures, or approval feedback (required for `refine`)
- `repository_context`: relevant paths, modules, ownership boundaries, and current implementation state

## Decomposition Requirements

- Decompose phase work into sequenced `plan` children with clear boundaries and non-overlapping ownership.
- Model dependency fan-in/fan-out explicitly:
  - fan-in: multiple prerequisite plans that converge on a shared integration or verification plan
  - fan-out: a prerequisite plan that enables multiple parallel downstream plans
- Keep each child plan independently testable and reviewable with explicit deliverables.
- Preserve stable child plan ids across `refine` runs unless there is a clear reason to split/merge/replace.
- In `refine` mode, reconcile prior synthesis and verification feedback, explain changes, and keep unchanged plans intact.
- Ensure every dependency id is resolvable to known node ids.
- Do not emit cyclic dependencies.

## Required Output

Return both sections:

1. Natural-language decomposition rationale
2. Structured payload (`yaml` preferred) that satisfies `docs/architecture/prompt-contract.md`

The structured payload MUST include all shared contract fields and a `plan_children` section.

## Structured Payload Shape (YAML)

```yaml
schema_version: "1.0"
node:
  id: "<phase-node-id>"
  tier: phase
  parent_id: "<epoch-node-id>"
  children_ids:
    - "<plan-id-1>"
    - "<plan-id-2>"
  status: in_progress

goals:
  - "<phase decomposition outcome>"
non_goals:
  - "<explicitly excluded work>"
definition_of_done:
  - "<measurable completion criterion>"
deps:
  - id: "<dependency-node-id>"
    reason: "<why it is required>"
artifacts:
  - path: "<repo/path/or/artifact>"
    kind: file
    required: true
risks:
  - risk: "<decomposition or sequencing risk>"
    impact: medium
    mitigation: "<how risk is reduced>"
idempotency:
  input_fingerprint: "<stable hash over normalized inputs>"
  output_fingerprint: "<stable hash over normalized output>"
  dedupe_key: "<phase-id + input fingerprint + mode>"
  idempotent: true
bounded_iteration:
  max_iterations: 3
  max_replans: 2
  stop_conditions:
    - "<all blocking dependencies resolved>"
    - "<all plan DoD items are satisfiable>"
  escalation_on_limit: "<request human review with unresolved blockers>"
auto_merge_guidance:
  eligible: false
  strategy: manual
  required_checks:
    - "<review approved>"
    - "<dependency topology valid>"
  blockers:
    - "<missing required artifact>"

plan_children:
  - id: "<plan-id-1>"
    title: "<plan title>"
    objective: "<single plan objective>"
    sequencing:
      order: 1
      parallel_group: "<group-a|group-b|none>"
    dependencies:
      - id: "<plan-id-or-upstream-node-id>"
        reason: "<fan-in/fan-out rationale>"
    definition_of_done:
      - "<plan-level DoD>"
    deliverables:
      - artifact: "<repo/path/or/output>"
        module: "<module or subsystem>"
        boundary_reason: "<why this deliverable belongs to this plan>"
    touched_modules:
      - "<module/path>"
    risks:
      - risk: "<plan-local risk>"
        impact: low
        mitigation: "<mitigation>"
    idempotency:
      dedupe_key: "<stable child-plan dedupe key>"
      idempotent: true
    bounded_iteration:
      max_iterations: 2
      max_replans: 1
      stop_conditions:
        - "<plan stop condition>"
    auto_merge_defaults:
      auto_start: false
      auto_merge_on_complete: false

change_summary:
  mode: "<initial|refine>"
  retained_plan_ids:
    - "<plan-id-retained>"
  added_plan_ids:
    - "<plan-id-added>"
  removed_plan_ids:
    - "<plan-id-removed>"
  changed_plan_ids:
    - "<plan-id-updated>"
  refinement_reason: "<required when mode=refine>"
```

## Validation Rules

- The top-level payload fields required by `prompt-contract.md` are mandatory.
- `node.tier` MUST be `phase`.
- Every `plan_children[].id` MUST appear in `node.children_ids`.
- Every dependency entry MUST include both `id` and `reason`.
- `change_summary.refinement_reason` is required when `mode=refine`.
- If validation fails, regenerate output instead of emitting partial payload.
