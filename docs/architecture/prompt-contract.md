# Prompt IO Contract (Runtime Coordinators)

## Scope

This contract is mandatory for runtime coordinators that generate, parse, extract, approve, or execute orchestration artifacts.

Primary consumers:

- `server/src/services/planParser.ts`
- `server/src/services/planOrchestrator.ts`
- `server/src/application/cliServices.ts` (`extractPlan`, `approvePlan`, planner prompt construction)

## Required Response Shape

Every prompt response MUST include both sections:

1. Natural-language rationale
2. Structured payload (`json` or `yaml`) following the schema below

The structured payload is the system-of-record for parser/orchestrator behavior.

## Structured Payload Schema

```yaml
schema_version: "1.0"
node:
  id: string
  tier: epoch | phase | plan | task | exec
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
```

## Field Requirements

All listed fields are required unless marked nullable.

Required structured fields:

- `goals`
- `non_goals`
- `definition_of_done` (DoD)
- `deps`
- `artifacts`
- `risks`
- `idempotency`
- `bounded_iteration`
- `auto_merge_guidance`

## Output Rules

- Prefer YAML for planner compatibility.
- If JSON is used, keys must be semantically identical to schema keys above.
- Rationale must not conflict with structured payload.
- Coordinators must treat structured payload as authoritative when conflict exists.
- If required fields are missing, extractor/approver must reject and request regeneration.

## Validation and Consumption by Existing Services

- `planParser.parsePlanOutput` validates materialized execution/sub-plan items and dependency constraints.
- `cliServices.extractPlan` persists parsed items into revision tables and surfaces validation errors.
- `cliServices.approvePlan` enforces dependency topology, recursion depth, and merge/automation defaults before task creation.
- `planOrchestrator` applies idempotency lock/hash semantics and bounded retries per output hash.

## Prompt Artifact Location

Prompt templates and shared sections are defined under [`/prompts`](../../prompts/README.md).
