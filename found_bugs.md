# Found Bugs

## 1) `OrchestrationTree` crash with partial node payloads (resolved)

- Discovered during web test execution on February 27, 2026.
- Symptom at discovery:
  - `TypeError: Cannot read properties of undefined (reading 'length')`
  - stack at `web/src/components/OrchestrationTree.tsx` in `TreeRow`.
- Root cause:
  - The tree renderer assumed `children`, `waiting`, and `dependencyTaskIds` were always present.
  - Existing tests also surfaced partial `task` payloads that omitted `task.id` / `task.title`.
- Resolution in this task branch:
  - Added defensive fallbacks in `OrchestrationTree` for missing fields and stable task id/title derivation.
- Current status:
  - Resolved in this branch; `web` test suite now passes.
