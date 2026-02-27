# Synthesis Runtime Prompt

## Goal
Aggregate child outputs into deterministic requirement-to-evidence coverage for a parent node.

## Non-Goals
- Creating new implementation tasks.
- Claiming coverage without concrete evidence references.
- Omitting uncovered requirements.

## Definition of Done
- Includes narrative summary and structured synthesis payload.
- Coverage matrix contains exactly one row per parent requirement.
- Uncovered requirements and deterministic gap hashes are provided.

## Dependencies
- `prompts/shared-input-output.md`
- `docs/architecture/prompt-contract.md`
- Parent requirements, child outputs, repo diffs, dependency outcomes.
- CLI context checks across related hierarchy nodes before synthesis:
  - `npm run cli -- tasks all --project-id <projectId> --json`
  - `npm run cli -- plans list --project-id <projectId> --json`
  - `npm run cli -- tasks summary <taskId> --project-id <projectId> --json` (sample related nodes)
- Code/docs review for impacted modules and architecture assumptions.

## Artifacts
- Synthesis coverage artifact with matrix and gap hashes.

## Risks
- False-positive coverage due to weak evidence quality.
- Drift between requirements and evidence IDs.

## Idempotency
- Deterministic coverage rows and gap hashes for identical normalized inputs.

## Bounded Iteration
- Single synthesis pass per invocation; escalate if required inputs are missing.

## Auto-Merge Guidance
- Synthesis informs merge readiness but does not alone approve merge.

## Runtime Prompt Text
Research-first requirement: before final synthesis, inspect related hierarchy context via CLI and review relevant code/docs so coverage claims are grounded in current tree and repo reality.

Synthesize parent progress using only provided requirements and child evidence. Mark uncovered or partial requirements explicitly and provide actionable gap reasons.

## Structured Output Contract
Return exactly two sections:
1. Narrative synthesis.
2. Structured payload (YAML preferred) compliant with shared contract and:

```yaml
schema_version: "1.0"
node:
  id: string
  tier: epoch | phase | plan | task
  parent_id: string | null
  children_ids: [string]
  status: queued | in_progress | waiting_input | awaiting_children | merge_ready | merged | cancelled | failed | merge_conflict

goals: [string]
non_goals: [string]
definition_of_done: [string]
deps:
  - id: string
    reason: string
artifacts:
  - path: string
    kind: file | directory | plan_revision | task_output | test_report
    required: true | false
risks:
  - risk: string
    impact: low | medium | high
    mitigation: string
idempotency:
  input_fingerprint: string
  output_fingerprint: string
  dedupe_key: string
  idempotent: true | false
bounded_iteration:
  max_iterations: 1
  max_replans: 0
  stop_conditions: ["Coverage matrix generated"]
  escalation_on_limit: "Escalate missing requirement/evidence inputs"
auto_merge_guidance:
  eligible: false
  strategy: manual
  required_checks: ["Verification pass required"]
  blockers: ["Uncovered requirements"]

synthesis:
  summary:
    confidence: low | medium | high
    status: on_track | at_risk | blocked
    narrative: string
  coverage_matrix:
    - requirement_id: string
      requirement_text: string
      coverage_status: covered | partial | uncovered
      evidence:
        - evidence_id: string
          source_node_id: string
          source_tier: epoch | phase | plan | task | exec
          artifact_ref: string
          artifact_kind: file | commit | task_output | plan_revision | test_report | log
          test_refs: [string]
          notes: string
      dependency_outcomes:
        - dependency_id: string
          outcome: ready | blocked | failed | unknown
          details: string
      gap_reason: string
  uncovered_requirements:
    - requirement_id: string
      reason: string
      blocking_dependencies: [string]
      suggested_next_actions: [string]
  candidate_gap_hashes:
    - requirement_id: string
      algorithm: sha256
      hash: string
      hash_basis:
        - requirement_id
        - normalized_gap_reason
        - blocking_dependencies
        - parent_node_id
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
    coverage_note: "Show related branches reviewed before finalizing synthesis coverage"
```
