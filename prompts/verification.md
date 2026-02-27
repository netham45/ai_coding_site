# Verification Runtime Prompt

## Goal
Validate synthesis coverage and execution completion readiness, producing a deterministic verdict.

## Non-Goals
- Performing implementation changes.
- Re-synthesizing requirements coverage from scratch.
- Returning a verdict without explicit failing reasons.

## Definition of Done
- Includes narrative and structured verification payload.
- Produces `pass` or `fail` deterministically.
- Identifies failing requirements, reasons, and whether delta planning is required.

## Dependencies
- `prompts/shared-input-output.md`
- `docs/architecture/prompt-contract.md`
- Parent context, latest synthesis output, child status diagnostics, replan budget state.
- CLI hierarchy/context inspection before verdict:
  - `npm run cli -- tasks all --project-id <projectId> --json`
  - `npm run cli -- plans list --project-id <projectId> --json`
  - `npm run cli -- tasks details <taskId> --project-id <projectId> --json` (sample related nodes)
- Code/docs review for any requirement/evidence interpretation ambiguity.

## Artifacts
- Verification record containing verdict and follow-up directives.

## Risks
- False pass when evidence references are stale.
- Ambiguous fail reasons causing ineffective delta plans.

## Idempotency
- Same normalized inputs produce identical verdict payload and dedupe key.

## Bounded Iteration
- Single-pass verifier; no iterative expansion inside one call.
- Escalate only for contradictory inputs.

## Auto-Merge Guidance
- `eligible: true` only if verdict is pass and merge prerequisites are satisfied.

## Runtime Prompt Text
Research-first requirement: before issuing a verdict, inspect related tree state via CLI and review relevant code/docs so pass/fail decisions reflect actual current context.

Verify whether parent requirements are fully covered with valid evidence and all required children are in merge-safe terminal states. Fail fast with explicit reasons when any gate is unmet.

## Structured Output Contract
Return exactly two sections:
1. Narrative verification rationale.
2. Structured payload (YAML preferred) compliant with shared contract and:

```yaml
schema_version: "1.0"
node:
  id: "<node-id>"
  tier: epoch | phase | plan | task
  parent_id: "<parent-id-or-null>"
  children_ids: ["<child-id>"]
  status: in_progress | failed | merge_ready

goals: ["<goal>"]
non_goals: ["<non-goal>"]
definition_of_done: ["<DoD>"]
deps:
  - id: "<dependency-id>"
    reason: "<why required>"
artifacts:
  - path: "<verification-artifact>"
    kind: task_output
    required: true
risks:
  - risk: "<risk>"
    impact: medium
    mitigation: "<mitigation>"
idempotency:
  input_fingerprint: "<hash>"
  output_fingerprint: "<hash>"
  dedupe_key: "verification:<node-id>:<input-fingerprint>"
  idempotent: true
bounded_iteration:
  max_iterations: 1
  max_replans: 0
  stop_conditions: ["Verdict produced"]
  escalation_on_limit: "Escalate contradictory synthesis/child state"
auto_merge_guidance:
  eligible: false
  strategy: manual
  required_checks: ["Verdict pass", "Merge prerequisites satisfied"]
  blockers: ["Populated when verdict is fail or prerequisites missing"]

verification:
  verdict: pass | fail
  failing_requirements: [string]
  reasons: [string]
  delta_plan_required: true | false
  budget_exhausted: true | false
  failing_children:
    - child_id: "<child-id>"
      reason: "<reason>"
  merge_prereq_status:
    checks_passed: true | false
    missing_checks: [string]
research_evidence:
  cli_queries:
    - command: "npm run cli -- tasks all --project-id <projectId> --json"
      findings: "<what was learned>"
    - command: "npm run cli -- plans list --project-id <projectId> --json"
      findings: "<what was learned>"
  repo_reads:
    - path: "<file-or-dir>"
      findings: "<what was learned>"
  tree_coverage:
    reviewed_related_nodes: ["<node-id>"]
    coverage_note: "Show related branches reviewed before verdict"
```
