// W0.5 exact build identity: buildIdentity(), the once-per-start `online` post, and the
// worker_build / server_build fields on every task record and final post.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { buildIdentity, fetchServerBuild } from "../worker/build.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
const WORKER = join(ROOT, "vinci/worker/worker.mjs");
const FULL_SHA = /^[0-9a-f]{40}$/;

// Every test runs even after a failure so a mutation shows every test it kills, not the first.
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ worker-build-identity: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ worker-build-identity: ${name}: ${error.stack ?? error.message}`);
  }
}
process.on("beforeExit", () => {
  if (failed > 0) process.exitCode = 1;
});

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

function handoff(id, workerId, body = "repo: test/repo\nevidence: none\n\nDo the thing") {
  return {
    message_id: id,
    kind: "handoff",
    to_agent: `worker:${workerId}`,
    subject: "build identity task",
    body,
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

const WORKER_BUILD_TAG = new RegExp(`(^| )worker_build=${here.commit}(-dirty)?( |$)`);

await test("T6 early terminal blockers (past deadline, governor refusal, envelope error) carry worker_build=", async () => {
  // (a) past deadline and (c) envelope error: no governor needed.
  const fixture = new WorkerTestFixture("build-early");
  try {
    fixture.linkTools(TOOLS);
    fixture.createRepo("test", "repo");
    await fixture.startBus([
      handoff("31", "w1", "repo: test/repo\nevidence: none\ndeadline: 2020-01-01T00:00:00Z\n\nTask"),
      handoff("32", "w1", "repo: not-org-form\nevidence: none\n\nTask"),
    ]);
    const { code, stderr } = await runOnce(fixture, "w1");
    assert.equal(code, 0, stderr);
    const posts = fixture.getPostedMessages();
    const deadline = posts.find((post) => post.subject === "task 31 blocked");
    assert.ok(deadline, JSON.stringify(posts));
    assert.match(deadline.body, /deadline is in the past/);
    assert.match(deadline.body, WORKER_BUILD_TAG, deadline.body);
    const envelope = posts.find((post) => /^task 32 (blocked|failed)$/.test(post.subject));
    assert.ok(envelope, JSON.stringify(posts));
    assert.match(envelope.body, /repo must be/);
    assert.match(envelope.body, WORKER_BUILD_TAG, envelope.body);
    assert.equal(fixture.getVinciCalls().length, 0);
  } finally {
    await fixture.cleanup();
  }

  // (b) governor refusal (409).
  const refused = new WorkerTestFixture("build-gov-refused");
  const governor = createHttpServer((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ reason: "path already leased to worker:other" }));
  });
  await new Promise((resolveListen) => governor.listen(0, "127.0.0.1", resolveListen));
  try {
    refused.linkTools(TOOLS);
    refused.createRepo("test", "repo");
    await refused.startBus([handoff("33", "w1")]);
    const proc = spawn(
      "node",
      [WORKER, "start", "--id", "w1", "--server", refused.busUrl(), "--once", "--state-dir", refused.tempDir,
        "--governor", `http://127.0.0.1:${governor.address().port}`],
      { env: refused.getEnv({ VINCI_GOVERNOR_TOKEN: "gov-token" }), stdio: "pipe" },
    );
    const code = await new Promise((resolveClose) => proc.once("close", resolveClose));
    assert.equal(code, 0);
    const blocker = refused.getPostedMessages().find((post) => post.kind === "blocker");
    assert.ok(blocker, JSON.stringify(refused.getPostedMessages()));
    assert.match(blocker.body, /Governor refused the lease/);
    assert.match(blocker.body, WORKER_BUILD_TAG, blocker.body);
    assert.equal(refused.getVinciCalls().length, 0);
  } finally {
    await new Promise((resolveClose) => governor.close(resolveClose));
    await refused.cleanup();
  }
});

await test("T7 a hung /v1/version times out (~3s): daemon still starts, server_build error mentions timeout", async () => {
  const fixture = new WorkerTestFixture("build-hung");
  try {
    fixture.linkTools(TOOLS);
    fixture.versionDelayMs = 20_000;
    await fixture.startBus([]);
    const startedAt = Date.now();
    const { code, stderr } = await runOnce(fixture, "w1");
    const elapsedMs = Date.now() - startedAt;
    assert.equal(code, 0, stderr);
    assert.ok(elapsedMs < 6000, `startup took ${elapsedMs}ms; the /v1/version timeout is 3s`);
    assert.ok(elapsedMs >= 2500, `startup took ${elapsedMs}ms; the hung fetch was not even waited for`);
    const online = fixture.getPostedMessages().filter((post) => post.subject === "worker w1 online");
    assert.equal(online.length, 1);
    assert.match(online[0].body, /(^| )server_build=unknown: .*timeout/i, online[0].body);
  } finally {
    await fixture.cleanup();
  }
});

await test("T8 dirty detection: a modified tracked file => dirty:true; an untracked file alone => dirty:false", async () => {
  const cloneRoot = mkdtempSync(join(tmpdir(), "worker-build-dirty-"));
  const git = (...args) => {
    const result = spawnSync("git", ["-C", cloneRoot, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "--initial-branch=main");
    git("config", "user.email", "test@test.com");
    git("config", "user.name", "Test");
    cpSync(join(ROOT, "vinci/worker/build.mjs"), join(cloneRoot, "worker/build.mjs"));
    cpSync(join(ROOT, "vinci/identity.json"), join(cloneRoot, "identity.json"));
    writeFileSync(join(cloneRoot, "tracked.txt"), "original\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const head = git("rev-parse", "HEAD");
    const copied = await import(pathToFileURL(join(cloneRoot, "worker/build.mjs")).href);

    const clean = copied.buildIdentity();
    assert.deepEqual(clean, { version: here.version, commit: head, dirty: false, source: "git" });

    writeFileSync(join(cloneRoot, "untracked.txt"), "not added\n");
    const untrackedOnly = copied.buildIdentity();
    assert.equal(untrackedOnly.dirty, false, "an untracked file alone must not read as dirty");
    assert.equal(untrackedOnly.commit, head);

    writeFileSync(join(cloneRoot, "tracked.txt"), "modified\n");
    const modified = copied.buildIdentity();
    assert.equal(modified.dirty, true, "a modified tracked file must read as dirty");
    assert.equal(modified.commit, head);
    assert.equal(copied.formatWorkerBuild(modified), `${head}-dirty`);
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true });
  }
});
