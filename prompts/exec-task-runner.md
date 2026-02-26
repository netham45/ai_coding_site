# Exec Task Runner Template

Use this template for `exec`-tier task execution with safe code edits, verifiable checks, and merge-ready reporting.

## Include Shared Section

Include `prompts/shared-input-output.md`.

## Required Inputs

- `node.*` metadata from the shared contract, including tier/parent/children/deps/status.
- `context.project_id`, `context.task_or_plan_id`, `context.workspace_path`.
- `repo_status`:
  - current branch
  - upstream tracking branch
  - working tree status summary (clean/dirty + file list)
  - current `HEAD` commit
- `branch_lineage`:
  - base branch (typically `main`)
  - execution branch
  - merge target
  - known divergence/merge constraints
- `acceptance_checks`:
  - required test/build/lint/typecheck commands
  - required functional/manual checks
  - minimum evidence required for each check
- `merge_assumptions`:
  - auto-merge policy assumptions
  - protected-branch/check requirements
  - conflict handling policy

## Safe Edit Workflow (Required)

1. Confirm scope and restate explicit non-goals before editing.
2. Record baseline evidence (`git status --short`, `git rev-parse HEAD`).
3. Apply minimal reversible changes that map directly to acceptance checks.
4. Run required checks. If a required check fails, do not report completion.
5. Capture command evidence for each check (command, exit code, concise output).
6. Summarize touched files and behavior deltas in PR-ready language.
7. Record rollback and conflict notes before finalizing readiness.

## Completion Gates (Must Pass)

- All required acceptance checks executed and passing, or explicitly blocked with reason and owner.
- Test evidence includes at least one concrete command and result per required check.
- Touched-file list is complete and consistent with repo status.
- Risks include mitigation and residual impact.
- Merge-safe notes include assumptions, known blockers, and rollback plan.

## Output

Produce both:

1. Natural-language execution summary
2. Structured payload (`yaml` preferred) that includes prompt-contract fields and the execution report below.

### Structured Execution Report

```yaml
schema_version: "1.0"
node:
  id: string
  tier: exec
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

execution_report:
  repo:
    baseline_head: string
    final_head: string
    branch: string
    base_branch: string
    merge_target: string
  touched_files:
    - path: string
      change_type: added | modified | deleted | renamed
      summary: string
  command_evidence:
    - command: string
      purpose: setup | build | lint | typecheck | test | verification | other
      exit_code: number
      outcome: pass | fail | blocked
      evidence: string
  acceptance_check_results:
    - check: string
      required: true | false
      status: pass | fail | blocked | not_run
      evidence_ref: string
  pr_ready_summary:
    problem: string
    changes:
      - string
    validation:
      - string
    remaining_risks:
      - string
  merge_safe_notes:
    assumptions:
      - string
    blockers:
      - string
    conflict_risk: low | medium | high
    rollback_plan:
      - string
```

## Failure/Blocker Handling

- If checks fail or required evidence is missing, set `node.status` to `failed` or `waiting_input` (as applicable).
- Keep `auto_merge_guidance.eligible` as `false` when blockers are present.
- Include exact next action needed to unblock completion.
