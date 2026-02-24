#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

enum ExitCode {
  Success = 0,
  Internal = 1,
  InvalidArgs = 2,
  NotFound = 3,
  Conflict = 4,
  Unavailable = 5
}

type ParsedArgv = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

type TaskEdit = {
  itemKey: string;
  title: string;
  description: string;
  prompt?: string;
  aiCommand?: string;
};

type Services = typeof import("../application/cliServices.js");

class CliArgError extends Error {}

function parseArgv(argv: string[]): ParsedArgv {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const withNoPrefix = token.slice(2);
    const eqIdx = withNoPrefix.indexOf("=");
    if (eqIdx >= 0) {
      const key = withNoPrefix.slice(0, eqIdx);
      const value = withNoPrefix.slice(eqIdx + 1);
      flags.set(key, value);
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(withNoPrefix, next);
      i += 1;
      continue;
    }
    flags.set(withNoPrefix, true);
  }

  return { positionals, flags };
}

function argError(message: string): never {
  throw new CliArgError(message);
}

function requireFlag(parsed: ParsedArgv, name: string): string {
  const value = parsed.flags.get(name);
  if (typeof value !== "string" || !value.trim()) {
    argError(`Missing required --${name}`);
  }
  return value;
}

function optionalFlag(parsed: ParsedArgv, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanFlag(parsed: ParsedArgv, name: string): boolean {
  const value = parsed.flags.get(name);
  if (value === undefined) return false;
  if (value === true) return true;
  const normalized = String(value).toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  argError(`Invalid boolean for --${name}: ${String(value)}`);
}

function optionalProjectId(parsed: ParsedArgv): string | undefined {
  return optionalFlag(parsed, "project-id") ?? optionalFlag(parsed, "project");
}

function optionalPlanId(parsed: ParsedArgv): string | undefined {
  return optionalFlag(parsed, "plan-id");
}

function csvFlag(parsed: ParsedArgv, name: string): string[] {
  const raw = optionalFlag(parsed, name);
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function maybeTaskEdits(parsed: ParsedArgv): TaskEdit[] | undefined {
  const editsFile = optionalFlag(parsed, "task-edits-file");
  if (!editsFile) return undefined;
  const fullPath = path.resolve(editsFile);
  let text: string;
  try {
    text = fs.readFileSync(fullPath, "utf8");
  } catch (error: any) {
    argError(`Failed to read task edits file: ${String(error?.message ?? error)}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error: any) {
    argError(`task edits file is not valid JSON: ${String(error?.message ?? error)}`);
  }
  if (!Array.isArray(parsedJson)) {
    argError("task edits file must be a JSON array");
  }
  return parsedJson as TaskEdit[];
}

function isJsonOutput(parsed: ParsedArgv): boolean {
  return booleanFlag(parsed, "json");
}

function printResult(result: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result && typeof result === "object" && "summary" in result) {
    const summary = (result as { summary?: unknown }).summary;
    if (typeof summary === "string" && summary.trim().length > 0) {
      console.log(summary);
      return;
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

function helpText(): string {
  return [
    "Usage: acs <command> [subcommand] [options]",
    "",
    "Commands:",
    "  tasks list [--project-id <projectId>] [--plan-id <planId>]",
    "  tasks all [--project-id <projectId>] [--plan-id <planId>]",
    "  tasks active [--project-id <projectId>] [--plan-id <planId>]",
    "  tasks get <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  tasks summary <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  tasks details <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  tasks create --project <projectId> --title <title> --prompt <prompt> [--ai-command <cmd>] [--depends-on a,b] [--auto-merge]",
    "  tasks start <taskId>",
    "  tasks input <taskId> --text <text>",
    "  tasks pull-main <taskId>",
    "",
    "  plans list [--project-id <projectId>] [--plan-id <planId>]",
    "  plans create --project <projectId> --title <title> --prompt <prompt> [--ai-command <cmd>]",
    "  plans get <planId>",
    "  plans extract <planId>",
    "  plans regenerate <planId> --feedback <text>",
    "  plans approve <planId> [--auto-merge-item-keys a,b] [--task-edits-file path.json]",
    "",
    "  info <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  session start <taskId>",
    "  session input <taskId> --text <text>",
    "  create task ... (alias for tasks create)",
    "  create plan ... (alias for plans create)",
    "  review <taskId>",
    "  ide status <taskId>",
    "  ide start <taskId>",
    "  ide stop <taskId>",
    "  ready_merge <taskId> (task alias)",
    "  ready_merge task <taskId>",
    "  ready_merge plan <planId>",
    "  merge <taskId> (task alias)",
    "  merge task <taskId>",
    "  merge plan <planId>",
    "",
    "Global options:",
    "  --json     Output machine-readable JSON",
    "  --help     Show this help"
  ].join("\n");
}

function mapErrorToExitCode(error: unknown): ExitCode {
  if (error instanceof CliArgError) {
    return ExitCode.InvalidArgs;
  }

  const maybeCode = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (maybeCode === "VALIDATION") return ExitCode.InvalidArgs;
  if (maybeCode === "NOT_FOUND") return ExitCode.NotFound;
  if (maybeCode === "CONFLICT") return ExitCode.Conflict;
  if (maybeCode === "UNAVAILABLE") return ExitCode.Unavailable;

  return ExitCode.Internal;
}

async function handleTasks(args: string[], userId: string, services: Services): Promise<unknown> {
  const parsed = parseArgv(args);
  const [subcommand, maybeId] = parsed.positionals;
  if (!subcommand) {
    argError("Missing tasks subcommand");
  }

  if (subcommand === "list" || subcommand === "all") {
    return await services.listAllTasks({
      userId,
      projectId: optionalProjectId(parsed),
      planId: optionalPlanId(parsed)
    });
  }
  if (subcommand === "active") {
    return await services.listActiveTasks({
      userId,
      projectId: optionalProjectId(parsed),
      planId: optionalPlanId(parsed)
    });
  }
  if (subcommand === "get" || subcommand === "details") {
    if (!maybeId) argError("Missing taskId");
    return await services.getTaskDetails({
      userId,
      taskId: maybeId,
      projectId: optionalProjectId(parsed),
      planId: optionalPlanId(parsed)
    });
  }
  if (subcommand === "summary") {
    if (!maybeId) argError("Missing taskId");
    return await services.getTaskSummary({
      userId,
      taskId: maybeId,
      projectId: optionalProjectId(parsed),
      planId: optionalPlanId(parsed)
    });
  }
  if (subcommand === "create") {
    return await services.createTask({
      userId,
      projectId: requireFlag(parsed, "project"),
      title: requireFlag(parsed, "title"),
      taskPrompt: requireFlag(parsed, "prompt"),
      aiCommand: optionalFlag(parsed, "ai-command"),
      autoMerge: booleanFlag(parsed, "auto-merge"),
      dependencyTaskIds: csvFlag(parsed, "depends-on")
    });
  }
  if (subcommand === "start") {
    if (!maybeId) argError("Missing taskId");
    return await services.startTaskSession({ userId, taskId: maybeId });
  }
  if (subcommand === "input") {
    if (!maybeId) argError("Missing taskId");
    return await services.sendTaskSessionInput({ userId, taskId: maybeId, text: requireFlag(parsed, "text") });
  }
  if (subcommand === "pull-main") {
    if (!maybeId) argError("Missing taskId");
    return await services.pullTaskMain({ userId, taskId: maybeId });
  }

  argError(`Unknown tasks subcommand: ${subcommand}`);
}

async function handlePlans(args: string[], userId: string, services: Services): Promise<unknown> {
  const parsed = parseArgv(args);
  const [subcommand, maybeId] = parsed.positionals;
  if (!subcommand) {
    argError("Missing plans subcommand");
  }

  if (subcommand === "list") {
    return await services.listPlans({
      userId,
      projectId: optionalProjectId(parsed),
      planId: optionalPlanId(parsed)
    });
  }
  if (subcommand === "create") {
    return await services.createPlan({
      userId,
      projectId: requireFlag(parsed, "project"),
      title: requireFlag(parsed, "title"),
      taskPrompt: requireFlag(parsed, "prompt"),
      aiCommand: optionalFlag(parsed, "ai-command")
    });
  }
  if (subcommand === "get") {
    if (!maybeId) argError("Missing planId");
    return await services.getPlan({ userId, planId: maybeId });
  }
  if (subcommand === "extract") {
    if (!maybeId) argError("Missing planId");
    return await services.extractPlan({ userId, planId: maybeId });
  }
  if (subcommand === "regenerate") {
    if (!maybeId) argError("Missing planId");
    return await services.regeneratePlan({ userId, planId: maybeId, feedback: requireFlag(parsed, "feedback") });
  }
  if (subcommand === "approve") {
    if (!maybeId) argError("Missing planId");
    return await services.approvePlan({
      userId,
      planId: maybeId,
      autoMergeItemKeys: csvFlag(parsed, "auto-merge-item-keys"),
      taskEdits: maybeTaskEdits(parsed)
    });
  }

  argError(`Unknown plans subcommand: ${subcommand}`);
}

async function handleCreate(args: string[], userId: string, services: Services): Promise<unknown> {
  const [kind, ...rest] = args;
  if (!kind) {
    argError("Missing create target. Use `create task` or `create plan`.");
  }
  if (kind === "task") {
    return await handleTasks(["create", ...rest], userId, services);
  }
  if (kind === "plan") {
    return await handlePlans(["create", ...rest], userId, services);
  }
  argError(`Unknown create target: ${kind}`);
}

async function handleSession(args: string[], userId: string, services: Services): Promise<unknown> {
  const [subcommand, taskId, ...rest] = args;
  if (!subcommand) {
    argError("Missing session subcommand");
  }
  const parsed = parseArgv([subcommand, taskId ?? "", ...rest].filter((value) => value !== ""));
  if (subcommand === "start") {
    if (!taskId) argError("Missing taskId");
    return await services.startTaskSession({ userId, taskId });
  }
  if (subcommand === "input") {
    if (!taskId) argError("Missing taskId");
    return await services.sendTaskSessionInput({ userId, taskId, text: requireFlag(parsed, "text") });
  }
  argError(`Unknown session subcommand: ${subcommand}`);
}

async function handleIde(args: string[], userId: string, services: Services): Promise<unknown> {
  const [subcommand, taskId] = args;
  if (!subcommand) {
    argError("Missing ide subcommand");
  }
  if (!taskId) {
    argError("Missing taskId");
  }

  if (subcommand === "status") {
    return await services.ideStatus({ userId, taskId });
  }
  if (subcommand === "start") {
    return await services.ideStart({ userId, taskId });
  }
  if (subcommand === "stop") {
    return await services.ideStop({ userId, taskId });
  }
  argError(`Unknown ide subcommand: ${subcommand}`);
}

function parseEntityId(
  args: string[],
  fallbackEntity: "task" | "plan" = "task"
): { entity: "task" | "plan"; id: string } {
  const [first, second] = args;
  if (!first) {
    argError("Missing target id");
  }
  if (!second) {
    return { entity: fallbackEntity, id: first };
  }
  if (first !== "task" && first !== "plan") {
    argError(`Unknown target entity: ${first}`);
  }
  return { entity: first, id: second };
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgv(argv);
  if (argv.length === 0 || parsed.flags.has("help") || parsed.positionals[0] === "help") {
    console.log(helpText());
    process.exitCode = ExitCode.Success;
    return;
  }

  const services = await import("../application/cliServices.js");
  const db = await import("../db/index.js");
  const userId = db.ensureLocalUser();

  const [command, ...rest] = argv;
  let result: unknown;

  if (command === "tasks") {
    result = await handleTasks(rest, userId, services);
  } else if (command === "plans") {
    result = await handlePlans(rest, userId, services);
  } else if (command === "info") {
    const [taskId] = parsed.positionals.slice(1);
    if (!taskId) argError("Missing taskId");
    result = await services.getTaskDetails({
      userId,
      taskId,
      projectId: optionalProjectId(parsed),
      planId: optionalPlanId(parsed)
    });
  } else if (command === "session") {
    result = await handleSession(rest, userId, services);
  } else if (command === "create") {
    result = await handleCreate(rest, userId, services);
  } else if (command === "review") {
    const [taskId] = parsed.positionals.slice(1);
    if (!taskId) argError("Missing taskId");
    result = await services.reviewTaskMergeRecords({ userId, taskId });
  } else if (command === "ide") {
    result = await handleIde(rest, userId, services);
  } else if (command === "ready_merge") {
    const parsedTarget = parseEntityId(parsed.positionals.slice(1), "task");
    if (parsedTarget.entity === "task") {
      result = await services.markTaskMergeReady({ userId, taskId: parsedTarget.id });
    } else {
      result = await services.markPlanMergeReady({ userId, planId: parsedTarget.id });
    }
  } else if (command === "merge") {
    const parsedTarget = parseEntityId(parsed.positionals.slice(1), "task");
    if (parsedTarget.entity === "task") {
      result = await services.mergeTask({ userId, taskId: parsedTarget.id });
    } else {
      result = await services.mergePlan({ userId, planId: parsedTarget.id });
    }
  } else {
    argError(`Unknown command: ${command}`);
  }

  printResult(result, isJsonOutput(parsed));
  process.exitCode = ExitCode.Success;
}

run().catch((error) => {
  const code = mapErrorToExitCode(error);
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = code;
});
