import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function taskBranchName(taskId: string): string {
  return `task/${taskId}`;
}

function nonInteractiveGitEnv(): Record<string, string> {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never"
  } as Record<string, string>;
}

function baseGitEnv(): Record<string, string> {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never"
  } as Record<string, string>;
}

export async function cloneRepo(params: {
  repoUrl: string;
  destination: string;
  branch: string;
}): Promise<void> {
  await fs.promises.mkdir(path.dirname(params.destination), { recursive: true });
  try {
    await execFileAsync("git", ["clone", "--origin", "origin", "--branch", params.branch, params.repoUrl, params.destination], {
      env: baseGitEnv(),
      timeout: 120000
    });
  } catch (error: any) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    const message = stderr.trim() || error?.message || "git clone failed";
    throw new Error(message);
  }
}

export async function cloneLocalRepoToWorkspace(params: {
  sourcePath: string;
  workspacePath: string;
  sourceBranch?: string;
}): Promise<void> {
  await fs.promises.mkdir(path.dirname(params.workspacePath), { recursive: true });
  try {
    const cloneArgs = ["clone"];
    if (params.sourceBranch) {
      cloneArgs.push("--branch", params.sourceBranch);
    }
    cloneArgs.push(params.sourcePath, params.workspacePath);
    await execFileAsync("git", cloneArgs, { timeout: 120000 });
    // Ensure task workspace origin fetch + push both point to the local base clone.
    await execFileAsync("git", ["-C", params.workspacePath, "remote", "set-url", "origin", params.sourcePath], {
      timeout: 15000
    });
    await execFileAsync("git", ["-C", params.workspacePath, "remote", "set-url", "--push", "origin", params.sourcePath], {
      timeout: 15000
    });
  } catch (error: any) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    const message = stderr.trim() || error?.message || "git local clone failed";
    throw new Error(message);
  }
}

export async function cloneLocalBaseToWorkspace(params: { basePath: string; workspacePath: string; baseBranch?: string }): Promise<void> {
  await cloneLocalRepoToWorkspace({
    sourcePath: params.basePath,
    workspacePath: params.workspacePath,
    sourceBranch: params.baseBranch
  });
}

export async function listRepoFiles(params: { repoPath: string; query?: string; limit?: number }): Promise<string[]> {
  const normalizedLimit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const normalizedQuery = (params.query ?? "").trim().toLowerCase();

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", params.repoPath, "ls-files", "--cached", "--others", "--exclude-standard"],
      {
        timeout: 20000,
        env: nonInteractiveGitEnv()
      }
    );

    const files = String(stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (!normalizedQuery) {
      return files.sort((a, b) => a.localeCompare(b)).slice(0, normalizedLimit);
    }

    return files
      .filter((file) => file.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => {
        const aLower = a.toLowerCase();
        const bLower = b.toLowerCase();
        const aBase = path.basename(aLower);
        const bBase = path.basename(bLower);

        const aScore = aLower.startsWith(normalizedQuery) ? 0 : aBase.startsWith(normalizedQuery) ? 1 : 2;
        const bScore = bLower.startsWith(normalizedQuery) ? 0 : bBase.startsWith(normalizedQuery) ? 1 : 2;

        if (aScore !== bScore) return aScore - bScore;
        if (a.length !== b.length) return a.length - b.length;
        return a.localeCompare(b);
      })
      .slice(0, normalizedLimit);
  } catch (error: any) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    const message = stderr.trim() || error?.message || "failed to list repository files";
    throw new Error(message);
  }
}

export async function getHeadCommitSha(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      timeout: 15000,
      env: nonInteractiveGitEnv()
    });
    return String(stdout).trim();
  } catch (error: any) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    const message = stderr.trim() || error?.message || "failed to read HEAD";
    throw new Error(message);
  }
}

export async function createTaskBranch(workspacePath: string, taskId: string): Promise<void> {
  const branch = taskBranchName(taskId);
  try {
    await execFileAsync("git", ["-C", workspacePath, "checkout", "-b", branch], {
      timeout: 15000,
      env: nonInteractiveGitEnv()
    });
  } catch (error: any) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    const message = stderr.trim() || error?.message || "failed to create task branch";
    throw new Error(message);
  }
}

export async function refreshBaseFromOrigin(params: { basePath: string; defaultBranch: string }): Promise<string> {
  try {
    await execFileAsync("git", ["-C", params.basePath, "fetch", "origin", params.defaultBranch], {
      timeout: 45000,
      env: nonInteractiveGitEnv()
    });
    await execFileAsync("git", ["-C", params.basePath, "checkout", params.defaultBranch], {
      timeout: 15000,
      env: nonInteractiveGitEnv()
    });
    await execFileAsync("git", ["-C", params.basePath, "reset", "--hard", `origin/${params.defaultBranch}`], {
      timeout: 30000,
      env: nonInteractiveGitEnv()
    });
    await execFileAsync("git", ["-C", params.basePath, "clean", "-fd"], {
      timeout: 20000,
      env: nonInteractiveGitEnv()
    });
  } catch (error: any) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    const message = stderr.trim() || error?.message || "failed to refresh base repository";
    throw new Error(message);
  }

  return getHeadCommitSha(params.basePath);
}

export type WorkspaceGitStatus = {
  branch: string;
  ahead: number;
  behind: number;
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  conflicted: number;
  untracked: number;
  staged: number;
  unstaged: number;
  clean: boolean;
};

export async function getWorkspaceGitStatus(workspacePath: string): Promise<WorkspaceGitStatus> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspacePath, "status", "--porcelain=v1", "--branch"], {
      timeout: 15000,
      env: nonInteractiveGitEnv()
    });
    const lines = String(stdout)
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);

    let branch = "unknown";
    let ahead = 0;
    let behind = 0;
    let modified = 0;
    let added = 0;
    let deleted = 0;
    let renamed = 0;
    let conflicted = 0;
    let untracked = 0;
    let staged = 0;
    let unstaged = 0;

    for (const line of lines) {
      if (line.startsWith("## ")) {
        const branchLine = line.slice(3);
        const [left, right] = branchLine.split("...");
        branch = (left || "unknown").trim();
        if (right?.includes("[")) {
          const details = right.slice(right.indexOf("[") + 1, right.lastIndexOf("]"));
          for (const item of details.split(",")) {
            const part = item.trim();
            if (part.startsWith("ahead ")) ahead = Number.parseInt(part.slice(6), 10) || 0;
            if (part.startsWith("behind ")) behind = Number.parseInt(part.slice(7), 10) || 0;
          }
        }
        continue;
      }

      const x = line[0] ?? " ";
      const y = line[1] ?? " ";

      if (x === "?" && y === "?") {
        untracked += 1;
        continue;
      }

      const conflictChars = new Set(["U", "A", "D"]);
      if ((x === "U" || y === "U") || (conflictChars.has(x) && conflictChars.has(y) && x !== y)) {
        conflicted += 1;
      }
      if (x !== " ") {
        staged += 1;
      }
      if (y !== " ") {
        unstaged += 1;
      }

      if (x === "A" || y === "A") added += 1;
      if (x === "M" || y === "M") modified += 1;
      if (x === "D" || y === "D") deleted += 1;
      if (x === "R" || y === "R") renamed += 1;
    }

    const dirtyEntries = modified + added + deleted + renamed + conflicted + untracked;
    return {
      branch,
      ahead,
      behind,
      modified,
      added,
      deleted,
      renamed,
      conflicted,
      untracked,
      staged,
      unstaged,
      clean: dirtyEntries === 0
    };
  } catch (error: any) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    const message = stderr.trim() || error?.message || "failed to read git status";
    throw new Error(message);
  }
}

export type PullMainResult = {
  conflicted: boolean;
  conflictFiles: string[];
  headCommitSha: string;
};

export async function pullRemoteRefIntoTaskWorkspace(params: { workspacePath: string; remoteRef: string }): Promise<PullMainResult> {
  try {
    await execFileAsync("git", ["-C", params.workspacePath, "fetch", "origin", params.remoteRef], {
      timeout: 30000,
      env: nonInteractiveGitEnv()
    });
  } catch (error: any) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    const message = stderr.trim() || error?.message || "failed to fetch main branch";
    throw new Error(message);
  }

  let conflicted = false;
  try {
    await execFileAsync("git", ["-C", params.workspacePath, "merge", "--no-edit", `origin/${params.remoteRef}`], {
      timeout: 45000,
      env: nonInteractiveGitEnv()
    });
  } catch (error: any) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", params.workspacePath, "diff", "--name-only", "--diff-filter=U"], {
        timeout: 10000,
        env: nonInteractiveGitEnv()
      });
      const files = String(stdout)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (files.length > 0) {
        conflicted = true;
      } else {
        const stderr = error?.stderr ? String(error.stderr) : "";
        const message = stderr.trim() || error?.message || "git merge failed";
        throw new Error(message);
      }
    } catch (inner: any) {
      const message = String(inner?.message ?? "git merge failed");
      throw new Error(message);
    }
  }

  let conflictFiles: string[] = [];
  if (conflicted) {
    const { stdout } = await execFileAsync("git", ["-C", params.workspacePath, "diff", "--name-only", "--diff-filter=U"], {
      timeout: 10000,
      env: nonInteractiveGitEnv()
    });
    conflictFiles = String(stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const headCommitSha = await getHeadCommitSha(params.workspacePath);
  return {
    conflicted,
    conflictFiles,
    headCommitSha
  };
}

export type MergeTaskResult =
  | {
      conflicted: false;
      mergeCommitSha: string;
      conflictFiles: [];
    }
  | {
      conflicted: true;
      mergeCommitSha: null;
      conflictFiles: string[];
    };

export async function mergeTaskWorkspaceIntoTarget(params: {
  targetPath: string;
  targetBranch: string;
  syncTargetBranchFromOrigin?: boolean;
  workspacePath: string;
  taskId: string;
}): Promise<MergeTaskResult> {
  if (params.syncTargetBranchFromOrigin) {
    try {
      await execFileAsync("git", ["-C", params.targetPath, "fetch", "origin", params.targetBranch], {
        timeout: 45000,
        env: nonInteractiveGitEnv()
      });
      await execFileAsync("git", ["-C", params.targetPath, "checkout", params.targetBranch], {
        timeout: 15000,
        env: nonInteractiveGitEnv()
      });
      await execFileAsync("git", ["-C", params.targetPath, "merge", "--ff-only", `origin/${params.targetBranch}`], {
        timeout: 30000,
        env: nonInteractiveGitEnv()
      });
    } catch (error: any) {
      const stderr = error?.stderr ? String(error.stderr) : "";
      const message = stderr.trim() || error?.message || "failed to sync target branch";
      throw new Error(message);
    }
  } else {
    try {
      await execFileAsync("git", ["-C", params.targetPath, "checkout", params.targetBranch], {
        timeout: 15000,
        env: nonInteractiveGitEnv()
      });
    } catch (error: any) {
      const stderr = error?.stderr ? String(error.stderr) : "";
      const message = stderr.trim() || error?.message || "failed to checkout target branch";
      throw new Error(message);
    }
  }

  try {
    const sourceBranch = taskBranchName(params.taskId);
    await execFileAsync("git", ["-C", params.workspacePath, "rev-parse", "--verify", `refs/heads/${sourceBranch}`], {
      timeout: 10000,
      env: nonInteractiveGitEnv()
    });
    await execFileAsync("git", ["-C", params.targetPath, "fetch", params.workspacePath, `refs/heads/${sourceBranch}`], {
      timeout: 45000,
      env: nonInteractiveGitEnv()
    });
  } catch (error: any) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    const message = stderr.trim() || error?.message || "failed to fetch task workspace branch";
    throw new Error(message);
  }

  try {
    await execFileAsync("git", ["-C", params.targetPath, "merge", "--no-ff", "--no-edit", "FETCH_HEAD"], {
      timeout: 60000,
      env: nonInteractiveGitEnv()
    });
  } catch (error: any) {
    const { stdout } = await execFileAsync("git", ["-C", params.targetPath, "diff", "--name-only", "--diff-filter=U"], {
      timeout: 10000,
      env: nonInteractiveGitEnv()
    });
    const conflictFiles = String(stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (conflictFiles.length > 0) {
      try {
        await execFileAsync("git", ["-C", params.targetPath, "merge", "--abort"], {
          timeout: 10000,
          env: nonInteractiveGitEnv()
        });
      } catch {
        // ignore abort errors; caller still gets conflict result
      }
      return {
        conflicted: true,
        mergeCommitSha: null,
        conflictFiles
      };
    }
    const stderr = error?.stderr ? String(error.stderr) : "";
    const message = stderr.trim() || error?.message || "merge into target failed";
    throw new Error(message);
  }

  const mergeCommitSha = await getHeadCommitSha(params.targetPath);

  return {
    conflicted: false,
    mergeCommitSha,
    conflictFiles: []
  };
}

export async function mergeTaskWorkspaceIntoBase(params: {
  basePath: string;
  workspacePath: string;
  defaultBranch: string;
  taskId: string;
}): Promise<MergeTaskResult> {
  return mergeTaskWorkspaceIntoTarget({
    targetPath: params.basePath,
    targetBranch: params.defaultBranch,
    syncTargetBranchFromOrigin: true,
    workspacePath: params.workspacePath,
    taskId: params.taskId
  });
}

export async function pullMainIntoTaskWorkspace(params: { workspacePath: string; defaultBranch: string }): Promise<PullMainResult> {
  return pullRemoteRefIntoTaskWorkspace({
    workspacePath: params.workspacePath,
    remoteRef: params.defaultBranch
  });
}
