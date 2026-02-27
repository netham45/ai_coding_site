# Workflow Ownership Cutover Traceability Report (2026-02-27)

## Scope
- Prompt objective: execute full server/web test suites, confirm workflow engine ownership replaces legacy orchestration ownership for targeted tiers, and document residual risks + rollback.
- Targeted tiers: `epoch`, `phase`, `plan`.

## Command Execution Evidence
- Required CLI discovery:
  - `cd server && npm run cli -- --help`
  - Result: pass (command usage printed successfully).
- Full server suite:
  - `cd server && npm test`
  - Result: pass after one regression fix in `src/services/adapters.ts` (final run: 52/52 tests passed).
- Full web suite:
  - `cd web && npm test`
  - Result: pass (5/5 files, 16/16 tests).
- Build verification:
  - `cd server && npm run build` (pass)
  - `cd web && npm run build` (pass; non-blocking chunk-size warning only).

## Requirement Traceability Matrix
1. Requirement: All critical tests pass.
- Evidence:
  - Server full suite green (`52 pass, 0 fail`).
  - Web full suite green (`16 pass, 0 fail`).
  - Server and web production builds pass.
- Status: Met.

2. Requirement: Confirm workflow engine replaces old orchestration ownership for targeted tiers.
- Evidence (implementation):
  - Tier routing in start API sends `epoch|phase|plan` nodes through workflow runs, not runtime-session starts: [tasks.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/routes/tasks.ts:2091).
  - Built-in workflow start path for tier nodes: [tasks.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/routes/tasks.ts:2145), [workflowBuiltins.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/services/workflowBuiltins.ts:78).
  - Legacy `plan_orchestration_pass` disabled by default behind flag: [featureFlags.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/config/featureFlags.ts:10), [hooks.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/services/orchestration/hooks.ts:96), [jobQueue.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/services/orchestration/jobQueue.ts:322).
  - Legacy planning jobs are suppressed when active workflow ownership exists: [ownership.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/services/orchestration/ownership.ts:53), [jobQueue.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/services/orchestration/jobQueue.ts:236).
- Evidence (tests):
  - Default cutover test: legacy `plan_orchestration_pass` stays disabled by default: [integration.test.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/integration.test.ts:2560).
  - Hook-level cutover default and rollback behavior: [hooks.test.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/services/orchestration/hooks.test.ts:19).
  - Legacy suppression for `decompose` and `synthesize` when workflow run is active: [ownership.test.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/services/orchestration/ownership.test.ts:66).
  - Plan-tier built-in workflow ownership start/reuse: [workflowBuiltins.test.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/services/workflowBuiltins.test.ts:29).
  - Per-node workflow assignment endpoint for tier nodes: [workflowApis.test.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/routes/workflowApis.test.ts:257), [tasks.ts](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/server/src/routes/tasks.ts:2200).
- Status: Met.

3. Requirement: Requirement traceability is complete.
- Evidence:
  - This document maps each acceptance requirement to concrete command output, source implementation, and test references.
- Status: Met.

4. Requirement: Cutover decision is evidence-backed.
- Decision:
  - Proceed with workflow-engine ownership as default for targeted tiers (`epoch|phase|plan`) with feature-flag rollback path preserved.
- Basis:
  - Full test suites and builds pass.
  - Integration/unit tests explicitly verify default legacy-pass disablement and legacy-job suppression under workflow ownership.
  - Runtime start path for targeted tiers is workflow-engine-backed.
- Status: Met.

## Remaining Risks
- Coverage depth by tier:
  - Current automated evidence is strongest for `plan` tier behavior; `epoch`/`phase` share routing logic but have less explicit tier-specific assertions.
- Rollout risk:
  - Long-running environments may accumulate mixed in-flight legacy and workflow events; queue observability should be monitored during rollout windows.
- Web build warning:
  - Current web bundle reports a chunk-size warning (non-blocking for cutover but worth tracking).

## Rollback Instructions
1. Immediate broad rollback:
- Set `ORCHESTRATION_COMPATIBILITY_MODE=true`.
- Restart server processes.
- Expected behavior: orchestration endpoints/workers disabled while core task workflows remain available (see rollout doc: [hierarchical-orchestration-rollout.md](/mnt/c/Users/Nathan/Documents/GitHub/ai_coding_site/repos/ai-coding-site-2/tasks/8dec03b7-673f-4d11-b404-76d026e18a0e/docs/rollout/hierarchical-orchestration-rollout.md:58)).

2. Partial rollback (keep orchestration active, re-enable legacy ownership paths):
- Set `ORCHESTRATION_LEGACY_PLAN_ORCHESTRATION_PASS_ENABLED=true` to re-enable legacy `plan_orchestration_pass`.
- Set `ORCHESTRATION_LEGACY_JOB_OWNERSHIP_ENABLED=true` to disable workflow-based suppression of legacy jobs.
- Restart server processes.

3. Post-rollback checks:
- Run `cd server && npm run cli -- --help`.
- Verify orchestration endpoint behavior for chosen rollback mode.
- Monitor queue/job completion events and error rates before expanding traffic.
