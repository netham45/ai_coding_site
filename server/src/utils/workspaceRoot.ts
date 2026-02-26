import fs from "node:fs";
import path from "node:path";

const WORKSPACE_PACKAGE_NAME = "ai-coding-site";
const REQUIRED_TOP_LEVEL_DIRS = ["server", "repos", "web"] as const;

function hasRequiredDirectories(root: string): boolean {
  return REQUIRED_TOP_LEVEL_DIRS.every((dirname) => {
    try {
      return fs.statSync(path.join(root, dirname)).isDirectory();
    } catch {
      return false;
    }
  });
}

function hasExpectedWorkspaceIdentity(root: string): boolean {
  const packageJsonPath = path.join(root, "package.json");
  let packageJsonRaw: string;
  try {
    packageJsonRaw = fs.readFileSync(packageJsonPath, "utf8");
  } catch {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonRaw);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const rootPkg = parsed as { name?: unknown; workspaces?: unknown };
  if (rootPkg.name !== WORKSPACE_PACKAGE_NAME) {
    return false;
  }
  if (!Array.isArray(rootPkg.workspaces)) {
    return false;
  }
  return rootPkg.workspaces.includes("server") && rootPkg.workspaces.includes("web");
}

function isWorkspaceRoot(root: string): boolean {
  return hasRequiredDirectories(root) && hasExpectedWorkspaceIdentity(root);
}

export function discoverWorkspaceRoot(startDir = process.cwd()): string | null {
  let current = path.resolve(startDir);
  while (true) {
    if (isWorkspaceRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function getWorkspaceRootOrThrow(startDir = process.cwd()): string {
  const found = discoverWorkspaceRoot(startDir);
  if (found) {
    return found;
  }
  const resolvedStart = path.resolve(startDir);
  throw new Error(
    [
      `Could not locate the ai-coding-site workspace root from ${resolvedStart}.`,
      "Run this command from within an ai-coding-site workspace (for example, <workspace>/server)."
    ].join(" ")
  );
}
