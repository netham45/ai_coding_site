# Task to Exec Tasks Runtime Prompt

## Goal
Decompose a `task` node into concrete `exec` children that can be executed with clear sequencing, acceptance checks, and merge readiness criteria.

## Non-Goals
- Editing repository code directly.
- Creating further planning tiers (`phase`, `plan`, `sub_plan`).
- Emitting exec items without test/verification expectations.

## Definition of Done
- Narrative and structured payload are present.
- Each exec child has objective, prompt, dependencies, DoD, and required checks.
- Output supports deterministic retry without duplicate child creation.

## Dependencies
- `prompts/shared-input-output.md`
- `docs/architecture/prompt-contract.md`
- Parent task context, repo context, and required validation commands.
- CLI tree/context inspection:
  - `npm run cli -- tasks get <taskId> --project-id <projectId> --json`
  - `npm run cli -- tasks all --project-id <projectId> --json`
  - `npm run cli -- plans list --project-id <projectId> --json`
  - `npm run cli -- tasks details <taskId> --project-id <projectId> --json` (sample related tasks)
- Code/docs inspection for touched areas before creating exec children.

## Artifacts
- `docs/tasks/<task-id>/exec-breakdown.yaml`
- `docs/tasks/<task-id>/exec-rationale.md`

## Risks
- Over-fragmentation causing orchestration overhead.
- Under-specification causing unclear execution behavior.
- Missing dependency rationale causing invalid ordering.

## Idempotency
- Stable exec child IDs for unchanged decomposition intent.
- Deterministic fingerprints and dedupe key per task + normalized input.

## Bounded Iteration
- `max_iterations: 3`
- `max_replans: 1`
- Stop when exec set is complete and non-overlapping.

## Auto-Merge Guidance
- Provide per-exec recommendation only when checks are explicit.
- Default to manual merge when risk or uncertainty is non-trivial.

## Runtime Prompt Text
You are decomposing one `task` into executable `exec` children.

Research-first requirement: before proposing `exec_children`, inspect related nodes in the hierarchy via CLI and review the relevant code/docs. Use those findings to avoid duplicate or conflicting work.

Minimize overlap, preserve deterministic IDs, and include concrete validation expectations for each child. Include blockers and escalation actions if prerequisites are missing.

## Structured Output Contract
Return exactly two sections:
1. Narrative decomposition rationale.
2. Structured payload (YAML preferred) with shared contract and `exec_children`:

```yaml
schema_version: "1.0"
node:
  id: "<task-id>"
  tier: task
  parent_id: "<plan-or-phase-id>"
  children_ids: ["<exec-id>"]
  status: awaiting_children

goals: ["<goal>"]
non_goals: ["<non-goal>"]
definition_of_done: ["<DoD>"]
deps:
  - id: "<dependency-id>"
    reason: "<why required>"
artifacts:
  - path: "docs/tasks/<task-id>/exec-breakdown.yaml"
    kind: file
    required: true
risks:
  - risk: "<risk>"
    impact: medium
    mitigation: "<mitigation>"
idempotency:
  input_fingerprint: "<hash>"
  output_fingerprint: "<hash>"
  dedupe_key: "task-to-exec-tasks:<task-id>:<input-fingerprint>"
  idempotent: true
bounded_iteration:
  max_iterations: 3
  max_replans: 1
  stop_conditions:
    - "All required exec work is represented"
    - "No dependency ambiguity"
  escalation_on_limit: "Escalate unresolved blocker to task owner"
auto_merge_guidance:
  eligible: false
  strategy: manual
  required_checks:
    - "Exec-level acceptance checks defined"
    - "Dependency order validated"
  blockers:
    - "Unknown prerequisite or unresolved dependency"

exec_children:
  - id: "<exec-id>"
    tier: exec
    title: "<short title>"
    objective: "<single executable outcome>"
    prompt: "<runtime instruction text for child exec task>"
    deps:
      - id: "<exec-or-upstream-id>"
        reason: "<why dependency exists>"
    goals: ["<goal>"]
    non_goals: ["<non-goal>"]
    definition_of_done: ["<measurable DoD>"]
    required_checks:
      - command: "<test/build/lint command>"
        purpose: test
    artifacts:
      - path: "<artifact-path>"
        kind: file
        required: true
    risks:
      - risk: "<risk>"
        impact: low
        mitigation: "<mitigation>"
    auto_merge_guidance:
      eligible: false
      strategy: manual
      required_checks: ["<check>"]
      blockers: []
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
    coverage_note: "Show related branches reviewed before exec decomposition"
```
