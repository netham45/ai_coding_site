import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { runAiCheckVerifier } from "./aiCheckVerifier.js";

function makeAiCheckScript(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-check-test-"));
  const scriptPath = path.join(dir, "ai_check");
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${source}\n`, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe("aiCheckVerifier", () => {
  test("returns OK for strict success payload and runs in non-interactive mode", async () => {
    const command = makeAiCheckScript(`
if (!process.argv.includes("--non-interactive")) {
  process.stdout.write(JSON.stringify({ status: "Failed", message: "missing --non-interactive" }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ status: "OK" }));
`);

    const result = await runAiCheckVerifier({ command });
    assert.deepEqual(result, { status: "OK" });
  });

  test("returns Failed with verifier-provided message", async () => {
    const command = makeAiCheckScript(`process.stdout.write(JSON.stringify({ status: "Failed", message: "check failed" }));`);
    const result = await runAiCheckVerifier({ command });
    assert.deepEqual(result, { status: "Failed", message: "check failed" });
  });

  test("treats malformed JSON output as failure", async () => {
    const command = makeAiCheckScript(`process.stdout.write("not-json");`);
    const result = await runAiCheckVerifier({ command });
    assert.equal(result.status, "Failed");
    assert.match(result.message, /malformed JSON/i);
  });

  test("treats JSON outside strict contract as failure", async () => {
    const command = makeAiCheckScript(`process.stdout.write(JSON.stringify({ status: "OK", extra: true }));`);
    const result = await runAiCheckVerifier({ command });
    assert.equal(result.status, "Failed");
    assert.match(result.message, /must be exactly/i);
  });

  test("times out and returns normalized failure", async () => {
    const command = makeAiCheckScript(`setTimeout(() => process.stdout.write(JSON.stringify({ status: "OK" })), 250);`);
    const result = await runAiCheckVerifier({ command, timeoutMs: 25 });
    assert.deepEqual(result, { status: "Failed", message: "ai_check timed out after 25ms" });
  });
});
