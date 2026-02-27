import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runInAsyncWorker, runInKeyedAsyncWorker } from "./asyncWorker.js";

describe("asyncWorker", () => {
  test("runInKeyedAsyncWorker serializes jobs for the same key", async () => {
    const steps: string[] = [];
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const first = runInKeyedAsyncWorker("same-key", async () => {
      steps.push("first:start");
      await wait(30);
      steps.push("first:end");
      return "first";
    });
    const second = runInKeyedAsyncWorker("same-key", async () => {
      steps.push("second:start");
      await wait(5);
      steps.push("second:end");
      return "second";
    });

    assert.equal(await first, "first");
    assert.equal(await second, "second");
    assert.deepEqual(steps, ["first:start", "first:end", "second:start", "second:end"]);
  });

  test("runInKeyedAsyncWorker continues queue after a failure", async () => {
    await assert.rejects(
      runInKeyedAsyncWorker("failure-key", async () => {
        throw new Error("boom");
      }),
      /boom/
    );
    const result = await runInKeyedAsyncWorker("failure-key", async () => "recovered");
    assert.equal(result, "recovered");
  });

  test("runInAsyncWorker executes independent one-shot workers", async () => {
    const calls: string[] = [];
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    await Promise.all([
      runInAsyncWorker(async () => {
        calls.push("a");
        await wait(10);
      }),
      runInAsyncWorker(async () => {
        calls.push("b");
        await wait(10);
      })
    ]);

    assert.equal(calls.length, 2);
    assert.equal(new Set(calls).size, 2);
  });
});
