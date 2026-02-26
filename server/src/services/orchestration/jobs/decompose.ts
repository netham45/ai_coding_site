import { createHash } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { makeId } from "../../../utils/id.js";
import { nowIso } from "../../../utils/time.js";
import type { NodeTier, ProjectRow, TaskMode, TaskRow } from "../../../types.js";
import { buildTierOrchestrationPrompt } from "../../promptBuilder.js";
import { db as appDb } from "../../../db/index.js";
import { recordEvent } from "../../events.js";
import { registerOrchestrationJobHandler } from "../jobQueue.js";
import { buildInitialNodeMetadata, readNodeMetadata, serializeNodeMetadata } from "../metadata.js";
import { selectPromptTemplateByTier } from "../promptRuntime.js";
import { runEvaluateReadinessForTask } from "./evaluateReadiness.js";

const nextTierByTier: Record<NodeTier, NodeTier | null> = {
  epoch: "phase",
  phase: "plan",
  plan: "task",
  task: "exec",
  exec: null
};

let decomposeHandlerRegistered = false;

function readTask(projectDb: Database.Database, taskId: string): TaskRow | undefined {
  return projectDb.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
}

function readDependencyIds(projectDb: Database.Database, taskId: string): string[] {
  return (
    projectDb
      .prepare("SELECT dependency_task_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Array<{ dependency_task_id: string }>
  ).map((row) => row.dependency_task_id);
}

function modeForTier(tier: NodeTier): TaskMode {
  return tier === "plan" || tier === "phase" || tier === "epoch" ? "plan" : "execution";
}

function deterministicChildId(parentId: string, tier: NodeTier): string {
  const hash = createHash("sha256").update(`${parentId}|${tier}|auto`).digest("hex");
  return `auto_${tier}_${hash.slice(0, 18)}`;
}

function projectWithConfig(projectId: string, projectDb: Database.Database): ProjectRow | undefined {
  const project = appDb
    .prepare(
      `SELECT
         id, name, slug, repo_url, default_branch, base_path,
         clone_status, clone_error, created_by_user_id, created_at, updated_at
       FROM projects
       WHERE id = ?`
    )
    .get(projectId) as
    | {
        id: string;
        name: string;
        slug: string;
        repo_url: string;
        default_branch: string;
        base_path: string;
        clone_status: ProjectRow["clone_status"];
        clone_error: string | null;
        created_by_user_id: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!project) return undefined;
  const config = projectDb
    .prepare(
      `SELECT
         project_prompt,
         project_rules,
         coding_standard,
         coding_standard_other,
         project_other
       FROM project_config
       WHERE project_id = ?`
    )
    .get(projectId) as
    | {
        project_prompt: string;
        project_rules: string;
        coding_standard: string;
        coding_standard_other: string;
        project_other: string;
      }
    | undefined;
  return {
    ...project,
    project_prompt: config?.project_prompt ?? "",
    project_rules: config?.project_rules ?? "",
    coding_standard: config?.coding_standard ?? "",
    coding_standard_other: config?.coding_standard_other ?? "",
    project_other: config?.project_other ?? ""
  };
}

function childWithTier(projectDb: Database.Database, parentTaskId: string, tier: NodeTier): TaskRow | undefined {
  const children = projectDb
    .prepare("SELECT * FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
    .all(parentTaskId) as TaskRow[];
  for (const child of children) {
    const metadata = readNodeMetadata({
      projectDb,
      task: child,
      dependencyTaskIds: readDependencyIds(projectDb, child.id)
    }).metadata;
    if (metadata.tier === tier) {
      return child;
    }
  }
  return undefined;
}

function insertChildNode(params: {
  projectDb: Database.Database;
  parent: TaskRow;
  parentTier: NodeTier;
  childTier: NodeTier;
  autoMode: boolean;
}): TaskRow {
  const project = projectWithConfig(params.parent.project_id, params.projectDb);
  if (!project) {
    throw new Error("Project not found for decomposition");
  }
  const childId = deterministicChildId(params.parent.id, params.childTier);
  const existing = readTask(params.projectDb, childId);
  if (existing) return existing;

  const childMode = modeForTier(params.childTier);
  const templates = selectPromptTemplateByTier({
    tier: params.childTier,
    job: params.childTier === "exec" ? "evaluate_readiness" : "decompose"
  });

  const childPrompt = buildTierOrchestrationPrompt({
    tier: params.childTier,
    action: "decompose",
    nodeId: childId,
    nodeTitle: `Auto ${params.childTier}: ${params.parent.title}`,
    nodePrompt: params.parent.task_prompt,
    autoMode: params.autoMode,
    tierTemplatePath: templates.tierTemplatePath,
    tierTemplate: templates.tierTemplate,
    coordinatorTemplatePath: templates.coordinatorTemplatePath,
    coordinatorTemplate: templates.coordinatorTemplate
  });

  const workspacePath = path.join(path.dirname(params.parent.workspace_path), "tasks", childId);
  const createdAt = nowIso();
  const metadataJson = serializeNodeMetadata(
    buildInitialNodeMetadata({
      task: {
        id: childId,
        project_id: params.parent.project_id,
        mode: childMode,
        metadata_json: null,
        auto_merge: 0,
        auto_start: params.autoMode ? 1 : 0,
        auto_merge_on_complete: 0,
        parent_plan_task_id: params.parent.id,
        source_plan_revision_id: null,
        source_plan_item_key: null
      },
      dependencyTaskIds: [],
      tier: params.childTier,
      crossTierDependencies: [{ id: params.parent.id, tier: params.parentTier, reason: "auto_decompose_parent" }]
    })
  );

  params.projectDb.transaction(() => {
    params.projectDb.prepare(
      `INSERT INTO tasks (
        id, project_id, title, task_prompt, result, effective_prompt, ai_command,
        auto_merge, auto_start, auto_merge_on_complete, metadata_json,
        mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
        status, workspace_path, base_commit_sha_at_create, head_commit_sha,
        cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', ?, ?, 0, ?, 0, ?, ?, ?, NULL, NULL, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
    ).run(
      childId,
      params.parent.project_id,
      `Auto ${params.childTier}: ${params.parent.title}`,
      childPrompt,
      childPrompt,
      params.parent.ai_command,
      params.autoMode ? 1 : 0,
      metadataJson,
      childMode,
      params.parent.id,
      workspacePath,
      params.parent.head_commit_sha ?? params.parent.base_commit_sha_at_create,
      params.parent.created_by_user_id,
      createdAt,
      createdAt
    );
    params.projectDb.prepare(
      `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
       VALUES (?, ?, 'null', 'queued', ?, NULL, ?)`
    ).run(makeId(), childId, "auto_decompose_created", createdAt);
  })();

  const child = readTask(params.projectDb, childId);
  if (!child) {
    throw new Error("Child node creation failed");
  }

  recordEvent({
    projectId: child.project_id,
    taskId: child.id,
    eventType: child.mode === "plan" ? "plan.created" : "task.created",
    payload: {
      title: child.title,
      parentTaskId: params.parent.id,
      tier: params.childTier,
      autoMode: params.autoMode,
      source: "orchestration.decompose"
    },
    database: params.projectDb
  });

  return child;
}

export async function runDecomposeForTask(params: {
  projectDb: Database.Database;
  projectId: string;
  taskId: string;
  autoMode: boolean;
  sourceEventId?: string | null;
}): Promise<{ parentId: string; parentTier: NodeTier; childIds: string[] } | null> {
  const task = readTask(params.projectDb, params.taskId);
  if (!task) return null;

  const metadata = readNodeMetadata({
    projectDb: params.projectDb,
    task,
    dependencyTaskIds: readDependencyIds(params.projectDb, task.id)
  }).metadata;
  const currentTier = metadata.tier;
  const nextTier = nextTierByTier[currentTier];
  if (!nextTier) {
    await runEvaluateReadinessForTask({
      projectDb: params.projectDb,
      taskId: task.id,
      sourceEventId: params.sourceEventId ?? null
    });
    return { parentId: task.id, parentTier: currentTier, childIds: [] };
  }

  const child = childWithTier(params.projectDb, task.id, nextTier) ??
    insertChildNode({
      projectDb: params.projectDb,
      parent: task,
      parentTier: currentTier,
      childTier: nextTier,
      autoMode: params.autoMode
    });

  recordEvent({
    projectId: params.projectId,
    taskId: task.id,
    eventType: "orchestration.decompose.completed",
    payload: {
      schema_version: 1,
      sourceEventId: params.sourceEventId ?? null,
      parent: { id: task.id, tier: currentTier },
      children: [{ id: child.id, tier: nextTier }],
      autoMode: params.autoMode
    },
    database: params.projectDb
  });

  await runEvaluateReadinessForTask({
    projectDb: params.projectDb,
    taskId: task.id,
    sourceEventId: params.sourceEventId ?? null
  });

  if (params.autoMode && nextTier !== "exec") {
    await runDecomposeForTask({
      projectDb: params.projectDb,
      projectId: params.projectId,
      taskId: child.id,
      autoMode: true,
      sourceEventId: params.sourceEventId ?? null
    });
  } else {
    await runEvaluateReadinessForTask({
      projectDb: params.projectDb,
      taskId: child.id,
      sourceEventId: params.sourceEventId ?? null
    });
  }

  return {
    parentId: task.id,
    parentTier: currentTier,
    childIds: [child.id]
  };
}

export function startDecomposeJobWorker(): void {
  if (decomposeHandlerRegistered) return;
  registerOrchestrationJobHandler("decompose", async (context) => {
    const taskId = context.payload.hintTaskId ?? null;
    if (!taskId) return;
    const autoMode = Boolean(context.payload.metadata?.autoMode ?? true);
    await runDecomposeForTask({
      projectDb: context.projectDb,
      projectId: context.projectId,
      taskId,
      autoMode,
      sourceEventId: typeof context.payload.metadata?.sourceEventId === "string" ? context.payload.metadata.sourceEventId : null
    });
  });
  decomposeHandlerRegistered = true;
}
