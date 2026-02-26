# Readiness Evaluation Template

Use this template for deterministic readiness evaluation in `evaluate_readiness(node)` across all tiers (`epoch`, `phase`, `plan`, `task`, `exec`).

## Include Shared Section

Include `prompts/shared-input-output.md`.

## Readiness-Specific Required Inputs

- `node` canonical metadata payload (id, tier, parent/children, status, deps, iteration, merge settings, evidence).
- `dependency_graph` status snapshot for all direct and transitive dependencies.
- `children_summary` aggregated child states and outstanding work counts.
- `prerequisites.merge` status for merge policy checks and required checks.
- `prerequisites.verification` status for tests/validation/evidence prerequisites.

## Deterministic State Evaluation Rules

Evaluate and normalize state using this lifecycle set:

- `draft`
- `ready`
- `blocked`
- `running`
- `complete`
- `failed`
- `canceled`

Rules:

- Use only provided inputs; do not infer hidden state.
- If any required upstream dependency is not `complete`, evaluate as `blocked`.
- If prerequisites are unsatisfied for execution start, evaluate as `blocked`.
- If node work is active and not terminal, evaluate as `running`.
- If DoD/evidence/prerequisites are all satisfied and no blockers remain, evaluate as `ready` or `complete` based on execution status.
- Terminal states (`complete`, `failed`, `canceled`) are sticky unless explicit override input is provided.
- For parent tiers (`epoch`, `phase`, `plan`), child terminal/blocking conditions must be reflected in parent readiness.
- Cross-tier dependencies must be evaluated identically to same-tier dependencies.

## Transition Reason Codes (Required)

Structured output MUST include at least one explicit reason code from this set:

- `NOOP_STATE_STABLE`
- `DEPS_INCOMPLETE`
- `DEPS_FAILED`
- `CHILDREN_INCOMPLETE`
- `CHILDREN_FAILED`
- `MERGE_PREREQ_MISSING`
- `VERIFICATION_PREREQ_MISSING`
- `READY_TO_START`
- `READY_TO_COMPLETE`
- `EXECUTION_IN_PROGRESS`
- `TERMINAL_COMPLETE`
- `TERMINAL_FAILED`
- `TERMINAL_CANCELED`
- `MANUAL_INTERVENTION_REQUIRED`

## Output

- Natural-language rationale
- Structured payload per prompt contract
- Readiness decision and transition recommendation payload containing:
  - `readiness.current_state`
  - `readiness.recommended_state`
  - `readiness.allowed_transition` (`true`/`false`)
  - `readiness.reason_codes` (non-empty array from required set)
  - `readiness.blockers` (dependency/child/prerequisite blockers with ids and required action)
  - `readiness.follow_up_jobs` (ordered jobs to unblock/advance state)
  - `readiness.idempotency_key` (stable dedupe key for this evaluation result)
