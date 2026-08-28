// W0.5 exact build identity: buildIdentity(), the once-per-start `online` post, and the
// worker_build / server_build fields on every task record and final post.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";
import { createServer } from "node:net";
import { buildIdentity, fetchServerBuild } from "../worker/build.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
const WORKER = join(ROOT, "vinci/worker/worker.mjs");
const FULL_SHA = /^[0-9a-f]{40}$/;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ worker-build-identity: ${name}`);
  } catch (error) {
    console.error(`✗ worker-build-identity: ${name}: ${error.stack ?? error.message}`);
    process.exit(1);
  }
}

function runOnce(fixture, workerId) {
  const proc = spawn(
    "node",
    [WORKER, "start", "--id", workerId, "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir],
    { env: fixture.getEnv(), stdio: "pipe" },
  );
  let stderr = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolveClose) => proc.once("close", (code) => resolveClose({ code, stderr })));
}

function handoff(id, workerId) {
  return {
    message_id: id,
    kind: "handoff",
    to_agent: `worker:${workerId}`,
    subject: "build identity task",
    body: "repo: test/repo\nevidence: none\n\nDo the thing",
    ts: "2026-08-26T10:00:00Z",
    posted_by: "scheduler",
  };
}

const here = buildIdentity();

await test("T1 buildIdentity() in a git checkout: 40-hex commit, source git; in a bare copy: null commit, source package", async () => {
  assert.match(here.commit ?? "", FULL_SHA, `expected a 40-hex commit, got ${JSON.stringify(here)}`);
  assert.equal(here.source, "git");
  assert.equal(typeof here.dirty, "boolean");
  assert.equal(typeof here.version, "string");

  // Same module, copied to a directory that is not inside any git repository.
  const copyRoot = mkdtempSync(join(tmpdir(), "worker-build-identity-"));
  try {
    assert.equal(existsSync(join(copyRoot, ".git")), false);
    cpSync(join(ROOT, "vinci/worker/build.mjs"), join(copyRoot, "worker/build.mjs"));
    cpSync(join(ROOT, "vinci/identity.json"), join(copyRoot, "identity.json"));
    const copied = await import(pathToFileURL(join(copyRoot, "worker/build.mjs")).href);
    let result;
    assert.doesNotThrow(() => {
      result = copied.buildIdentity();
    });
    assert.equal(result.commit, null, JSON.stringify(result));
    assert.equal(result.dirty, null);
    assert.equal(result.source, "package");
    assert.equal(result.version, here.version);
  } finally {
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

await test("T2 daemon start posts exactly one online status with worker_build and server_build", async () => {
  const fixture = new WorkerTestFixture("build-online");
  try {
    fixture.linkTools(TOOLS);
    await fixture.startBus([]);
    const { code, stderr } = await runOnce(fixture, "w1");
    assert.equal(code, 0, stderr);
    assert.equal(fixture.versionRequests, 1, "must fetch /v1/version exactly once");
    const online = fixture.getPostedMessages().filter((post) => post.subject === "worker w1 online");
    assert.equal(online.length, 1, `expected exactly one online post, got ${JSON.stringify(fixture.getPostedMessages())}`);
    assert.equal(online[0].kind, "status");
    const expectedWorker = here.dirty ? `${here.commit}-dirty` : here.commit;
    assert.match(online[0].body, new RegExp(`(^| )worker_build=${expectedWorker}( |$)`), online[0].body);
    assert.match(online[0].body, new RegExp(`(^| )worker_version=${here.version.replace(/\\./g, "\\\\.")}( |$)`), online[0].body);
    assert.match(online[0].body, new RegExp(`(^| )server_build=${fixture.serverBuild.git_sha}( |$)`), online[0].body);
    // Once per start, before the first poll.
    assert.equal(fixture.getPostedMessages()[0].subject, "worker w1 online");
  } finally {
    await fixture.cleanup();
  }
});

await test("T3 /v1/version unavailable: daemon still starts, online post says server_build=unknown: …", async () => {
  const fixture = new WorkerTestFixture("build-noversion");
  try {
    fixture.linkTools(TOOLS);
    fixture.serveVersion = false;
    await fixture.startBus([]);
    const { code, stderr } = await runOnce(fixture, "w1");
    assert.equal(code, 0, stderr);
    const online = fixture.getPostedMessages().filter((post) => post.subject === "worker w1 online");
    assert.equal(online.length, 1);
    assert.match(online[0].body, /(^| )server_build=unknown: .+/, online[0].body);
    assert.doesNotMatch(online[0].body, /server_build=[0-9a-f]{40}/);

    // Truly unreachable (a port nothing listens on): the helper records the error, never throws.
    const probe = createServer();
    await new Promise((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
    const closedPort = probe.address().port;
    await new Promise((resolveClose) => probe.close(resolveClose));
    const unreachable = await fetchServerBuild(`http://127.0.0.1:${closedPort}`, { timeoutMs: 3000 });
    assert.match(unreachable.error, /ECONNREFUSED/, JSON.stringify(unreachable));
  } finally {
    await fixture.cleanup();
  }
});

await test("T4+T5 processed task snapshot carries worker_build/server_build; final post carries worker_build=", async () => {
  const fixture = new WorkerTestFixture("build-task");
  try {
    fixture.linkTools(TOOLS);
    fixture.createRepo("test", "repo");
    await fixture.startBus([handoff("7", "w1")]);
    const { code, stderr } = await runOnce(fixture, "w1");
    assert.equal(code, 0, stderr);

    // T4: on-disk snapshot
    const snapshot = JSON.parse(readFileSync(join(fixture.tempDir, "tasks", "7.json"), "utf8"));
    assert.ok(snapshot.terminal, JSON.stringify(snapshot));
    assert.equal(snapshot.vinci_version, here.version, "vinci_version stays for compatibility");
    assert.deepEqual(snapshot.worker_build, { version: here.version, commit: here.commit, dirty: here.dirty });
    assert.equal(snapshot.worker_build.commit, here.commit);
    assert.equal(snapshot.server_build.git_sha, fixture.serverBuild.git_sha, JSON.stringify(snapshot.server_build));
    assert.equal(snapshot.server_build.error, undefined);
    assert.deepEqual(snapshot.server_build, fixture.serverBuild, "the /v1/version payload is stored verbatim");

    // T5: final bus post
    const finals = fixture.getPostedMessages().filter((post) => /^task 7 /.test(post.subject) && !/claimed$/.test(post.subject));
    assert.equal(finals.length, 1, JSON.stringify(fixture.getPostedMessages()));
    const expectedWorker = here.dirty ? `${here.commit}-dirty` : here.commit;
    assert.match(finals[0].body, new RegExp(`(^| )worker_build=${expectedWorker}( |$)`), finals[0].body);
    // Exactly one online post even though a task was processed.
    assert.equal(fixture.getPostedMessages().filter((post) => / online$/.test(post.subject)).length, 1);
  } finally {
    await fixture.cleanup();
  }
});
