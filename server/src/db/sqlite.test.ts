import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { assertTestSafeSqlitePath } from "./sqlite.js";
import { workspaceRoot } from "../utils/paths.js";

describe("sqlite test safety guard", () => {
  test("allows isolated test sqlite path", () => {
    assert.doesNotThrow(() => {
      assertTestSafeSqlitePath(path.join(workspaceRoot, ".tmp", "test-data", "app.sqlite"));
    });
  });

  test("rejects protected live root aliases", () => {
    assert.throws(() => {
      assertTestSafeSqlitePath(path.join(path.resolve(path.sep, "data"), "app.sqlite"));
    }, /\[test-safety\]/);
    assert.throws(() => {
      assertTestSafeSqlitePath(path.join(path.resolve(path.sep, "repo"), "project.sqlite"));
    }, /\[test-safety\]/);
    assert.throws(() => {
      assertTestSafeSqlitePath(path.join(path.resolve(path.sep, "repos"), "project.sqlite"));
    }, /\[test-safety\]/);
  });

  test("rejects workspace live roots", () => {
    assert.throws(() => {
      assertTestSafeSqlitePath(path.join(workspaceRoot, "data", "app.sqlite"));
    }, /\[test-safety\]/);
    assert.throws(() => {
      assertTestSafeSqlitePath(path.join(workspaceRoot, "repos", "proj", ".ai-coding", "project.sqlite"));
    }, /\[test-safety\]/);
  });
});
