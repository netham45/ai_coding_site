import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { authMiddleware } from "./middleware/auth.js";
import { db as appDb } from "./db/index.js";
import { plansRouter } from "./routes/plans.js";
import { projectsRouter } from "./routes/projects.js";
import { settingsRouter } from "./routes/settings.js";
import { tasksRouter } from "./routes/tasks.js";
import { endpointWorkerHandler, wrapRouterHandlersInAsyncWorkers } from "./middleware/endpointWorker.js";
import { workspaceRoot } from "./utils/paths.js";
import { collectProjectDbDiagnosticsHealth } from "./db/projectDbDiagnostics.js";
import { collectProjectMigrationHealth } from "./db/projectDataMigration.js";
import { logEndpoint } from "./utils/backendLogger.js";
import type { DiagnosticsProfiler } from "./services/diagnosticsProfiler.js";

type CreateAppOptions = {
  profiler?: DiagnosticsProfiler | null;
};

function redactHeaders(headers: express.Request["headers"]): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowered = key.toLowerCase();
    if (lowered === "authorization" || lowered === "cookie" || lowered === "set-cookie") {
      redacted[key] = "[REDACTED]";
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    const startedAtIso = new Date().toISOString();

    logEndpoint("http.request.start", {
      requestId,
      startedAt: startedAtIso,
      method: req.method,
      originalUrl: req.originalUrl,
      path: req.path,
      query: req.query,
      params: req.params,
      ip: req.ip,
      userAgent: req.header("user-agent"),
      headers: redactHeaders(req.headers),
      body: req.body
    });

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logEndpoint("http.request.finish", {
        requestId,
        finishedAt: new Date().toISOString(),
        startedAt: startedAtIso,
        durationMs,
        method: req.method,
        originalUrl: req.originalUrl,
        routePath: req.route?.path,
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        contentLength: res.getHeader("content-length"),
        userId: req.user?.id
      });
    });

    res.on("close", () => {
      if (res.writableEnded) {
        return;
      }
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logEndpoint("http.request.aborted", {
        requestId,
        abortedAt: new Date().toISOString(),
        startedAt: startedAtIso,
        durationMs,
        method: req.method,
        originalUrl: req.originalUrl,
        statusCode: res.statusCode
      });
    });

    next();
  });
  app.use(authMiddleware);

  app.get("/api/health", endpointWorkerHandler((_req: express.Request, res: express.Response) => {
    res.json({
      ok: true,
      diagnostics: {
        projectDb: collectProjectDbDiagnosticsHealth(),
        migration: collectProjectMigrationHealth(appDb)
      }
    });
  }));
  app.get("/api/debug/profiler/status", endpointWorkerHandler((_req: express.Request, res: express.Response) => {
    const status = options.profiler?.status ?? null;
    res.json({
      enabled: Boolean(status),
      status
    });
  }));
  app.post("/api/debug/profiler/snapshot", endpointWorkerHandler(async (req: express.Request, res: express.Response) => {
    const profiler = options.profiler;
    if (!profiler) {
      res.status(404).json({ error: "Profiler is disabled. Set AI_CODING_PROFILER_ENABLED=1." });
      return;
    }

    const reason = typeof req.body?.reason === "string" ? req.body.reason : "http-snapshot";
    const filePath = await profiler.captureSnapshot(reason);
    res.status(202).json({ ok: true, filePath });
  }));
  app.post("/api/debug/profiler/cpu", endpointWorkerHandler(async (req: express.Request, res: express.Response) => {
    const profiler = options.profiler;
    if (!profiler) {
      res.status(404).json({ error: "Profiler is disabled. Set AI_CODING_PROFILER_ENABLED=1." });
      return;
    }

    const reason = typeof req.body?.reason === "string" ? req.body.reason : "http-cpu-profile";
    const rawDurationMs = Number(req.body?.durationMs);
    const durationMs = Number.isFinite(rawDurationMs) ? rawDurationMs : undefined;
    const filePath = await profiler.captureCpuProfile(durationMs, reason);
    res.status(202).json({ ok: true, filePath });
  }));

  app.use("/api/projects", wrapRouterHandlersInAsyncWorkers(projectsRouter));
  app.use("/api/users/me/settings", wrapRouterHandlersInAsyncWorkers(settingsRouter));
  app.use("/api", wrapRouterHandlersInAsyncWorkers(tasksRouter));
  app.use("/api", wrapRouterHandlersInAsyncWorkers(plansRouter));

  const webDist = path.join(workspaceRoot, "web", "dist");
  const webIndex = path.join(webDist, "index.html");
  if (fs.existsSync(webIndex)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api).*/, endpointWorkerHandler((_req: express.Request, res: express.Response) => {
      res.sendFile(webIndex);
    }));
  } else {
    app.get("/", endpointWorkerHandler((_req: express.Request, res: express.Response) => {
      res.status(200).send("Frontend not built yet. Run `npm run build -w web` or `npm run dev -w web`.");
    }));
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = String((error as Error)?.message ?? "Unexpected server error");
    logEndpoint("http.request.error", {
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error)
    });
    res.status(500).json({ error: message });
  });

  return app;
}
