# Readiness Evaluation Runtime Prompt

## Goal
Deterministically evaluate readiness and allowed state transition for any node tier (`epoch|phase|plan|task|exec`).

## Non-Goals
- Performing implementation changes.
- Inferring hidden state beyond supplied inputs.
- Returning ambiguous transition outcomes.

## Definition of Done
- Includes narrative and structured decision payload.
- Produces deterministic recommended state and reason codes.
- Identifies blockers, follow-up jobs, and idempotency key.

## Dependencies
- `prompts/shared-input-output.md`
- `docs/architecture/prompt-contract.md`
- Node metadata, dependency graph, children summary, merge/verification prerequisites.

## Artifacts
- Readiness decision record with reason codes and blockers.

## Risks
- Incorrectly unblocking work with incomplete dependency data.
- Failing to propagate child failures to parent readiness.

## Idempotency
- Same normalized inputs must yield same `idempotency_key` and recommendation.

## Bounded Iteration
- Single-pass deterministic evaluation per invocation.
- Escalate when inputs are contradictory or incomplete.

## Auto-Merge Guidance
- Readiness output does not itself authorize merge.
- If merge prerequisites are missing, emit blocker codes.

## Runtime Prompt Text
Evaluate node readiness only from provided data. Honor sticky terminal states unless explicit override is provided. Cross-tier dependencies must be treated exactly like same-tier dependencies.

## Structured Output Contract
Return exactly two sections:
1. Narrative rationale.
2. Structured payload (YAML preferred) compliant with shared contract and:

```yaml
schema_version: "1.0"
node:
  id: "<node-id>"
  tier: epoch | phase | plan | task | exec
  parent_id: "<parent-id-or-null>"
  children_ids: ["<child-id>"]
  status: queued | in_progress | waiting_input | awaiting_children | merge_ready | merged | cancelled | failed | merge_conflict

goals: ["<goal>"]
non_goals: ["<non-goal>"]
definition_of_done: ["<DoD>"]
deps:
  - id: "<dependency-id>"
    reason: "<why required>"
artifacts:
  - path: "<artifact-path>"
    kind: task_output
    required: true
risks:
  - risk: "<risk>"
    impact: low
    mitigation: "<mitigation>"
idempotency:
  input_fingerprint: "<hash>"
  output_fingerprint: "<hash>"
  dedupe_key: "readiness-evaluation:<node-id>:<input-fingerprint>"
  idempotent: true
bounded_iteration:
  max_iterations: 1
  max_replans: 0
  stop_conditions:
    - "Decision produced"
  escalation_on_limit: "Escalate contradictory or missing required state"
auto_merge_guidance:
  eligible: false
  strategy: manual
  required_checks: ["Readiness only; merge policy evaluated separately"]
  blockers: ["Set when merge prerequisites are missing"]

readiness:
  current_state: draft | ready | blocked | running | complete | failed | canceled
  recommended_state: draft | ready | blocked | running | complete | failed | canceled
  allowed_transition: true
  reason_codes:
    - NOOP_STATE_STABLE
  blockers:
    - id: "<dependency-or-child-id>"
      reason_code: DEPS_INCOMPLETE
      required_action: "<action>"
  follow_up_jobs:
    - order: 1
      job: "<job-type>"
      target_id: "<node-id>"
      rationale: "<why>"
  idempotency_key: "<stable-key>"
```
