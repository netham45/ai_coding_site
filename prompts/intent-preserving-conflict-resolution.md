# Intent-Preserving Conflict Resolution Runtime Prompt

## Goal
Resolve merge conflicts while preserving both parent invariants and child intended behavior.

## Non-Goals
- Blindly favoring one side without intent analysis.
- Declaring merge-ready status with unresolved critical conflicts.
- Making scope changes unrelated to conflicting hunks.

## Definition of Done
- Includes narrative and structured conflict-resolution payload.
- Every conflicting hunk has a resolution strategy or explicit escalation.
- Required verification gates for merge retry are listed.

## Dependencies
- `prompts/shared-input-output.md`
- `docs/architecture/prompt-contract.md`
- Parent/child specs, conflicting hunks, verification constraints, merge context.

## Artifacts
- Conflict resolution plan with per-hunk patch strategy and gate checklist.

## Risks
- Regressing parent invariants during conflict resolution.
- Losing child-delivered behavior while fixing conflicts.
- Repeated conflict loops due to weak retry criteria.

## Idempotency
- Deterministic mapping from conflict hunk + intent constraints to chosen strategy.

## Bounded Iteration
- `max_iterations: 2`
- `max_replans: 1`
- Escalate if intent cannot be preserved safely.

## Auto-Merge Guidance
- Never mark auto-merge eligible until all gate checks pass and unresolved conflicts are empty.

## Runtime Prompt Text
Analyze parent and child intent first, then propose per-hunk conflict resolution strategies that preserve both intents. If tradeoffs cannot be safely resolved, escalate with a precise decision request.

## Structured Output Contract
Return exactly two sections:
1. Narrative conflict-resolution rationale.
2. Structured payload (YAML preferred) compliant with shared contract and:

```yaml
schema_version: "1.0"
node:
  id: "<node-id>"
  tier: phase | plan | task | exec
  parent_id: "<parent-id-or-null>"
  children_ids: ["<child-id>"]
  status: merge_conflict | waiting_input | in_progress

goals: ["Preserve parent and child intent through conflict resolution"]
non_goals: ["Unrelated refactors"]
definition_of_done:
  - "Every conflict hunk resolved or escalated"
  - "Merge gate checklist defined"
deps:
  - id: "<dependency-id>"
    reason: "<why required>"
artifacts:
  - path: "<conflict-resolution-plan>"
    kind: file
    required: true
risks:
  - risk: "Intent regression"
    impact: high
    mitigation: "Per-hunk invariant validation"
idempotency:
  input_fingerprint: "<hash>"
  output_fingerprint: "<hash>"
  dedupe_key: "intent-conflict-resolution:<node-id>:<input-fingerprint>"
  idempotent: true
bounded_iteration:
  max_iterations: 2
  max_replans: 1
  stop_conditions:
    - "All hunks resolved with gate plan"
    - "Escalation required"
  escalation_on_limit: "Escalate unresolved intent tradeoff"
auto_merge_guidance:
  eligible: false
  strategy: manual
  required_checks:
    - "Conflict-free branch"
    - "Required verification checks pass"
  blockers:
    - "Unresolved high-risk conflict"

conflict_resolution:
  intent_justification: "<why strategy preserves parent + child intent>"
  patch_plan:
    - file: "<path>"
      hunk_id: "<hunk-id>"
      strategy: ours | theirs | manual_blend | redesign
      rationale: "<why this preserves intent>"
      expected_behavior: "<post-merge behavior>"
  merge_gate_checklist:
    - check: "<check>"
      pass_criteria: "<criteria>"
  unresolved_conflicts:
    - file: "<path>"
      hunk_id: "<hunk-id>"
      reason: "<reason unresolved>"
  escalation:
    required: false
    reason: "<if true>"
    requested_decision: "<needed decision>"
    retry_policy: "<when/how to retry>"
```
