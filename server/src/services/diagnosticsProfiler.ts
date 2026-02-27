import fs from "node:fs";
import path from "node:path";
import inspector from "node:inspector";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { dataRoot } from "../utils/paths.js";
import { logInfo, logWarn, logError } from "../utils/structuredLog.js";

type ActiveHandleGetter = () => unknown[];
type ActiveRequestGetter = () => unknown[];

type ProfilerStatus = {
  enabled: boolean;
  outputDir: string;
  eventLoopLagThresholdMs: number;
  eventLoopPollIntervalMs: number;
  cpuProfileDurationMs: number;
  stallSnapshotCooldownMs: number;
};

export type DiagnosticsProfiler = {
  status: ProfilerStatus;
  captureSnapshot: (reason: string) => Promise<string>;
  captureCpuProfile: (durationMs: number | undefined, reason: string) => Promise<string>;
};

type RawProcessWithInternals = NodeJS.Process & {
  _getActiveHandles?: ActiveHandleGetter;
  _getActiveRequests?: ActiveRequestGetter;
};

const rawProcess = process as RawProcessWithInternals;

function boolFromEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== "string") return defaultValue;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return defaultValue;
}

function numberFromEnv(name: string, defaultValue: number, min: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.trunc(parsed));
}

function safeReason(reason: string): string {
  const normalized = reason.trim().toLowerCase();
  return normalized.replace(/[^a-z0-9._-]+/g, "-").slice(0, 80) || "capture";
}

function summarizeHandle(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    return { type: typeof input, value: input };
  }
  const handle = input as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    type: (handle.constructor as { name?: string } | undefined)?.name ?? "unknown"
  };

  const interestingFields = [
    "fd",
    "bytesRead",
    "bytesWritten",
    "readable",
    "writable",
    "destroyed",
    "connecting",
    "pending",
    "localAddress",
    "localPort",
    "remoteAddress",
    "remotePort"
  ] as const;

  for (const key of interestingFields) {
    if (key in handle) {
      summary[key] = handle[key];
    }
  }

  return summary;
}

function ensureDir(targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
}

function timestampForFilename(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "_");
}

function inspectorPost(session: inspector.Session, method: string, params?: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    session.post(method, params ?? {}, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

export function setupDiagnosticsProfiler(): DiagnosticsProfiler | null {
  const enabled = boolFromEnv("AI_CODING_PROFILER_ENABLED", false);
  if (!enabled) {
    return null;
  }

  const outputDir = path.resolve(process.env.AI_CODING_PROFILER_OUTPUT_DIR ?? path.join(dataRoot, "profiles"));
  const eventLoopLagThresholdMs = numberFromEnv("AI_CODING_PROFILER_LAG_THRESHOLD_MS", 750, 20);
  const eventLoopPollIntervalMs = numberFromEnv("AI_CODING_PROFILER_POLL_INTERVAL_MS", 250, 20);
  const cpuProfileDurationMs = numberFromEnv("AI_CODING_PROFILER_CPU_MS", 10000, 100);
  const stallSnapshotCooldownMs = numberFromEnv("AI_CODING_PROFILER_STALL_COOLDOWN_MS", 30000, 1000);
  const enableSignals = boolFromEnv("AI_CODING_PROFILER_SIGNALS_ENABLED", true);

  ensureDir(outputDir);

  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();

  let inFlightCpuProfile: Promise<string> | null = null;
  let lastStallSnapshotMs = 0;
  let lastTick = performance.now();

  const status: ProfilerStatus = {
    enabled,
    outputDir,
    eventLoopLagThresholdMs,
    eventLoopPollIntervalMs,
    cpuProfileDurationMs,
    stallSnapshotCooldownMs
  };

  const captureSnapshot = async (reason: string): Promise<string> => {
    const now = new Date();
    const safe = safeReason(reason);
    const filePath = path.join(outputDir, `${timestampForFilename()}-${safe}.snapshot.json`);

    const handles = (rawProcess._getActiveHandles?.() ?? []).map(summarizeHandle);
    const requests = (rawProcess._getActiveRequests?.() ?? []).map(summarizeHandle);

    const payload = {
      ts: now.toISOString(),
      pid: process.pid,
      reason,
      uptimeSec: process.uptime(),
      cpuUsage: process.cpuUsage(),
      resourceUsage: process.resourceUsage(),
      memoryUsage: process.memoryUsage(),
      eventLoop: {
        minMs: Number(eventLoopDelay.min / 1_000_000),
        maxMs: Number(eventLoopDelay.max / 1_000_000),
        meanMs: Number(eventLoopDelay.mean / 1_000_000),
        stddevMs: Number(eventLoopDelay.stddev / 1_000_000)
      },
      activeHandles: handles,
      activeRequests: requests
    };

    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2));
    logWarn("profiler.snapshot.captured", { filePath, reason, activeHandleCount: handles.length, activeRequestCount: requests.length });
    return filePath;
  };

  const captureCpuProfile = async (durationMs: number | undefined, reason: string): Promise<string> => {
    if (inFlightCpuProfile) {
      return inFlightCpuProfile;
    }

    const effectiveDurationMs = Math.max(100, Math.trunc(durationMs ?? cpuProfileDurationMs));
    inFlightCpuProfile = (async () => {
      const safe = safeReason(reason);
      const filePath = path.join(outputDir, `${timestampForFilename()}-${safe}.cpuprofile`);
      const session = new inspector.Session();
      session.connect();

      try {
        await inspectorPost(session, "Profiler.enable");
        await inspectorPost(session, "Profiler.start");
        await new Promise((resolve) => setTimeout(resolve, effectiveDurationMs));
        const result = await inspectorPost(session, "Profiler.stop");
        await fs.promises.writeFile(filePath, JSON.stringify(result.profile));
        logWarn("profiler.cpu.captured", { filePath, reason, durationMs: effectiveDurationMs });
        return filePath;
      } finally {
        session.disconnect();
        inFlightCpuProfile = null;
      }
    })();

    return inFlightCpuProfile;
  };

  const stallInterval = setInterval(() => {
    const now = performance.now();
    const expected = lastTick + eventLoopPollIntervalMs;
    lastTick = now;

    const lagMs = Math.max(0, now - expected);
    if (lagMs < eventLoopLagThresholdMs) {
      return;
    }

    const wallNow = Date.now();
    if (wallNow - lastStallSnapshotMs < stallSnapshotCooldownMs) {
      logWarn("profiler.event_loop.stall_skipped", { lagMs, cooldownMs: stallSnapshotCooldownMs });
      return;
    }
    lastStallSnapshotMs = wallNow;

    logWarn("profiler.event_loop.stall_detected", {
      lagMs,
      thresholdMs: eventLoopLagThresholdMs,
      maxDelayMs: Number(eventLoopDelay.max / 1_000_000)
    });

    void captureSnapshot("event-loop-stall").catch((error) => {
      logError("profiler.snapshot.failed", { reason: "event-loop-stall", error: String((error as Error).message || error) });
    });
  }, eventLoopPollIntervalMs);
  stallInterval.unref();

  if (enableSignals) {
    process.on("SIGUSR1", () => {
      void captureSnapshot("sigusr1").catch((error) => {
        logError("profiler.snapshot.failed", { reason: "sigusr1", error: String((error as Error).message || error) });
      });
    });

    process.on("SIGUSR2", () => {
      void captureCpuProfile(undefined, "sigusr2").catch((error) => {
        logError("profiler.cpu.failed", { reason: "sigusr2", error: String((error as Error).message || error) });
      });
    });
  }

  logInfo("profiler.enabled", {
    outputDir,
    eventLoopLagThresholdMs,
    eventLoopPollIntervalMs,
    cpuProfileDurationMs,
    stallSnapshotCooldownMs,
    signalsEnabled: enableSignals
  });

  return {
    status,
    captureSnapshot,
    captureCpuProfile
  };
}
