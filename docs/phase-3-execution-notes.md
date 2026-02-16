# Phase 3 Execution Notes

Date executed: 2026-02-16

## Scope completed

- Added `task_sessions` table and indexes.
- Added runtime adapter and tmux services.
- Added runtime APIs:
  - `POST /api/tasks/:taskId/start`
  - `POST /api/tasks/:taskId/input`
  - `POST /api/tasks/:taskId/stop`
- Added heartbeat monitoring loop for active sessions.
- Added startup recovery for persisted active sessions.
- Added frontend runtime controls and session status card on task detail page.

## Acceptance checks completed

1. Build succeeded (`npm run build`).
2. Start runtime created tmux session and DB session row with `status=running`.
3. Input endpoint delivered user text into running session.
4. Stop endpoint set session `stopped` and task transition to `waiting_input`.
5. Restart recovery check:
   - server process restarted while tmux session remained running
   - API still returned active running session after restart

## Notes

- Socket path moved to a short `/tmp` path to avoid UNIX socket path length limits.
- `ai_command` policy blocks shell metacharacter tokens (`; & | < > \` $ ( )`).

## Remaining for Phase 4+

- Websocket terminal attach + xterm.js live stream.
- Full runtime worker separation.
- Richer adapter-specific lifecycle parsing.
