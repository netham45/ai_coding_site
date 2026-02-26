import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

const DEFAULT_OUTPUT_DEBOUNCE_MS = 1_500;

type OutputSource = "runtime_session" | "plan_file";

type OutputSourceState = {
  last_material_hash?: string;
  last_event_at_ms?: number;
  pending_hash?: string;
};

type OutputMonitorState = {
  sources?: Partial<Record<OutputSource, OutputSourceState>>;
};

type TaskMetadataShape = {
  custom?: {
    output_monitor?: OutputMonitorState;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseMetadata(raw: string | null | undefined): TaskMetadataShape {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return asObject(parsed) ?? {};
  } catch {
    return {};
  }
}

function readTaskMetadata(projectDb: Database.Database, taskId: string): { metadata: TaskMetadataShape; raw: string | null } | null {
  const row = projectDb
    .prepare("SELECT metadata_json FROM tasks WHERE id = ? LIMIT 1")
    .get(taskId) as { metadata_json: string | null } | undefined;
  if (!row) return null;
  return {
    metadata: parseMetadata(row.metadata_json),
    raw: row.metadata_json
  };
}

function writeTaskMetadata(projectDb: Database.Database, taskId: string, metadata: TaskMetadataShape): void {
  projectDb.prepare("UPDATE tasks SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), taskId);
}

function stripAnsiCodes(value: string): string {
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

export function normalizeOutputForMaterialHash(raw: string): string {
  const normalizedLines = stripAnsiCodes(raw)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""));
  return normalizedLines.join("\n").trim();
}

export function computeOutputMaterialHash(raw: string): string {
  return createHash("sha256").update(normalizeOutputForMaterialHash(raw)).digest("hex");
}

export function observeNodeOutputMaterialChange(params: {
  projectDb: Database.Database;
  taskId: string;
  source: OutputSource;
  rawOutput: string;
  debounceMs?: number;
  nowMs?: number;
}):
  | {
      materialChanged: true;
      outputHash: string;
      previousOutputHash: string | null;
      source: OutputSource;
    }
  | {
      materialChanged: false;
    } {
  const nowMs = params.nowMs ?? Date.now();
  const debounceMs = Math.max(0, params.debounceMs ?? DEFAULT_OUTPUT_DEBOUNCE_MS);
  const loaded = readTaskMetadata(params.projectDb, params.taskId);
  if (!loaded) {
    return { materialChanged: false };
  }

  const metadata = loaded.metadata;
  if (!metadata.custom || typeof metadata.custom !== "object") {
    metadata.custom = {};
  }
  const custom = metadata.custom as Record<string, unknown>;
  const monitorObj = asObject(custom.output_monitor) ?? {};
  const sourceStatesObj = asObject(monitorObj.sources) ?? {};
  const currentState = (asObject(sourceStatesObj[params.source]) ?? {}) as OutputSourceState;

  const latestHash = computeOutputMaterialHash(params.rawOutput);
  const previousMaterialHash = typeof currentState.last_material_hash === "string" ? currentState.last_material_hash : null;
  const lastEventAtMs = typeof currentState.last_event_at_ms === "number" ? currentState.last_event_at_ms : null;
  const pendingHash = typeof currentState.pending_hash === "string" ? currentState.pending_hash : null;
  const canEmit = !lastEventAtMs || nowMs - lastEventAtMs >= debounceMs;
  let stateChanged = false;

  let emitHash: string | null = null;
  if (latestHash !== previousMaterialHash) {
    if (canEmit) {
      emitHash = latestHash;
    } else {
      if (currentState.pending_hash !== latestHash) {
        currentState.pending_hash = latestHash;
        stateChanged = true;
      }
    }
  } else if (pendingHash && pendingHash !== previousMaterialHash && canEmit) {
    emitHash = pendingHash;
  } else {
    if (typeof currentState.pending_hash === "string") {
      currentState.pending_hash = undefined;
      stateChanged = true;
    }
  }

  if (!emitHash && !stateChanged) {
    return { materialChanged: false };
  }

  if (emitHash) {
    stateChanged = true;
    currentState.last_material_hash = emitHash;
    currentState.last_event_at_ms = nowMs;
    currentState.pending_hash = undefined;
  }

  sourceStatesObj[params.source] = currentState;
  monitorObj.sources = sourceStatesObj;
  custom.output_monitor = monitorObj;
  metadata.custom = custom as TaskMetadataShape["custom"];
  writeTaskMetadata(params.projectDb, params.taskId, metadata);

  if (!emitHash || emitHash === previousMaterialHash) {
    return { materialChanged: false };
  }

  return {
    materialChanged: true,
    source: params.source,
    outputHash: emitHash,
    previousOutputHash: previousMaterialHash
  };
}
