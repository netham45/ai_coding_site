# Plan to Subplans and Tasks Runtime Prompt

## Goal
Decompose one `plan` into a DAG of `sub_plan` and `execution_task` items that is parser-compatible and safe to materialize.

## Non-Goals
- Executing code changes.
- Producing cyclic or unresolved dependencies.
- Emitting ambiguous item types.

## Definition of Done
- Narrative, structured payload, and parser-compatible YAML item list are all present.
- Every item has stable id, title, prompt, `item_type`, and `depends_on`.
- Automation fields follow type-specific rules.

## Dependencies
- `prompts/shared-input-output.md`
- `docs/architecture/prompt-contract.md`
- `server/src/services/planParser.ts`
- `server/src/application/cliServices.ts`
- CLI tree/context inspection prior to decomposition:
  - `npm run cli -- plans get <planId> --json`
  - `npm run cli -- plans list --project-id <projectId> --json`
  - `npm run cli -- tasks all --project-id <projectId> --json`
  - `npm run cli -- info <taskId> --project-id <projectId> --json` (sample relevant tasks)
- Code/docs review for modules and docs touched by candidate items.

## Artifacts
- `docs/plans/<plan-id>/items.yaml`
- `docs/plans/<plan-id>/decomposition-rationale.md`

## Risks
- Recursion depth overflow for `sub_plan` expansion.
- Invalid YAML causing parser/materializer failure.
- Merge-topology mismatch for dependencies.

## Idempotency
- Stable item keys for unchanged intent.
- Deterministic decomposition fingerprints per item.

## Bounded Iteration
- `max_iterations: 3`
- `max_replans: 1`
- If depth or topology constraints fail, downgrade to `execution_task` and record escalation.

## Auto-Merge Guidance
- `execution_task` items may use `auto_merge`.
- `sub_plan` items may use `auto_start`/`auto_merge_on_complete`.
- Never mix automation models on one item.

## Runtime Prompt Text
You are decomposing one `plan` into parser-compatible child items.

Research before layout is mandatory:
1. Use CLI to inspect related branches/nodes in the project tree.
2. Review relevant code and documentation for existing constraints and interfaces.
3. Base item boundaries on that evidence, then emit the DAG.

Choose `item_type` deterministically: use `sub_plan` only when more orchestration is required; default to `execution_task` when uncertain. Emit a valid DAG, enforce recursion limits, and keep output idempotent.

## Structured Output Contract
Return three sections:
1. Narrative rationale.
2. Structured payload (shared contract + `plan_decomposition`).
3. Parser-compatible YAML (`tasks:` or `items:`).

```yaml
schema_version: "1.0"
node:
  id: "<plan-id>"
  tier: plan
  parent_id: "<parent-id-or-null>"
  children_ids: ["<item-id>"]
  status: awaiting_children

goals: ["<goal>"]
non_goals: ["<non-goal>"]
definition_of_done: ["<DoD>"]
deps:
  - id: "<dependency-id>"
    reason: "<why required>"
artifacts:
  - path: "docs/plans/<plan-id>/items.yaml"
    kind: file
    required: true
risks:
  - risk: "<risk>"
    impact: medium
    mitigation: "<mitigation>"
idempotency:
  input_fingerprint: "<hash>"
  output_fingerprint: "<hash>"
  dedupe_key: "plan-to-subplans-and-tasks:<plan-id>:<input-fingerprint>"
  idempotent: true
bounded_iteration:
  max_iterations: 3
  max_replans: 1
  stop_conditions:
    - "All dependencies resolve to emitted items or known nodes"
    - "No cycles"
  escalation_on_limit: "Escalate with blocked item IDs and cause"
auto_merge_guidance:
  eligible: false
  strategy: manual
  required_checks:
    - "YAML parse success"
    - "Materialization constraints pass"
  blockers:
    - "Depth guard exceeded without downgrade"

plan_decomposition:
  parent_plan_id: "<plan-id>"
  parent_depth: 0
  max_sub_plan_recursion_depth: 6
  defaults:
    auto_start: false
    auto_merge_on_complete: false
    auto_merge_item_keys: ["<execution-item-key>"]
  items:
    - item_key: "<item-key>"
      item_type: execution_task
      depends_on: []
      topology_scope:
        parent_plan_id: "<plan-id-or-null>"
        merge_target: "<target>"
      automation:
        auto_merge: false
        auto_start: false
        auto_merge_on_complete: false
      idempotency:
        decomposition_fingerprint: "<hash>"
research_evidence:
  cli_queries:
    - command: "npm run cli -- plans get <planId> --json"
      findings: "<what was learned>"
    - command: "npm run cli -- tasks all --project-id <projectId> --json"
      findings: "<what was learned>"
  repo_reads:
    - path: "<file-or-dir>"
      findings: "<what was learned>"
  tree_coverage:
    reviewed_related_nodes: ["<node-id>"]
    coverage_note: "Confirm upstream/downstream context was reviewed before emitting items"
```
