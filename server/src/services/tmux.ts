import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runTmux(args: string[], timeout = 15000): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, { timeout });
  return String(stdout || "");
}

export function buildSessionName(taskId: string, runId?: string): string {
  if (!runId) {
    return `task_${taskId}`;
  }
  const compact = runId.replace(/-/g, "").slice(0, 8);
  return `task_${taskId}_${compact}`;
}

export function buildSocketPath(root: string, taskId: string): string {
  const compact = taskId.replace(/-/g, "").slice(0, 24);
  return path.join(root, `t_${compact}.sock`);
}

export async function ensureTmuxAvailable(): Promise<void> {
  try {
    await runTmux(["-V"], 5000);
  } catch {
    throw new Error("tmux is not installed or not available in PATH");
  }
}

export async function createSession(params: {
  socketPath: string;
  sessionName: string;
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}): Promise<void> {
  await fs.promises.mkdir(path.dirname(params.socketPath), { recursive: true });

  const tmuxArgs = [
    "-S",
    params.socketPath,
    "new-session",
    "-d",
    "-s",
    params.sessionName,
    "-c",
    params.cwd,
    params.command,
    ...params.args
  ];

  try {
    await execFileAsync("tmux", tmuxArgs, { timeout: 20000, env: params.env ?? process.env });
    // Ensure wheel events scroll tmux history/copy-mode instead of being sent as arrow keys.
    await execFileAsync("tmux", ["-S", params.socketPath, "set-option", "-t", params.sessionName, "mouse", "on"], {
      timeout: 5000
    });
  } catch (error: any) {
    const stderr = String(error?.stderr || "").trim();
    throw new Error(stderr || "failed to create tmux session");
  }
}

export async function getPaneId(socketPath: string, sessionName: string): Promise<string> {
  const out = await runTmux(["-S", socketPath, "display-message", "-p", "-t", `${sessionName}:0.0`, "#{pane_id}"]);
  return out.trim();
}

export async function hasSession(socketPath: string, sessionName: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-S", socketPath, "has-session", "-t", sessionName], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function sendInput(socketPath: string, sessionName: string, text: string): Promise<void> {
  await execFileAsync("tmux", ["-S", socketPath, "send-keys", "-t", `${sessionName}:0.0`, "-l", text], { timeout: 10000 });
  await execFileAsync("tmux", ["-S", socketPath, "send-keys", "-t", `${sessionName}:0.0`, "Enter"], { timeout: 10000 });
}

export async function sendRawInput(socketPath: string, sessionName: string, data: string): Promise<void> {
  const target = `${sessionName}:0.0`;
  if (!data) return;

  let buffer = "";
  const flush = async () => {
    if (!buffer) return;
    await execFileAsync("tmux", ["-S", socketPath, "send-keys", "-t", target, "-l", buffer], { timeout: 10000 });
    buffer = "";
  };

  for (const ch of data) {
    if (ch === "\r" || ch === "\n") {
      await flush();
      await execFileAsync("tmux", ["-S", socketPath, "send-keys", "-t", target, "Enter"], { timeout: 10000 });
      continue;
    }
    if (ch === "\u007f") {
      await flush();
      await execFileAsync("tmux", ["-S", socketPath, "send-keys", "-t", target, "BSpace"], { timeout: 10000 });
      continue;
    }
    if (ch === "\u0003") {
      await flush();
      await execFileAsync("tmux", ["-S", socketPath, "send-keys", "-t", target, "C-c"], { timeout: 10000 });
      continue;
    }
    if (ch === "\t") {
      await flush();
      await execFileAsync("tmux", ["-S", socketPath, "send-keys", "-t", target, "Tab"], { timeout: 10000 });
      continue;
    }
    buffer += ch;
  }

  await flush();
}

export async function capturePane(socketPath: string, sessionName: string): Promise<string> {
  // Capture normal pane with ANSI escapes + preserved spacing.
  return await runTmux(
    ["-S", socketPath, "capture-pane", "-e", "-N", "-p", "-t", `${sessionName}:0.0`, "-S", "-2000"],
    10000
  );
}

export async function getPaneCursorPosition(
  socketPath: string,
  sessionName: string
): Promise<{ x: number; y: number }> {
  const target = `${sessionName}:0.0`;
  const tryFormats = ["#{cursor_x} #{cursor_y}", "#{pane_cursor_x} #{pane_cursor_y}"];
  for (const fmt of tryFormats) {
    try {
      const out = await runTmux(["-S", socketPath, "display-message", "-p", "-t", target, fmt], 5000);
      const [xRaw, yRaw] = out.trim().split(/\s+/);
      const x = Number(xRaw);
      const y = Number(yRaw);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return { x, y };
      }
    } catch {
      // try next format
    }
  }
  return { x: 0, y: 0 };
}

export async function paneExitStatus(
  socketPath: string,
  sessionName: string
): Promise<{ dead: boolean; status: number | null }> {
  try {
    const out = await runTmux([
      "-S",
      socketPath,
      "list-panes",
      "-t",
      `${sessionName}:0.0`,
      "-F",
      "#{pane_dead} #{pane_dead_status}"
    ]);
    const [deadRaw, statusRaw] = out.trim().split(/\s+/);
    return {
      dead: deadRaw === "1",
      status: statusRaw !== undefined ? Number(statusRaw) : null
    };
  } catch {
    return { dead: false, status: null };
  }
}

export async function killSession(socketPath: string, sessionName: string): Promise<void> {
  try {
    await execFileAsync("tmux", ["-S", socketPath, "kill-session", "-t", sessionName], { timeout: 8000 });
  } catch {
    // best effort
  }
}
