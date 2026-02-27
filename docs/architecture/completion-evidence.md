# Completion Evidence Artifacts

## Overview
Parent-node completion now persists deterministic synthesis and verification artifacts and exposes them through task/plan APIs for UI inspection.

## Artifact lifecycle
1. `synthesize(parent)` writes `orchestration.synthesize.completed` with:
- summary text
- requirement to evidence coverage matrix
- uncovered requirements

2. `verify(parent)` writes `orchestration.verify.completed` with:
- verdict (`pass`/`fail`)
- failing requirements
- verification reasons
- whether `delta_plan` was enqueued
- replan budget exhaustion status

3. Metadata links and snapshots are persisted on the parent node under `metadata.custom`:
- `synthesis_artifact_event_id`
- `verification_artifact_event_id`
- `verification_verdict`
- `completion_artifacts.synthesis`
- `completion_artifacts.verification`
- `completion_artifacts.delta_loop_history` (latest 20 attempts)

## Evidence mapping
Coverage matrix evidence rows include:
- `artifact_ref` (`task:<childId>#result` or `#title`)
- `snippet`
- `repo_path` (detected file/module path from child artifacts)
- `module_ref` (derived from repo path)
- `test_ref` (detected test/spec reference)

This supports requirement to evidence traceability to repository modules and tests.

## API exposure
Serialized task/plan payloads include a normalized `completion` object:
- latest synthesis and verification artifacts
- summary shortcut
- verification verdict and event ids
- delta loop history for gap-closure auditing

When metadata snapshots are missing, API serialization falls back to event payloads.

## UI exposure
`TaskDetailPage` renders:
- completion summary (artifact-backed)
- requirement to evidence matrix with unresolved gaps
- verification outcome details
- delta loop (gap closure) history

This allows users to inspect why verification failed, which requirements remain unresolved, and whether additional delta work was enqueued.
