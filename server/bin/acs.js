#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKSPACE_PACKAGE_NAME = "ai-coding-site";
const REQUIRED_TOP_LEVEL_DIRS = ["server", "repos", "web"];

function hasRequiredDirectories(root) {
  return REQUIRED_TOP_LEVEL_DIRS.every((dirname) => {
    try {
      return fs.statSync(path.join(root, dirname)).isDirectory();
    } catch {
      return false;
    }
  });
}

function hasExpectedWorkspaceIdentity(root) {
  const packageJsonPath = path.join(root, "package.json");
  let packageJsonRaw;
  try {
    packageJsonRaw = fs.readFileSync(packageJsonPath, "utf8");
  } catch {
    return false;
  }

  let parsed;
  try {
    parsed = JSON.parse(packageJsonRaw);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }

  const rootPkg = parsed;
  if (rootPkg.name !== WORKSPACE_PACKAGE_NAME) {
    return false;
  }

  if (!Array.isArray(rootPkg.workspaces)) {
    return false;
  }

  return rootPkg.workspaces.includes("server") && rootPkg.workspaces.includes("web");
}

function discoverWorkspaceRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    if (hasRequiredDirectories(current) && hasExpectedWorkspaceIdentity(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function ensureWorkspaceRoot() {
  const found = discoverWorkspaceRoot(process.cwd());
  if (found) {
    return found;
  }

  const resolvedStart = path.resolve(process.cwd());
  console.error(
    [
      `Error: Could not locate the ai-coding-site workspace root from ${resolvedStart}.`,
      "Run this command from within an ai-coding-site workspace (for example, <workspace>/server)."
    ].join(" ")
  );
  process.exit(1);
}

function runViaTsx(srcCliPath, args) {
  const serverRoot = path.dirname(path.dirname(srcCliPath));
  const localBin = path.join(
    serverRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx"
  );
  const runner = fs.existsSync(localBin) ? localBin : "tsx";
  const child = spawnSync(runner, [srcCliPath, ...args], { stdio: "inherit" });
  if (typeof child.status === "number") {
    process.exit(child.status);
  }
  if (child.error) {
    console.error(`Error: Failed to start tsx: ${child.error.message}`);
  }
  process.exit(1);
}

async function main() {
  ensureWorkspaceRoot();

  const thisFile = fileURLToPath(import.meta.url);
  const serverRoot = path.dirname(path.dirname(thisFile));
  const distCli = path.join(serverRoot, "dist", "cli", "index.js");
  const srcCli = path.join(serverRoot, "src", "cli", "index.ts");
  const args = process.argv.slice(2);

  if (fs.existsSync(distCli)) {
    await import(pathToFileURL(distCli).href);
    return;
  }

  if (fs.existsSync(srcCli)) {
    runViaTsx(srcCli, args);
    return;
  }

  console.error(
    `Error: Could not find CLI entrypoint. Expected one of: ${distCli} or ${srcCli}. Try running \`npm run build -w server\`.`
  );
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
