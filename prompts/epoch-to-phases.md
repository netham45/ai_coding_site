# Epoch to Phases Runtime Prompt

## Goal
Decompose one `epoch` node into a minimal, sufficient set of `phase` children with explicit sequencing and dependency rationale.

## Non-Goals
- Writing implementation-level task steps.
- Creating `plan`, `task`, or `exec` children directly.
- Emitting speculative dependencies without evidence.

## Definition of Done
- Output includes narrative plus structured payload.
- Every proposed phase has measurable DoD.
- Dependency DAG is acyclic and every edge includes a reason.
- Required contract sections and fields are present.

## Dependencies
- `prompts/shared-input-output.md`
- `docs/architecture/prompt-contract.md`
- Current hierarchy/DAG snapshot for parent project.
- CLI visibility into hierarchy and node details:
  - `npm run cli -- tasks all --project-id <projectId> --json`
  - `npm run cli -- plans list --project-id <projectId> --json`
  - `npm run cli -- tasks details <taskId> --project-id <projectId> --json` (sample across related branches)
  - `npm run cli -- info <taskId> --project-id <projectId> --json` (sample)
- Repository evidence from code and docs (`README`, architecture docs, module boundaries).

## Artifacts
- `docs/plans/<epoch-id>/phase-strategy.md`
- `docs/plans/<epoch-id>/phase-graph.yaml`

## Risks
- Overlapping phase scope causing redundant downstream planning.
- Hidden external blockers invalidating dependency ordering.
- Unstable IDs causing duplicate children on retries.

## Idempotency
- Normalize inputs before decomposition.
- Reuse stable phase IDs when intent/scope is unchanged.
- Emit deterministic `input_fingerprint`, `output_fingerprint`, and `dedupe_key`.

## Bounded Iteration
- `max_iterations: 3`
- `max_replans: 1`
- Stop when decomposition is complete, no material improvement is found, or limits are reached.
- Escalate with exact missing decisions when limits are reached with unresolved critical ambiguity.

## Auto-Merge Guidance
- Decomposition output is not merge-ready by default.
- `eligible: false` unless explicitly configured by controller policy.
- Require dependency and DoD review before merge.

## Runtime Prompt Text
You are the hierarchical orchestration coordinator.

Before proposing any `phase` layout, run a research pass:
1. Inspect the existing hierarchy/tree using CLI outputs (other epochs/phases/plans/tasks, not just the target node).
2. Inspect relevant code paths and documentation to ground scope and boundaries.
3. Summarize findings and only then propose decomposition.

Produce a deterministic decomposition from one `epoch` into `phase` children grounded in that evidence. Prioritize outcome-oriented phase boundaries, front-load uncertainty, and enforce explicit dependency reasons. Keep output idempotent and avoid duplicate children for unchanged inputs.

If required input is missing or contradictory, continue with bounded assumptions, mark risks, and emit escalation requirements.

## Structured Output Contract
Return exactly two sections:
1. Narrative strategy.
2. Structured payload (YAML preferred) compliant with `docs/architecture/prompt-contract.md` and this extension:

```yaml
schema_version: "1.0"
node:
  id: "<epoch-id>"
  tier: epoch
  parent_id: "<parent-id-or-null>"
  children_ids: ["<phase-id>"]
  status: awaiting_children

goals: ["<epoch outcome>"]
non_goals: ["<out-of-scope>"]
definition_of_done: ["<measurable checks>"]
deps:
  - id: "<node-id>"
    reason: "<dependency reason>"
artifacts:
  - path: "docs/plans/<epoch-id>/phase-graph.yaml"
    kind: file
    required: true
risks:
  - risk: "<risk>"
    impact: medium
    mitigation: "<mitigation>"
idempotency:
  input_fingerprint: "<hash>"
  output_fingerprint: "<hash>"
  dedupe_key: "epoch-to-phases:<epoch-id>:<input-fingerprint>"
  idempotent: true
bounded_iteration:
  max_iterations: 3
  max_replans: 1
  stop_conditions:
    - "DoD complete"
    - "No material improvement"
    - "Iteration budget reached"
  escalation_on_limit: "Escalate missing decisions with blocked phase IDs"
auto_merge_guidance:
  eligible: false
  strategy: manual
  required_checks:
    - "Dependency DAG review"
    - "Phase DoD review"
  blockers:
    - "Unresolved external blocker"

phase_children:
  - id: "<phase-id>"
    tier: phase
    title: "<title>"
    objective: "<outcome>"
    goals: ["<goal>"]
    non_goals: ["<non-goal>"]
    definition_of_done: ["<measurable DoD>"]
    deps:
      - id: "<dependency-id>"
        reason: "<why required>"
    artifacts:
      - path: "<artifact-path>"
        kind: file
        required: true
    risks:
      - risk: "<risk>"
        impact: low
        mitigation: "<mitigation>"

cross_tier_dependency_reasons:
  - from_node_id: "<epoch-or-phase-id>"
    from_tier: epoch
    to_node_id: "<phase-or-plan-id>"
    to_tier: phase
    reason: "<cross-tier rationale>"

assumptions: ["<assumption>"]
research_evidence:
  cli_queries:
    - command: "npm run cli -- tasks all --project-id <projectId> --json"
      findings: "<what was learned>"
    - command: "npm run cli -- plans list --project-id <projectId> --json"
      findings: "<what was learned>"
  repo_reads:
    - path: "<file-or-dir>"
      findings: "<what was learned>"
  tree_coverage:
    reviewed_related_nodes: ["<node-id>"]
    coverage_note: "Confirm related branches were reviewed before decomposition"
escalations:
  - trigger: "<trigger>"
    action: "<owner/action>"
    required_input: "<needed decision/artifact>"
    blocks: ["<phase-id>"]
```
