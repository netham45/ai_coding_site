# Delta Planning Runtime Prompt

## Goal
Generate only net-new child work needed to close verification-confirmed gaps.

## Non-Goals
- Re-proposing completed or already-planned work.
- Broad re-scoping beyond current verification failures.
- Exceeding iteration budget.

## Definition of Done
- Includes narrative and structured delta plan payload.
- Proposed children map directly to failed verification gaps.
- Every proposed child includes deterministic `gap_hash` and valid dependencies.

## Dependencies
- `prompts/shared-input-output.md`
- `docs/architecture/prompt-contract.md`
- Verification fail output, iteration budget, seen gap hashes, existing children, DAG state.
- CLI research context before proposing net-new children:
  - `npm run cli -- tasks all --project-id <projectId> --json`
  - `npm run cli -- plans list --project-id <projectId> --json`
  - `npm run cli -- tasks details <taskId> --project-id <projectId> --json` (target + related open items)
- Repository code/docs review for impacted gap areas.

## Artifacts
- Delta planning artifact with net-new proposed children and dedupe rationale.

## Risks
- Duplicate remediation items due to unstable hash basis.
- Invalid dependency wiring causing orchestration deadlocks.

## Idempotency
- Compute gap hashes from normalized failing requirement evidence.
- Skip items whose `gap_hash` already exists in seen state.

## Bounded Iteration
- Respect `constraints.iteration_budget` strictly.
- If budget exhausted, emit escalation and no new children.

## Auto-Merge Guidance
- Delta plans are not merge-eligible by default.

## Runtime Prompt Text
Use verification failures as authoritative and propose the smallest set of new children that close uncovered requirements. Exclude unchanged, complete, or duplicate work.

Before proposing any new child, run a research pass across related hierarchy nodes (CLI) and relevant code/docs so the delta only adds truly missing work.

## Structured Output Contract
Return exactly two sections:
1. Narrative delta rationale.
2. Structured payload (YAML preferred) compliant with shared contract and:

```yaml
schema_version: "1.0"
node:
  id: "<parent-id>"
  tier: epoch | phase | plan | task
  parent_id: "<parent-id-or-null>"
  children_ids: ["<child-id>"]
  status: in_progress | awaiting_children | waiting_input

goals: ["<goal>"]
non_goals: ["<non-goal>"]
definition_of_done: ["<DoD>"]
deps:
  - id: "<dependency-id>"
    reason: "<why required>"
artifacts:
  - path: "<delta-plan-artifact>"
    kind: file
    required: true
risks:
  - risk: "<risk>"
    impact: medium
    mitigation: "<mitigation>"
idempotency:
  input_fingerprint: "<hash>"
  output_fingerprint: "<hash>"
  dedupe_key: "delta-planning:<parent-id>:<input-fingerprint>"
  idempotent: true
bounded_iteration:
  max_iterations: 1
  max_replans: 0
  stop_conditions:
    - "Net-new gap-closing children emitted"
    - "Budget exhausted"
  escalation_on_limit: "Escalate when iteration budget exceeded"
auto_merge_guidance:
  eligible: false
  strategy: manual
  required_checks: ["Verification re-run required"]
  blockers: ["Budget exhausted or unresolved external dependency"]

delta_plan:
  proposed_children:
    - id: "<child-id>"
      tier: plan | task | exec
      title: "<title>"
      objective: "<gap-closing outcome>"
      gap_hash: "<sha256>"
      deps:
        - id: "<valid-node-id>"
          reason: "<why required>"
      prompt: "<runtime prompt text>"
  dedupe:
    skipped_gap_hashes: ["<hash>"]
    skipped_reasons: ["already_seen", "already_complete", "out_of_scope"]
  escalation:
    required: false
    reason: "<if true>"
    requested_decision: "<needed decision>"
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
    coverage_note: "Confirm related open/completed work was reviewed before proposing delta children"
```
