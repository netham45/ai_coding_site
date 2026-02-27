import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { authMiddleware } from "./auth.js";
import { db } from "../db/index.js";
import { nowIso } from "../utils/time.js";

describe("authMiddleware", () => {
  test("attaches user from x-user-id header", () => {
    const userId = randomUUID();
    const now = nowIso();
    db.prepare("INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, `${userId}@example.com`, "Header User", now, now);

    let nextCalled = 0;
    const req: any = {
      header: (name: string) => (name === "x-user-id" ? userId : undefined)
    };
    const res: any = {
      statusCode: null,
      body: null,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      }
    };

    authMiddleware(req, res, () => {
      nextCalled += 1;
    });

    assert.equal(nextCalled, 1);
    assert.equal(req.user.id, userId);
    assert.equal(res.statusCode, null);
  });

  test("returns 401 for unknown user id", () => {
    const req: any = {
      header: (name: string) => (name === "x-user-id" ? randomUUID() : undefined)
    };

    let nextCalled = 0;
    const res: any = {
      statusCode: null,
      body: null,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      }
    };

    authMiddleware(req, res, () => {
      nextCalled += 1;
    });

    assert.equal(nextCalled, 0);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Unknown user" });
  });
});
