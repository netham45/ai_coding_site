import type Database from "better-sqlite3";
import { readNodeMetadata } from "./metadata.js";
import type { NodeDependencyRef, NodeTier, TaskRow } from "../../types.js";

type TaskLikeTier = "task" | "plan" | "exec";

type GraphNode = {
  id: string;
  tier: NodeTier;
  dependencies: NodeDependencyRef[];
};

type ProjectGraphSnapshot = {
  taskDeps: Map<string, string[]>;
  taskTierById: Map<string, NodeTier>;
  taskStatusById: Map<string, string>;
  nodes: Map<string, GraphNode>;
};

export type ProposedNode = {
  id: string;
  tier: NodeTier;
  dependencies: NodeDependencyRef[];
};

function isTaskLikeTier(tier: NodeTier): tier is TaskLikeTier {
  return tier === "task" || tier === "plan" || tier === "exec";
}

function keyFor(ref: { id: string; tier: NodeTier }): string {
  return `${ref.tier}:${ref.id}`;
}

function normalizeRef(ref: NodeDependencyRef, defaultTier: NodeTier): NodeDependencyRef {
  return {
    id: ref.id.trim(),
    tier: ref.tier ?? defaultTier,
    reason: typeof ref.reason === "string" && ref.reason.trim().length > 0 ? ref.reason.trim() : undefined
  };
}

function normalizeMetadataDependencies(metadataDeps: {
  same_tier?: NodeDependencyRef[];
  cross_tier?: NodeDependencyRef[];
} | undefined, nodeTier: NodeTier): NodeDependencyRef[] {
  const refs: NodeDependencyRef[] = [];
  for (const dep of metadataDeps?.same_tier ?? []) {
    refs.push(normalizeRef(dep, nodeTier));
  }
  for (const dep of metadataDeps?.cross_tier ?? []) {
    refs.push(normalizeRef(dep, "task"));
  }
  return refs;
}

function dedupeRefs(refs: NodeDependencyRef[]): NodeDependencyRef[] {
  const seen = new Set<string>();
  const out: NodeDependencyRef[] = [];
  for (const ref of refs) {
    const tier = ref.tier ?? "task";
    const key = keyFor({ id: ref.id, tier });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...ref, tier });
  }
  return out;
}

function buildTaskDependencyMap(projectDb: Database.Database, projectId?: string): Map<string, string[]> {
  const rows = (projectId
    ? projectDb
      .prepare(
        `SELECT td.task_id, td.dependency_task_id
         FROM task_dependencies td
         JOIN tasks owner ON owner.id = td.task_id
         WHERE owner.project_id = ?
         ORDER BY td.created_at ASC`
      )
      .all(projectId)
    : projectDb
      .prepare("SELECT task_id, dependency_task_id FROM task_dependencies ORDER BY created_at ASC")
      .all()) as Array<{ task_id: string; dependency_task_id: string }>;
  const out = new Map<string, string[]>();
  for (const row of rows) {
    if (!out.has(row.task_id)) {
      out.set(row.task_id, []);
    }
    out.get(row.task_id)?.push(row.dependency_task_id);
  }
  return out;
}

function resolveTaskTier(projectDb: Database.Database, task: TaskRow, dependencyTaskIds: string[]): NodeTier {
  return readNodeMetadata({ projectDb, task, dependencyTaskIds }).metadata.tier;
}

const GRAPH_CACHE_TTL_MS = Math.max(0, Number(process.env.AI_CODING_DEP_GRAPH_CACHE_TTL_MS ?? 3000));
const graphSnapshotCache = new WeakMap<Database.Database, Map<string, { expiresAt: number; snapshot: ProjectGraphSnapshot }>>();

function loadProjectGraphSnapshot(params: {
  projectDb: Database.Database;
  projectId: string;
}): ProjectGraphSnapshot {
  if (GRAPH_CACHE_TTL_MS > 0) {
    const cachedByProject = graphSnapshotCache.get(params.projectDb);
    const cached = cachedByProject?.get(params.projectId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.snapshot;
    }
  }

  const tasks = params.projectDb
    .prepare("SELECT * FROM tasks WHERE project_id = ?")
    .all(params.projectId) as TaskRow[];
  const taskDeps = buildTaskDependencyMap(params.projectDb, params.projectId);
  const taskTierById = new Map<string, NodeTier>();
  const taskStatusById = new Map<string, string>();

  for (const task of tasks) {
    const depTaskIds = taskDeps.get(task.id) ?? [];
    taskTierById.set(task.id, resolveTaskTier(params.projectDb, task, depTaskIds));
    taskStatusById.set(task.id, task.status);
  }

  const nodes = new Map<string, GraphNode>();
  for (const task of tasks) {
    const depTaskIds = taskDeps.get(task.id) ?? [];
    const tier = taskTierById.get(task.id) ?? resolveTaskTier(params.projectDb, task, depTaskIds);
    const metadata = readNodeMetadata({ projectDb: params.projectDb, task, dependencyTaskIds: depTaskIds }).metadata;
    const refs = normalizeMetadataDependencies(metadata.dependencies, tier);
    for (const depTaskId of depTaskIds) {
      const depTier = taskTierById.get(depTaskId) ?? "task";
      refs.push({ id: depTaskId, tier: depTier });
    }
    const normalized = dedupeRefs(refs).filter((ref) => ref.id.length > 0);
    nodes.set(keyFor({ id: task.id, tier }), { id: task.id, tier, dependencies: normalized });
  }

  const snapshot: ProjectGraphSnapshot = {
    taskDeps,
    taskTierById,
    taskStatusById,
    nodes
  };

  if (GRAPH_CACHE_TTL_MS > 0) {
    const cachedByProject = graphSnapshotCache.get(params.projectDb) ?? new Map<string, { expiresAt: number; snapshot: ProjectGraphSnapshot }>();
    cachedByProject.set(params.projectId, {
      expiresAt: Date.now() + GRAPH_CACHE_TTL_MS,
      snapshot
    });
    graphSnapshotCache.set(params.projectDb, cachedByProject);
  }

  return snapshot;
}

function loadExistingGraphNodes(params: {
  projectDb: Database.Database;
  projectId: string;
}): Map<string, GraphNode> {
  const snapshot = loadProjectGraphSnapshot(params);
  const out = new Map<string, GraphNode>();
  for (const [nodeKey, node] of snapshot.nodes.entries()) {
    out.set(nodeKey, {
      id: node.id,
      tier: node.tier,
      dependencies: node.dependencies.map((dep) => ({ ...dep }))
    });
  }
  return out;
}

function buildAdjacency(nodes: Map<string, GraphNode>): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const [nodeKey, node] of nodes.entries()) {
    const edges = dedupeRefs(node.dependencies)
      .map((dep) => keyFor({ id: dep.id, tier: dep.tier ?? "task" }))
      .sort((a, b) => a.localeCompare(b));
    adj.set(nodeKey, edges);
    for (const edge of edges) {
      if (!adj.has(edge)) {
        adj.set(edge, []);
      }
    }
  }
  return adj;
}

function findCycleFromStart(startKey: string, adjacency: Map<string, string[]>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (nodeKey: string): string[] | null => {
    state.set(nodeKey, 1);
    stack.push(nodeKey);
    const neighbors = adjacency.get(nodeKey) ?? [];
    for (const next of neighbors) {
      if (next === startKey) {
        return [...stack, startKey];
      }
      const nextState = state.get(next) ?? 0;
      if (nextState === 0) {
        const nested = visit(next);
        if (nested) return nested;
      } else if (nextState === 1) {
        const idx = stack.indexOf(next);
        if (idx >= 0) {
          return [...stack.slice(idx), next];
        }
      }
    }
    stack.pop();
    state.set(nodeKey, 2);
    return null;
  };

  return visit(startKey);
}

function formatCycle(cycle: string[]): string {
  return cycle.join(" -> ");
}

export function partitionDependenciesByTier(dependencies: NodeDependencyRef[], nodeTier: NodeTier): {
  sameTierDependencies: NodeDependencyRef[];
  crossTierDependencies: NodeDependencyRef[];
} {
  const normalized = dedupeRefs(dependencies.map((dep) => normalizeRef(dep, "task")));
  const sameTierDependencies = normalized.filter((dep) => (dep.tier ?? "task") === nodeTier);
  const crossTierDependencies = normalized.filter((dep) => (dep.tier ?? "task") !== nodeTier);
  return { sameTierDependencies, crossTierDependencies };
}

export function resolveAndValidateNodeDependencies(params: {
  projectDb: Database.Database;
  projectId: string;
  nodeId: string;
  nodeTier: NodeTier;
  dependencyTaskIds?: string[];
  dependencyNodeRefs?: NodeDependencyRef[];
  proposedNodes?: ProposedNode[];
}): {
  normalizedDependencies: NodeDependencyRef[];
  taskDependencies: TaskRow[];
  unresolvedTaskDependencies: TaskRow[];
} {
  const refs: NodeDependencyRef[] = [];
  for (const depTaskId of params.dependencyTaskIds ?? []) {
    refs.push({ id: depTaskId, tier: "task" });
  }
  for (const ref of params.dependencyNodeRefs ?? []) {
    refs.push(ref);
  }

  const normalized = refs.map((ref) => normalizeRef(ref, "task"));
  const seen = new Set<string>();
  for (const ref of normalized) {
    if (!ref.id) {
      throw new Error("Dependency ids must be non-empty");
    }
    const depKey = keyFor({ id: ref.id, tier: ref.tier ?? "task" });
    if (seen.has(depKey)) {
      throw new Error("Duplicate dependency ids are not allowed");
    }
    seen.add(depKey);
    if (depKey === keyFor({ id: params.nodeId, tier: params.nodeTier })) {
      throw new Error("A node cannot depend on itself");
    }
  }

  const taskLikeIds = [...new Set(normalized.filter((ref) => isTaskLikeTier(ref.tier ?? "task")).map((ref) => ref.id))];
  const taskRows = taskLikeIds.length === 0
    ? []
    : (params.projectDb
      .prepare(`SELECT * FROM tasks WHERE project_id = ? AND id IN (${taskLikeIds.map(() => "?").join(", ")})`)
      .all(params.projectId, ...taskLikeIds) as TaskRow[]);
  const taskRowById = new Map(taskRows.map((row) => [row.id, row]));

  const taskDeps = buildTaskDependencyMap(params.projectDb, params.projectId);
  const rowTierById = new Map<string, NodeTier>();
  for (const row of taskRows) {
    rowTierById.set(row.id, resolveTaskTier(params.projectDb, row, taskDeps.get(row.id) ?? []));
  }

  for (const ref of normalized) {
    const depTier = ref.tier ?? "task";
    if (!isTaskLikeTier(depTier)) {
      continue;
    }
    const row = taskRowById.get(ref.id);
    if (!row) {
      throw new Error(`Dependency not found in this project: ${depTier}:${ref.id}`);
    }
    const actualTier = rowTierById.get(row.id) ?? "task";
    if (ref.tier && ref.tier !== actualTier) {
      throw new Error(`Dependency tier mismatch for ${ref.id}: expected ${ref.tier}, found ${actualTier}`);
    }
    ref.tier = actualTier;
  }

  const existingNodes = loadExistingGraphNodes({ projectDb: params.projectDb, projectId: params.projectId });
  const proposedNodes = params.proposedNodes ?? [];
  proposedNodes.push({ id: params.nodeId, tier: params.nodeTier, dependencies: normalized });
  for (const node of proposedNodes) {
    existingNodes.set(keyFor(node), { ...node, dependencies: dedupeRefs(node.dependencies.map((dep) => normalizeRef(dep, "task"))) });
  }

  const adjacency = buildAdjacency(existingNodes);
  const startKeys = proposedNodes
    .map((node) => keyFor(node))
    .sort((a, b) => a.localeCompare(b));
  for (const startKey of startKeys) {
    const cycle = findCycleFromStart(startKey, adjacency);
    if (cycle) {
      throw new Error(`Cyclic dependency detected: ${formatCycle(cycle)}`);
    }
  }

  const normalizedUnique = dedupeRefs(normalized);
  const taskDependencies = normalizedUnique
    .map((ref) => taskRowById.get(ref.id))
    .filter((row): row is TaskRow => Boolean(row));
  const unresolvedTaskDependencies = taskDependencies.filter((row) => row.status !== "merged");

  return {
    normalizedDependencies: normalizedUnique,
    taskDependencies,
    unresolvedTaskDependencies
  };
}

export function validateProposedNodeGraph(params: {
  projectDb: Database.Database;
  projectId: string;
  proposedNodes: ProposedNode[];
}): void {
  const existingNodes = loadExistingGraphNodes({ projectDb: params.projectDb, projectId: params.projectId });
  const proposedNodes = params.proposedNodes.map((node) => ({
    id: node.id,
    tier: node.tier,
    dependencies: dedupeRefs(node.dependencies.map((dep) => normalizeRef(dep, "task")))
  }));
  const proposedKeys = new Set<string>();
  for (const node of proposedNodes) {
    const nodeKey = keyFor(node);
    if (proposedKeys.has(nodeKey)) {
      throw new Error(`Duplicate proposed node id: ${nodeKey}`);
    }
    proposedKeys.add(nodeKey);
    const seenDeps = new Set<string>();
    for (const dep of node.dependencies) {
      const depTier = dep.tier ?? "task";
      const depKey = keyFor({ id: dep.id, tier: depTier });
      if (seenDeps.has(depKey)) {
        throw new Error(`Duplicate dependency ids are not allowed for ${nodeKey}`);
      }
      seenDeps.add(depKey);
      if (depKey === nodeKey) {
        throw new Error(`A node cannot depend on itself: ${nodeKey}`);
      }
    }
    existingNodes.set(nodeKey, node);
  }
  const adjacency = buildAdjacency(existingNodes);
  const starts = [...proposedKeys].sort((a, b) => a.localeCompare(b));
  for (const start of starts) {
    const cycle = findCycleFromStart(start, adjacency);
    if (cycle) {
      throw new Error(`Cyclic dependency detected: ${formatCycle(cycle)}`);
    }
  }
}

export function buildDependencyDiagnostics(params: {
  projectDb: Database.Database;
  task: TaskRow;
}): {
  node: { id: string; tier: NodeTier };
  unresolved: Array<{ id: string; tier: NodeTier; reason: string | null; status: string | null }>;
  lineage: Array<{ fromId: string; fromTier: NodeTier; toId: string; toTier: NodeTier; reason: string | null }>;
} {
  const snapshot = loadProjectGraphSnapshot({
    projectDb: params.projectDb,
    projectId: params.task.project_id
  });
  const allDeps = snapshot.taskDeps;
  const nodeTier = snapshot.taskTierById.get(params.task.id)
    ?? resolveTaskTier(params.projectDb, params.task, allDeps.get(params.task.id) ?? []);
  const direct = snapshot.nodes.get(keyFor({ id: params.task.id, tier: nodeTier }))?.dependencies ?? [];
  const unresolved = direct
    .map((ref) => {
      const tier = ref.tier ?? "task";
      const status = snapshot.taskStatusById.get(ref.id) ?? null;
      const resolved = status === "merged";
      return {
        id: ref.id,
        tier,
        reason: ref.reason ?? null,
        status: resolved ? status : status
      };
    })
    .filter((row) => row.status !== "merged");

  const existing = snapshot.nodes;
  const lineage: Array<{ fromId: string; fromTier: NodeTier; toId: string; toTier: NodeTier; reason: string | null }> = [];
  const start = keyFor({ id: params.task.id, tier: nodeTier });
  const queue = [start];
  const visited = new Set<string>([start]);
  while (queue.length > 0) {
    const currentKey = queue.shift() as string;
    const node = existing.get(currentKey);
    if (!node) continue;
    for (const dep of dedupeRefs(node.dependencies)) {
      const toTier = dep.tier ?? "task";
      lineage.push({
        fromId: node.id,
        fromTier: node.tier,
        toId: dep.id,
        toTier,
        reason: dep.reason ?? null
      });
      const depKey = keyFor({ id: dep.id, tier: toTier });
      if (!visited.has(depKey)) {
        visited.add(depKey);
        queue.push(depKey);
      }
    }
  }

  return {
    node: { id: params.task.id, tier: nodeTier },
    unresolved,
    lineage
  };
}
