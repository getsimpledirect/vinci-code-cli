import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const tmpDir = resolve(here, "..", ".accept-precedence-test");

try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {}
mkdirSync(tmpDir, { recursive: true });

// Create a stub vac that echoes its environment for testing
const stubVacPath = resolve(tmpDir, "vac");
const stubVacScript = `#!/bin/bash
# Stub vac: echo key environment variables as JSON
printf '{"VAC_CLI_PATH":"%s","VAC_BASE_URL":"%s","job_id":"stub-job","status":"VERIFIED_PASS","summary":"accepted","snapshotDigest":"sha256:stub","event_cursor":"events:1"}' "$VAC_CLI_PATH" "$VAC_BASE_URL"
exit 0
`;

writeFileSync(stubVacPath, stubVacScript);
chmodSync(stubVacPath, 0o755);

const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });

// Load the accept tool extension to test
const mockPI = {
  tool: null,
  registerTool(tool) {
    this.tool = tool;
  },
};

const acceptModule = await loader.import(resolve(here, "../extensions/vinci-accept.ts"), {
  default: false,
});
const stateModule = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), { default: false });
const control = await loader.import(resolve(here, "../extensions/lib/control.ts"), { default: false });
const acceptExtension = acceptModule.default;
acceptExtension(mockPI);

const tool = mockPI.tool;
assert(tool, "Tool not registered");

const text = (result) => result.content.map((c) => c.text).join("");
let persisted = 0;
stateModule.resetVinciVerificationState();
control.setVinciPersistVerification(() => persisted++);

// Test 1: VAC_CLI_PATH override in tool execution
{
  process.env.VAC_CLI_PATH = stubVacPath;
  process.env.VAC_BASE_URL = "https://test.acceptance.local";

  const result = await tool.execute("t1", { action: "verify" }, undefined);
  assert.equal(result.details.exitCode, 0, "tool should succeed with stub vac");
  
  const output = JSON.parse(text(result));
  assert(output.job_id, "stub vac should return valid JSON");
  assert.equal(output.VAC_CLI_PATH, stubVacPath, "VAC_CLI_PATH should be passed to vac");
  assert.equal(result.details.latchRecorded, true, "terminal verdict should be recorded");
  const verdict = Object.values(stateModule.getVinciVerificationState().remoteAcceptanceVerdicts ?? {})[0];
  assert.equal(verdict.jobId, "stub-job");
  assert.equal(verdict.eventCursor, "events:1");
  assert.equal(persisted, 1, "recorded verdict should be persisted");
  console.log("ok (1) VAC_CLI_PATH override works in tool");
}

// Test 2: VAC_BASE_URL passed through environment
{
  process.env.VAC_CLI_PATH = stubVacPath;
  process.env.VAC_BASE_URL = "https://custom.url";

  const result = await tool.execute("t2", { action: "status", job_id: "test-job" }, undefined);
  assert.equal(result.details.exitCode, 0, "tool should succeed");
  const output = JSON.parse(text(result));
  assert.equal(output.VAC_BASE_URL, "https://custom.url", "VAC_BASE_URL should reach vac");
  console.log("ok (2) VAC_BASE_URL passes through environment");
}

// Clean up
delete process.env.VAC_CLI_PATH;
delete process.env.VAC_BASE_URL;
control.setVinciPersistVerification(null);
rmSync(tmpDir, { recursive: true, force: true });

console.log("✓ accept-config-precedence.mjs: all tests passed");
