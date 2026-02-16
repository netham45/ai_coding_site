import type { Database as DatabaseType } from "better-sqlite3";
import { appDb, hydrateProjectWithConfig, projectDbForProject } from "./index.js";
import type { AppProjectRow, ProjectRow, TaskRow } from "../types.js";

export type ProjectContext = {
  appProject: AppProjectRow;
  project: ProjectRow;
  db: DatabaseType;
};

export type TaskContext = ProjectContext & {
  task: TaskRow;
};

export function allAppProjects(): AppProjectRow[] {
  return appDb.prepare("SELECT * FROM projects ORDER BY created_at ASC").all() as AppProjectRow[];
}

export function appProjectById(projectId: string): AppProjectRow | undefined {
  return appDb.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as AppProjectRow | undefined;
}

export function appProjectsForUser(userId: string): AppProjectRow[] {
  return appDb
    .prepare(
      `SELECT p.*
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = ?
       ORDER BY p.created_at ASC`
    )
    .all(userId) as AppProjectRow[];
}

export function appProjectForUser(projectId: string, userId: string): AppProjectRow | undefined {
  return appDb
    .prepare(
      `SELECT p.*
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE p.id = ? AND pm.user_id = ?`
    )
    .get(projectId, userId) as AppProjectRow | undefined;
}

export function projectContextFromAppProject(appProject: AppProjectRow): ProjectContext {
  const db = projectDbForProject({ projectId: appProject.id, basePath: appProject.base_path });
  const project = hydrateProjectWithConfig(appProject);
  return { appProject, project, db };
}

export function projectContextForUser(projectId: string, userId: string): ProjectContext | undefined {
  const appProject = appProjectForUser(projectId, userId);
  if (!appProject) {
    return undefined;
  }
  return projectContextFromAppProject(appProject);
}

export function taskContextForUser(taskId: string, userId: string): TaskContext | undefined {
  const projects = appProjectsForUser(userId);
  for (const appProject of projects) {
    try {
      const context = projectContextFromAppProject(appProject);
      const task = context.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
      if (task) {
        return { ...context, task };
      }
    } catch {
      // Ignore projects with unavailable/corrupt DBs while resolving by task id.
    }
  }
  return undefined;
}

export function taskContextById(taskId: string): TaskContext | undefined {
  const projects = allAppProjects();
  for (const appProject of projects) {
    try {
      const context = projectContextFromAppProject(appProject);
      const task = context.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
      if (task) {
        return { ...context, task };
      }
    } catch {
      // Ignore projects with unavailable/corrupt DBs here.
    }
  }
  return undefined;
}
