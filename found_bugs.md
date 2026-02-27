# Found Bugs

## 1) `PATCH /api/users/me/settings` returns 500 due missing `events` table in app DB (unresolved)

- Discovered during server test execution on February 27, 2026.
- Reproduction:
  - `PATCH /api/users/me/settings` with either `defaultAiCommand` or `defaultAiCommands`.
- Observed behavior:
  - HTTP 500 with error: `no such table: events`.
- Technical cause:
  - `server/src/routes/settings.ts` calls `recordEvent(...)` without specifying a project database.
  - `recordEvent` writes into the default app DB, but that DB schema does not include an `events` table.
- Additional impact:
  - `user_settings` update is committed before the failing `recordEvent` call, so clients receive a 500 even though settings are persisted.
- Current status:
  - Unresolved in this branch (per task instruction to log bugs without fixing).

## 2) `OrchestrationTree` crash with partial node payloads (resolved)

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
