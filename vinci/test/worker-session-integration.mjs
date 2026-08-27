import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readSessionState } from "../worker/session-read.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const directory = mkdtempSync(join(tmpdir(), "worker-session-"));
try {
  const sessionId = "real-session-redacted";
  const excerpt = readFileSync(join(fixtures, "worker-session.jsonl"), "utf8").replaceAll("SESSION_ID", sessionId);
  writeFileSync(join(directory, "session.jsonl"), excerpt);
  const state = readSessionState(directory, sessionId);
  assert.equal(state.costUsd, 9.99, "budget accounting must read data.usage.estimatedCostUsd");
  assert.equal(state.outcome.state, "DONE");
  assert.equal(state.outcome.verificationStatus, "passed");

  writeFileSync(join(directory, "session.jsonl"), excerpt.replaceAll("estimatedCostUsd", "mutatedCostKey"));
  assert.equal(
    readSessionState(directory, sessionId).costUsd,
    0,
    "mutation guard: changing estimatedCostUsd must remove the observed budget usage",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write("✓ worker-real-session-shape-and-usage-key\n");
