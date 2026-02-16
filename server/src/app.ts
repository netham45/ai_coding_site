import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
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

export function createApp(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use(authMiddleware);

  app.get("/api/health", endpointWorkerHandler((_req, res) => {
    res.json({
      ok: true,
      diagnostics: {
        projectDb: collectProjectDbDiagnosticsHealth(),
        migration: collectProjectMigrationHealth(appDb)
      }
    });
  }));

  app.use("/api/projects", wrapRouterHandlersInAsyncWorkers(projectsRouter));
  app.use("/api/users/me/settings", wrapRouterHandlersInAsyncWorkers(settingsRouter));
  app.use("/api", wrapRouterHandlersInAsyncWorkers(tasksRouter));
  app.use("/api", wrapRouterHandlersInAsyncWorkers(plansRouter));

  const webDist = path.join(workspaceRoot, "web", "dist");
  const webIndex = path.join(webDist, "index.html");
  if (fs.existsSync(webIndex)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api).*/, endpointWorkerHandler((_req, res) => {
      res.sendFile(webIndex);
    }));
  } else {
    app.get("/", endpointWorkerHandler((_req, res) => {
      res.status(200).send("Frontend not built yet. Run `npm run build -w web` or `npm run dev -w web`.");
    }));
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = String((error as Error)?.message ?? "Unexpected server error");
    res.status(500).json({ error: message });
  });

  return app;
}
