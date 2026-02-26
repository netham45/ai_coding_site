import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const workspaceRoot = path.resolve(moduleDir, "..", "..", "..");

function resolveRootFromEnv(envValue: string | undefined, fallback: string): string {
  const raw = (envValue ?? "").trim();
  return raw ? path.resolve(raw) : fallback;
}

export const dataRoot = resolveRootFromEnv(process.env.AI_CODING_DATA_ROOT, path.join(workspaceRoot, "data"));
export const reposRoot = resolveRootFromEnv(process.env.AI_CODING_REPOS_ROOT, path.join(dataRoot, "repos"));
const tasksRoot = resolveRootFromEnv(process.env.AI_CODING_TASKS_ROOT, path.join(dataRoot, "tasks"));

export function projectTaskWorkspacesRoot(projectId: string): string {
  return path.join(tasksRoot, projectId);
}

export function taskWorkspacePath(projectId: string, taskId: string): string {
  return path.join(projectTaskWorkspacesRoot(projectId), taskId);
}

export function legacyProjectTaskWorkspacesRoot(projectBasePath: string): string {
  return path.resolve(path.dirname(projectBasePath), "tasks");
}
