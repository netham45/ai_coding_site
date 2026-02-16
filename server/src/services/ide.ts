import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Provider = "code_server" | "openvscode_server";

type Runtime = {
  taskId: string;
  provider: Provider;
  port: number;
  process: ChildProcess;
  stderrTail: string;
};

const runtimes = new Map<string, Runtime>();
const disabledIdeExtensions = ["GitHub.copilot", "GitHub.copilot-chat"];

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate IDE port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function listChildPids(rootPid: number): Promise<Set<number>> {
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "pid=", "--ppid", String(current)], { timeout: 3000 });
      const children = String(stdout)
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
      for (const pid of children) {
        if (!seen.has(pid)) {
          seen.add(pid);
          queue.push(pid);
        }
      }
    } catch {
      // ignore
    }
  }
  return seen;
}

async function findListeningPortForPidTree(rootPid: number): Promise<number | null> {
  const pidSet = await listChildPids(rootPid);
  try {
    const { stdout } = await execFileAsync("ss", ["-ltnpH"], { timeout: 3000 });
    const lines = String(stdout).split("\n");
    for (const line of lines) {
      if (!line.includes("pid=")) continue;
      const pidMatches = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number.parseInt(m[1] ?? "", 10)).filter((pid) => Number.isFinite(pid));
      const owned = pidMatches.some((pid) => pidSet.has(pid));
      if (!owned) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const localAddress = parts[3] ?? "";
      const idx = localAddress.lastIndexOf(":");
      if (idx === -1) continue;
      const port = Number.parseInt(localAddress.slice(idx + 1), 10);
      if (Number.isFinite(port) && port > 0) {
        return port;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function appendTail(prev: string, chunk: string, maxLen = 4000): string {
  const next = `${prev}${chunk}`;
  if (next.length <= maxLen) {
    return next;
  }
  return next.slice(next.length - maxLen);
}

async function waitForPort(params: {
  host: string;
  preferredPort: number;
  process: ChildProcess;
  getErrorTail: () => string;
  timeoutMs: number;
}): Promise<number> {
  const start = Date.now();
  let candidatePort = params.preferredPort;
  while (Date.now() - start < params.timeoutMs) {
    if (params.process.exitCode !== null) {
      const stderrTail = params.getErrorTail();
      const details = stderrTail ? ` ${stderrTail}` : "";
      throw new Error(`IDE process exited before readiness.${details}`);
    }

    if (params.process.pid) {
      const observed = await findListeningPortForPidTree(params.process.pid);
      if (observed) {
        candidatePort = observed;
      }
    }

    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect(candidatePort, params.host);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (connected) {
      return candidatePort;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const stderrTail = params.getErrorTail();
  if (stderrTail) {
    throw new Error(`IDE process did not become ready in time. ${stderrTail}`);
  }
  throw new Error("IDE process did not become ready in time");
}

function isRunning(process: ChildProcess): boolean {
  return process.exitCode === null && process.killed === false;
}

function resolveGlobalGitConfigPath(): string | null {
  const direct = process.env.GIT_CONFIG_GLOBAL;
  if (typeof direct === "string" && direct.length > 0 && fs.existsSync(direct)) {
    return direct;
  }

  const homeCandidates = [process.env.SNAP_REAL_HOME, process.env.HOME].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );

  for (const home of homeCandidates) {
    const candidate = path.join(home, ".gitconfig");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function compactId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "");
  if (cleaned.length > 0) {
    return cleaned.slice(0, 48);
  }
  return "task";
}

export async function prepareIdeWorkspace(params: {
  taskId: string;
  workspacePath: string;
  tmuxSocketPath?: string | null;
  tmuxSessionName?: string | null;
}): Promise<string> {
  const hasTmuxTarget = Boolean(params.tmuxSocketPath && params.tmuxSessionName);
  if (!hasTmuxTarget) {
    return params.workspacePath;
  }

  const workspaceFilePath = path.join(params.workspacePath, `.ai-coding-site-${compactId(params.taskId)}.code-workspace`);
  const tmuxSocketPath = params.tmuxSocketPath as string;
  const tmuxSessionName = params.tmuxSessionName as string;
  const attachCommand = `tmux -S ${shellSingleQuote(tmuxSocketPath)} attach-session -t ${shellSingleQuote(tmuxSessionName)}`;

  const workspaceSpec = {
    folders: [{ path: params.workspacePath }],
    settings: {
      "task.allowAutomaticTasks": "on"
    },
    tasks: {
      version: "2.0.0",
      tasks: [
        {
          label: "Attach Task Runtime",
          type: "shell",
          command: attachCommand,
          options: {
            env: {
              TMUX: ""
            }
          },
          runOptions: {
            runOn: "folderOpen"
          },
          presentation: {
            reveal: "always",
            panel: "dedicated",
            focus: true
          },
          problemMatcher: []
        }
      ]
    }
  };

  await fs.promises.writeFile(workspaceFilePath, `${JSON.stringify(workspaceSpec, null, 2)}\n`, "utf8");
  return workspaceFilePath;
}

export async function startIdeSession(params: { taskId: string; workspacePath: string }): Promise<{ provider: Provider; url: string }> {
  const active = runtimes.get(params.taskId);
  if (active && isRunning(active.process)) {
    return {
      provider: active.provider,
      url: `http://127.0.0.1:${active.port}/`
    };
  }

  const port = await reservePort();
  let provider: Provider;
  let command: string;
  let args: string[];

  if (await commandExists("code-server")) {
    provider = "code_server";
    command = "code-server";
    args = [
      "--auth",
      "none",
      "--disable-telemetry",
      "--disable-update-check",
      "--disable-workspace-trust",
      "--bind-addr",
      `127.0.0.1:${port}`,
      ...disabledIdeExtensions.flatMap((extensionId) => ["--disable-extension", extensionId]),
      params.workspacePath
    ];
  } else if (await commandExists("openvscode-server")) {
    provider = "openvscode_server";
    command = "openvscode-server";
    args = [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--without-connection-token",
      ...disabledIdeExtensions.flatMap((extensionId) => ["--disable-extension", extensionId]),
      params.workspacePath
    ];
  } else {
    throw new Error("No IDE provider found. Install `code-server` or `openvscode-server`.");
  }

  const child = spawn(command, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
    env: (() => {
      const env = { ...process.env } as Record<string, string>;
      const gitGlobal = resolveGlobalGitConfigPath();
      if (gitGlobal) {
        env.GIT_CONFIG_GLOBAL = gitGlobal;
      }
      env.GIT_TERMINAL_PROMPT = "0";
      env.GCM_INTERACTIVE = "Never";
      return env;
    })()
  });

  const runtime: Runtime = {
    taskId: params.taskId,
    provider,
    port,
    process: child,
    stderrTail: ""
  };
  runtimes.set(params.taskId, runtime);

  child.stderr?.on("data", (chunk: Buffer | string) => {
    runtime.stderrTail = appendTail(runtime.stderrTail, String(chunk));
  });

  child.on("exit", () => {
    const latest = runtimes.get(params.taskId);
    if (latest?.process.pid === child.pid) {
      runtimes.delete(params.taskId);
    }
  });

  try {
    const actualPort = await waitForPort({
      host: "127.0.0.1",
      preferredPort: port,
      process: child,
      getErrorTail: () => runtime.stderrTail.trim(),
      timeoutMs: 60000
    });
    runtime.port = actualPort;
  } catch (error) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignored
    }
    runtimes.delete(params.taskId);
    throw error;
  }

  return {
    provider,
    url: `http://127.0.0.1:${runtime.port}/`
  };
}

export function stopIdeSession(taskId: string): boolean {
  const runtime = runtimes.get(taskId);
  if (!runtime) {
    return false;
  }
  try {
    runtime.process.kill("SIGTERM");
  } catch {
    // ignored
  }
  runtimes.delete(taskId);
  return true;
}

export function ideSessionRunning(taskId: string): boolean {
  const runtime = runtimes.get(taskId);
  if (!runtime) return false;
  return isRunning(runtime.process);
}

export function ideSessionTarget(taskId: string): { host: string; port: number } | null {
  const runtime = runtimes.get(taskId);
  if (!runtime || !isRunning(runtime.process)) {
    return null;
  }
  return { host: "127.0.0.1", port: runtime.port };
}

export function startIdeHeartbeat(onDown: (taskId: string) => void): void {
  setInterval(() => {
    for (const [taskId, runtime] of runtimes.entries()) {
      if (!isRunning(runtime.process)) {
        runtimes.delete(taskId);
        onDown(taskId);
      }
    }
  }, 3000).unref();
}
