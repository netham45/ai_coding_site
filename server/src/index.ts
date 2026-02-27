import http from "node:http";
import { db as appDb, ensureLocalUser, resolveProjectDatabase } from "./db/index.js";
import { startIdeHeartbeat } from "./services/ide.js";
import { startOrchestrationJobQueueWorker } from "./services/orchestration/jobQueue.js";
import { startHierarchicalOrchestrationJobs } from "./services/orchestration/jobs/index.js";
import { startTaskQueueWorker } from "./services/queue.js";
import { startRuntimeHeartbeat } from "./services/runtime.js";
import { setupDiagnosticsProfiler } from "./services/diagnosticsProfiler.js";
import { createIdeProxyGateway } from "./ws/ideProxyGateway.js";
import { nowIso } from "./utils/time.js";
import { createApp } from "./app.js";
import { orchestrationWorkersEnabled } from "./config/featureFlags.js";

const profiler = setupDiagnosticsProfiler();
const app = createApp({ profiler });
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

ensureLocalUser();

const server = http.createServer(app);
createIdeProxyGateway(server);

server.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
});

startRuntimeHeartbeat().catch((error) => {
  console.warn(`Runtime heartbeat disabled: ${String((error as Error).message || error)}`);
});
if (orchestrationWorkersEnabled()) {
  startOrchestrationJobQueueWorker();
  startHierarchicalOrchestrationJobs();
} else {
  console.log("Orchestration workers disabled by feature flag");
}
startTaskQueueWorker();

startIdeHeartbeat((taskId) => {
  const now = nowIso();
  const projects = appDb
    .prepare("SELECT id, base_path FROM projects ORDER BY created_at ASC")
    .all() as Array<{ id: string; base_path: string }>;
  for (const project of projects) {
    const scoped = resolveProjectDatabase({
      appDb,
      projectId: project.id,
      basePath: project.base_path,
      intent: "write"
    });
    scoped.database.prepare(
      `UPDATE ide_instances
       SET status = 'failed', ended_at = COALESCE(ended_at, ?), last_heartbeat_at = ?
       WHERE task_id = ? AND status IN ('starting','running')`
    ).run(now, now, taskId);
  }
});
