// B2: until prepareRepository threads base_ref (#23), a `base_ref:` other than main is refused
// BEFORE clone (fail closed) — the header parses, the task BLOCKs with base_ref_unsupported, and
// neither git nor vinci nor gh runs. `base_ref: main` is accepted and behaves like no header.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");

async function scenario(name, headers) {
  const fixture = new WorkerTestFixture(`base-ref-${name}`);
  try {
    fixture.createRepo("test", "repo", {});
    fixture.linkTools(TOOLS);
    await fixture.startBus([{
      message_id: name,
      to_agent: "worker:publisher",
      kind: "handoff",
      subject: name,
      body: `repo: test/repo\nevidence: pr\n${headers}\n\nTask`,
      ts: "2026-08-26T13:00:00Z",
      posted_by: "scheduler",
    }]);
    const child = spawn(
      "node",
      [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "publisher", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir],
      { env: fixture.getEnv(), stdio: "pipe" },
    );
    assert.equal(await new Promise((resolveClose) => child.once("close", resolveClose)), 0);
    return { fixture, state: JSON.parse(readFileSync(join(fixture.tempDir, "tasks", `${name}.json`), "utf8")) };
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}

let result = await scenario("br1", "base_ref: release/2026-08");
assert.equal(result.state.state, "BLOCKED");
assert.match(result.state.outcome.reason, /^base_ref_unsupported/);
assert.equal(existsSync(join(result.fixture.tempDir, "repos")), false, "refused BEFORE clone: no repo directory");
assert.equal(result.fixture.getVinciCalls().length, 0, "refused before spawn");
assert.equal(existsSync(join(result.fixture.tempDir, "gh-calls.txt")), false, "no gh call");
assert.match(result.fixture.getPostedMessages().at(-1).body, /base_ref_unsupported/);
await result.fixture.cleanup();

result = await scenario("br2", "base_ref: main");
assert.equal(result.state.state, "COMPLETED", "base_ref: main is the supported base");
assert.equal(result.state.base_ref, "main");
assert.equal(result.state.pr, "https://github.com/test/repo/pull/123");
await result.fixture.cleanup();

process.stdout.write("PASS worker-publish-base-ref\n");
