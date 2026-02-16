import cors from "cors";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ensureLocalUser } from "./db/index.js";
import { authMiddleware } from "./middleware/auth.js";
import { projectsRouter } from "./routes/projects.js";
import { settingsRouter } from "./routes/settings.js";
import { tasksRouter } from "./routes/tasks.js";
import { startIdeHeartbeat } from "./services/ide.js";
import { startTaskQueueWorker } from "./services/queue.js";
import { startRuntimeHeartbeat } from "./services/runtime.js";
import { createIdeProxyGateway } from "./ws/ideProxyGateway.js";
import { createTerminalGateway } from "./ws/terminalGateway.js";
import { workspaceRoot } from "./utils/paths.js";
import { db } from "./db/index.js";
import { nowIso } from "./utils/time.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

ensureLocalUser();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(authMiddleware);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/projects", projectsRouter);
app.use("/api/users/me/settings", settingsRouter);
app.use("/api", tasksRouter);

const webDist = path.join(workspaceRoot, "web", "dist");
const webIndex = path.join(webDist, "index.html");
if (fs.existsSync(webIndex)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(webIndex);
  });
} else {
  app.get("/", (_req, res) => {
    res.status(200).send("Frontend not built yet. Run `npm run build -w web` or `npm run dev -w web`.");
  });
}

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = String(error?.message ?? "Unexpected server error");
  res.status(500).json({ error: message });
});

const server = http.createServer(app);
createTerminalGateway(server);
createIdeProxyGateway(server);

server.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
});

startRuntimeHeartbeat().catch((error) => {
  console.warn(`Runtime heartbeat disabled: ${String((error as Error).message || error)}`);
});
startTaskQueueWorker();

startIdeHeartbeat((taskId) => {
  const now = nowIso();
  db.prepare(
    `UPDATE ide_instances
     SET status = 'failed', ended_at = COALESCE(ended_at, ?), last_heartbeat_at = ?
     WHERE task_id = ? AND status IN ('starting','running')`
  ).run(now, now, taskId);
});
