import { createHash } from "node:crypto";
import type { NodeMetadata } from "../../types.js";

const DEFAULT_MAX_REPLAN_ITERATIONS = 3;

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function digestStable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function normalizeGapHashList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const values = value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return [...new Set(values)];
}

export function readReplanControl(metadata: NodeMetadata): {
  maxIterations: number;
  iterationsUsed: number;
  budgetOverride: boolean;
  gapHashesSeen: string[];
} {
  const custom = (metadata.custom ?? {}) as Record<string, unknown>;
  const maxIterations = Math.max(1, Number(metadata.budgets?.max_replans ?? DEFAULT_MAX_REPLAN_ITERATIONS));
  const iterationsUsed = Math.max(0, Number(custom.replan_iterations ?? 0));
  const budgetOverride = Boolean(custom.replan_budget_override);
  const gapHashesSeen = normalizeGapHashList(custom.gap_hashes_seen);
  return {
    maxIterations,
    iterationsUsed,
    budgetOverride,
    gapHashesSeen
  };
}

export function writeReplanControl(params: {
  metadata: NodeMetadata;
  iterationsUsed: number;
  gapHashesSeen: string[];
  decompositionFingerprint?: string | undefined;
  latestGapHash?: string | undefined;
}): NodeMetadata {
  const custom = { ...(params.metadata.custom ?? {}) } as Record<string, unknown>;
  custom.replan_iterations = Math.max(0, Math.floor(params.iterationsUsed));
  custom.gap_hashes_seen = [...new Set(params.gapHashesSeen)];
  return {
    ...params.metadata,
    idempotency: {
      ...(params.metadata.idempotency ?? {}),
      decomposition_fingerprint: params.decompositionFingerprint ?? params.metadata.idempotency?.decomposition_fingerprint,
      gap_hash: params.latestGapHash ?? params.metadata.idempotency?.gap_hash
    },
    custom
  };
}

