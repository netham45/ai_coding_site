# Runtime Prompt Artifacts

This directory contains runtime prompt templates and shared contract sections for orchestration coordinators.

## Conventions

- One markdown file per runtime template.
- Kebab-case names: `<tier>-<action>.md`.
- Shared required sections live in `shared-input-output.md`.
- Output must comply with [`docs/architecture/prompt-contract.md`](../docs/architecture/prompt-contract.md).

## Files

- `shared-input-output.md` - required inputs/outputs section to include in all templates.
- `plan-generate.md` - plan-generation runtime template.
- `plan-extract.md` - extraction/runtime normalization template.
- `plan-approve.md` - approval/materialization template.
- `phase-to-plans.md` - phase decomposition template for generating plan children.
- `task-execution.md` - execution-task runtime template.
- `synthesis.md` - parent synthesis template for requirement-to-evidence coverage aggregation.
- `re-review-unblock.md` - re-review decision template for unblock vs delta-work.
- `exec-task-runner.md` - exec-tier safe execution runtime template with evidence and merge-readiness reporting.

## Usage

1. Select the template for coordinator action.
2. Include shared input/output requirements.
3. Require natural-language rationale + structured payload.
4. Validate payload before persisting or acting.
