import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nextSlug, slugify } from "./slug.js";

describe("slug utilities", () => {
  test("slugify normalizes separators, case, and length", () => {
    assert.equal(slugify("  Hello,   WORLD!!  "), "hello-world");
    assert.equal(slugify("a".repeat(100)), "a".repeat(48));
    assert.equal(slugify("%%%"), "");
  });

  test("nextSlug returns first available suffix", () => {
    const existing = new Set(["proj", "proj-2", "proj-3"]);
    assert.equal(nextSlug("proj", (slug) => existing.has(slug)), "proj-4");
    assert.equal(nextSlug("new-proj", (slug) => existing.has(slug)), "new-proj");
    assert.equal(nextSlug("", (slug) => slug === "project"), "project-2");
  });
});
