import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { describe, test } from "node:test";
import { createApp } from "./app.js";
import { db as appDb } from "./db/index.js";
import { nowIso } from "./utils/time.js";

type ApiResponse = {
  status: number;
  json: any;
  text: string;
};

type SnapshotProfiler = {
  status: { enabled: boolean; samples: number };
  captureSnapshot: (reason: string) => Promise<string>;
  captureCpuProfile: (durationMs?: number, reason?: string) => Promise<string>;
};

function createUser(): string {
  const id = randomUUID();
  const now = nowIso();
  appDb.prepare("INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, `${id}@example.com`, `user-${id.slice(0, 6)}`, now, now);
  appDb.prepare("INSERT INTO user_settings (user_id, default_ai_command, default_ai_commands, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, "codex --yolo {prompt}", JSON.stringify(["codex --yolo {prompt}"]), now, now);
  return id;
}

async function withServer<T>(
  options: { profiler?: SnapshotProfiler | null },
  fn: (baseUrl: string, userId: string) => Promise<T>
): Promise<T> {
  const app = createApp(options as any);
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const userId = createUser();
  try {
    return await fn(baseUrl, userId);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function callApi(baseUrl: string, pathname: string, options?: { method?: string; body?: unknown; userId?: string }): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) headers["content-type"] = "application/json";
  if (options?.userId) headers["x-user-id"] = options.userId;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options?.method ?? "GET",
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

describe("createApp", () => {
  test("health and profiler endpoints return expected payloads when profiler disabled", async () => {
    await withServer({ profiler: null }, async (baseUrl, userId) => {
      const health = await callApi(baseUrl, "/api/health", { userId });
      assert.equal(health.status, 200);
      assert.equal(health.json?.ok, true);
      assert.equal(typeof health.json?.diagnostics?.projectDb?.openHandles, "number");

      const status = await callApi(baseUrl, "/api/debug/profiler/status", { userId });
      assert.equal(status.status, 200);
      assert.equal(status.json?.enabled, false);
      assert.equal(status.json?.status, null);

      const snapshot = await callApi(baseUrl, "/api/debug/profiler/snapshot", { method: "POST", userId, body: {} });
      assert.equal(snapshot.status, 404);
      assert.match(snapshot.json?.error ?? "", /Profiler is disabled/);

      const cpu = await callApi(baseUrl, "/api/debug/profiler/cpu", { method: "POST", userId, body: {} });
      assert.equal(cpu.status, 404);
      assert.match(cpu.json?.error ?? "", /Profiler is disabled/);
    });
  });

  test("profiler snapshot and cpu endpoints invoke profiler with defaults and overrides", async () => {
    const calls: Array<{ kind: string; reason?: string; durationMs?: number }> = [];
    const profiler: SnapshotProfiler = {
      status: { enabled: true, samples: 3 },
      captureSnapshot: async (reason: string) => {
        calls.push({ kind: "snapshot", reason });
        return `/tmp/${reason}.json`;
      },
      captureCpuProfile: async (durationMs?: number, reason?: string) => {
        calls.push({ kind: "cpu", reason, durationMs });
        return `/tmp/${reason ?? "cpu"}.cpuprofile`;
      }
    };

    await withServer({ profiler }, async (baseUrl, userId) => {
      const status = await callApi(baseUrl, "/api/debug/profiler/status", { userId });
      assert.equal(status.status, 200);
      assert.equal(status.json?.enabled, true);
      assert.equal(status.json?.status?.samples, 3);

      const snapshot = await callApi(baseUrl, "/api/debug/profiler/snapshot", {
        method: "POST",
        userId,
        body: { reason: "manual" }
      });
      assert.equal(snapshot.status, 202);
      assert.equal(snapshot.json?.filePath, "/tmp/manual.json");

      const cpuDefault = await callApi(baseUrl, "/api/debug/profiler/cpu", {
        method: "POST",
        userId,
        body: { durationMs: "not-a-number" }
      });
      assert.equal(cpuDefault.status, 202);
      assert.equal(cpuDefault.json?.ok, true);

      const cpuCustom = await callApi(baseUrl, "/api/debug/profiler/cpu", {
        method: "POST",
        userId,
        body: { durationMs: 250, reason: "custom-cpu" }
      });
      assert.equal(cpuCustom.status, 202);
      assert.equal(cpuCustom.json?.filePath, "/tmp/custom-cpu.cpuprofile");

      assert.deepEqual(calls, [
        { kind: "snapshot", reason: "manual" },
        { kind: "cpu", reason: "http-cpu-profile", durationMs: undefined },
        { kind: "cpu", reason: "custom-cpu", durationMs: 250 }
      ]);
    });
  });

  test("root endpoint returns fallback message when frontend dist is unavailable", async () => {
    await withServer({ profiler: null }, async (baseUrl, userId) => {
      const response = await callApi(baseUrl, "/", { userId });
      assert.equal(response.status, 200);
      assert.match(response.text, /Frontend not built yet/);
    });
  });
});
