import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { partitionDependenciesByTier } from "./dependencyGraph.js";

describe("orchestration dependency graph helpers", () => {
  test("partitions same-tier and cross-tier dependencies and dedupes duplicates", () => {
    const partitioned = partitionDependenciesByTier(
      [
        { id: "task-a", tier: "task", reason: "same" },
        { id: "task-a", tier: "task", reason: "same duplicate" },
        { id: "plan-1", tier: "plan", reason: "cross" },
        { id: "phase-1", tier: "phase", reason: "cross phase" }
      ],
      "task"
    );

    assert.deepEqual(
      partitioned.sameTierDependencies.map((dep) => ({ id: dep.id, tier: dep.tier })),
      [{ id: "task-a", tier: "task" }]
    );
    assert.deepEqual(
      partitioned.crossTierDependencies.map((dep) => ({ id: dep.id, tier: dep.tier })),
      [
        { id: "plan-1", tier: "plan" },
        { id: "phase-1", tier: "phase" }
      ]
    );
  });
});
