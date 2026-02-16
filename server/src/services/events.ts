import type Database from "better-sqlite3";
import { db } from "../db/index.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

export function recordEvent(params: {
  projectId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  eventType: string;
  payload?: unknown;
  database?: Database.Database;
}): void {
  const targetDb = params.database ?? db;
  targetDb.prepare(
    `INSERT INTO events (id, project_id, task_id, session_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    makeId(),
    params.projectId ?? null,
    params.taskId ?? null,
    params.sessionId ?? null,
    params.eventType,
    JSON.stringify(params.payload ?? {}),
    nowIso()
  );
}
