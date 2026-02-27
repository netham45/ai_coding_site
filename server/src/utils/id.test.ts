import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { makeId } from "./id.js";

describe("makeId", () => {
  test("returns UUIDv4-shaped unique IDs", () => {
    const a = makeId();
    const b = makeId();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(b, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(a, b);
  });
});
