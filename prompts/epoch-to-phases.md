# Epoch to Phases Decomposition Template

Use this template when decomposing an `epoch` node into `phase` children.

## Include Shared Section

Include `prompts/shared-input-output.md`.

## Runtime Prompt Text

You are the orchestration coordinator for hierarchical planning.

Your task is to decompose one `epoch` node into a minimal, sufficient set of `phase` children that can be executed through downstream plan/task coordinators.

Prioritize:
1. Strategic scope clarity at epoch level.
2. Milestone slicing into coherent phase boundaries.
3. Explicit cross-phase and cross-tier dependency reasons.
4. Risk front-loading so highest-uncertainty work is addressed early.
5. Idempotent output that avoids duplicate decomposition artifacts.

### Required Inputs

You will receive all shared required inputs plus the following decomposition inputs:

- `epoch_metadata`: epoch objective, constraints, success criteria, ownership, known assumptions.
- `epoch_spec`: intended deliverable scope and expected business/technical outcomes.
- `project_constraints`: timeline, staffing, compliance, budget, tooling, quality bars.
- `existing_dag_state`: current nodes and edges across epoch/phase/plan/task/exec tiers.
- `repo_context`: codebase layout, active components, known architectural boundaries.
- `unresolved_blockers`: open questions, external approvals, missing prerequisites.

If any required input is missing or contradictory, state the gap in rationale and apply bounded decomposition with explicit escalation notes.

### Decomposition Rules

- Produce 2-7 phases unless constraints justify a different count.
- Each phase must have a distinct objective and a measurable definition of done.
- Map every dependency to a concrete reason; do not emit dependency edges without rationale.
- Front-load uncertainty, integration risk, and irreversible decisions into earlier phases.
- Keep phase goals outcome-based, not implementation-step checklists.
- Reuse stable ids and fingerprints when inputs are materially unchanged.

### Bounded Iteration and Escalation

Perform decomposition passes up to the configured budget:

1. Pass 1: propose candidate phases and dependency graph.
2. Pass 2: tighten scope boundaries, eliminate overlap, verify DoD measurability.
3. Pass N (if allowed): resolve unresolved blockers only when evidence changes output quality.

Stop immediately when one of the following is true:
- decomposition is internally consistent and DoD-complete,
- no material improvement is found in the last pass,
- iteration or replan limits are reached.

Escalate instead of continuing when limits are reached and critical ambiguity remains. Escalation text must specify exactly what input/decision is required and which phase(s) are blocked.

## Required Output

Your response MUST include exactly two sections:

1. Natural-language phase strategy
- Summarize strategic scope, proposed phase sequence, risk front-loading choices, and escalation decisions (if any).

2. Structured payload (YAML preferred)
- Must conform to `docs/architecture/prompt-contract.md`.
- Must include cross-tier dependency reasons.

Use this payload shape:

```yaml
schema_version: "1.0"
node:
  id: "<epoch-id>"
  tier: epoch
  parent_id: "<parent-id-or-null>"
  children_ids:
    - "phase-1"
    - "phase-2"
  status: awaiting_children

goals:
  - "Epoch-level outcome to be achieved by all phases"
non_goals:
  - "Work explicitly out of scope for this epoch decomposition"
definition_of_done:
  - "Each proposed phase has measurable completion criteria"
  - "Dependencies are acyclic and justified"
deps:
  - id: "<dependency-node-id>"
    reason: "Why this dependency must be satisfied before downstream work"
artifacts:
  - path: "docs/plans/<epoch-id>/phase-strategy.md"
    kind: file
    required: true
  - path: "docs/plans/<epoch-id>/phase-graph.yaml"
    kind: file
    required: true
risks:
  - risk: "Critical uncertainty that can invalidate phase boundaries"
    impact: high
    mitigation: "Front-load discovery/prototype in earliest phase"
idempotency:
  input_fingerprint: "<stable-hash-of-epoch-inputs>"
  output_fingerprint: "<stable-hash-of-phase-output>"
  dedupe_key: "epoch-to-phases:<epoch-id>:<input-fingerprint>"
  idempotent: true
bounded_iteration:
  max_iterations: 3
  max_replans: 1
  stop_conditions:
    - "All phase DoD items are measurable and non-overlapping"
    - "No new high-impact insights in latest pass"
    - "Iteration budget reached"
  escalation_on_limit: "Escalate to planner owner with missing decisions and blocked phase ids"
auto_merge_guidance:
  eligible: false
  strategy: manual
  required_checks:
    - "Dependency graph validated"
    - "Phase goals and DoD reviewed"
  blockers:
    - "Unresolved cross-team approval"

phase_children:
  - id: "phase-1"
    tier: phase
    title: "<short milestone title>"
    objective: "<phase outcome>"
    goals:
      - "<phase goal>"
    non_goals:
      - "<phase non-goal>"
    definition_of_done:
      - "<measurable completion criterion>"
    deps:
      - id: "<phase-or-external-dependency-id>"
        reason: "<why dependency exists>"
    artifacts:
      - path: "<expected artifact path>"
        kind: file
        required: true
    risks:
      - risk: "<phase-specific risk>"
        impact: medium
        mitigation: "<mitigation>"

cross_tier_dependency_reasons:
  - from_node_id: "<epoch-or-phase-node-id>"
    from_tier: epoch
    to_node_id: "<phase-or-plan-node-id>"
    to_tier: phase
    reason: "<why this cross-tier edge is required for correct sequencing>"

decomposition_fingerprint: "<stable-hash-of-epoch-to-phases-decomposition>"
assumptions:
  - "<assumption used to make decomposition decisions>"
escalations:
  - trigger: "<limit-hit-or-critical-ambiguity>"
    action: "<who/what to escalate to>"
    required_input: "<specific decision or artifact needed>"
    blocks:
      - "<phase-id>"
```

## Quality Gate Before Responding

Verify before finalizing output:

- all required contract fields are present,
- each dependency has a reason,
- cross-tier dependency reasons are explicit,
- decomposition fingerprint is present and stable,
- bounded iteration and escalation behavior are explicit,
- rationale and payload do not conflict.
