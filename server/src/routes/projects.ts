import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { z } from "zod";
import {
  PROJECT_DB_DIRNAME,
  db,
  ensureProjectDb,
  getProjectConfig,
  isProjectDbError,
  upsertProjectConfig
} from "../db/index.js";
import type { AppProjectRow, ProjectConfigFields, ProjectRow } from "../types.js";
import { makeId } from "../utils/id.js";
import { nextSlug, slugify } from "../utils/slug.js";
import { nowIso } from "../utils/time.js";
import { isValidRepoUrl } from "../utils/validation.js";
import { cloneRepo, listRepoFiles } from "../services/git.js";
import { recordEvent } from "../services/events.js";
import { reposRoot } from "../utils/paths.js";
import { ideSessionRunning, ideSessionTarget, startIdeSession, stopIdeSession } from "../services/ide.js";

const createSchema = z.object({
  name: z.string().min(2).max(120),
  repoUrl: z.string().min(1),
  projectPrompt: z.string().max(8000).default(""),
  projectRules: z.string().max(12000).default(""),
  codingStandard: z.string().max(200).default(""),
  codingStandardOther: z.string().max(4000).default(""),
  projectOther: z.string().max(12000).default(""),
  defaultBranch: z.string().min(1).max(120).default("main")
});

const patchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  projectPrompt: z.string().max(8000).optional(),
  projectRules: z.string().max(12000).optional(),
  codingStandard: z.string().max(200).optional(),
  codingStandardOther: z.string().max(4000).optional(),
  projectOther: z.string().max(12000).optional()
});

function serializeProject(project: ProjectRow) {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    repoUrl: project.repo_url,
    defaultBranch: project.default_branch,
    basePath: project.base_path,
    projectPrompt: project.project_prompt,
    projectRules: project.project_rules,
    codingStandard: project.coding_standard,
    codingStandardOther: project.coding_standard_other,
    projectOther: project.project_other,
    cloneStatus: project.clone_status,
    cloneError: project.clone_error,
    createdByUserId: project.created_by_user_id,
    createdAt: project.created_at,
    updatedAt: project.updated_at
  };
}

function projectConfigFor(project: Pick<AppProjectRow, "id" | "base_path" | "clone_status">): ProjectConfigFields {
  if (project.clone_status !== "ready") {
    return {
      project_prompt: "",
      project_rules: "",
      coding_standard: "",
      coding_standard_other: "",
      project_other: ""
    };
  }

  const config = getProjectConfig({
    projectId: project.id,
    basePath: project.base_path
  });
  return {
    project_prompt: config.project_prompt,
    project_rules: config.project_rules,
    coding_standard: config.coding_standard,
    coding_standard_other: config.coding_standard_other,
    project_other: config.project_other
  };
}

function hydrateProject(project: AppProjectRow): ProjectRow {
  return {
    ...project,
    ...projectConfigFor(project)
  };
}

function appProjectForUser(projectId: string, userId: string): AppProjectRow | undefined {
  return db
    .prepare(
      `SELECT p.*
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE p.id = ? AND pm.user_id = ?`
    )
    .get(projectId, userId) as AppProjectRow | undefined;
}

function hydratedProjectForUser(projectId: string, userId: string): ProjectRow | undefined {
  const project = appProjectForUser(projectId, userId);
  return project ? hydrateProject(project) : undefined;
}

function respondProjectDbError(res: any, error: unknown): boolean {
  if (!isProjectDbError(error)) {
    return false;
  }
  const status = error.code === "PROJECT_DB_UNAVAILABLE" ? 503 : 409;
  res.status(status).json({
    error: error.message,
    code: error.code
  });
  return true;
}

export const projectsRouter = Router();

const projectIdeTokenHashes = new Map<string, string>();

function projectIdeSessionKey(projectId: string): string {
  return `project:${projectId}:base`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function issueProjectIdeLaunchUrl(projectId: string, folderPath: string): string {
  const raw = randomBytes(24).toString("hex");
  projectIdeTokenHashes.set(projectId, hashToken(raw));
  return `/api/projects/${projectId}/ide/view?token=${encodeURIComponent(raw)}&folder=${encodeURIComponent(folderPath)}`;
}

function rewriteProxyLocation(params: { location: string; projectId: string; targetPort: number }): string {
  const proxyBase = `/api/projects/${params.projectId}/ide/proxy`;
  const localPrefix = `http://127.0.0.1:${params.targetPort}`;
  if (params.location.startsWith(localPrefix)) {
    return `${proxyBase}${params.location.slice(localPrefix.length) || "/"}`;
  }
  if (params.location.startsWith("/")) {
    return `${proxyBase}${params.location}`;
  }
  return params.location;
}

function proxyProjectIdeHttp(req: any, res: any, params: { projectId: string; targetPort: number }): void {
  const proxyBase = `/api/projects/${params.projectId}/ide/proxy`;
  const host = req.headers.host || "localhost";
  const incoming = new URL(req.originalUrl || req.url, `http://${host}`);
  const upstreamPathname = incoming.pathname.startsWith(proxyBase) ? incoming.pathname.slice(proxyBase.length) || "/" : "/";
  const upstreamPath = `${upstreamPathname}${incoming.search}`;

  const requestHeaders = { ...req.headers };
  delete requestHeaders.connection;
  delete requestHeaders["content-length"];
  requestHeaders["x-forwarded-host"] = req.headers.host || "";
  requestHeaders["x-forwarded-proto"] = req.protocol || "http";
  requestHeaders["x-forwarded-for"] = req.ip || "";

  const upstreamReq = http.request(
    {
      hostname: "127.0.0.1",
      port: params.targetPort,
      method: req.method,
      path: upstreamPath,
      headers: requestHeaders
    },
    (upstreamRes) => {
      const headers = { ...upstreamRes.headers } as Record<string, string | string[] | undefined>;
      if (typeof headers.location === "string") {
        headers.location = rewriteProxyLocation({
          location: headers.location,
          projectId: params.projectId,
          targetPort: params.targetPort
        });
      }
      if (Array.isArray(headers.location) && headers.location.length > 0) {
        headers.location = headers.location.map((location) =>
          rewriteProxyLocation({
            location,
            projectId: params.projectId,
            targetPort: params.targetPort
          })
        );
      }
      res.status(upstreamRes.statusCode || 502);
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        res.setHeader(key, value as any);
      }
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on("error", (error) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `IDE proxy request failed: ${String(error.message || error)}` });
    } else {
      res.end();
    }
  });

  req.pipe(upstreamReq);
}

projectsRouter.get("/", (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = ?
       ORDER BY p.created_at DESC`
    )
    .all(req.user.id) as AppProjectRow[];
  try {
    res.json({ projects: rows.map((row) => serializeProject(hydrateProject(row))) });
  } catch (error) {
    if (respondProjectDbError(res, error)) {
      return;
    }
    throw error;
  }
});

projectsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const input = parsed.data;
  if (!isValidRepoUrl(input.repoUrl)) {
    res.status(400).json({ error: "Invalid repository URL" });
    return;
  }

  const now = nowIso();
  const id = makeId();
  const base = slugify(input.name);
  const slug = nextSlug(base, (candidate) => {
    const found = db.prepare("SELECT id FROM projects WHERE slug = ?").get(candidate);
    return Boolean(found);
  });

  const basePath = path.join(reposRoot, slug, "base");
  fs.mkdirSync(path.dirname(basePath), { recursive: true });

  db.prepare(
    `INSERT INTO projects (
      id, name, slug, repo_url, default_branch, base_path,
      clone_status, clone_error, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`
  ).run(
    id,
    input.name,
    slug,
    input.repoUrl,
    input.defaultBranch,
    basePath,
    req.user.id,
    now,
    now
  );

  db.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
    id,
    req.user.id,
    now
  );

  recordEvent({
    projectId: id,
    eventType: "project.created",
    payload: {
      name: input.name,
      repoUrl: input.repoUrl,
      defaultBranch: input.defaultBranch
    }
  });

  db.prepare("UPDATE projects SET clone_status = 'cloning', updated_at = ? WHERE id = ?").run(nowIso(), id);

  try {
    await cloneRepo({
      repoUrl: input.repoUrl,
      destination: basePath,
      branch: input.defaultBranch
    });
    fs.mkdirSync(path.join(basePath, PROJECT_DB_DIRNAME), { recursive: true });
    ensureProjectDb({
      projectId: id,
      basePath,
      initializeIfMissing: true,
      configDefaults: {
        project_prompt: input.projectPrompt,
        project_rules: input.projectRules,
        coding_standard: input.codingStandard,
        coding_standard_other: input.codingStandardOther,
        project_other: input.projectOther
      }
    });

    db.prepare("UPDATE projects SET clone_status = 'ready', clone_error = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id);
    recordEvent({
      projectId: id,
      eventType: "project.clone.succeeded",
      payload: { basePath }
    });
  } catch (error: any) {
    const cloneError = String(error?.message ?? "Clone failed");
    db.prepare("UPDATE projects SET clone_status = 'failed', clone_error = ?, updated_at = ? WHERE id = ?").run(
      cloneError,
      nowIso(),
      id
    );
    recordEvent({
      projectId: id,
      eventType: "project.clone.failed",
      payload: { cloneError }
    });
  }

  const project = appProjectForUser(id, req.user.id);
  if (!project) {
    res.status(500).json({ error: "Project not found after create" });
    return;
  }
  try {
    res.status(201).json({ project: serializeProject(hydrateProject(project)) });
  } catch (error) {
    if (respondProjectDbError(res, error)) {
      return;
    }
    throw error;
  }
});

projectsRouter.get("/:projectId", (req, res) => {
  let project: ProjectRow | undefined;
  try {
    project = hydratedProjectForUser(req.params.projectId, req.user.id);
  } catch (error) {
    if (respondProjectDbError(res, error)) {
      return;
    }
    throw error;
  }
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json({ project: serializeProject(project) });
});

projectsRouter.get("/:projectId/files", async (req, res) => {
  const project = appProjectForUser(req.params.projectId, req.user.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.clone_status !== "ready") {
    res.json({ files: [] });
    return;
  }

  const query = typeof req.query.query === "string" ? req.query.query : "";
  const rawLimit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : Number.NaN;
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;

  try {
    const files = await listRepoFiles({
      repoPath: project.base_path,
      query,
      limit
    });
    res.json({ files });
  } catch (error: any) {
    res.status(500).json({ error: String(error?.message ?? "Failed to list files") });
  }
});

projectsRouter.patch("/:projectId", (req, res) => {
  const parsed = patchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const existing = appProjectForUser(req.params.projectId, req.user.id);
  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const updates = parsed.data;
  const nextName = updates.name ?? existing.name;

  db.prepare(
    `UPDATE projects
     SET name = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    nextName,
    nowIso(),
    existing.id
  );

  const hasConfigUpdate =
    updates.projectPrompt !== undefined ||
    updates.projectRules !== undefined ||
    updates.codingStandard !== undefined ||
    updates.codingStandardOther !== undefined ||
    updates.projectOther !== undefined;
  if (hasConfigUpdate) {
    try {
      const currentConfig = projectConfigFor(existing);
      upsertProjectConfig({
        projectId: existing.id,
        basePath: existing.base_path,
        projectPrompt: updates.projectPrompt ?? currentConfig.project_prompt,
        projectRules: updates.projectRules ?? currentConfig.project_rules,
        codingStandard: updates.codingStandard ?? currentConfig.coding_standard,
        codingStandardOther: updates.codingStandardOther ?? currentConfig.coding_standard_other,
        projectOther: updates.projectOther ?? currentConfig.project_other
      });
    } catch (error: any) {
      if (respondProjectDbError(res, error)) {
        return;
      }
      res.status(409).json({ error: String(error?.message ?? "Project config is unavailable") });
      return;
    }
  }

  recordEvent({
    projectId: existing.id,
    eventType: "project.updated",
    payload: updates
  });

  let project: ProjectRow | undefined;
  try {
    project = hydratedProjectForUser(existing.id, req.user.id);
  } catch (error) {
    if (respondProjectDbError(res, error)) {
      return;
    }
    throw error;
  }
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json({ project: serializeProject(project) });
});

projectsRouter.post("/:projectId/ide/start", async (req, res) => {
  const project = appProjectForUser(req.params.projectId, req.user.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.clone_status !== "ready") {
    res.status(409).json({ error: "Project base repository is not ready" });
    return;
  }

  const sessionKey = projectIdeSessionKey(project.id);
  try {
    await startIdeSession({
      taskId: sessionKey,
      workspacePath: project.base_path
    });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Failed to start project IDE") });
    return;
  }

  const launchUrl = issueProjectIdeLaunchUrl(project.id, project.base_path);
  res.json({
    launchUrl
  });
});

projectsRouter.post("/:projectId/ide/stop", (req, res) => {
  const project = appProjectForUser(req.params.projectId, req.user.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const stopped = stopIdeSession(projectIdeSessionKey(project.id));
  res.json({ stopped });
});

projectsRouter.get("/:projectId/ide/view", (req, res) => {
  const project = appProjectForUser(req.params.projectId, req.user.id);
  if (!project) {
    res.status(404).send("Project not found");
    return;
  }

  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token) {
    res.status(401).send("Missing IDE token");
    return;
  }
  const tokenHash = projectIdeTokenHashes.get(project.id);
  if (!tokenHash || tokenHash !== hashToken(token)) {
    res.status(401).send("Invalid IDE token");
    return;
  }

  if (!ideSessionRunning(projectIdeSessionKey(project.id))) {
    res.status(409).send("IDE is not running");
    return;
  }

  const folder = typeof req.query.folder === "string" ? req.query.folder : "";
  const folderQuery = folder ? `?folder=${encodeURIComponent(folder)}` : "";
  res.redirect(302, `/api/projects/${project.id}/ide/proxy/${folderQuery}`);
});

projectsRouter.all("/:projectId/ide/proxy*", (req, res) => {
  const project = appProjectForUser(req.params.projectId, req.user.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const sessionKey = projectIdeSessionKey(project.id);
  if (!ideSessionRunning(sessionKey)) {
    res.status(409).json({ error: "IDE is not running" });
    return;
  }
  const target = ideSessionTarget(sessionKey);
  if (!target) {
    res.status(409).json({ error: "IDE target is unavailable" });
    return;
  }
  proxyProjectIdeHttp(req, res, { projectId: project.id, targetPort: target.port });
});
