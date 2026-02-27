# Intent-Preserving Conflict Resolution

Use this template when merge conflicts block auto-merge and stage intent must be preserved.

## Required Inputs

- `parent_spec`: parent node intent, invariants, and constraints.
- `child_spec`: child node intent and expected delivered behavior.
- `conflicting_hunks`: file/hunk conflict details.
- `verification_constraints`: required checks and merge gates.
- `merge_context`: branch, commit, and scope metadata for this merge attempt.

## Resolution Procedure

1. Identify parent invariants that must not regress.
2. Identify child intent that must remain delivered.
3. For each conflicting hunk, propose a patch strategy that preserves both intents.
4. Define evidence/check steps required before retrying merge.
5. If intent cannot be safely preserved, stop and escalate.

## Output Contract

- Narrative summary:
  - Explain intent tradeoffs and why the patch plan is safe.
- Structured payload:
  - `conflict_resolution.patch_plan[]`
  - `conflict_resolution.intent_justification`
  - `conflict_resolution.merge_gate_checklist[]`
  - `conflict_resolution.unresolved_conflicts[]`
  - `conflict_resolution.escalation`

## Hard Stops

- Do not output a merge-ready recommendation if any required gate/check fails.
- If intent preservation is uncertain, require escalation with a retry policy and keep all context artifacts.
