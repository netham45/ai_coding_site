import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const workspaceRoot = path.resolve(moduleDir, "..", "..", "..");
const testDataRoot = path.join(workspaceRoot, ".tmp", "test-data");
const testReposRoot = path.join(workspaceRoot, ".tmp", "test-repos");

function resolveRootFromEnv(envValue: string | undefined, fallback: string): string {
  const raw = (envValue ?? "").trim();
  return raw ? path.resolve(raw) : fallback;
}

function isTestRuntime(): boolean {
  if (process.execArgv.includes("--test")) return true;
  if (process.argv.includes("--test")) return true;
  if ((process.env.NODE_ENV ?? "").toLowerCase() === "test") return true;
  if ((process.env.npm_lifecycle_event ?? "").toLowerCase() === "test") return true;
  return false;
}

function ensureIsolatedTestRoot(name: string, value: string, expectedRoot: string): string {
  const normalized = path.resolve(value);
  const expected = path.resolve(expectedRoot);
  if (normalized === expected || normalized.startsWith(`${expected}${path.sep}`)) {
    return normalized;
  }
  if (process.env.AI_CODING_ALLOW_NONISOLATED_TEST_PATHS === "1") {
    return normalized;
  }
  throw new Error(
    `[test-safety] Refusing to use non-isolated ${name}: ${normalized}. ` +
      `Use a path under ${expected} or set AI_CODING_ALLOW_NONISOLATED_TEST_PATHS=1 to override.`
  );
}

const runningTests = isTestRuntime();
const defaultDataRoot = runningTests ? testDataRoot : path.join(workspaceRoot, "data");
const defaultReposRoot = runningTests ? testReposRoot : path.join(workspaceRoot, "repos");

const resolvedDataRoot = resolveRootFromEnv(process.env.AI_CODING_DATA_ROOT, defaultDataRoot);
const resolvedReposRoot = resolveRootFromEnv(process.env.AI_CODING_REPOS_ROOT, defaultReposRoot);

export const dataRoot = runningTests ? ensureIsolatedTestRoot("AI_CODING_DATA_ROOT", resolvedDataRoot, testDataRoot) : resolvedDataRoot;
export const reposRoot = runningTests
  ? ensureIsolatedTestRoot("AI_CODING_REPOS_ROOT", resolvedReposRoot, testReposRoot)
  : resolvedReposRoot;
