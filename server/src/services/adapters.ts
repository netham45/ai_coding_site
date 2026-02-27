import type { TaskStatus } from "../types.js";

export type DetectedTool = "codex" | "claude" | "custom";

export type AdapterExecution = {
  detectedTool: DetectedTool;
  command: string;
  args: string[];
  supportsInteractiveInput: boolean;
};

export type LifecycleSignal = {
  sessionStatus?: "running" | "waiting_input";
  taskStatus?: TaskStatus;
  reason?: string;
};

const BLOCKED_META = /[;&|<>`$()]/;

function tokenize(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function classifyTool(aiCommand: string): DetectedTool {
  const first = tokenize(aiCommand)[0]?.toLowerCase() || "";
  if (first.includes("codex")) return "codex";
  if (first.includes("claude")) return "claude";
  return "custom";
}

export function buildCommand(aiCommand: string): AdapterExecution {
  const tokens = tokenize(aiCommand);
  if (!tokens.length) {
    throw new Error("ai_command cannot be empty");
  }
  if (tokens.some((token) => BLOCKED_META.test(token.replaceAll("{prompt}", "")))) {
    throw new Error("ai_command contains blocked shell metacharacters");
  }

  const detectedTool = classifyTool(aiCommand);
  const normalizedTokens = [...tokens];
  if (detectedTool === "codex" && normalizedTokens[1]?.toLowerCase() === "resume") {
    normalizedTokens.splice(1, normalizedTokens.length - 1, "--yolo");
  }

  const args = normalizedTokens
    .slice(1)
    .map((token) => token.replaceAll("{prompt}", ""))
    .filter((token) => token.length > 0);

  return {
    detectedTool,
    command: normalizedTokens[0],
    args,
    supportsInteractiveInput: true
  };
}

export function parseLifecycleSignals(output: string): LifecycleSignal {
  const tail = output.toLowerCase();

  if (/waiting for input|awaiting input|need user input/.test(tail)) {
    return {
      sessionStatus: "waiting_input",
      taskStatus: "waiting_input",
      reason: "adapter_waiting_input"
    };
  }

  if (/task complete|ready to merge|work complete|all done/.test(tail)) {
    return {
      taskStatus: "merge_ready",
      reason: "adapter_marked_complete"
    };
  }

  return {};
}
