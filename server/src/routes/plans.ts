import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { recordEvent } from "../services/events.js";
import { buildEffectivePrompt } from "../services/promptBuilder.js";
import { parsePlanOutput } from "../services/planParser.js";
import { kickTaskQueueProcessing } from "../services/queue.js";
import { cloneLocalBaseToWorkspace, createTaskBranch, getHeadCommitSha } from "../services/git.js";
import { sendTaskRuntimeInput } from "../services/runtime.js";
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
  aiCommand: z.string().min(1).max(500).optional()
});

const regenerateSchema = z.object({
  feedback: z.string().min(1).max(12000)
});

const PLAN_OUTPUT_RELATIVE_PATH = ".ai-plan/latest-plan.yaml";

function planningFormatInstructions(): string {
  return [
    "Planner Output Contract:",
    "Return the final plan as YAML only.",
    "Wrap YAML in a fenced block using ```yaml.",
    "Top-level key must be `tasks:`.",
    "Each task entry must include:",
    "- id: unique task identifier",
    "- title: short task title",
    "- prompt: implementation prompt for that task",
    "- depends_on: list of task ids (optional)",
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

function readPlanOutputSource(plan: TaskRow): { raw: string; source: "file" | "session_output"; filePath: string } {
  const filePath = planOutputFilePath(plan.workspace_path);
  try {
    const fileValue = fs.readFileSync(filePath, "utf8").trim();
    if (fileValue) {
      return { raw: fileValue, source: "file", filePath };
    }
  } catch {
    // Fall through to session output.
  }

  const raw = getLatestSessionOutput(plan.id);
  return { raw, source: "session_output", filePath };
}

function projectForUser(projectId: string, userId: string): ProjectRow | undefined {
  return db
    .prepare(
      `SELECT p.*
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE p.id = ? AND pm.user_id = ?`
    )
    .get(projectId, userId) as ProjectRow | undefined;
}

function planForUser(planTaskId: string, userId: string): TaskRow | undefined {
  return db
    .prepare(
      `SELECT t.*
       FROM tasks t
       JOIN project_members pm ON pm.project_id = t.project_id
       WHERE t.id = ? AND pm.user_id = ? AND t.mode = 'plan'`
    )
    .get(planTaskId, userId) as TaskRow | undefined;
}

function serializeTask(task: TaskRow) {
  const dependencyTaskIds = db
    .prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
    .all(task.id) as Array<{ dependency_task_id: string }>;
  const blockedByTaskIds = db
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
    effectivePrompt: task.effective_prompt,
    aiCommand: task.ai_command,
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
  const settings = db
    .prepare("SELECT default_ai_command FROM user_settings WHERE user_id = ?")
    .get(userId) as { default_ai_command: string } | undefined;
  return settings?.default_ai_command || "codex --yolo {prompt}";
}

function nextRevisionNumber(planTaskId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(revision_number), 0) AS max_number FROM plan_revisions WHERE plan_task_id = ?")
    .get(planTaskId) as { max_number: number };
  return Number(row.max_number) + 1;
}

function getLatestSessionOutput(taskId: string): string {
  const row = db
    .prepare("SELECT last_output FROM task_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(taskId) as { last_output: string } | undefined;
  return (row?.last_output ?? "").trim();
}

export const plansRouter = Router();

plansRouter.post("/projects/:projectId/plans", async (req, res) => {
  const parsed = createPlanSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const project = projectForUser(req.params.projectId, req.user.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

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

  let baseCommitSha: string;
  try {
    baseCommitSha = await getHeadCommitSha(project.base_path);
    await cloneLocalBaseToWorkspace({ basePath: project.base_path, workspacePath });
    await createTaskBranch(workspacePath, id);
    await fs.promises.mkdir(path.join(workspacePath, ".ai-plan"), { recursive: true });
  } catch (error: any) {
    const message = String(error?.message ?? "Failed to initialize plan workspace");
    res.status(500).json({ error: message });
    return;
  }

  db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (
        id, project_id, title, task_prompt, effective_prompt, ai_command,
        mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
        status, workspace_path, base_commit_sha_at_create, head_commit_sha,
        cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'plan', NULL, NULL, NULL, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
    ).run(id, project.id, input.title, plannerPrompt, effectivePrompt, aiCommand, workspacePath, baseCommitSha, req.user.id, now, now);

    db.prepare(
      `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(makeId(), id, "null", "queued", "plan_created", req.user.id, now);
  })();

  recordEvent({
    projectId: project.id,
    taskId: id,
    eventType: "plan.created",
    payload: {
      title: input.title,
      aiCommand,
      workspacePath,
      baseCommitShaAtCreate: baseCommitSha
    }
  });

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
  kickTaskQueueProcessing();
  res.status(201).json({ plan: serializeTask(task) });
});

plansRouter.get("/plans/:planId", (req, res) => {
  const plan = planForUser(req.params.planId, req.user.id);
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  const transitions = db
    .prepare("SELECT * FROM task_state_transitions WHERE task_id = ? ORDER BY created_at ASC")
    .all(plan.id) as TaskTransitionRow[];

  const revisions = db
    .prepare("SELECT * FROM plan_revisions WHERE plan_task_id = ? ORDER BY revision_number DESC")
    .all(plan.id) as PlanRevisionRow[];

  const revisionItems = revisions.length
    ? (db
        .prepare(
          `SELECT *
           FROM plan_revision_items
           WHERE revision_id IN (${revisions.map(() => "?").join(",")})
           ORDER BY ordinal ASC`
        )
        .all(...revisions.map((row) => row.id)) as PlanRevisionItemRow[])
    : [];

  const dependencies = revisionItems.length
    ? (db
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
      title: item.title,
      prompt: item.prompt,
      ordinal: item.ordinal,
      dependsOnItemKeys
    });
  }

  const approvedTasks = db
    .prepare("SELECT * FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
    .all(plan.id) as TaskRow[];

  res.json({
    plan: serializeTask(plan),
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
    approvedTasks: approvedTasks.map(serializeTask)
  });
});

plansRouter.post("/plans/:planId/extract", (req, res) => {
  const plan = planForUser(req.params.planId, req.user.id);
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  const source = readPlanOutputSource(plan);
  if (!source.raw) {
    res.status(409).json({ error: "No plan output available. Generate plan YAML first." });
    return;
  }

  const revisionId = makeId();
  const revisionNumber = nextRevisionNumber(plan.id);
  const createdAt = nowIso();

  try {
    const parsed = parsePlanOutput(source.raw);
    fs.mkdirSync(path.dirname(source.filePath), { recursive: true });
    fs.writeFileSync(source.filePath, `${parsed.yamlText.trim()}\n`, "utf8");

    db.transaction(() => {
      db.prepare("UPDATE plan_revisions SET status = 'superseded' WHERE plan_task_id = ? AND status = 'proposed'").run(plan.id);

      db.prepare(
        `INSERT INTO plan_revisions (
          id, plan_task_id, revision_number, status, feedback, raw_output, parse_error, created_by_user_id, created_at, approved_at
         ) VALUES (?, ?, ?, 'proposed', NULL, ?, NULL, ?, ?, NULL)`
      ).run(revisionId, plan.id, revisionNumber, parsed.yamlText, req.user.id, createdAt);

      for (let i = 0; i < parsed.tasks.length; i += 1) {
        const task = parsed.tasks[i];
        const itemId = makeId();
        db.prepare(
          `INSERT INTO plan_revision_items (id, revision_id, item_key, title, prompt, ordinal, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(itemId, revisionId, task.itemKey, task.title, task.prompt, i + 1, createdAt);

        for (const dep of task.dependsOnItemKeys) {
          db.prepare(
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
      payload: { revisionId, revisionNumber, items: parsed.tasks.length, source: source.source, planFile: source.filePath }
    });

    res.json({ ok: true, revisionId, revisionNumber, tasksExtracted: parsed.tasks.length, source: source.source, planFile: source.filePath });
  } catch (error: any) {
    const parseError = String(error?.message ?? "Failed to parse plan output");
    db.prepare(
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

  const plan = planForUser(req.params.planId, req.user.id);
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  const feedback = parsed.data.feedback.trim();
  const revisionId = makeId();
  const revisionNumber = nextRevisionNumber(plan.id);
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
    await sendTaskRuntimeInput(plan.id, req.user.id, guidance);
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message ?? "Plan runtime is not ready for feedback") });
    return;
  }

  db.prepare(
    `INSERT INTO plan_revisions (
      id, plan_task_id, revision_number, status, feedback, raw_output, parse_error, created_by_user_id, created_at, approved_at
     ) VALUES (?, ?, ?, 'feedback_requested', ?, '', NULL, ?, ?, NULL)`
  ).run(revisionId, plan.id, revisionNumber, feedback, req.user.id, createdAt);

  recordEvent({
    projectId: plan.project_id,
    taskId: plan.id,
    eventType: "plan.revision.feedback_requested",
    payload: { revisionId, revisionNumber }
  });

  res.json({ ok: true, revisionId, revisionNumber });
});

plansRouter.post("/plans/:planId/approve", async (req, res) => {
  const plan = planForUser(req.params.planId, req.user.id);
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  const latestRevision = db
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

  const alreadyApproved = db
    .prepare(
      "SELECT id FROM tasks WHERE source_plan_revision_id = ? AND parent_plan_task_id = ? LIMIT 1"
    )
    .get(latestRevision.id, plan.id) as { id: string } | undefined;

  if (alreadyApproved) {
    const approvedTasks = db
      .prepare("SELECT * FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
      .all(plan.id) as TaskRow[];
    res.json({ approvedTasks: approvedTasks.map(serializeTask) });
    return;
  }

  const project = projectForUser(plan.project_id, req.user.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const items = db
    .prepare("SELECT * FROM plan_revision_items WHERE revision_id = ? ORDER BY ordinal ASC")
    .all(latestRevision.id) as PlanRevisionItemRow[];

  if (!items.length) {
    res.status(409).json({ error: "Latest revision has no tasks" });
    return;
  }

  const depRows = db
    .prepare(
      `SELECT d.*
       FROM plan_revision_item_dependencies d
       JOIN plan_revision_items i ON i.id = d.revision_item_id
       WHERE i.revision_id = ?`
    )
    .all(latestRevision.id) as PlanRevisionItemDependencyRow[];

  const itemIdToDeps = new Map<string, string[]>();
  for (const row of depRows) {
    if (!itemIdToDeps.has(row.revision_item_id)) {
      itemIdToDeps.set(row.revision_item_id, []);
    }
    itemIdToDeps.get(row.revision_item_id)?.push(row.depends_on_item_key);
  }

  const itemKeyToTaskId = new Map<string, string>();
  const taskRows: Array<{ item: PlanRevisionItemRow; taskId: string; workspacePath: string; dependencyTaskIds: string[] }> = [];

  for (const item of items) {
    const taskId = makeId();
    itemKeyToTaskId.set(item.item_key.toLowerCase(), taskId);
    taskRows.push({
      item,
      taskId,
      workspacePath: path.join(path.dirname(project.base_path), "tasks", taskId),
      dependencyTaskIds: []
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

  let baseCommitSha: string;
  try {
    baseCommitSha = await getHeadCommitSha(project.base_path);

    for (const row of taskRows) {
      if (row.dependencyTaskIds.length > 0) continue;
      await cloneLocalBaseToWorkspace({ basePath: project.base_path, workspacePath: row.workspacePath });
      await createTaskBranch(row.workspacePath, row.taskId);
    }
  } catch (error: any) {
    res.status(500).json({ error: String(error?.message ?? "Failed to initialize plan task workspaces") });
    return;
  }

  const createdAt = nowIso();

  db.transaction(() => {
    db.prepare("UPDATE plan_revisions SET status = 'approved', approved_at = ? WHERE id = ?").run(createdAt, latestRevision.id);

    for (const row of taskRows) {
      db.prepare(
        `INSERT INTO tasks (
          id, project_id, title, task_prompt, effective_prompt, ai_command,
          mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
          status, workspace_path, base_commit_sha_at_create, head_commit_sha,
          cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'execution', ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
      ).run(
        row.taskId,
        project.id,
        row.item.title,
        row.item.prompt,
        buildEffectivePrompt(project, row.item.prompt),
        resolveAiCommand(undefined, req.user.id),
        plan.id,
        latestRevision.id,
        row.item.item_key,
        row.workspacePath,
        baseCommitSha,
        req.user.id,
        createdAt,
        createdAt
      );

      db.prepare(
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
        db.prepare(
          "INSERT INTO task_dependencies (task_id, dependency_task_id, created_at) VALUES (?, ?, ?)"
        ).run(row.taskId, dependencyTaskId, createdAt);
      }
    }
  })();

  recordEvent({
    projectId: project.id,
    taskId: plan.id,
    eventType: "plan.approved",
    payload: {
      revisionId: latestRevision.id,
      tasksCreated: taskRows.length
    }
  });

  kickTaskQueueProcessing();

  const approvedTasks = db
    .prepare("SELECT * FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
    .all(plan.id) as TaskRow[];

  res.json({ approvedTasks: approvedTasks.map(serializeTask) });
});
