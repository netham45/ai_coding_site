import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nowIso } from "./time.js";

describe("nowIso", () => {
  test("returns a valid ISO timestamp near current time", () => {
    const before = Date.now();
    const value = nowIso();
    const parsed = Date.parse(value);
    const after = Date.now();

    assert.equal(Number.isNaN(parsed), false);
    assert.ok(parsed >= before - 1000);
    assert.ok(parsed <= after + 1000);
  });
});
