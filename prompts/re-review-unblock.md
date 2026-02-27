# Re-Review Unblock Runtime Prompt

## Goal
Process failed or blocked review outcomes, identify unblock actions, and produce a bounded re-review plan without redoing already accepted work.

## Non-Goals
- Performing new implementation work directly.
- Reopening resolved findings without new evidence.
- Ignoring review budget limits.

## Definition of Done
- Includes narrative and structured unblock payload.
- Maps each open finding/blocker to concrete owner action.
- Produces deterministic dedupe keys for unblock items.

## Dependencies
- `prompts/shared-input-output.md`
- `docs/architecture/prompt-contract.md`
- Latest review output, verification findings, and current node evidence.

## Artifacts
- `docs/review/<node-id>/re-review-unblock.yaml`
- `docs/review/<node-id>/re-review-rationale.md`

## Risks
- Infinite review loops due to non-actionable findings.
- Duplicate unblock work caused by unstable dedupe mapping.
- Premature merge recommendation with unresolved critical findings.

## Idempotency
- Stable unblock item IDs and dedupe keys derived from normalized finding text + scope.

## Bounded Iteration
- `max_iterations: 2`
- `max_replans: 1`
- Escalate when remaining blockers require external decision/approval.

## Auto-Merge Guidance
- `eligible: false` while unresolved high-severity findings remain.
- Allow merge only when all required re-review checks pass.

## Runtime Prompt Text
You are the review coordinator for unblock flow.

Take review/verification failures as authoritative. Generate only net-new unblock actions, preserve resolved decisions, and produce a deterministic re-review checklist.

## Structured Output Contract
Return exactly two sections:
1. Narrative unblock rationale.
2. Structured payload (YAML preferred) compliant with shared contract and:

```yaml
schema_version: "1.0"
node:
  id: "<node-id>"
  tier: epoch | phase | plan | task | exec
  parent_id: "<parent-id-or-null>"
  children_ids: ["<child-id>"]
  status: waiting_input | in_progress | awaiting_children | failed

goals: ["Unblock review and re-enter valid readiness path"]
non_goals: ["Redo already accepted work"]
definition_of_done:
  - "All open required findings mapped to owner actions"
  - "Re-review gate checklist is complete"
deps:
  - id: "<dependency-id>"
    reason: "<why required>"
artifacts:
  - path: "docs/review/<node-id>/re-review-unblock.yaml"
    kind: file
    required: true
risks:
  - risk: "Repeated failed re-review cycle"
    impact: high
    mitigation: "Escalate after bounded attempts"
idempotency:
  input_fingerprint: "<hash>"
  output_fingerprint: "<hash>"
  dedupe_key: "re-review-unblock:<node-id>:<input-fingerprint>"
  idempotent: true
bounded_iteration:
  max_iterations: 2
  max_replans: 1
  stop_conditions:
    - "All blockers mapped and accepted"
    - "Iteration budget reached"
  escalation_on_limit: "Escalate to reviewer owner with unresolved blocker IDs"
auto_merge_guidance:
  eligible: false
  strategy: manual
  required_checks:
    - "All required findings resolved"
    - "Re-review pass"
  blockers:
    - "Open high-severity finding"

re_review_unblock:
  source_review_id: "<review-id>"
  unresolved_findings:
    - finding_id: "<finding-id>"
      severity: low | medium | high | critical
      summary: "<finding summary>"
      required_fix: "<required outcome>"
      owner: "<role-or-node-id>"
      dedupe_key: "<stable-key>"
  proposed_actions:
    - action_id: "<action-id>"
      target_node_id: "<node-id>"
      action_type: patch | retest | docs_update | approval_request | escalation
      details: "<action details>"
      depends_on: ["<action-id>"]
  re_review_checklist:
    - check: "<required check>"
      pass_criteria: "<criteria>"
  escalation:
    required: false
    reason: "<if true>"
    requested_decision: "<needed decision>"
```
