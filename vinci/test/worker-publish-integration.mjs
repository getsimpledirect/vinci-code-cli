import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");

async function scenario(name, repoOptions, env) {
  const fixture = new WorkerTestFixture(`publish-${name}`);
  try {
    fixture.createRepo("test", "repo", repoOptions);
    fixture.linkTools(TOOLS);
    await fixture.startBus([{
      message_id: name,
      to_agent: "publisher",
      kind: "handoff",
      subject: name,
      body: "repo: test/repo\nevidence: pr\nref: job_publish\n\nTask",
      ts: "2026-08-26T13:00:00Z",
      posted_by: "scheduler",
    }]);
    const child = spawn(
      "node",
      [join(ROOT, "vinci/worker/worker.mjs"), "start", "--id", "publisher", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir],
      { env: fixture.getEnv(env), stdio: "pipe" },
    );
    assert.equal(await new Promise((resolveClose) => child.once("close", resolveClose)), 0);
    return {
      fixture,
      state: JSON.parse(readFileSync(join(fixture.tempDir, "tasks", `${name}.json`), "utf8")),
    };
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}

let result = await scenario("13", {}, { FAKE_VINCI_WORKTREE_BLOCKER: "1", FAKE_GH_OUTPUT: "notice\nhttps://github.com/test/repo/pull/321\ntrailing" });
assert.equal(result.state.state, "COMPLETED", "working-tree-only BLOCKER.md must not block publishing");
assert.equal(result.state.pr, "https://github.com/test/repo/pull/321");
await result.fixture.cleanup();

result = await scenario("14", {}, { FAKE_GH_OUTPUT: "notice\nhttp://github.com/test/repo/pull/321\nnot-a-pr" });
assert.equal(result.state.state, "UNVERIFIED");
assert.equal(result.state.pr, null, "malformed gh output must not be recorded as a PR");
await result.fixture.cleanup();

result = await scenario("15", { files: { "BLOCKER.md": "Do not publish.\n" } }, {});
assert.equal(result.state.state, "BLOCKED");
assert.equal(result.state.publish, "blocked");
assert.match(result.fixture.getPostedMessages().at(-1).body, /BLOCKER\.md at HEAD is non-empty/);
assert.equal(existsSync(join(result.fixture.tempDir, "gh-calls.txt")), false, "HEAD blocker must abort before gh");
await result.fixture.cleanup();

process.stdout.write("✓ worker-head-blocker-and-pr-url-parsing\n");
