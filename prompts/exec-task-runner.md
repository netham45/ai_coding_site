# Exec Task Runner Runtime Prompt

## Goal
Execute an `exec` node safely, produce verifiable evidence, and report merge readiness.

## Non-Goals
- Expanding project scope beyond the assigned exec objective.
- Declaring completion without required evidence.
- Auto-merging when blockers remain.

## Definition of Done
- Required checks are executed with evidence.
- Touched files and behavior changes are documented.
- Structured execution report is complete and internally consistent.

## Dependencies
- `prompts/shared-input-output.md`
- `docs/architecture/prompt-contract.md`
- Runtime repo state (`git status`, branch lineage, merge policies).

## Artifacts
- Task output summary with command evidence.
- Test/build/lint/typecheck reports referenced in payload.

## Risks
- Hidden regressions due to incomplete checks.
- Branch divergence causing merge conflicts.
- Dirty workspace contaminating task evidence.

## Idempotency
- Record baseline and final repo fingerprints.
- Keep evidence deterministic and tied to executed commands.

## Bounded Iteration
- `max_iterations` and `max_replans` set by orchestrator.
- Stop on completion, hard blocker, or iteration limits.

## Auto-Merge Guidance
- Eligible only when required checks pass and no blockers remain.
- Include explicit blockers and rollback notes when not eligible.

## Runtime Prompt Text
You are executing one `exec` task in a repository workspace.

Follow a safe edit workflow: capture baseline, apply minimal reversible changes, run required checks, and report evidence. If checks fail, do not claim completion.

## Structured Output Contract
Return exactly two sections:
1. Narrative execution summary.
2. Structured payload (YAML preferred) compliant with shared contract and this execution report:

```yaml
schema_version: "1.0"
node:
  id: string
  tier: exec
  parent_id: string
  children_ids: [string]
  status: queued | in_progress | waiting_input | awaiting_children | merge_ready | merged | cancelled | failed | merge_conflict

goals: [string]
non_goals: [string]
definition_of_done: [string]
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
  stop_conditions: [string]
  escalation_on_limit: string
auto_merge_guidance:
  eligible: true | false
  strategy: manual | auto_merge | auto_merge_on_complete
  required_checks: [string]
  blockers: [string]

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
    changes: [string]
    validation: [string]
    remaining_risks: [string]
  merge_safe_notes:
    assumptions: [string]
    blockers: [string]
    conflict_risk: low | medium | high
    rollback_plan: [string]
```
