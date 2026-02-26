import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { NodeDependencyRef, NodeMetadata, NodeTier, TaskRow } from "../../types.js";
import { nowIso } from "../../utils/time.js";

type MetadataReadableTask = Pick<
  TaskRow,
  | "id"
  | "project_id"
  | "mode"
  | "metadata_json"
  | "auto_merge"
  | "auto_start"
  | "auto_merge_on_complete"
  | "parent_plan_task_id"
  | "source_plan_revision_id"
  | "source_plan_item_key"
>;

type MetadataSource = "task_row" | "events_fallback" | "generated_default";

type MetadataEventPayload = {
  metadata?: unknown;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null;
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

function isTier(value: unknown): value is NodeTier {
  return value === "epoch" || value === "phase" || value === "plan" || value === "task" || value === "exec";
}

function normalizeDependencyRefs(input: unknown): NodeDependencyRef[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: NodeDependencyRef[] = [];
  for (const row of input) {
    const entry = asObject(row);
    if (!entry || typeof entry.id !== "string" || !entry.id.trim()) continue;
    out.push({
      id: entry.id,
      tier: isTier(entry.tier) ? entry.tier : undefined,
      reason: typeof entry.reason === "string" ? entry.reason : undefined
    });
  }
  return out.length > 0 ? out : undefined;
}

function inferDefaultTier(task: MetadataReadableTask): NodeTier {
  if (task.mode === "plan") return "plan";
  if (task.source_plan_revision_id) return "exec";
  return "task";
}

function buildFingerprint(params: { taskId: string; tier: NodeTier; dependencyTaskIds: string[]; sourcePlanItemKey?: string | null }): string {
  const hash = createHash("sha256");
  const depKey = [...new Set(params.dependencyTaskIds)].sort().join(",");
  hash.update(params.taskId);
  hash.update("|");
  hash.update(params.tier);
  hash.update("|");
  hash.update(params.sourcePlanItemKey ?? "");
  hash.update("|");
  hash.update(depKey);
  return hash.digest("hex");
}

function normalizeMetadataShape(params: {
  task: MetadataReadableTask;
  dependencyTaskIds: string[];
  metadataObj: Record<string, unknown> | null;
}): NodeMetadata {
  const input = params.metadataObj;
  const orchestration = asObject(input?.orchestration);
  const budgets = asObject(input?.budgets);
  const idempotency = asObject(input?.idempotency);
  const deps = asObject(input?.dependencies);
  const tier = isTier(input?.tier) ? input.tier : inferDefaultTier(params.task);

  const sameTierFromMetadata = normalizeDependencyRefs(deps?.same_tier);
  const sameTierFallback =
    params.dependencyTaskIds.length > 0 ? params.dependencyTaskIds.map((id) => ({ id, tier: "task" as const })) : undefined;
  const sameTier = sameTierFromMetadata ?? sameTierFallback;

  const normalized: NodeMetadata = {
    schema_version: 1,
    tier,
    orchestration: {
      auto_merge:
        typeof orchestration?.auto_merge === "boolean" ? orchestration.auto_merge : Boolean(params.task.auto_merge),
      auto_start:
        typeof orchestration?.auto_start === "boolean" ? orchestration.auto_start : Boolean(params.task.auto_start),
      auto_merge_on_complete:
        typeof orchestration?.auto_merge_on_complete === "boolean"
          ? orchestration.auto_merge_on_complete
          : Boolean(params.task.auto_merge_on_complete),
      hints: Array.isArray(orchestration?.hints)
        ? orchestration.hints.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : undefined
    },
    budgets: {
      max_retries: typeof budgets?.max_retries === "number" ? budgets.max_retries : undefined,
      max_replans: typeof budgets?.max_replans === "number" ? budgets.max_replans : undefined,
      max_children: typeof budgets?.max_children === "number" ? budgets.max_children : undefined,
      token_budget: typeof budgets?.token_budget === "number" ? budgets.token_budget : undefined
    },
    idempotency: {
      fingerprint:
        typeof idempotency?.fingerprint === "string" && idempotency.fingerprint.trim().length > 0
          ? idempotency.fingerprint
          : buildFingerprint({
              taskId: params.task.id,
              tier,
              dependencyTaskIds: params.dependencyTaskIds,
              sourcePlanItemKey: params.task.source_plan_item_key
            }),
      decomposition_fingerprint:
        typeof idempotency?.decomposition_fingerprint === "string" ? idempotency.decomposition_fingerprint : undefined,
      gap_hash: typeof idempotency?.gap_hash === "string" ? idempotency.gap_hash : undefined
    },
    dependencies: {
      same_tier: sameTier,
      cross_tier: normalizeDependencyRefs(deps?.cross_tier)
    },
    custom: asObject(input?.custom) ?? undefined
  };

  return normalized;
}

function readLatestMetadataEvent(projectDb: Database.Database, taskId: string): Record<string, unknown> | null {
  const eventRow = projectDb
    .prepare(
      `SELECT payload
       FROM events
       WHERE task_id = ? AND event_type = 'task.metadata.updated'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(taskId) as { payload: string } | undefined;
  if (!eventRow?.payload) return null;
  const eventPayload = parseJsonObject(eventRow.payload) as MetadataEventPayload | null;
  return asObject(eventPayload?.metadata);
}

export function readNodeMetadata(params: {
  projectDb: Database.Database;
  task: MetadataReadableTask;
  dependencyTaskIds?: string[];
}): { metadata: NodeMetadata; source: MetadataSource } {
  const deps = params.dependencyTaskIds ?? [];
  const taskMetadata = parseJsonObject(params.task.metadata_json);
  if (taskMetadata) {
    return {
      metadata: normalizeMetadataShape({ task: params.task, dependencyTaskIds: deps, metadataObj: taskMetadata }),
      source: "task_row"
    };
  }

  const eventMetadata = readLatestMetadataEvent(params.projectDb, params.task.id);
  if (eventMetadata) {
    return {
      metadata: normalizeMetadataShape({ task: params.task, dependencyTaskIds: deps, metadataObj: eventMetadata }),
      source: "events_fallback"
    };
  }

  return {
    metadata: normalizeMetadataShape({ task: params.task, dependencyTaskIds: deps, metadataObj: null }),
    source: "generated_default"
  };
}

export function buildInitialNodeMetadata(params: {
  task: MetadataReadableTask;
  dependencyTaskIds?: string[];
  tier?: NodeTier;
  sameTierDependencies?: NodeDependencyRef[];
  crossTierDependencies?: NodeDependencyRef[];
}): NodeMetadata {
  const base = normalizeMetadataShape({
    task: params.task,
    dependencyTaskIds: params.dependencyTaskIds ?? [],
    metadataObj: params.tier ? { tier: params.tier } : null
  });
  if ((params.sameTierDependencies?.length ?? 0) > 0 || (params.crossTierDependencies?.length ?? 0) > 0) {
    base.dependencies = {
      same_tier: params.sameTierDependencies?.length ? params.sameTierDependencies : base.dependencies?.same_tier,
      cross_tier: params.crossTierDependencies
    };
  }
  return base;
}

export function serializeNodeMetadata(metadata: NodeMetadata): string {
  return JSON.stringify(metadata);
}

export function writeNodeMetadata(params: {
  projectDb: Database.Database;
  taskId: string;
  metadata: NodeMetadata;
}): void {
  params.projectDb
    .prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?")
    .run(serializeNodeMetadata(params.metadata), nowIso(), params.taskId);
}
