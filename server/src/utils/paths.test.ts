import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { assertIsolatedTestRoot, workspaceRoot } from "./paths.js";

describe("test root isolation guard", () => {
  test("allows expected root and descendants", () => {
    const expected = path.join(workspaceRoot, ".tmp", "test-data");
    assert.equal(assertIsolatedTestRoot("AI_CODING_DATA_ROOT", expected, expected), path.resolve(expected));
    const child = path.join(expected, "nested");
    assert.equal(assertIsolatedTestRoot("AI_CODING_DATA_ROOT", child, expected), path.resolve(child));
  });

  test("rejects non-isolated paths", () => {
    const expected = path.join(workspaceRoot, ".tmp", "test-data");
    const nonIsolated = path.join(workspaceRoot, "data");
    assert.throws(() => {
      assertIsolatedTestRoot("AI_CODING_DATA_ROOT", nonIsolated, expected);
    }, /\[test-safety\]/);
  });
});
