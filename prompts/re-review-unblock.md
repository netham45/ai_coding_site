# Re-Review Unblock Template

Use this template for coordinator `re_review(node)` decisions after dependency, child, or verification state changes.

## Include Shared Section

Include `prompts/shared-input-output.md`.

## Required Inputs

In addition to shared required inputs, include:

- `changes.deps`: changed dependency statuses/events since last decision
- `changes.children`: changed child statuses/events since last decision
- `changes.events`: relevant runtime events (verification, merge, conflict, retry, cancellation)
- `state.latest_synthesis`: latest coordinator synthesis for the node
- `state.latest_verification`: latest verification/test/evidence state
- `state.iteration_counters`: current iteration and replan counters vs budget
- `state.prior_gap_hashes`: previously observed unresolved gap hashes

## Re-Review Decision Logic

- Recompute blocker set from both dependencies and children.
- A node is `unblocked` only when all required deps are complete and all required children have satisfied parent completion triggers.
- If blockers remain but no new actionable gap exists, return `still_blocked`.
- If blockers are caused by a newly identified actionable gap, return `spawn_delta_work` with minimal child delta scope.
- Do not emit more than one action. Exactly one action is required.

## Anti-Thrash and Debounce Rules

- Debounce repeated re-reviews when blocker hash has not changed.
- Prefer `still_blocked` over spawning duplicate delta work when `gap_hash` matches prior unresolved gaps.
- Require a materially new signal (new failing evidence, changed dep status, changed child output hash, or new conflict) before creating delta work.
- Enforce bounded retries; when retry/replan budget is exhausted, set escalation and stop auto-looping.

## Output

- Natural-language rationale that cites the specific unblock/blocker evidence and why the chosen action is correct.
- Structured payload per prompt contract with the additional required fields below.

## Structured Payload Additions

```yaml
re_review:
  action: unblocked | still_blocked | spawn_delta_work
  rationale: string
  blocker_summary:
    deps_blocking: [string]
    children_blocking: [string]
  trigger_evidence:
    changed_dep_ids: [string]
    changed_child_ids: [string]
    event_ids: [string]
  gap_hash_candidates:
    - hash: string
      reason: string
      seen_before: true | false
  retry_guidance:
    next_retry_after_seconds: number
    max_additional_retries: number
    stop_conditions:
      - string
  escalation:
    escalate: true | false
    reason: string
```

## Required Output Constraints

- `re_review.action` must be exactly one of `unblocked`, `still_blocked`, `spawn_delta_work`.
- `gap_hash_candidates` is required for all actions; use an empty list only when explicitly no gap exists.
- If budget is exhausted, `escalation.escalate` must be `true` and `retry_guidance.max_additional_retries` must be `0`.
- If action is `spawn_delta_work`, payload must include actionable gap rationale and bounded retry instructions.
