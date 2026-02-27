import assert from "node:assert/strict";
import express from "express";
import { describe, test } from "node:test";
import { endpointWorkerHandler, wrapRouterHandlersInAsyncWorkers } from "./endpointWorker.js";

describe("endpointWorker", () => {
  test("endpointWorkerHandler runs handler and forwards thrown errors", async () => {
    const calls: string[] = [];
    const okHandler = endpointWorkerHandler(async () => {
      calls.push("handled");
    });

    okHandler({} as any, {} as any, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, ["handled"]);

    const error = new Error("boom");
    const failing = endpointWorkerHandler(async () => {
      throw error;
    });

    await new Promise<void>((resolve) => {
      failing({} as any, {} as any, (nextError?: unknown) => {
        assert.equal(nextError, error);
        resolve();
      });
    });
  });

  test("wrapRouterHandlersInAsyncWorkers wraps non-wrapped handlers once", async () => {
    const router = express.Router();
    let count = 0;
    router.get("/test", (_req, _res) => {
      count += 1;
    });

    wrapRouterHandlersInAsyncWorkers(router);
    wrapRouterHandlersInAsyncWorkers(router);

    const layer: any = (router as any).stack.find((entry: any) => entry.route?.path === "/test");
    const handler: any = layer.route.stack[0].handle;
    assert.equal(handler.__asyncWorkerWrapped, true);

    handler({} as any, {} as any, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(count, 1);
  });
});
