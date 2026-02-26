# Verification Template

Use this template for `verify(parent)` coordinator instructions that validate synthesis coverage and completion readiness.

## Verification Inputs

Required verification inputs in addition to shared required inputs:
- Parent node context and metadata lifecycle flags.
- Latest synthesis artifact including `summary` and `coverage_matrix`.
- Child node completion states and failure diagnostics.
- Replan budget state (`max_replans`, `iterations_used`, `budget_override`).

## Verification Requirements

- Produce a deterministic `pass` or `fail` verdict from the provided inputs.
- Fail when any requirement is not fully covered by evidence.
- Fail when any child is not merged or is in terminal failure.
- On fail, list explicit failing requirement ids and reasons.
- Keep output deterministic for identical inputs.

## Output

Return structured payload:
- `verdict`: `pass` | `fail`
- `failing_requirements`: string[]
- `reasons`: string[]
- `delta_plan_required`: boolean
- `budget_exhausted`: boolean
