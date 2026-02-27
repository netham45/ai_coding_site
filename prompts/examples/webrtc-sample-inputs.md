# WebRTC Remote Desktop Sample Inputs

This file provides realistic sample runtime inputs for the epoch walkthrough scenario:
`ep-webrtc-rd-001`.

## 1) Epoch -> Phases (`epoch-to-phases`)

```yaml
mode: initial
node:
  id: ep-webrtc-rd-001
  tier: epoch
  title: "Windows WebRTC Remote Desktop"
  status: in_progress
  parent_id: null
  children_ids: []
project_constraints:
  platform: ["Windows 11 host", "Chromium-based browser client"]
  media_stack: ["WGC", "WMF", "WebRTC"]
  security: ["DTLS-SRTP", "short-lived session tokens"]
  timeline: "MVP in 8 weeks"
existing_dag_state:
  dependencies:
    - id: ip-02
      status: merged
    - id: ip-03
      status: merged
    - id: ip-04
      status: merged
    - id: ip-05
      status: merged
    - id: ip-06
      status: merged
    - id: ip-07
      status: merged
    - id: ip-08
      status: merged
    - id: ip-09
      status: merged
    - id: ip-10
      status: merged
    - id: ip-11
      status: merged
    - id: ip-12
      status: merged
    - id: ip-27
      status: merged
repo_context:
  default_branch: main
  active_branch: orchestrator/demo/webrtc-epoch
  known_modules:
    - src/host/capture
    - src/host/webrtc
    - src/browser/player
    - src/signaling
unresolved_blockers: []
```

## 2) Re-review Unblock (`re-review-unblock`)

```yaml
node:
  id: pl-host-capture-pipeline-001
  tier: plan
  status: blocked
  parent_id: ph-streaming-core-001
  children_ids: []
current_blockers:
  - id: tsk-toolkit-selection-adr-001
    reason: "WMF graph and interop decisions not finalized"
    hash: "sha256:blocker:tsk-toolkit-selection-adr-001:not_merged"
changed_dependency_events:
  - id: tsk-toolkit-selection-adr-001
    old_status: merge_ready
    new_status: merged
    event_id: evt-merge-adr-001
changed_children_events: []
latest_synthesis: null
latest_verification: null
iteration_counters:
  retries_used: 0
  max_retries: 3
  replans_used: 0
  max_replans: 2
prior_gap_hashes: []
```

Expected decision shape:

```yaml
re_review:
  action: unblocked
  reason: "blocking dependency completed"
  blockers_remaining: []
  escalation: false
```

## 3) Verify Fail Input (`verification`)

```yaml
node:
  id: tsk-host-webrtc-publisher-001
  tier: task
  status: awaiting_children
  parent_id: pl-host-capture-pipeline-001
  children_ids:
    - exec-peer-connection-publish-001
    - exec-publisher-telemetry-001
parent_definition_of_done:
  - "Browser receives host video frames with latency <=120ms on LAN"
  - "Session reconnect succeeds within 5s after ICE interruption"
  - "Publisher emits telemetry for connect/disconnect/reconnect"
synthesis:
  matrix:
    - requirement_id: REQ-PUB-001
      status: covered
      evidence_refs: ["task:exec-peer-connection-publish-001#result"]
    - requirement_id: REQ-PUB-002
      status: uncovered
      evidence_refs: []
    - requirement_id: REQ-PUB-003
      status: covered
      evidence_refs: ["task:exec-publisher-telemetry-001#result"]
checks:
  tests:
    - name: host-webrtc-publisher.unit
      result: pass
    - name: host-webrtc-publisher.integration
      result: pass
children_completion_evidence:
  required_children_complete: true
```

Expected verification outcome:

```yaml
verification:
  status: fail
  deterministic_fail_reasons:
    - missing_definition_of_done_coverage
  uncovered_gaps:
    - requirement_id: REQ-PUB-002
      gap_hash: "sha256:req=REQ-PUB-002|kind=behavior|scope=tsk-host-webrtc-publisher-001"
      severity: high
  delta_planning:
    should_trigger: true
```

## 4) Delta Planning Input (`delta-planning`)

```yaml
node:
  id: tsk-host-webrtc-publisher-001
  tier: task
verification_fail_output:
  uncovered_gaps:
    - requirement_id: REQ-PUB-002
      gap_hash: "sha256:req=REQ-PUB-002|kind=behavior|scope=tsk-host-webrtc-publisher-001"
existing_children:
  - id: exec-peer-connection-publish-001
    status: merged
  - id: exec-publisher-telemetry-001
    status: merged
dependency_dag:
  valid: true
state:
  gap_hashes_seen: []
iteration:
  max_iterations: 3
  max_replans: 2
  iteration_index: 1
  replan_index: 0
```

Expected delta output shape:

```yaml
proposed_children:
  - id: exec-reconnect-state-machine-001
    item_type: execution_task
    depends_on: [exec-peer-connection-publish-001]
    gap_hash: "sha256:req=REQ-PUB-002|kind=behavior|scope=tsk-host-webrtc-publisher-001"
dedupe_summary:
  duplicates_removed: 0
escalation:
  required: false
```
