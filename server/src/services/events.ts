import type { Database as DatabaseType } from "better-sqlite3";
import { appDb, projectDbForProject } from "../db/index.js";
import { appProjectById, taskContextById } from "../db/ownership.js";
import type { AppProjectRow, TaskRow } from "../types.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

type EventProjectTarget = {
  project: AppProjectRow;
  db: DatabaseType;
};

function resolveProjectByTaskId(taskId: string): AppProjectRow | undefined {
  return taskContextById(taskId)?.appProject;
}

function resolveEventTarget(params: { projectId?: string | null; taskId?: string | null }): EventProjectTarget | undefined {
  const project =
    (params.projectId ? appProjectById(params.projectId) : undefined) ??
    (params.taskId ? resolveProjectByTaskId(params.taskId) : undefined);
  if (!project) {
    return undefined;
  }
  const db = projectDbForProject({ projectId: project.id, basePath: project.base_path });
  return { project, db };
}

export function findTaskAcrossProjects(taskId: string): { project: AppProjectRow; task: TaskRow; db: DatabaseType } | undefined {
  const context = taskContextById(taskId);
  if (!context) return undefined;
  return { project: context.appProject, task: context.task, db: context.db };
}

export function recordEvent(params: {
  projectId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  eventType: string;
  payload?: unknown;
}): void {
  const target = resolveEventTarget({ projectId: params.projectId, taskId: params.taskId });
  if (!target) {
    return;
  }

  target.db
    .prepare(
    `INSERT INTO events (id, project_id, task_id, session_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      makeId(),
      target.project.id,
      params.taskId ?? null,
      params.sessionId ?? null,
      params.eventType,
      JSON.stringify(params.payload ?? {}),
      nowIso()
    );
}
