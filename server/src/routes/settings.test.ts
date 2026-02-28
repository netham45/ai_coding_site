import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { createApp } from "../app.js";
import { db as appDb } from "../db/index.js";
import { nowIso } from "../utils/time.js";

type ApiResponse = {
  status: number;
  json: any;
  text: string;
};

let server: http.Server;
let apiBaseUrl = "";

function createUser(withSettings = true): string {
  const id = randomUUID();
  const now = nowIso();
  appDb.prepare("INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, `${id}@example.com`, `user-${id.slice(0, 6)}`, now, now);
  if (withSettings) {
    appDb.prepare("INSERT INTO user_settings (user_id, default_ai_command, default_ai_commands, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, "codex --yolo {prompt}", JSON.stringify(["codex --yolo {prompt}"]), now, now);
  }
  return id;
}

async function callApi(pathname: string, options?: { method?: string; body?: unknown; userId?: string }): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) headers["content-type"] = "application/json";
  if (options?.userId) headers["x-user-id"] = options.userId;
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
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

describe("settings routes", () => {
  before(() => {
    server = createApp().listen(0);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to start test server");
    }
    apiBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("GET /api/users/me/settings returns normalized commands", async () => {
    const userId = createUser();
    appDb.prepare("UPDATE user_settings SET default_ai_commands = ? WHERE user_id = ?")
      .run(JSON.stringify(["  codex --fast {prompt}", "codex --fast {prompt}", "  "]), userId);

    const response = await callApi("/api/users/me/settings", { userId });
    assert.equal(response.status, 200);
    assert.equal(response.json?.settings?.defaultAiCommand, "codex --fast {prompt}");
    assert.deepEqual(response.json?.settings?.defaultAiCommands, ["codex --fast {prompt}"]);
  });

  test("GET /api/users/me/settings falls back to legacy default command when JSON is invalid", async () => {
    const userId = createUser();
    appDb.prepare("UPDATE user_settings SET default_ai_command = ?, default_ai_commands = ? WHERE user_id = ?")
      .run("claude --print {prompt}", "not-json", userId);

    const response = await callApi("/api/users/me/settings", { userId });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json?.settings?.defaultAiCommands, ["claude --print {prompt}"]);
  });

  test("PATCH /api/users/me/settings currently errors because app DB is missing events table", async () => {
    const userId = createUser();
    appDb.prepare("UPDATE user_settings SET default_ai_commands = ? WHERE user_id = ?")
      .run(JSON.stringify(["codex --yolo {prompt}", "aider {prompt}"]), userId);

    const response = await callApi("/api/users/me/settings", {
      method: "PATCH",
      userId,
      body: { defaultAiCommand: "aider {prompt}" }
    });

    assert.equal(response.status, 500);
    assert.match(response.json?.error ?? "", /no such table: events/);
    const persisted = appDb
      .prepare("SELECT default_ai_command, default_ai_commands FROM user_settings WHERE user_id = ?")
      .get(userId) as { default_ai_command: string; default_ai_commands: string };
    assert.equal(persisted.default_ai_command, "aider {prompt}");
    assert.equal(persisted.default_ai_commands, JSON.stringify(["aider {prompt}", "codex --yolo {prompt}"]));
  });

  test("PATCH /api/users/me/settings with command arrays also hits the same server error", async () => {
    const userId = createUser();

    const ok = await callApi("/api/users/me/settings", {
      method: "PATCH",
      userId,
      body: { defaultAiCommands: ["  codex {prompt}", "codex {prompt}", "claude {prompt}"] }
    });
    assert.equal(ok.status, 500);
    assert.match(ok.json?.error ?? "", /no such table: events/);
    const persisted = appDb
      .prepare("SELECT default_ai_commands FROM user_settings WHERE user_id = ?")
      .get(userId) as { default_ai_commands: string };
    assert.equal(persisted.default_ai_commands, JSON.stringify(["codex {prompt}", "claude {prompt}"]));

    const invalid = await callApi("/api/users/me/settings", {
      method: "PATCH",
      userId,
      body: { defaultAiCommands: [] }
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json?.error, "Invalid payload");
  });

  test("PATCH /api/users/me/settings returns 404 when row does not exist", async () => {
    const userId = createUser(false);

    const response = await callApi("/api/users/me/settings", {
      method: "PATCH",
      userId,
      body: { defaultAiCommand: "codex --safe {prompt}" }
    });

    assert.equal(response.status, 404);
    assert.equal(response.json?.error, "Settings not found");
  });
});
