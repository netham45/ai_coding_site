# Backup and Recovery Runbook

Date updated: 2026-02-16

## Scope

This runbook covers operational backup and restore for:

- app DB (`app.sqlite`) for users, projects, memberships, and migration state
- per-project DBs (`data/projects/<projectId>/project.sqlite`) for project config, tasks, plans, runtime state, and events

## Backup strategy

1. Quiesce write traffic.
2. Back up app DB and each project DB as SQLite backups.
3. Record a manifest with checksums and timestamps.
4. Verify backups by opening each backup DB and running quick integrity checks.

Recommended cadence:

- Hourly snapshots for active environments.
- Daily retained snapshots for 30 days.
- Weekly retained snapshots for 12 weeks.

## Pre-backup checks

1. Call `GET /api/health` and confirm:
   - `ok: true`
   - `diagnostics.projectDb.failureCounts` does not show growing `open:*`/`validation:*` failures
   - `diagnostics.migration.counts.failed` is `0` (or known and accepted)
2. Ensure disk space is sufficient for full snapshot copies.
3. Confirm no ongoing filesystem-level maintenance on repo directories.

## Backup commands (example)

```bash
set -euo pipefail

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="backups/${STAMP}"
mkdir -p "${BACKUP_ROOT}/app" "${BACKUP_ROOT}/projects"

# App DB
sqlite3 data/app.sqlite ".backup '${BACKUP_ROOT}/app/app.sqlite'"

# Project DBs
find data/projects -type f -path "*/project.sqlite" | while read -r db; do
  rel="${db#data/projects/}"
  out="${BACKUP_ROOT}/projects/${rel}"
  mkdir -p "$(dirname "${out}")"
  sqlite3 "${db}" ".backup '${out}'"
done

# Checksums manifest
(cd "${BACKUP_ROOT}" && find . -type f -name "*.sqlite" -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS.txt)
```

## Backup validation

For each backup file:

1. Run `sqlite3 <file> "PRAGMA integrity_check;"` and require `ok`.
2. For app backup, verify core tables exist:
   - `users`, `projects`, `project_members`, `project_data_migrations`
3. For project backup, verify core tables exist:
   - `project_metadata`, `project_config`, `tasks`, `task_sessions`, `events`

## Recovery procedures

### Full recovery

1. Stop API process.
2. Restore `app.sqlite` from selected snapshot.
3. Restore project DBs into corresponding `data/projects/<projectId>/project.sqlite` paths.
4. Start API process.
5. Verify:
   - `GET /api/health`
   - Sample project read (`GET /api/projects/:projectId`)
   - Sample task list (`GET /api/projects/:projectId/tasks`)

### Single-project recovery

1. Stop API process (or ensure project is not being written).
2. Restore only target project DB file.
3. Start API process.
4. Validate project:
   - `GET /api/projects/:projectId`
   - `GET /api/projects/:projectId/tasks`
   - Optional: verify `project_metadata.project_id` matches app `projects.id`

### Corrupt/missing project DB emergency handling

1. Confirm error code:
   - `PROJECT_DB_UNAVAILABLE` (missing/unreadable)
   - `PROJECT_DB_CORRUPT` (open/validation mismatch)
2. Check `GET /api/health` diagnostics for recent failure detail.
3. Restore affected project DB from latest valid backup.
4. If backup unavailable and loss is accepted, reinitialize project DB by re-cloning project through project creation flow.

## Rollback notes for split persistence

If project DB storage must be bypassed temporarily:

1. Set `SPLIT_PERSISTENCE_PHASE=monolith`.
2. Restart server.
3. Confirm `GET /api/health` and task/plan reads work from monolith tables.

After issue is fixed, return to `write_cutover` or `cleanup` per rollout plan.
