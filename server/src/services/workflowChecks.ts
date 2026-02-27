import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { WorkflowCheckResultRow, WorkflowCheckStatus, WorkflowStageRunRow } from "../types.js";
import { createWorkflowCheckResult, getWorkflowStageRunById, transitionWorkflowStageRunStatus } from "./workflowRepository.js";

export type CheckComparator = "eq" | "gte" | "lte";

export type DeterministicWorkflowCheck =
  | {
      type: "file_created";
      name: string;
      relativePath: string;
      baselineExists?: boolean;
      since?: string;
    }
  | {
      type: "file_exists";
      name: string;
      relativePath: string;
    }
  | {
      type: "file_modified_within";
      name: string;
      relativePath: string;
      withinSeconds: number;
      now?: string;
    }
  | {
      type: "line_present_in_file";
      name: string;
      relativePath: string;
      line: string;
      caseSensitive?: boolean;
    }
  | {
      type: "json_path_equals";
      name: string;
      relativePath: string;
      jsonPath: string;
      expected: unknown;
    }
  | {
      type: "command_exit_code";
      name: string;
      command: string[];
      cwdRelative?: string;
      expectedExitCode: number;
      timeoutMs?: number;
    }
  | {
      type: "stage_complete";
      name: string;
      stageRunId: string;
      expectedStatus?: "succeeded" | "failed" | "skipped" | "cancelled";
    }
  | {
      type: "node_merged";
      name: string;
      nodeId: string;
    }
  | {
      type: "child_nodes_created_count";
      name: string;
      parentNodeId: string;
      expectedCount: number;
      comparator?: CheckComparator;
    };

export type EvaluatedWorkflowCheck = {
  checkName: string;
  status: WorkflowCheckStatus;
  details: Record<string, unknown>;
};

export type RunDeterministicChecksResult = {
  stageRun: WorkflowStageRunRow;
  checkResults: WorkflowCheckResultRow[];
  allPassed: boolean;
};

function resolveAbsolutePath(workspacePath: string, relativePath: string): string {
  return path.resolve(workspacePath, relativePath);
}

function parseJsonPath(input: string): Array<string | number> {
  const normalized = input.trim().replace(/\[(\d+)\]/g, ".$1");
  if (!normalized) return [];
  return normalized
    .split(".")
    .filter(Boolean)
    .map((token) => (/^\d+$/.test(token) ? Number(token) : token));
}

function jsonPathGet(root: unknown, jsonPath: string): unknown {
  const parts = parseJsonPath(jsonPath);
  let current: unknown = root;
  for (const part of parts) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
      continue;
    }
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compareCount(actual: number, expected: number, comparator: CheckComparator): boolean {
  if (comparator === "gte") return actual >= expected;
  if (comparator === "lte") return actual <= expected;
  return actual === expected;
}

function evaluateCheck(params: {
  db: Database.Database;
  workspacePath: string;
  check: DeterministicWorkflowCheck;
}): EvaluatedWorkflowCheck {
  const { db, workspacePath, check } = params;
  try {
    switch (check.type) {
      case "file_created": {
        const absolutePath = resolveAbsolutePath(workspacePath, check.relativePath);
        const existsNow = fs.existsSync(absolutePath);
        const baselineExists = check.baselineExists ?? false;
        let modifiedAtIso: string | null = null;
        let modifiedAfterSince = false;

        if (existsNow) {
          const stat = fs.statSync(absolutePath);
          modifiedAtIso = stat.mtime.toISOString();
          if (check.since) {
            modifiedAfterSince = stat.mtime.getTime() >= new Date(check.since).getTime();
          }
        }

        const pass = existsNow && !baselineExists && (!check.since || modifiedAfterSince);
        return {
          checkName: check.name,
          status: pass ? "pass" : "fail",
          details: {
            type: check.type,
            relativePath: check.relativePath,
            baselineExists,
            existsNow,
            since: check.since ?? null,
            modifiedAt: modifiedAtIso,
            modifiedAfterSince
          }
        };
      }
      case "file_exists": {
        const absolutePath = resolveAbsolutePath(workspacePath, check.relativePath);
        const exists = fs.existsSync(absolutePath);
        return {
          checkName: check.name,
          status: exists ? "pass" : "fail",
          details: {
            type: check.type,
            relativePath: check.relativePath,
            exists
          }
        };
      }
      case "file_modified_within": {
        const absolutePath = resolveAbsolutePath(workspacePath, check.relativePath);
        const exists = fs.existsSync(absolutePath);
        if (!exists) {
          return {
            checkName: check.name,
            status: "fail",
            details: {
              type: check.type,
              relativePath: check.relativePath,
              exists: false,
              withinSeconds: check.withinSeconds
            }
          };
        }

        const now = check.now ? new Date(check.now) : new Date();
        const stat = fs.statSync(absolutePath);
        const ageMs = now.getTime() - stat.mtime.getTime();
        const withinMs = check.withinSeconds * 1000;
        const pass = ageMs >= 0 && ageMs <= withinMs;
        return {
          checkName: check.name,
          status: pass ? "pass" : "fail",
          details: {
            type: check.type,
            relativePath: check.relativePath,
            withinSeconds: check.withinSeconds,
            modifiedAt: stat.mtime.toISOString(),
            now: now.toISOString(),
            ageMs
          }
        };
      }
      case "line_present_in_file": {
        const absolutePath = resolveAbsolutePath(workspacePath, check.relativePath);
        const exists = fs.existsSync(absolutePath);
        if (!exists) {
          return {
            checkName: check.name,
            status: "fail",
            details: {
              type: check.type,
              relativePath: check.relativePath,
              exists: false,
              line: check.line
            }
          };
        }

        const contents = fs.readFileSync(absolutePath, "utf8");
        const lines = contents.split(/\r?\n/);
        const caseSensitive = check.caseSensitive ?? true;
        const target = caseSensitive ? check.line : check.line.toLowerCase();
        const found = lines.some((line) => (caseSensitive ? line : line.toLowerCase()) === target);
        return {
          checkName: check.name,
          status: found ? "pass" : "fail",
          details: {
            type: check.type,
            relativePath: check.relativePath,
            line: check.line,
            caseSensitive,
            found
          }
        };
      }
      case "json_path_equals": {
        const absolutePath = resolveAbsolutePath(workspacePath, check.relativePath);
        const exists = fs.existsSync(absolutePath);
        if (!exists) {
          return {
            checkName: check.name,
            status: "fail",
            details: {
              type: check.type,
              relativePath: check.relativePath,
              exists: false,
              jsonPath: check.jsonPath,
              expected: check.expected
            }
          };
        }

        const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as unknown;
        const actual = jsonPathGet(parsed, check.jsonPath);
        const pass = JSON.stringify(actual) === JSON.stringify(check.expected);
        return {
          checkName: check.name,
          status: pass ? "pass" : "fail",
          details: {
            type: check.type,
            relativePath: check.relativePath,
            jsonPath: check.jsonPath,
            expected: check.expected,
            actual
          }
        };
      }
      case "command_exit_code": {
        if (check.command.length === 0) {
          return {
            checkName: check.name,
            status: "error",
            details: {
              type: check.type,
              error: "command must not be empty"
            }
          };
        }

        const commandCwd = check.cwdRelative
          ? resolveAbsolutePath(workspacePath, check.cwdRelative)
          : workspacePath;
        const [cmd, ...args] = check.command;
        const spawned = spawnSync(cmd, args, {
          cwd: commandCwd,
          encoding: "utf8",
          timeout: check.timeoutMs ?? 30_000
        });
        const actualExitCode = spawned.status ?? -1;
        const pass = actualExitCode === check.expectedExitCode;
        return {
          checkName: check.name,
          status: pass ? "pass" : "fail",
          details: {
            type: check.type,
            command: check.command,
            cwd: commandCwd,
            expectedExitCode: check.expectedExitCode,
            actualExitCode,
            stdout: spawned.stdout ?? "",
            stderr: spawned.stderr ?? ""
          }
        };
      }
      case "stage_complete": {
        const row = db
          .prepare("SELECT id, status FROM workflow_stage_runs WHERE id = ? LIMIT 1")
          .get(check.stageRunId) as { id: string; status: string } | undefined;
        const terminal = new Set(["succeeded", "failed", "skipped", "cancelled"]);
        const exists = Boolean(row);
        const actualStatus = row?.status ?? null;
        const expectedStatus = check.expectedStatus ?? null;
        const pass = exists && (expectedStatus ? actualStatus === expectedStatus : terminal.has(String(actualStatus)));
        return {
          checkName: check.name,
          status: pass ? "pass" : "fail",
          details: {
            type: check.type,
            stageRunId: check.stageRunId,
            exists,
            expectedStatus,
            actualStatus
          }
        };
      }
      case "node_merged": {
        const row = db.prepare("SELECT id, status FROM tasks WHERE id = ? LIMIT 1").get(check.nodeId) as
          | { id: string; status: string }
          | undefined;
        const exists = Boolean(row);
        const status = row?.status ?? null;
        const pass = status === "merged";
        return {
          checkName: check.name,
          status: pass ? "pass" : "fail",
          details: {
            type: check.type,
            nodeId: check.nodeId,
            exists,
            status
          }
        };
      }
      case "child_nodes_created_count": {
        const countRow = db
          .prepare("SELECT COUNT(*) AS count FROM tasks WHERE parent_plan_task_id = ?")
          .get(check.parentNodeId) as { count: number };
        const comparator = check.comparator ?? "eq";
        const actualCount = Number(countRow?.count ?? 0);
        const pass = compareCount(actualCount, check.expectedCount, comparator);
        return {
          checkName: check.name,
          status: pass ? "pass" : "fail",
          details: {
            type: check.type,
            parentNodeId: check.parentNodeId,
            comparator,
            expectedCount: check.expectedCount,
            actualCount
          }
        };
      }
      default: {
        return {
          checkName: check satisfies never,
          status: "error",
          details: {
            error: "unsupported check type"
          }
        };
      }
    }
  } catch (error) {
    return {
      checkName: check.name,
      status: "error",
      details: {
        type: check.type,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export function runDeterministicChecksForStageRun(params: {
  db: Database.Database;
  workflowStageRunId: string;
  workspacePath: string;
  checks: DeterministicWorkflowCheck[];
  failStageOnAnyFailure?: boolean;
}): RunDeterministicChecksResult {
  const { db, workflowStageRunId, workspacePath, checks } = params;
  const stageRun = getWorkflowStageRunById(db, workflowStageRunId);
  if (!stageRun) {
    throw new Error(`workflow stage run not found: ${workflowStageRunId}`);
  }

  db.prepare("DELETE FROM workflow_check_results WHERE workflow_stage_run_id = ?").run(workflowStageRunId);

  const persisted: WorkflowCheckResultRow[] = [];
  for (const check of checks) {
    const evaluated = evaluateCheck({ db, workspacePath, check });
    persisted.push(
      createWorkflowCheckResult(db, {
        workflowStageRunId,
        checkName: evaluated.checkName,
        status: evaluated.status,
        details: evaluated.details
      })
    );
  }

  const allPassed = persisted.every((row) => row.status === "pass");

  if (params.failStageOnAnyFailure && !allPassed && stageRun.status === "running") {
    transitionWorkflowStageRunStatus(db, {
      stageRunId: stageRun.id,
      toStatus: "failed",
      reason: "deterministic_checks_failed",
      payload: {
        failedChecks: persisted.filter((row) => row.status !== "pass").map((row) => row.check_name)
      }
    });
  }

  const latestStageRun = getWorkflowStageRunById(db, workflowStageRunId)!;
  return {
    stageRun: latestStageRun,
    checkResults: persisted,
    allPassed
  };
}
