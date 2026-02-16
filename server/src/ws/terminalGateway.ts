import type { Server as HttpServer } from "node:http";
import { URL } from "node:url";
import type Database from "better-sqlite3";
import { WebSocketServer, type WebSocket } from "ws";
import { db as appDb, resolveProjectDatabase } from "../db/index.js";
import { recordEvent } from "../services/events.js";
import { capturePane, getPaneCursorPosition, hasSession, sendRawInput } from "../services/tmux.js";
import { verifyTerminalToken } from "../services/terminalToken.js";
import type { TaskSessionRow } from "../types.js";

type WsPayload =
  | { type: "hello"; taskId: string; sessionId: string }
  | { type: "output"; data: string; reset?: boolean; cursorX?: number; cursorY?: number }
  | { type: "status"; sessionStatus: string; taskStatus: string }
  | { type: "error"; message: string }
  | { type: "ack" };

type TaskScope = {
  projectId: string;
  basePath: string;
  projectDb: Database.Database;
};

function latestSession(scope: TaskScope, taskId: string): TaskSessionRow | undefined {
  return scope.projectDb
    .prepare("SELECT * FROM task_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(taskId) as TaskSessionRow | undefined;
}

function taskStatus(scope: TaskScope, taskId: string): string | undefined {
  const row = scope.projectDb.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
  return row?.status;
}

function sessionStatus(scope: TaskScope, sessionId: string): string | undefined {
  const row = scope.projectDb.prepare("SELECT status FROM task_sessions WHERE id = ?").get(sessionId) as { status: string } | undefined;
  return row?.status;
}

function taskScopeForUser(taskId: string, userId: string): TaskScope | undefined {
  const projects = appDb
    .prepare(
      `SELECT p.id, p.base_path
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = ?`
    )
    .all(userId) as Array<{ id: string; base_path: string }>;

  for (const project of projects) {
    const scoped = resolveProjectDatabase({
      appDb,
      projectId: project.id,
      basePath: project.base_path,
      intent: "write"
    });
    const row = scoped.database
      .prepare("SELECT id FROM tasks WHERE id = ? AND project_id = ?")
      .get(taskId, project.id) as { id: string } | undefined;
    if (row?.id) {
      return {
        projectId: project.id,
        basePath: project.base_path,
        projectDb: scoped.database
      };
    }
  }

  return undefined;
}

function sendJson(ws: WebSocket, payload: WsPayload): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function createTerminalGateway(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  const STREAM_POLL_MS = 120;

  server.on("upgrade", (req, socket, head) => {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "", `http://${host}`);
    const match = url.pathname.match(/^\/ws\/tasks\/([^/]+)\/terminal$/);
    if (!match) {
      return;
    }

    const taskId = decodeURIComponent(match[1]);
    const token = url.searchParams.get("token") || "";

    let claims: { taskId: string; userId: string };
    try {
      claims = verifyTerminalToken(token);
    } catch {
      socket.destroy();
      return;
    }

    if (claims.taskId !== taskId) {
      socket.destroy();
      return;
    }
    const scope = taskScopeForUser(taskId, claims.userId);
    if (!scope) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).__terminal = { taskId, userId: claims.userId, scope };
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    const meta = (ws as any).__terminal as { taskId: string; userId: string; scope: TaskScope };
    const session = latestSession(meta.scope, meta.taskId);

    if (!session || !["starting", "running", "waiting_input"].includes(session.status)) {
      sendJson(ws, { type: "error", message: "No active runtime session" });
      ws.close(1008);
      return;
    }

    let lastFrame = "";
    let lastCursor = { x: -1, y: -1 };
    let lastTaskStatus = "";
    let lastSessionStatus = "";

    const publishStatus = (force = false) => {
      const currentTaskStatus = taskStatus(meta.scope, meta.taskId) ?? "unknown";
      const currentSessionStatus = sessionStatus(meta.scope, session.id) ?? "unknown";
      if (!force && currentTaskStatus === lastTaskStatus && currentSessionStatus === lastSessionStatus) {
        return;
      }
      sendJson(ws, { type: "status", taskStatus: currentTaskStatus, sessionStatus: currentSessionStatus });
      lastTaskStatus = currentTaskStatus;
      lastSessionStatus = currentSessionStatus;
    };

    sendJson(ws, { type: "hello", taskId: meta.taskId, sessionId: session.id });
    publishStatus(true);
    recordEvent({
      projectId: meta.scope.projectId,
      taskId: meta.taskId,
      sessionId: session.id,
      eventType: "terminal.ws.attached",
      payload: { userId: meta.userId },
      database: meta.scope.projectDb
    });

    const streamTick = async () => {
      try {
        publishStatus();
        const alive = await hasSession(session.tmux_socket_path, session.tmux_session_name);
        if (!alive) {
          sendJson(ws, { type: "error", message: "Session ended" });
          ws.close(1000);
          return;
        }

        const frame = await capturePane(session.tmux_socket_path, session.tmux_session_name);
        const cursor = await getPaneCursorPosition(session.tmux_socket_path, session.tmux_session_name);
        if (frame === lastFrame && cursor.x === lastCursor.x && cursor.y === lastCursor.y) {
          return;
        }
        sendJson(ws, { type: "output", data: frame, reset: true, cursorX: cursor.x, cursorY: cursor.y });

        lastFrame = frame;
        lastCursor = cursor;
        meta.scope.projectDb.prepare("UPDATE task_sessions SET last_output = ?, last_heartbeat_at = ? WHERE id = ?").run(
          frame,
          new Date().toISOString(),
          session.id
        );
      } catch (error: any) {
        sendJson(ws, { type: "error", message: String(error?.message ?? "terminal stream error") });
        ws.close(1011);
      }
    };

    // Always snapshot tmux on attach and reset the terminal with the full buffer.
    (async () => {
      try {
        publishStatus();
        const alive = await hasSession(session.tmux_socket_path, session.tmux_session_name);
        if (!alive) {
          sendJson(ws, { type: "error", message: "Session ended" });
          ws.close(1000);
          return;
        }
        const snapshot = await capturePane(session.tmux_socket_path, session.tmux_session_name);
        const cursor = await getPaneCursorPosition(session.tmux_socket_path, session.tmux_session_name);
        lastFrame = snapshot;
        lastCursor = cursor;
        sendJson(ws, { type: "output", data: snapshot, reset: true, cursorX: cursor.x, cursorY: cursor.y });
        meta.scope.projectDb.prepare("UPDATE task_sessions SET last_output = ?, last_heartbeat_at = ? WHERE id = ?").run(
          snapshot,
          new Date().toISOString(),
          session.id
        );
      } catch (error: any) {
        sendJson(ws, { type: "error", message: String(error?.message ?? "terminal snapshot error") });
        ws.close(1011);
      }
    })();

    const timer = setInterval(() => {
      streamTick().catch(() => {
        // handled in streamTick
      });
    }, STREAM_POLL_MS);

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; text?: string; data?: string };
        if (msg.type !== "input") {
          return;
        }
        const payload = typeof msg.data === "string" ? msg.data : typeof msg.text === "string" ? msg.text : "";
        if (!payload) return;
        await sendRawInput(session.tmux_socket_path, session.tmux_session_name, payload);
        // Push output immediately after input to reduce perceived typing latency.
        await streamTick();
        publishStatus();
        sendJson(ws, { type: "ack" });
      } catch (error: any) {
        sendJson(ws, { type: "error", message: String(error?.message ?? "input handling failed") });
      }
    });

    ws.on("close", () => {
      clearInterval(timer);
      recordEvent({
        projectId: meta.scope.projectId,
        taskId: meta.taskId,
        sessionId: session.id,
        eventType: "terminal.ws.detached",
        payload: { userId: meta.userId },
        database: meta.scope.projectDb
      });
    });
  });
}
