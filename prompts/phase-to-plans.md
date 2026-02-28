# Phase to Plans Runtime Prompt

## Goal
Decompose one `phase` into a DAG of reviewable `plan` children with clear ownership boundaries.

## Non-Goals
- Defining execution-level code changes.
- Creating `task`/`exec` children directly.
- Rewriting stable plans in `refine` mode without justification.

## Definition of Done
- Narrative and structured payload are both present.
- Each plan has objective, DoD, dependencies with reasons, and deliverables.
- Fan-in/fan-out dependency patterns are explicit where applicable.
- Output is deterministic for identical normalized inputs.

## Dependencies
- `prompts/shared-input-output.md`
- `docs/architecture/prompt-contract.md`
- Parent phase metadata, dependency statuses, and repository context.
- CLI visibility into sibling/adjacent hierarchy:
  - `npm run cli -- plans list --project-id <projectId> --json`
  - `npm run cli -- tasks all --project-id <projectId> --json`
  - `npm run cli -- plans get <planId> --json` (sample relevant plans)
  - `npm run cli -- tasks summary <taskId> --project-id <projectId> --json` (sample)
- Relevant code/docs inspection for impacted modules and interfaces.

## Artifacts
- `docs/plans/<phase-id>/plan-decomposition.yaml`
- `docs/plans/<phase-id>/plan-rationale.md`

## Risks
- Plan overlap causing duplicate implementation effort.
- Invalid dependency references causing orchestration failures.
- Drift in plan IDs across refine runs.

## Idempotency
- Preserve unchanged plan IDs in `refine` mode.
- Use deterministic `dedupe_key` from `phase-id + mode + normalized inputs`.

## Bounded Iteration
- `max_iterations: 3`
- `max_replans: 2`
- Stop when all plan boundaries and DoD are coherent and blockers are explicit.

## Auto-Merge Guidance
- Default `eligible: false` for decomposition artifacts.
- Require review approval and topology validation before merge.

## Runtime Prompt Text
You are the coordinator decomposing a single `phase` into sequenced `plan` children.

Research-first rule: before drafting `plan_children`, inspect neighboring nodes in the tree via CLI and review relevant code/docs to understand existing ownership, prior work, and constraints.

Preserve non-overlapping ownership and ensure each plan is independently testable/reviewable. In `refine` mode, reconcile synthesis/verification feedback while minimizing churn.

## Structured Output Contract
Return exactly two sections:
1. `## Natural-language rationale`
2. `## Structured payload`

The `## Structured payload` section must be YAML (preferred) or JSON and compliant with the shared contract plus:

```yaml
schema_version: "1.0"
node:
  id: "<phase-id>"
  tier: phase
  parent_id: "<epic-id>"
  children_ids: ["<plan-id>"]
  status: awaiting_children

goals: ["<phase outcome>"]
non_goals: ["<excluded scope>"]
definition_of_done: ["<checks>"]
deps:
  - id: "<dependency-id>"
    reason: "<why required>"
artifacts:
  - path: "docs/plans/<phase-id>/plan-decomposition.yaml"
    kind: file
    required: true
risks:
  - risk: "<risk>"
    impact: medium
    mitigation: "<mitigation>"
idempotency:
  input_fingerprint: "<hash>"
  output_fingerprint: "<hash>"
  dedupe_key: "phase-to-plans:<phase-id>:<mode>:<input-fingerprint>"
  idempotent: true
bounded_iteration:
  max_iterations: 3
  max_replans: 2
  stop_conditions:
    - "All plan DoD items are satisfiable"
    - "Dependency topology valid"
  escalation_on_limit: "Escalate unresolved blockers to phase owner"
auto_merge_guidance:
  eligible: false
  strategy: manual
  required_checks:
    - "Plan review approved"
    - "Dependency validation passed"
  blockers:
    - "Missing required deliverable definitions"

plan_children:
  - id: "<plan-id>"
    title: "<title>"
    objective: "<objective>"
    sequencing:
      order: 1
      parallel_group: none
    dependencies:
      - id: "<node-id>"
        reason: "<fan-in/fan-out rationale>"
    goals: ["<goal>"]
    non_goals: ["<non-goal>"]
    definition_of_done: ["<measurable DoD>"]
    deliverables:
      - artifact: "<path-or-output>"
        module: "<module>"
        boundary_reason: "<why scoped here>"
    touched_modules: ["<module/path>"]
    risks:
      - risk: "<risk>"
        impact: low
        mitigation: "<mitigation>"

change_summary:
  mode: "<initial|refine>"
  retained_plan_ids: ["<plan-id>"]
  added_plan_ids: ["<plan-id>"]
  removed_plan_ids: ["<plan-id>"]
  changed_plan_ids: ["<plan-id>"]
  refinement_reason: "<required when mode=refine>"
research_evidence:
  cli_queries:
    - command: "npm run cli -- plans list --project-id <projectId> --json"
      findings: "<what was learned>"
    - command: "npm run cli -- tasks all --project-id <projectId> --json"
      findings: "<what was learned>"
  repo_reads:
    - path: "<file-or-dir>"
      findings: "<what was learned>"
  tree_coverage:
    reviewed_related_nodes: ["<node-id>"]
    coverage_note: "Show which adjacent branches informed this decomposition"
```
