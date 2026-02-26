import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { Router } from "express";
import { z } from "zod";
import { db as appDb, isProjectDbError, resolveProjectDatabase } from "../db/index.js";
import { recordEvent } from "../services/events.js";
import { buildEffectivePrompt } from "../services/promptBuilder.js";
import { parsePlanOutput } from "../services/planParser.js";
import { kickTaskQueueProcessing } from "../services/queue.js";
import { cloneLocalBaseToWorkspace, createTaskBranch, getHeadCommitSha, taskBranchName } from "../services/git.js";
import { sendTaskRuntimeInputWorker } from "../services/runtimeWorker.js";
import type {
  PlanRevisionItemDependencyRow,
  PlanRevisionItemRow,
  PlanRevisionRow,
  ProjectRow,
  TaskRow,
  TaskTransitionRow
} from "../types.js";
import { makeId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

const createPlanSchema = z.object({
  title: z.string().min(2).max(160),
  taskPrompt: z.string().min(1).max(12000),
  aiCommand: z.string().min(1).max(500).optional(),
  autoStart: z.boolean().optional(),
  autoMergeOnComplete: z.boolean().optional(),
  parentPlanTaskId: z.string().min(1).max(200).optional()
});

const regenerateSchema = z.object({
  feedback: z.string().min(1).max(12000)
});

const approvePlanSchema = z.object({
  autoStart: z.boolean().optional(),
  autoMergeOnComplete: z.boolean().optional(),
  parentPlanTaskId: z.string().min(1).max(200).nullable().optional(),
  autoMergeItemKeys: z.array(z.string().min(1).max(200)).max(1000).optional(),
  taskEdits: z
    .array(
      z.object({
        itemKey: z.string().min(1).max(200),
        itemType: z.enum(["execution_task", "sub_plan"]).optional(),
        title: z.string().min(2).max(160),
        description: z.string().min(1).max(12000),
        prompt: z.string().max(12000).optional(),
        aiCommand: z.string().min(1).max(500).optional(),
        parentPlanTaskId: z.string().min(1).max(200).nullable().optional(),
        autoStart: z.boolean().optional(),
        autoMergeOnComplete: z.boolean().optional()
      })
    )
    .max(1000)
    .optional()
});

const PLAN_OUTPUT_RELATIVE_PATH = ".ai-plan/latest-plan.yaml";

function planningFormatInstructions(): string {
  return [
    "CLI Usage Context:",
    "- Run commands from /server.",
    "- First run `npm run cli -- --help` to view all available commands and options.",
    "- Execute commands with `npm run cli -- <command>`.",
    "- Available commands:",
    "  - tasks list [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks all [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks active [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks get <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks summary <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks details <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks create --project <projectId> --title <title> --prompt <prompt> [--ai-command <cmd>] [--depends-on a,b] [--auto-merge]",
    "  - tasks start <taskId>",
    "  - tasks input <taskId> --text <text>",
    "  - tasks pull-main <taskId>",
    "  - plans list [--project-id <projectId>] [--plan-id <planId>]",
    "  - plans create --project <projectId> --title <title> --prompt <prompt> [--ai-command <cmd>] [--auto-start] [--auto-merge-on-complete] [--parent-plan-id <planId>]",
    "  - plans get <planId>",
    "  - plans review <planId>",
    "  - plans extract <planId>",
    "  - plans regenerate <planId> --feedback <text>",
    "  - plans approve <planId> [--auto-merge-item-keys a,b] [--auto-start] [--auto-merge-on-complete] [--parent-plan-id <planId>] [--task-edits-file path.json]",
    "  - info <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  - session start <taskId>",
    "  - session input <taskId> --text <text>",
    "  - create task ...",
    "  - create plan ...",
    "  - review task <taskId>",
    "  - review plan <planId>",
    "  - review <taskId>",
    "  - ide status <taskId>",
    "  - ide start <taskId>",
    "  - ide stop <taskId>",
    "  - ready_merge <taskId>",
    "  - ready_merge task <taskId>",
    "  - ready_merge plan <planId>",
    "  - merge <taskId>",
    "  - merge task <taskId>",
    "  - merge plan <planId>",
    "",
    "Planner Output Contract:",
    "Return the final plan as YAML only.",
    "Wrap YAML in a fenced block using ```yaml.",
    "Top-level key must be `tasks:` (or `items:` for compatibility).",
    "Optional top-level defaults:",
    "- auto_start: default for sub_plan items",
    "- auto_merge_on_complete: default for sub_plan items",
    "- auto_merge_item_keys: execution item ids that should auto-merge",
    "Each plan item entry must include:",
    "- id: unique task identifier",
    "- title: short task title",
    "- prompt: implementation prompt for that task",
    "- item_type: execution_task | sub_plan (optional, defaults to execution_task)",
    "- depends_on: list of task ids (optional)",
    "Dependencies may reference any prior item type and must form an acyclic graph.",
    "Optional item-level automation:",
    "- execution_task: auto_merge: true|false",
    "- sub_plan: auto_start: true|false, auto_merge_on_complete: true|false",
    "After generating YAML, write the exact same YAML to this file in the workspace:",
    `${PLAN_OUTPUT_RELATIVE_PATH}`
  ].join("\n");
}

function buildPlanTaskPrompt(userPrompt: string): string {
  return `${userPrompt.trim()}\n\n${planningFormatInstructions()}`.trim();
}

function planOutputFilePath(workspacePath: string): string {
  return path.join(workspacePath, PLAN_OUTPUT_RELATIVE_PATH);
}

function readPlanOutputSource(projectDb: Database.Database, plan: TaskRow): { raw: string; source: "file" | "session_output"; filePath: string } {
  const filePath = planOutputFilePath(plan.workspace_path);
  try {
    const fileValue = fs.readFileSync(filePath, "utf8").trim();
    if (fileValue) {
      return { raw: fileValue, source: "file", filePath };
    }
  } catch {
    // Fall through to session output.
  }

  const raw = getLatestSessionOutput(projectDb, plan.id);
  return { raw, source: "session_output", filePath };
}

function projectForUser(projectId: string, userId: string): ProjectRow | undefined {
  return appDb
    .prepare(
      `SELECT p.*
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE p.id = ? AND pm.user_id = ?`
    )
    .get(projectId, userId) as ProjectRow | undefined;
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

function memberProjectsForUser(userId: string): ProjectRow[] {
  return appDb
    .prepare(
      `SELECT p.*
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = ?`
    )
    .all(userId) as ProjectRow[];
}

function projectDatabaseFor(project: ProjectRow, intent: "read" | "write"): Database.Database {
  return resolveProjectDatabase({
    appDb,
    projectId: project.id,
    basePath: project.base_path,
    intent
  }).database;
}

function planForUser(
  planTaskId: string,
  userId: string,
  intent: "read" | "write"
): { plan: TaskRow; project: ProjectRow; projectDb: Database.Database } | undefined {
  const projects = memberProjectsForUser(userId);
  for (const project of projects) {
    let projectDb: Database.Database;
    try {
      projectDb = projectDatabaseFor(project, intent);
    } catch (error) {
      if (isProjectDbError(error)) {
        continue;
      }
      throw error;
    }
    const plan = projectDb
      .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ? AND mode = 'plan'")
      .get(planTaskId, project.id) as TaskRow | undefined;
    if (plan) {
      return { plan, project, projectDb };
    }
  }
  return undefined;
}

function serializeTask(projectDb: Database.Database, task: TaskRow) {
  const dependencyTaskIds = projectDb
    .prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
    .all(task.id) as Array<{ dependency_task_id: string }>;
  const blockedByTaskIds = projectDb
    .prepare(
      `SELECT td.dependency_task_id
       FROM task_dependencies td
       JOIN tasks dep ON dep.id = td.dependency_task_id
       WHERE td.task_id = ? AND dep.status != 'merged'
       ORDER BY dep.created_at ASC`
    )
    .all(task.id) as Array<{ dependency_task_id: string }>;

  return {
    id: task.id,
    projectId: task.project_id,
    title: task.title,
    taskPrompt: task.task_prompt,
    result: task.result,
    effectivePrompt: task.effective_prompt,
    aiCommand: task.ai_command,
    autoMerge: Boolean(task.auto_merge),
    autoStart: Boolean(task.auto_start),
    autoMergeOnComplete: Boolean(task.auto_merge_on_complete),
    mode: task.mode,
    parentPlanTaskId: task.parent_plan_task_id,
    sourcePlanRevisionId: task.source_plan_revision_id,
    sourcePlanItemKey: task.source_plan_item_key,
    status: task.status,
    workspacePath: task.workspace_path,
    baseCommitShaAtCreate: task.base_commit_sha_at_create,
    headCommitSha: task.head_commit_sha,
    cancelReason: task.cancel_reason,
    mergedAt: task.merged_at,
    mergedByUserId: task.merged_by_user_id,
    dependencyTaskIds: dependencyTaskIds.map((x) => x.dependency_task_id),
    blockedByTaskIds: blockedByTaskIds.map((x) => x.dependency_task_id),
    isBlocked: task.status === "queued" && blockedByTaskIds.length > 0,
    createdByUserId: task.created_by_user_id,
    createdAt: task.created_at,
    updatedAt: task.updated_at
  };
}

function planTaskInProject(projectDb: Database.Database, projectId: string, planTaskId: string): TaskRow | undefined {
  return projectDb
    .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ? AND mode = 'plan'")
    .get(planTaskId, projectId) as TaskRow | undefined;
}

function serializeTransition(row: TaskTransitionRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at
  };
}

function resolveAiCommand(inputAiCommand: string | undefined, userId: string): string {
  if (inputAiCommand) {
    return inputAiCommand;
  }
  const settings = appDb
    .prepare("SELECT default_ai_command, default_ai_commands FROM user_settings WHERE user_id = ?")
    .get(userId) as { default_ai_command: string; default_ai_commands?: string } | undefined;
  if (!settings) {
    return "codex --yolo {prompt}";
  }

  try {
    const parsed = JSON.parse(settings.default_ai_commands ?? "[]");
    if (Array.isArray(parsed)) {
      const first = parsed.find((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (first) {
        return first.trim();
      }
    }
  } catch {
    // Fall through to legacy value.
  }

  return settings.default_ai_command || "codex --yolo {prompt}";
}

function nextRevisionNumber(projectDb: Database.Database, planTaskId: string): number {
  const row = projectDb
    .prepare("SELECT COALESCE(MAX(revision_number), 0) AS max_number FROM plan_revisions WHERE plan_task_id = ?")
    .get(planTaskId) as { max_number: number };
  return Number(row.max_number) + 1;
}

function getLatestSessionOutput(projectDb: Database.Database, taskId: string): string {
  const row = projectDb
    .prepare("SELECT last_output FROM task_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(taskId) as { last_output: string } | undefined;
  return (row?.last_output ?? "").trim();
}

function getProjectAccessOrRespond(
  params: { projectId: string; userId: string; notFoundMessage: string; intent: "read" | "write" },
  res: any
): { project: ProjectRow; projectDb: Database.Database } | null {
  const project = projectForUser(params.projectId, params.userId);
  if (!project) {
    res.status(404).json({ error: params.notFoundMessage });
    return null;
  }
  try {
    return {
      project,
      projectDb: projectDatabaseFor(project, params.intent)
    };
  } catch (error) {
    if (respondProjectDbError(res, error)) {
      return null;
    }
    throw error;
  }
}

function getPlanAccessOrRespond(
  params: { planId: string; userId: string; notFoundMessage: string; intent: "read" | "write" },
  res: any
): { plan: TaskRow; project: ProjectRow; projectDb: Database.Database } | null {
  try {
    const scoped = planForUser(params.planId, params.userId, params.intent);
    if (!scoped) {
      res.status(404).json({ error: params.notFoundMessage });
      return null;
    }
    return scoped;
  } catch (error) {
    if (respondProjectDbError(res, error)) {
      return null;
    }
    throw error;
  }
}

export const plansRouter = Router();

plansRouter.post("/projects/:projectId/plans", async (req, res) => {
  const parsed = createPlanSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const scopedProject = getProjectAccessOrRespond(
    { projectId: req.params.projectId, userId: req.user.id, notFoundMessage: "Project not found", intent: "write" },
    res
  );
  if (!scopedProject) return;
  const { project, projectDb } = scopedProject;

  if (project.clone_status !== "ready") {
    res.status(409).json({ error: "Project base repository is not ready" });
    return;
  }

  const input = parsed.data;
  const plannerPrompt = buildPlanTaskPrompt(input.taskPrompt);
  const id = makeId();
  const now = nowIso();
  const workspacePath = path.join(path.dirname(project.base_path), "tasks", id);
  const aiCommand = resolveAiCommand(input.aiCommand, req.user.id);
  const effectivePrompt = buildEffectivePrompt(project, plannerPrompt);
  const autoStart = Boolean(input.autoStart);
  const autoMergeOnComplete = Boolean(input.autoMergeOnComplete);

  let parentPlanTask: TaskRow | undefined;
  if (input.parentPlanTaskId) {
    parentPlanTask = planTaskInProject(projectDb, project.id, input.parentPlanTaskId);
    if (!parentPlanTask) {
      res.status(400).json({ error: "parentPlanTaskId must reference an existing plan in this project" });
      return;
    }
  }

  let baseCommitSha: string;
  try {
    const sourcePath = parentPlanTask ? parentPlanTask.workspace_path : project.base_path;
    const sourceBranch = parentPlanTask ? taskBranchName(parentPlanTask.id) : project.default_branch;
    baseCommitSha = await getHeadCommitSha(sourcePath);
    await cloneLocalBaseToWorkspace({ basePath: sourcePath, baseBranch: sourceBranch, workspacePath });
    await createTaskBranch(workspacePath, id);
    await fs.promises.mkdir(path.join(workspacePath, ".ai-plan"), { recursive: true });
  } catch (error: any) {
    const message = String(error?.message ?? "Failed to initialize plan workspace");
    res.status(500).json({ error: message });
    return;
  }

  projectDb.transaction(() => {
    projectDb.prepare(
      `INSERT INTO tasks (
        id, project_id, title, task_prompt, result, effective_prompt, ai_command,
        auto_merge, auto_start, auto_merge_on_complete,
        mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
        status, workspace_path, base_commit_sha_at_create, head_commit_sha,
        cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', ?, ?, 0, ?, ?, 'plan', ?, NULL, NULL, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
    ).run(
      id,
      project.id,
      input.title,
      plannerPrompt,
      effectivePrompt,
      aiCommand,
      autoStart ? 1 : 0,
      autoMergeOnComplete ? 1 : 0,
      parentPlanTask?.id ?? null,
      workspacePath,
      baseCommitSha,
      req.user.id,
      now,
      now
    );

    projectDb.prepare(
      `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(makeId(), id, "null", "queued", "plan_created", req.user.id, now);
  })();

  recordEvent({
    projectId: project.id,
    taskId: id,
    eventType: "plan.created",
    database: projectDb,
    payload: {
      title: input.title,
      aiCommand,
      autoStart,
      autoMergeOnComplete,
      parentPlanTaskId: parentPlanTask?.id ?? null,
      workspacePath,
      baseCommitShaAtCreate: baseCommitSha
    }
  });

  const task = projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
  kickTaskQueueProcessing();
  res.status(201).json({ plan: serializeTask(projectDb, task) });
});

plansRouter.get("/plans/:planId", (req, res) => {
  const scopedPlan = getPlanAccessOrRespond(
    { planId: req.params.planId, userId: req.user.id, notFoundMessage: "Plan not found", intent: "read" },
    res
  );
  if (!scopedPlan) return;
  const { plan, projectDb } = scopedPlan;

  const transitions = projectDb
    .prepare("SELECT * FROM task_state_transitions WHERE task_id = ? ORDER BY created_at ASC")
    .all(plan.id) as TaskTransitionRow[];

  const revisions = projectDb
    .prepare("SELECT * FROM plan_revisions WHERE plan_task_id = ? ORDER BY revision_number DESC")
    .all(plan.id) as PlanRevisionRow[];

  const revisionItems = revisions.length
    ? (projectDb
        .prepare(
          `SELECT *
           FROM plan_revision_items
           WHERE revision_id IN (${revisions.map(() => "?").join(",")})
           ORDER BY ordinal ASC`
        )
        .all(...revisions.map((row) => row.id)) as PlanRevisionItemRow[])
    : [];

  const dependencies = revisionItems.length
    ? (projectDb
        .prepare(
          `SELECT d.*
           FROM plan_revision_item_dependencies d
           JOIN plan_revision_items i ON i.id = d.revision_item_id
           WHERE i.revision_id IN (${revisions.map(() => "?").join(",")})`
        )
        .all(...revisions.map((row) => row.id)) as PlanRevisionItemDependencyRow[])
    : [];

  const itemsByRevision = new Map<string, Array<{
    id: string;
    itemKey: string;
    itemType: string;
    title: string;
    prompt: string;
    ordinal: number;
    dependsOnItemKeys: string[];
  }>>();

  for (const item of revisionItems) {
    const dependsOnItemKeys = dependencies
      .filter((dep) => dep.revision_item_id === item.id)
      .map((dep) => dep.depends_on_item_key);
    if (!itemsByRevision.has(item.revision_id)) {
      itemsByRevision.set(item.revision_id, []);
    }
    itemsByRevision.get(item.revision_id)?.push({
      id: item.id,
      itemKey: item.item_key,
      itemType: item.item_type,
      title: item.title,
      prompt: item.prompt,
      ordinal: item.ordinal,
      dependsOnItemKeys
    });
  }

  const approvedTasks = projectDb
    .prepare("SELECT * FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
    .all(plan.id) as TaskRow[];

  res.json({
    plan: serializeTask(projectDb, plan),
    transitions: transitions.map(serializeTransition),
    revisions: revisions.map((revision) => ({
      id: revision.id,
      planTaskId: revision.plan_task_id,
      revisionNumber: revision.revision_number,
      status: revision.status,
      feedback: revision.feedback,
      rawOutput: revision.raw_output,
      parseError: revision.parse_error,
      createdByUserId: revision.created_by_user_id,
      createdAt: revision.created_at,
      approvedAt: revision.approved_at,
      items: (itemsByRevision.get(revision.id) ?? []).sort((a, b) => a.ordinal - b.ordinal)
    })),
    approvedTasks: approvedTasks.map((task) => serializeTask(projectDb, task))
  });
});

plansRouter.post("/plans/:planId/extract", (req, res) => {
  const scopedPlan = getPlanAccessOrRespond(
    { planId: req.params.planId, userId: req.user.id, notFoundMessage: "Plan not found", intent: "write" },
    res
  );
  if (!scopedPlan) return;
  const { plan, projectDb } = scopedPlan;

  const source = readPlanOutputSource(projectDb, plan);
  if (!source.raw) {
    res.status(409).json({ error: "No plan output available. Generate plan YAML first." });
    return;
  }

  const revisionId = makeId();
  const revisionNumber = nextRevisionNumber(projectDb, plan.id);
  const createdAt = nowIso();

  try {
    const parsed = parsePlanOutput(source.raw);
    fs.mkdirSync(path.dirname(source.filePath), { recursive: true });
    fs.writeFileSync(source.filePath, `${parsed.yamlText.trim()}\n`, "utf8");

    projectDb.transaction(() => {
      projectDb.prepare("UPDATE plan_revisions SET status = 'superseded' WHERE plan_task_id = ? AND status = 'proposed'").run(plan.id);

      projectDb.prepare(
        `INSERT INTO plan_revisions (
          id, plan_task_id, revision_number, status, feedback, raw_output, parse_error, created_by_user_id, created_at, approved_at
         ) VALUES (?, ?, ?, 'proposed', NULL, ?, NULL, ?, ?, NULL)`
      ).run(revisionId, plan.id, revisionNumber, parsed.yamlText, req.user.id, createdAt);

      for (let i = 0; i < parsed.tasks.length; i += 1) {
        const task = parsed.tasks[i];
        const itemId = makeId();
        projectDb.prepare(
          `INSERT INTO plan_revision_items (id, revision_id, item_key, item_type, title, prompt, ordinal, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(itemId, revisionId, task.itemKey, task.itemType, task.title, task.prompt, i + 1, createdAt);

        for (const dep of task.dependsOnItemKeys) {
          projectDb.prepare(
            `INSERT INTO plan_revision_item_dependencies (revision_item_id, depends_on_item_key)
             VALUES (?, ?)`
          ).run(itemId, dep);
        }
      }
    })();

    recordEvent({
      projectId: plan.project_id,
      taskId: plan.id,
      eventType: "plan.revision.extracted",
      database: projectDb,
      payload: { revisionId, revisionNumber, items: parsed.tasks.length, source: source.source, planFile: source.filePath }
    });

    res.json({ ok: true, revisionId, revisionNumber, tasksExtracted: parsed.tasks.length, source: source.source, planFile: source.filePath });
  } catch (error: any) {
    const parseError = String(error?.message ?? "Failed to parse plan output");
    projectDb.prepare(
      `INSERT INTO plan_revisions (
        id, plan_task_id, revision_number, status, feedback, raw_output, parse_error, created_by_user_id, created_at, approved_at
       ) VALUES (?, ?, ?, 'parse_failed', NULL, ?, ?, ?, ?, NULL)`
    ).run(revisionId, plan.id, revisionNumber, source.raw, parseError, req.user.id, createdAt);

    res.status(400).json({ error: parseError });
  }
});

plansRouter.post("/plans/:planId/regenerate", async (req, res) => {
  const parsed = regenerateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const scopedPlan = getPlanAccessOrRespond(
    { planId: req.params.planId, userId: req.user.id, notFoundMessage: "Plan not found", intent: "write" },
    res
  );
  if (!scopedPlan) return;
  const { plan, project, projectDb } = scopedPlan;

  const feedback = parsed.data.feedback.trim();
  const revisionId = makeId();
  const revisionNumber = nextRevisionNumber(projectDb, plan.id);
  const createdAt = nowIso();
  const guidance = [
    "Regenerate the plan based on this feedback and restate the complete plan.",
    "Return plan output as YAML using the required schema under top-level `tasks:`.",
    "Write the exact YAML to file:",
    PLAN_OUTPUT_RELATIVE_PATH,
    "Then print the YAML in a ```yaml fenced block.",
    "Feedback:",
    feedback
  ].join("\n");

  try {
    await sendTaskRuntimeInputWorker(plan.id, req.user.id, guidance, {
      projectId: project.id,
      basePath: project.base_path,
      projectDb
    });
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Plan runtime is not ready for feedback") });
    return;
  }

  projectDb.prepare(
    `INSERT INTO plan_revisions (
      id, plan_task_id, revision_number, status, feedback, raw_output, parse_error, created_by_user_id, created_at, approved_at
     ) VALUES (?, ?, ?, 'feedback_requested', ?, '', NULL, ?, ?, NULL)`
  ).run(revisionId, plan.id, revisionNumber, feedback, req.user.id, createdAt);

  recordEvent({
    projectId: plan.project_id,
    taskId: plan.id,
    eventType: "plan.revision.feedback_requested",
    database: projectDb,
    payload: { revisionId, revisionNumber }
  });

  res.json({ ok: true, revisionId, revisionNumber });
});

plansRouter.post("/plans/:planId/approve", async (req, res) => {
  const parsed = approvePlanSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const scopedPlan = getPlanAccessOrRespond(
    { planId: req.params.planId, userId: req.user.id, notFoundMessage: "Plan not found", intent: "write" },
    res
  );
  if (!scopedPlan) return;
  const { plan, project, projectDb } = scopedPlan;

  const latestRevision = projectDb
    .prepare(
      `SELECT *
       FROM plan_revisions
       WHERE plan_task_id = ? AND status = 'proposed'
       ORDER BY revision_number DESC
       LIMIT 1`
    )
    .get(plan.id) as PlanRevisionRow | undefined;

  if (!latestRevision) {
    res.status(409).json({ error: "No proposed revision available to approve" });
    return;
  }

  const alreadyApproved = projectDb
    .prepare(
      "SELECT id FROM tasks WHERE source_plan_revision_id = ? AND parent_plan_task_id = ? LIMIT 1"
    )
    .get(latestRevision.id, plan.id) as { id: string } | undefined;

  if (alreadyApproved) {
    const approvedTasks = projectDb
      .prepare("SELECT * FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
      .all(plan.id) as TaskRow[];
    res.json({ approvedTasks: approvedTasks.map((task) => serializeTask(projectDb, task)) });
    return;
  }

  const items = projectDb
    .prepare("SELECT * FROM plan_revision_items WHERE revision_id = ? ORDER BY ordinal ASC")
    .all(latestRevision.id) as PlanRevisionItemRow[];

  if (!items.length) {
    res.status(409).json({ error: "Latest revision has no tasks" });
    return;
  }

  const depRows = projectDb
    .prepare(
      `SELECT d.*
       FROM plan_revision_item_dependencies d
       JOIN plan_revision_items i ON i.id = d.revision_item_id
       WHERE i.revision_id = ?`
    )
    .all(latestRevision.id) as PlanRevisionItemDependencyRow[];

  const itemIdToDeps = new Map<string, string[]>();
  const autoMergeItemKeys = new Set((parsed.data.autoMergeItemKeys ?? []).map((key) => key.toLowerCase()));
  const taskEditsByItemKey = new Map(
    (parsed.data.taskEdits ?? []).map((edit) => [edit.itemKey.toLowerCase(), edit])
  );
  let parsedRevisionDefaults:
    | {
        autoStart: boolean;
        autoMergeOnComplete: boolean;
        tasksByItemKey: Map<
          string,
          {
            itemType: "execution_task" | "sub_plan";
            autoMerge: boolean;
            autoStart: boolean;
            autoMergeOnComplete: boolean;
          }
        >;
      }
    | undefined;
  try {
    const parsedRevision = parsePlanOutput(latestRevision.raw_output);
    parsedRevisionDefaults = {
      autoStart: parsedRevision.autoStart,
      autoMergeOnComplete: parsedRevision.autoMergeOnComplete,
      tasksByItemKey: new Map(
        parsedRevision.tasks.map((task) => [
          task.itemKey.toLowerCase(),
          {
            itemType: task.itemType,
            autoMerge: task.autoMerge,
            autoStart: task.autoStart,
            autoMergeOnComplete: task.autoMergeOnComplete
          }
        ])
      )
    };
  } catch {
    // Fallback to revision rows only when stored raw_output is not parseable.
  }
  const defaultSubPlanAutoStart = parsed.data.autoStart ?? parsedRevisionDefaults?.autoStart ?? false;
  const defaultSubPlanAutoMergeOnComplete =
    parsed.data.autoMergeOnComplete ?? parsedRevisionDefaults?.autoMergeOnComplete ?? false;
  const defaultSubPlanParentPlanTaskId = parsed.data.parentPlanTaskId === undefined ? plan.id : parsed.data.parentPlanTaskId;
  const defaultExecutionAutoMerge = Boolean(plan.auto_start);
  for (const row of depRows) {
    if (!itemIdToDeps.has(row.revision_item_id)) {
      itemIdToDeps.set(row.revision_item_id, []);
    }
    itemIdToDeps.get(row.revision_item_id)?.push(row.depends_on_item_key);
  }

  const itemKeyToTaskId = new Map<string, string>();
  const taskRows: Array<{
    item: PlanRevisionItemRow;
    taskId: string;
    workspacePath: string;
    dependencyTaskIds: string[];
    mode: "execution" | "plan";
    parentPlanTaskId: string | null;
    autoStart: boolean;
    autoMergeOnComplete: boolean;
    autoMerge: boolean;
    sourcePath: string;
    sourceBranch: string;
    baseCommitShaAtCreate: string;
  }> = [];

  for (const item of items) {
    const taskId = makeId();
    const edit = taskEditsByItemKey.get(item.item_key.toLowerCase());
    const parsedRevisionItem = parsedRevisionDefaults?.tasksByItemKey.get(item.item_key.toLowerCase());
    const itemType = edit?.itemType ?? parsedRevisionItem?.itemType ?? item.item_type;
    const mode = itemType === "sub_plan" ? "plan" : "execution";
    const autoMerge = mode === "execution"
      && (
        autoMergeItemKeys.has(item.item_key.toLowerCase())
        || Boolean(parsedRevisionItem?.autoMerge)
        || defaultExecutionAutoMerge
      );
    const autoStart = mode === "plan" ? (edit?.autoStart ?? parsedRevisionItem?.autoStart ?? defaultSubPlanAutoStart) : false;
    const autoMergeOnComplete =
      mode === "plan"
        ? (edit?.autoMergeOnComplete ?? parsedRevisionItem?.autoMergeOnComplete ?? defaultSubPlanAutoMergeOnComplete)
        : false;
    const parentPlanTaskId =
      mode === "plan"
        ? (edit?.parentPlanTaskId === undefined ? defaultSubPlanParentPlanTaskId : edit.parentPlanTaskId)
        : plan.id;
    let sourcePath = plan.workspace_path;
    let sourceBranch = taskBranchName(plan.id);
    if (parentPlanTaskId && parentPlanTaskId !== plan.id) {
      const targetParentPlan = planTaskInProject(projectDb, project.id, parentPlanTaskId);
      if (!targetParentPlan) {
        res.status(400).json({ error: `Invalid parent plan target for item ${item.item_key}` });
        return;
      }
      sourcePath = targetParentPlan.workspace_path;
      sourceBranch = taskBranchName(targetParentPlan.id);
    } else if (!parentPlanTaskId) {
      sourcePath = project.base_path;
      sourceBranch = project.default_branch;
    }

    itemKeyToTaskId.set(item.item_key.toLowerCase(), taskId);
    taskRows.push({
      item,
      taskId,
      workspacePath: path.join(path.dirname(project.base_path), "tasks", taskId),
      dependencyTaskIds: [],
      mode,
      parentPlanTaskId,
      autoStart,
      autoMergeOnComplete,
      autoMerge,
      sourcePath,
      sourceBranch,
      baseCommitShaAtCreate: ""
    });
  }

  for (const row of taskRows) {
    const depKeys = itemIdToDeps.get(row.item.id) ?? [];
    row.dependencyTaskIds = depKeys.map((depKey) => {
      const depTaskId = itemKeyToTaskId.get(depKey.toLowerCase());
      if (!depTaskId) {
        throw new Error(`Revision contains unknown dependency: ${depKey}`);
      }
      return depTaskId;
    });
  }

  try {
    for (const row of taskRows) {
      row.baseCommitShaAtCreate = await getHeadCommitSha(row.sourcePath);
      if (row.dependencyTaskIds.length > 0) continue;
      await cloneLocalBaseToWorkspace({
        basePath: row.sourcePath,
        baseBranch: row.sourceBranch,
        workspacePath: row.workspacePath
      });
      await createTaskBranch(row.workspacePath, row.taskId);
      if (row.mode === "plan") {
        await fs.promises.mkdir(path.join(row.workspacePath, ".ai-plan"), { recursive: true });
      }
    }
  } catch (error: any) {
    res.status(500).json({ error: String(error?.message ?? "Failed to initialize plan task workspaces") });
    return;
  }

  const createdAt = nowIso();

  projectDb.transaction(() => {
    projectDb.prepare("UPDATE plan_revisions SET status = 'approved', approved_at = ? WHERE id = ?").run(createdAt, latestRevision.id);

    for (const row of taskRows) {
      const edit = taskEditsByItemKey.get(row.item.item_key.toLowerCase());
      const title = edit?.title.trim() || row.item.title;
      const description = edit?.description.trim() || row.item.prompt;
      const prompt = edit?.prompt?.trim() ?? "";
      const basePrompt = [description, prompt].filter(Boolean).join("\n\n");
      const taskPrompt = row.mode === "plan" ? buildPlanTaskPrompt(basePrompt) : basePrompt;
      const aiCommand = resolveAiCommand(edit?.aiCommand?.trim() || undefined, req.user.id);

      projectDb.prepare(
        `INSERT INTO tasks (
          id, project_id, title, task_prompt, result, effective_prompt, ai_command,
          auto_merge, auto_start, auto_merge_on_complete,
          mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
          status, workspace_path, base_commit_sha_at_create, head_commit_sha,
          cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
      ).run(
        row.taskId,
        project.id,
        title,
        taskPrompt,
        buildEffectivePrompt(project, taskPrompt),
        aiCommand,
        row.autoMerge ? 1 : 0,
        row.autoStart ? 1 : 0,
        row.autoMergeOnComplete ? 1 : 0,
        row.mode,
        row.parentPlanTaskId,
        latestRevision.id,
        row.item.item_key,
        row.workspacePath,
        row.baseCommitShaAtCreate,
        req.user.id,
        createdAt,
        createdAt
      );

      projectDb.prepare(
        `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        makeId(),
        row.taskId,
        "null",
        "queued",
        row.dependencyTaskIds.length ? "task_created_from_plan_blocked" : "task_created_from_plan",
        req.user.id,
        createdAt
      );

      for (const dependencyTaskId of row.dependencyTaskIds) {
        projectDb.prepare(
          "INSERT INTO task_dependencies (task_id, dependency_task_id, created_at) VALUES (?, ?, ?)"
        ).run(row.taskId, dependencyTaskId, createdAt);
      }
    }
  })();

  recordEvent({
    projectId: project.id,
    taskId: plan.id,
    eventType: "plan.approved",
    database: projectDb,
    payload: {
      revisionId: latestRevision.id,
      tasksCreated: taskRows.length
    }
  });

  kickTaskQueueProcessing();

  const approvedTasks = projectDb
    .prepare("SELECT * FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
    .all(plan.id) as TaskRow[];

  res.json({ approvedTasks: approvedTasks.map((task) => serializeTask(projectDb, task)) });
});
