import { createHash } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { makeId } from "../../../utils/id.js";
import { nowIso } from "../../../utils/time.js";
import type { NodeMetadata, TaskRow } from "../../../types.js";
import { recordEvent } from "../../events.js";
import { buildDependencyDiagnostics } from "../dependencyGraph.js";
import { registerOrchestrationJobHandler } from "../jobQueue.js";
import { readNodeMetadata, writeNodeMetadata } from "../metadata.js";
import { digestStable, readReplanControl, writeReplanControl } from "../idempotency.js";
import { runEvaluateReadinessForTask } from "./evaluateReadiness.js";

type GapCandidate = {
  hash: string;
  reason: string;
  blockerTaskId?: string;
};

let deltaPlanHandlerRegistered = false;

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

function readChildren(projectDb: Database.Database, parentTaskId: string): TaskRow[] {
  return projectDb
    .prepare("SELECT * FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
    .all(parentTaskId) as TaskRow[];
}

function deterministicChildId(parentId: string, gapHash: string): string {
  const digest = createHash("sha256").update(`${parentId}|${gapHash}|delta`).digest("hex");
  return `delta_${digest.slice(0, 18)}`;
}

function toGapCandidates(params: { task: TaskRow; projectDb: Database.Database; metadata: NodeMetadata }): GapCandidate[] {
  const diagnostics = buildDependencyDiagnostics({ projectDb: params.projectDb, task: params.task });
  const unresolved = diagnostics.unresolved.map((blocker) => {
    const payload = {
      kind: "dependency",
      blockerId: blocker.id,
      blockerStatus: blocker.status ?? "unknown",
      reason: blocker.reason ?? "dependency_unresolved"
    };
    return {
      hash: digestStable(payload),
      reason: String(payload.reason),
      blockerTaskId: blocker.id
    };
  });

  const failedChildren = readChildren(params.projectDb, params.task.id)
    .filter((child) => child.status === "failed" || child.status === "merge_conflict" || child.status === "cancelled")
    .map((child) => ({
      hash: digestStable({ kind: "failed_child", childId: child.id, status: child.status }),
      reason: `recover_child:${child.id}`,
      blockerTaskId: child.id
    }));

  return [...unresolved, ...failedChildren];
}

function insertGapClosingChild(params: {
  projectDb: Database.Database;
  parent: TaskRow;
  gap: GapCandidate;
}): string | null {
  if (params.parent.mode !== "plan") return null;

  const childId = deterministicChildId(params.parent.id, params.gap.hash);
  const existing = readTask(params.projectDb, childId);
  if (existing) return childId;

  const now = nowIso();
  const workspacePath = path.join(path.dirname(params.parent.workspace_path), "tasks", childId);
  const childPrompt = [
    `Close the identified planning gap for parent node ${params.parent.id}.`,
    `Gap hash: ${params.gap.hash}`,
    `Gap reason: ${params.gap.reason}`
  ].join("\n");
  const childMetadata: NodeMetadata = {
    schema_version: 1,
    tier: "exec",
    orchestration: {
      auto_merge: false,
      auto_start: false,
      auto_merge_on_complete: false
    },
    dependencies: {
      same_tier: params.gap.blockerTaskId
        ? [{ id: params.gap.blockerTaskId, tier: "exec", reason: "delta_gap_blocker" }]
        : undefined,
      cross_tier: [{ id: params.parent.id, tier: "plan", reason: "delta_plan_parent" }]
    }
  };

  params.projectDb.transaction(() => {
    params.projectDb.prepare(
      `INSERT INTO tasks (
        id, project_id, title, task_prompt, result, effective_prompt, ai_command,
        auto_merge, auto_start, auto_merge_on_complete, metadata_json,
        mode, parent_plan_task_id, source_plan_revision_id, source_plan_item_key,
        status, workspace_path, base_commit_sha_at_create, head_commit_sha,
        cancel_reason, merged_at, merged_by_user_id, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', ?, ?, 0, 0, 0, ?, 'execution', ?, NULL, NULL, 'queued', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
    ).run(
      childId,
      params.parent.project_id,
      `Delta gap ${params.gap.hash.slice(0, 8)}`,
      childPrompt,
      childPrompt,
      params.parent.ai_command,
      JSON.stringify(childMetadata),
      params.parent.id,
      workspacePath,
      params.parent.head_commit_sha ?? params.parent.base_commit_sha_at_create,
      params.parent.created_by_user_id,
      now,
      now
    );
    params.projectDb.prepare(
      `INSERT INTO task_state_transitions (id, task_id, from_status, to_status, reason, actor_user_id, created_at)
       VALUES (?, ?, 'null', 'queued', ?, NULL, ?)`
    ).run(makeId(), childId, "delta_plan_created", now);
    if (params.gap.blockerTaskId) {
      params.projectDb
        .prepare("INSERT INTO task_dependencies (task_id, dependency_task_id, created_at) VALUES (?, ?, ?)")
        .run(childId, params.gap.blockerTaskId, now);
    }
  })();

  recordEvent({
    projectId: params.parent.project_id,
    taskId: childId,
    eventType: "task.created",
    payload: {
      title: `Delta gap ${params.gap.hash.slice(0, 8)}`,
      parentTaskId: params.parent.id,
      source: "orchestration.delta_plan",
      gapHash: params.gap.hash
    },
    database: params.projectDb
  });
  return childId;
}

export async function runDeltaPlanForTask(params: {
  projectDb: Database.Database;
  taskId: string;
  sourceEventId?: string | null;
}): Promise<{ taskId: string; createdChildIds: string[]; budgetExceeded: boolean } | null> {
  const task = readTask(params.projectDb, params.taskId);
  if (!task) return null;

  const metadataRead = readNodeMetadata({
    projectDb: params.projectDb,
    task,
    dependencyTaskIds: readDependencyIds(params.projectDb, task.id)
  });
  const metadata = metadataRead.metadata;
  const replan = readReplanControl(metadata);
  const gapCandidates = toGapCandidates({ task, projectDb: params.projectDb, metadata });
  const netNewGaps = gapCandidates.filter((gap) => !replan.gapHashesSeen.includes(gap.hash));
  const currentChildren = readChildren(params.projectDb, task.id).map((child) => `${child.id}:${child.status}`);
  const decompositionFingerprint = digestStable({
    parent: task.id,
    children: currentChildren.sort(),
    netNewGapHashes: netNewGaps.map((gap) => gap.hash).sort()
  });

  if (netNewGaps.length === 0) {
    const nextMetadata = writeReplanControl({
      metadata,
      iterationsUsed: replan.iterationsUsed,
      gapHashesSeen: replan.gapHashesSeen,
      decompositionFingerprint
    });
    writeNodeMetadata({
      projectDb: params.projectDb,
      taskId: task.id,
      metadata: nextMetadata
    });
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      eventType: "orchestration.delta_plan.noop",
      payload: {
        schema_version: 1,
        sourceEventId: params.sourceEventId ?? null,
        reason: "no_net_new_gaps",
        decomposition_fingerprint: decompositionFingerprint
      },
      database: params.projectDb
    });
    return { taskId: task.id, createdChildIds: [], budgetExceeded: false };
  }

  if (replan.iterationsUsed >= replan.maxIterations && !replan.budgetOverride) {
    const nextMetadata = writeReplanControl({
      metadata,
      iterationsUsed: replan.iterationsUsed,
      gapHashesSeen: replan.gapHashesSeen,
      decompositionFingerprint,
      latestGapHash: netNewGaps[0]?.hash
    });
    writeNodeMetadata({
      projectDb: params.projectDb,
      taskId: task.id,
      metadata: nextMetadata
    });
    recordEvent({
      projectId: task.project_id,
      taskId: task.id,
      eventType: "orchestration.delta_plan.budget_exhausted",
      payload: {
        schema_version: 1,
        sourceEventId: params.sourceEventId ?? null,
        max_replans: replan.maxIterations,
        iterations_used: replan.iterationsUsed
      },
      database: params.projectDb
    });
    return { taskId: task.id, createdChildIds: [], budgetExceeded: true };
  }

  const createdChildIds = netNewGaps
    .map((gap) => insertGapClosingChild({ projectDb: params.projectDb, parent: task, gap }))
    .filter((id): id is string => Boolean(id));
  const nextGapHashesSeen = [...new Set([...replan.gapHashesSeen, ...netNewGaps.map((gap) => gap.hash)])];
  const nextMetadata = writeReplanControl({
    metadata,
    iterationsUsed: replan.iterationsUsed + (createdChildIds.length > 0 ? 1 : 0),
    gapHashesSeen: nextGapHashesSeen,
    decompositionFingerprint,
    latestGapHash: netNewGaps[0]?.hash
  });
  writeNodeMetadata({
    projectDb: params.projectDb,
    taskId: task.id,
    metadata: nextMetadata
  });

  recordEvent({
    projectId: task.project_id,
    taskId: task.id,
    eventType: "orchestration.delta_plan.completed",
    payload: {
      schema_version: 1,
      sourceEventId: params.sourceEventId ?? null,
      parentTaskId: task.id,
      createdChildIds,
      gap_hashes: netNewGaps.map((gap) => gap.hash),
      decomposition_fingerprint: decompositionFingerprint,
      iterations_used: replan.iterationsUsed + (createdChildIds.length > 0 ? 1 : 0)
    },
    database: params.projectDb
  });

  await runEvaluateReadinessForTask({
    projectDb: params.projectDb,
    taskId: task.id,
    sourceEventId: params.sourceEventId ?? null
  });

  return {
    taskId: task.id,
    createdChildIds,
    budgetExceeded: false
  };
}

export function startDeltaPlanJobWorker(): void {
  if (deltaPlanHandlerRegistered) return;
  registerOrchestrationJobHandler("delta_plan", async (context) => {
    const taskId = context.payload.hintTaskId ?? null;
    if (!taskId) return;
    await runDeltaPlanForTask({
      projectDb: context.projectDb,
      taskId,
      sourceEventId: typeof context.payload.metadata?.sourceEventId === "string" ? context.payload.metadata.sourceEventId : null
    });
  });
  deltaPlanHandlerRegistered = true;
}

