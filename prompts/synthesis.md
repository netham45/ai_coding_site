# Synthesis Template

Use this template for `synthesize(parent)` coordinator instructions that aggregate child outputs into requirement-to-evidence coverage.

## Include Shared Section

Include `prompts/shared-input-output.md`.

## Synthesis Inputs

Required synthesis inputs in addition to shared required inputs:

- `parent.spec` (goals, non-goals, DoD, constraints)
- `parent.requirements` (stable requirement ids and statements)
- `children.outputs` (structured payloads and rationale from child nodes)
- `repo.diffs` (relevant file changes, commit/test evidence)
- `dependency.outcomes` (ready/blocked/failed status for deps)

`node.tier` may be any parent tier: `epoch | phase | plan | task`.

## Synthesis-Specific Requirements

- Produce a short narrative synthesis explaining current parent progress and confidence.
- Build a requirement-evidence coverage matrix that is explicit and machine-readable.
- Map each parent requirement id to concrete evidence/artifacts/tests from child outputs or repo diffs.
- Mark uncovered requirements explicitly and provide actionable gap reasons.
- Emit deterministic candidate gap hashes so uncovered work can be deduplicated across retries.
- Keep output idempotent: same inputs must produce the same coverage rows and gap hashes.

## Output

- Natural-language rationale
- Structured payload per prompt contract
- Synthesis coverage payload with the exact schema below

```yaml
schema_version: "1.0"
node:
  id: string
  tier: epoch | phase | plan | task
  parent_id: string | null
  children_ids: [string]
  status: queued | in_progress | waiting_input | awaiting_children | merge_ready | merged | cancelled | failed | merge_conflict

goals:
  - string
non_goals:
  - string
definition_of_done:
  - string
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
  max_iterations: number
  max_replans: number
  stop_conditions:
    - string
  escalation_on_limit: string
auto_merge_guidance:
  eligible: true | false
  strategy: manual | auto_merge | auto_merge_on_complete
  required_checks:
    - string
  blockers:
    - string

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
      suggested_next_actions:
        - string
  candidate_gap_hashes:
    - requirement_id: string
      algorithm: sha256
      hash: string
      hash_basis:
        - requirement_id
        - normalized_gap_reason
        - blocking_dependencies
        - parent_node_id
```

## Coverage Matrix Rules

- `coverage_matrix` must include exactly one row per `parent.requirements` id.
- `coverage_status=covered` requires at least one evidence entry with concrete `artifact_ref`.
- `coverage_status=partial` requires at least one evidence entry and non-empty `gap_reason`.
- `coverage_status=uncovered` requires empty `evidence` and non-empty `gap_reason`.
- `uncovered_requirements` must match rows where `coverage_status=uncovered`.
- `candidate_gap_hashes` must include one entry per uncovered requirement.
- `candidate_gap_hashes.hash` must be deterministic for identical input state.
