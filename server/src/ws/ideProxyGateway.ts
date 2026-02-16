import net from "node:net";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { URL } from "node:url";
import { appDb } from "../db/index.js";
import { appProjectForUser, taskContextForUser } from "../db/ownership.js";
import { ideSessionTarget } from "../services/ide.js";

function resolveUserIdFromUpgrade(req: IncomingMessage): string | null {
  const headerUserId = typeof req.headers["x-user-id"] === "string" ? req.headers["x-user-id"].trim() : "";
  if (headerUserId) {
    const exists = appDb.prepare("SELECT id FROM users WHERE id = ?").get(headerUserId) as { id: string } | undefined;
    if (exists?.id) {
      return exists.id;
    }
  }
  const firstUser = appDb.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  return firstUser?.id ?? null;
}

function canAccessTask(taskId: string, userId: string): boolean {
  return Boolean(taskContextForUser(taskId, userId));
}

function canAccessProject(projectId: string, userId: string): boolean {
  return Boolean(appProjectForUser(projectId, userId));
}

function buildUpgradeRequest(req: IncomingMessage, upstreamPath: string, targetPort: number): string {
  const lines: string[] = [];
  lines.push(`GET ${upstreamPath} HTTP/${req.httpVersion}`);
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        lines.push(`${key}: ${item}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push(`x-forwarded-host: ${req.headers.host || ""}`);
  lines.push("x-forwarded-proto: http");
  lines.push(`x-forwarded-port: ${targetPort}`);
  lines.push("");
  lines.push("");
  return lines.join("\r\n");
}

export function createIdeProxyGateway(server: HttpServer): void {
  server.on("upgrade", (req, socket, head) => {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "", `http://${host}`);
    const userId = resolveUserIdFromUpgrade(req);
    if (!userId) {
      socket.destroy();
      return;
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/ide\/proxy(\/.*)?$/);
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/ide\/proxy(\/.*)?$/);
    if (!taskMatch && !projectMatch) {
      return;
    }

    let sessionKey: string;
    let prefix: string;
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1] || "");
      if (!canAccessTask(taskId, userId)) {
        socket.destroy();
        return;
      }
      sessionKey = taskId;
      prefix = `/api/tasks/${encodeURIComponent(taskId)}/ide/proxy`;
    } else {
      const projectId = decodeURIComponent(projectMatch?.[1] || "");
      if (!canAccessProject(projectId, userId)) {
        socket.destroy();
        return;
      }
      sessionKey = `project:${projectId}:base`;
      prefix = `/api/projects/${encodeURIComponent(projectId)}/ide/proxy`;
    }

    const target = ideSessionTarget(sessionKey);
    if (!target) {
      socket.destroy();
      return;
    }

    const upstreamPath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || "/" : "/";
    const upstreamPathWithQuery = `${upstreamPath}${url.search}`;

    const upstreamSocket = net.connect(target.port, target.host);
    upstreamSocket.setNoDelay(true);
    (socket as net.Socket).setNoDelay(true);

    upstreamSocket.on("connect", () => {
      const requestHead = buildUpgradeRequest(req, upstreamPathWithQuery, target.port);
      upstreamSocket.write(requestHead);
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    });

    const closeBoth = () => {
      if (!socket.destroyed) socket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };

    upstreamSocket.on("error", closeBoth);
    upstreamSocket.on("close", closeBoth);
    socket.on("error", closeBoth);
    socket.on("close", closeBoth);
  });
}
