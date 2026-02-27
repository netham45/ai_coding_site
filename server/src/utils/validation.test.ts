import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isValidRepoUrl } from "./validation.js";

describe("isValidRepoUrl", () => {
  test("accepts supported https/ssh/scp-like URLs", () => {
    assert.equal(isValidRepoUrl("https://github.com/org/repo.git"), true);
    assert.equal(isValidRepoUrl("ssh://git@github.com/org/repo.git"), true);
    assert.equal(isValidRepoUrl("git@github.com:org/repo.git"), true);
    assert.equal(isValidRepoUrl("  https://github.com/org/repo.git  "), true);
  });

  test("rejects empty, malformed, and unsupported protocols", () => {
    assert.equal(isValidRepoUrl(""), false);
    assert.equal(isValidRepoUrl("   "), false);
    assert.equal(isValidRepoUrl("ftp://github.com/org/repo.git"), false);
    assert.equal(isValidRepoUrl("not a url"), false);
  });
});
