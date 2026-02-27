import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;

export type AiCheckVerifierResult =
  | { status: "OK" }
  | { status: "Failed"; message: string };

export type RunAiCheckVerifierParams = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseAiCheckVerifierResponse(stdout: string): AiCheckVerifierResult {
  const raw = stdout.trim();
  if (!raw) {
    return { status: "Failed", message: "ai_check returned empty output" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "Failed", message: "ai_check returned malformed JSON output" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "Failed", message: "ai_check response must be a JSON object" };
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const status = record.status;

  if (status === "OK") {
    if (keys.length !== 1 || keys[0] !== "status") {
      return { status: "Failed", message: "ai_check OK response must be exactly {\"status\":\"OK\"}" };
    }
    return { status: "OK" };
  }

  if (status === "Failed") {
    const message = asNonEmptyString(record.message);
    if (keys.length !== 2 || keys[0] !== "message" || keys[1] !== "status" || !message) {
      return { status: "Failed", message: "ai_check Failed response must be exactly {\"status\":\"Failed\",\"message\":\"...\"}" };
    }
    return { status: "Failed", message };
  }

  return { status: "Failed", message: "ai_check response status must be \"OK\" or \"Failed\"" };
}

export async function runAiCheckVerifier(params: RunAiCheckVerifierParams = {}): Promise<AiCheckVerifierResult> {
  const timeoutMs = Math.max(1, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const command = params.command?.trim() || "ai_check";
  const args = ["--non-interactive", ...(params.args ?? [])];

  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: params.cwd,
      env: params.env,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });
    return parseAiCheckVerifierResponse(stdout);
  } catch (error: any) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const parsed = parseAiCheckVerifierResponse(stdout);
    if (parsed.status === "OK" || (parsed.status === "Failed" && parsed.message !== "ai_check returned empty output")) {
      return parsed;
    }

    if (error?.killed) {
      return { status: "Failed", message: `ai_check timed out after ${timeoutMs}ms` };
    }

    const stderr = asNonEmptyString(error?.stderr);
    const errorMessage = asNonEmptyString(error?.message);
    return {
      status: "Failed",
      message: stderr ?? errorMessage ?? "ai_check verifier execution failed"
    };
  }
}
