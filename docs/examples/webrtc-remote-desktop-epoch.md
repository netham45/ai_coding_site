# WebRTC Remote Desktop Epoch Walkthrough

## Scope
Epoch prompt:
> "Create a remote desktop application that uses WebRTC to stream Windows to browsers captured via WGC and converted using WMF"

This walkthrough demonstrates:
- Epoch -> Phase -> Plan -> Task -> Exec decomposition.
- A blocked setup path on toolkit selection (`ip-12`) and later unblocking via dependency completion + `re_review`.
- Hook/job timeline (`readiness`, `decompose`, `re_review`, `synthesize`, `verify`, `delta_plan`, merge outcomes).
- Verification fail -> delta_plan -> pass within bounded iteration budget.
- Idempotency and auto-merge defaults with user override points.

## Global Defaults
- `bounded_iteration.max_iterations`: `3`
- `bounded_iteration.max_replans`: `2`
- `auto_merge_guidance.strategy`: `auto_merge_on_complete`
- User override points:
  - Plan approval can override `--auto-merge-item-keys`.
  - Any task/plan can be switched to manual merge before `ready_merge`.

## Hierarchy (Concrete IDs)

### Epoch
- `id`: `ep-webrtc-rd-001`
- `tier`: `epoch`
- `status` transitions: `queued -> in_progress -> awaiting_children -> merge_ready -> merged`
- `deps`:
  - `ip-02` Prompt contract foundation.
  - `ip-03` Readiness evaluator.
  - `ip-04` Synthesis template.
  - `ip-05` Verification template.
  - `ip-06` Delta planning template.
  - `ip-07` Re-review template.
  - `ip-08` Epoch->Phase template.
  - `ip-09` Phase->Plans template.
  - `ip-10` Plan->Subplans/Tasks template.
  - `ip-11` Task->Exec template.
  - `ip-12` Exec task runner template.
  - `ip-27` Completion evidence UX.
- `children_ids`: `ph-platform-spike-001`, `ph-streaming-core-001`, `ph-hardening-release-001`

### Phase
1. `ph-platform-spike-001` (Platform/Toolkit decisions)
- `status`: `merged`
- `deps`: `ip-08`, `ip-09`
- `children_ids`: `pl-capture-stack-001`, `pl-signaling-stack-001`

2. `ph-streaming-core-001` (MVP streaming path)
- `status`: `merged`
- `deps`: `ph-platform-spike-001`
- `children_ids`: `pl-host-capture-pipeline-001`, `pl-browser-playback-001`, `pl-session-control-001`

3. `ph-hardening-release-001` (Productionization)
- `status`: `merge_ready`
- `deps`: `ph-streaming-core-001`
- `children_ids`: `pl-observability-001`, `pl-deployment-security-001`

### Plan
1. `pl-capture-stack-001` (WGC/WMF toolkit selection and prototype)
- `status`: `merged`
- `deps`: `ip-10`
- `children_ids`: `tsk-eval-wgc-wmf-001`, `tsk-toolkit-selection-adr-001`

2. `pl-host-capture-pipeline-001` (Capture -> encode -> transport)
- Initial `status`: `blocked`
- Later `status`: `merged`
- `deps`: `tsk-toolkit-selection-adr-001` (reason: final WMF transform graph depends on approved toolkit decision)
- `children_ids`: `tsk-capture-service-001`, `tsk-encode-adapter-001`, `tsk-host-webrtc-publisher-001`

3. `pl-browser-playback-001`
- `status`: `merged`
- `children_ids`: `tsk-browser-player-001`, `tsk-input-roundtrip-001`

### Task
1. `tsk-toolkit-selection-adr-001`
- `status`: `merged`
- `definition_of_done`: ADR includes chosen API set, fallback matrix, perf envelope.
- `children_ids`: `exec-benchmark-capture-apis-001`, `exec-write-adr-001`

2. `tsk-capture-service-001`
- Initial `status`: `blocked` (waiting on toolkit ADR)
- Later `status`: `merged`
- `children_ids`: `exec-build-wgc-session-001`, `exec-add-frame-adapter-tests-001`

3. `tsk-host-webrtc-publisher-001`
- First verify result: `failed` (missing reconnect handling criterion)
- Delta cycle result: `merged`
- `children_ids`: `exec-peer-connection-publish-001`, `exec-reconnect-state-machine-001`

### Exec
Example leaf exec nodes:
- `exec-benchmark-capture-apis-001` -> benchmarked WGC vs alternatives.
- `exec-build-wgc-session-001` -> implemented capture session service.
- `exec-add-frame-adapter-tests-001` -> added WMF conversion tests.
- `exec-peer-connection-publish-001` -> initial publisher path.
- `exec-reconnect-state-machine-001` -> delta child for verification gap closure.

## Blocked -> Unblocked Flow (Toolkit Dependency)
1. `pl-host-capture-pipeline-001` is created with dependency `tsk-toolkit-selection-adr-001`.
2. `readiness` evaluates `pl-host-capture-pipeline-001` as `blocked`:
- reason code: `deps_incomplete`
- blocker hash basis: `tsk-toolkit-selection-adr-001:not_merged`
3. `tsk-toolkit-selection-adr-001` finishes and merges.
4. Hook emits dependency-completed event for dependents.
5. `re_review(pl-host-capture-pipeline-001)` runs:
- previous blocker hash changed.
- action: `unblocked`
- transition: `blocked -> ready`
6. `decompose` and child starts continue automatically under `auto_merge_on_complete` defaults.

## Hook/Job Timeline (Condensed)
1. `2026-02-24T15:00:00Z` `readiness` on `ep-webrtc-rd-001` -> `ready`.
2. `2026-02-24T15:00:03Z` `decompose` epoch -> phases created.
3. `2026-02-24T15:00:10Z` `readiness` on `pl-host-capture-pipeline-001` -> `blocked` (`deps_incomplete`).
4. `2026-02-24T15:12:00Z` `merge` outcome: `tsk-toolkit-selection-adr-001` merged.
5. `2026-02-24T15:12:02Z` dependency hook triggers `re_review` for blocked dependents.
6. `2026-02-24T15:12:03Z` `re_review` on `pl-host-capture-pipeline-001` -> action `unblocked`.
7. `2026-02-24T15:12:04Z` `decompose` plan -> tasks/exec children.
8. `2026-02-24T16:10:00Z` `synthesize` on `tsk-host-webrtc-publisher-001` produced coverage matrix.
9. `2026-02-24T16:10:02Z` `verify` -> `fail` (`reconnect criterion uncovered`).
10. `2026-02-24T16:10:03Z` `delta_plan` creates `exec-reconnect-state-machine-001` with unseen `gap_hash`.
11. `2026-02-24T16:32:00Z` delta exec merged.
12. `2026-02-24T16:32:10Z` `synthesize` + `verify` rerun -> `pass`.
13. `2026-02-24T16:33:00Z` `ready_merge` then `merge` outcomes for parent task/plan.

## Coverage Matrix Example (First Verify: Fail)
| Requirement ID | Requirement | Evidence | Status |
| --- | --- | --- | --- |
| `REQ-PUB-001` | Stream host desktop frames to browser via WebRTC | `task:exec-peer-connection-publish-001#result`, `src/host/webrtc/publisher.ts` | covered |
| `REQ-PUB-002` | Recover session within 5s after ICE disconnect | none | uncovered |
| `REQ-PUB-003` | Emit telemetry for publish lifecycle | `tests/publisher.telemetry.spec.ts` | covered |

Verification output:
- `status`: `fail`
- `deterministic_fail_reasons`: `missing_definition_of_done_coverage`
- `uncovered_gaps[0].gap_hash`: `sha256:req=REQ-PUB-002|kind=behavior|scope=tsk-host-webrtc-publisher-001`

## Delta Plan and Budget Behavior
- Budget before failure:
  - `max_iterations=3`, `max_replans=2`, `iteration_index=1`, `replan_index=0`
- `delta_plan` proposes one net-new child:
  - `id`: `exec-reconnect-state-machine-001`
  - `depends_on`: `exec-peer-connection-publish-001`
  - `gap_hash`: `sha256:req=REQ-PUB-002|kind=behavior|scope=tsk-host-webrtc-publisher-001`
- Deduplication behavior:
  - If rerun sees same unresolved `gap_hash`, no duplicate child is spawned.
- After delta merge:
  - `iteration_index=2`, `replan_index=1`
  - verify passes; budget not exhausted.

## Idempotency Example
For `delta_plan(tsk-host-webrtc-publisher-001)`:
- `idempotency.input_fingerprint`: hash of parent DoD + uncovered gaps + child completion set.
- `idempotency.output_fingerprint`: hash of proposed child set.
- `idempotency.dedupe_key`: `delta:tsk-host-webrtc-publisher-001:<input_fingerprint>`.
- Reprocessing the same input emits the same child set and no duplicate materialization.

## Auto-merge Defaults and User Overrides
Defaults used in this walkthrough:
- All exec tasks created with `auto_merge=true`.
- Parent tasks/plans use `auto_merge_on_complete=true`.

User override points shown:
1. During `plans approve`, user narrows `--auto-merge-item-keys` to exclude risky networking items.
2. Before merging `tsk-host-webrtc-publisher-001`, user flips strategy to manual after viewing verification reasons.
3. After delta pass and checks, user explicitly calls merge to finalize.
