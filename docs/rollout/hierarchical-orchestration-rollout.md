# Hierarchical Orchestration Rollout

## Goal
Ship hierarchical orchestration capabilities with staged rollout controls, preserve legacy task/plan workflows, and support fast rollback.

## Feature Flags
- `ORCHESTRATION_COMPATIBILITY_MODE`
  - Default: `false`
  - When `true`, disables hierarchy/action orchestration APIs and orchestration workers.
  - Use for immediate rollback to compatibility behavior.
- `ORCHESTRATION_WORKERS_ENABLED`
  - Default: `true`
  - Controls startup of orchestration workers (`jobQueue`, hierarchical jobs, plan orchestrator).
- `ORCHESTRATION_HIERARCHY_API_ENABLED`
  - Default: `true`
  - Controls read endpoints:
    - `GET /api/projects/:projectId/hierarchy`
    - `GET /api/projects/:projectId/dependency-graph`
    - `GET /api/nodes/:nodeId`
- `ORCHESTRATION_ACTIONS_API_ENABLED`
  - Default: `true`
  - Controls mutation endpoints:
    - `POST /api/nodes/:nodeId/start`
    - `POST /api/nodes/:nodeId/auto-mode`
    - `POST /api/nodes/:nodeId/auto-merge`
    - `POST /api/nodes/:nodeId/force-re-review`
    - `POST /api/nodes/:nodeId/approve-budget-override`

## Staged Rollout Plan
1. Baseline validation
- Deploy with defaults (`compatibility=false`, workers/api flags enabled).
- Confirm test suite and migration checks pass in pre-prod.

2. Read-only exposure
- Enable hierarchy APIs while keeping actions disabled:
  - `ORCHESTRATION_HIERARCHY_API_ENABLED=true`
  - `ORCHESTRATION_ACTIONS_API_ENABLED=false`
- Observe API usage and dependency graph payload correctness.

3. Controlled action enablement
- Enable actions for selected environments/tenants.
- Monitor manual override and orchestration job audit events.

4. Full automation
- Enable workers and both API surfaces globally.
- Keep compatibility mode documented for emergency rollback.

## Migration Notes
- No new persistence primitive is required for these controls.
- Existing task/plan schemas remain valid.
- Backward compatibility is preserved by default values and metadata normalization.

## Rollback Procedure
1. Set `ORCHESTRATION_COMPATIBILITY_MODE=true`.
2. Restart server processes to stop orchestration workers and disable orchestration endpoints.
3. Verify:
- `/api/projects/:id/tasks` and `/api/tasks/:id` continue serving normal workflows.
- Orchestration endpoints return `404` with `code=FEATURE_DISABLED`.
4. Keep project/task operations running in compatibility mode until incident resolution.

## Observability Metrics and Signals
- API signals
  - `FEATURE_DISABLED` response count by endpoint.
  - 4xx/5xx rate for orchestration endpoints.
- Queue/job health
  - Pending orchestration job event count.
  - Completed job event count and dedupe rate.
  - Job execution latency (enqueue -> completed).
- Dependency/lifecycle correctness
  - `orchestration.readiness.evaluated` volume by reason code.
  - `orchestration.delta_plan.completed` count and iterations used.
  - Parent completion guard block counts.
- Manual override auditability
  - Event rates for:
    - `orchestration.override.auto_mode`
    - `orchestration.override.auto_merge`
    - `orchestration.override.replan_budget`
    - `orchestration.override.force_re_review`

## Verification Checklist
- `npm run cli -- --help` from `server` passes.
- `npm run build` passes for `server` and `web`.
- `server` integration + orchestration unit tests pass.
- `web` smoke tests for start-from-tier and automation toggles pass.
- Compatibility mode integration tests pass.
