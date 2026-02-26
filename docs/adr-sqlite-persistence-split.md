# ADR: Split Persistence into App DB and Per-Project DB

- Status: Accepted
- Date: 2026-02-16

## Context

The system currently stores global entities and project-local runtime/task entities in one SQLite database. This creates coupling between unrelated projects, makes per-project backup/recovery harder, and raises blast radius when a single project's data is damaged.

We are splitting persistence into two SQLite layers with clear ownership boundaries.

## Decision

Use two SQLite databases:

1. App DB (global): `data/app.sqlite`
2. Project DB (per project): `data/projects/<projectId>/project.sqlite`

`<projectId>` comes from `projects.id` in the app DB.

## Ownership Boundaries

### App DB (`data/app.sqlite`) is source of truth for

- `users`
- `user_settings`
- `projects`
- `project_members`

`projects` keeps global project metadata only (identity, repo, path, membership-relevant metadata). Project prompt/config fields are removed from app DB ownership.

### Project DB (`data/projects/<projectId>/project.sqlite`) is source of truth for

- `tasks`
- `task_dependencies`
- `task_state_transitions`
- `task_sessions`
- `plan_revisions`
- `plan_revision_items`
- `plan_revision_item_dependencies`
- `ide_instances`
- `merge_records`
- `events`
- Project prompt/config fields currently on `projects`:
  - `project_prompt`
  - `project_rules`
  - `coding_standard`
  - `coding_standard_other`
  - `project_other`

These prompt/config fields MUST be stored in a project-local config table in project DB (single-row per project model).

## Cross-DB Rules

1. No dual-write authority
- A record is written only in its owning DB.
- Non-owning DB may cache derived metadata only if explicitly marked non-authoritative.

2. Cross-DB references are by ID only
- App DB and project DB do not use SQLite foreign keys across files.
- Integrity across DBs is enforced in application logic.

3. Project DB bootstrap metadata
- Each project DB includes a metadata row containing at least:
  - `project_id` (must match app DB `projects.id`)
  - `schema_version`
  - `created_at`
- On open, service validates metadata `project_id` match before serving.

4. Delete/archive behavior
- Deleting a project from app DB requires coordinated deletion/archive of `<project.base_path>/.ai-coding/`.
- If coordinated delete fails, operation is marked partial and retried; app must not silently orphan project DBs.

## Sync and Source-of-Truth Behavior

1. Project creation
- Write project row in app DB first.
- Create `<project.base_path>/.ai-coding/`.
- Create and migrate project DB.
- Seed project-local config defaults in project DB.

2. Project prompt/config reads and writes
- Read/write only from project DB.
- App DB `projects` no longer stores these fields.

3. Task and plan lifecycle
- All task/plan/session/event/merge operations read/write only project DB.
- App DB is never used as fallback storage for these entities.

4. Membership and authorization
- Membership remains in app DB.
- Every project-DB operation performs auth check against app DB (`project_members`) before touching project DB.

5. Listing and aggregation
- Global project listing comes from app DB.
- Project-scoped task views come from that project's DB.
- If global rollups are needed later, they are async projections and explicitly non-authoritative.

## Failure Behavior: Missing or Corrupt Project DB

### Missing project DB file

Definition: `project.sqlite` does not exist at `<project.base_path>/.ai-coding/project.sqlite`.

Behavior:

1. If project DB has never been initialized (new project flow), create DB, run migrations, continue.
2. Otherwise treat as unavailable and fail closed for project-local operations:
- Return a project-scoped availability error (e.g., `PROJECT_DB_UNAVAILABLE`).
- Do not auto-create a replacement DB when data is expected, to avoid silent data loss.
3. Global app operations remain available (project list, users, settings, membership management).

### Corrupt/unreadable project DB

Definition: SQLite open/integrity/migration check fails.

Behavior:

1. Fail closed for project-local reads/writes (`PROJECT_DB_CORRUPT`).
2. Do not write partial updates to app DB to "compensate".
3. Mark project DB health as degraded in app-level operational state/logs.
4. Emit recoverable diagnostics and require explicit repair action (restore from backup or operator repair workflow).
5. Keep global app operations available.

## Migration Constraints

1. Schema split
- Remove project prompt/config columns from app DB `projects`.
- Add project-local config table to project DB and migrate values per project.

2. Data migration order
- For each project:
  - Ensure project DB exists and migrated.
  - Copy project-local entities from monolith DB to project DB.
  - Verify counts/checksums.
- After verification, remove migrated data from monolith-owned scope.

3. Cutover policy
- Cut over read paths first behind a feature flag.
- Enable writes to project DB only after read validation passes.
- Keep rollback path until migration verification completes.

## Consequences

Positive:

- Clear ownership boundaries.
- Reduced blast radius to per-project failures.
- Easier per-project backup/restore/portability.

Tradeoffs:

- App logic must handle two connections and cross-DB integrity checks.
- More explicit operational handling for missing/corrupt project DBs.
