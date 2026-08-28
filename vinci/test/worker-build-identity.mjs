// W0.5 exact build identity: buildIdentity(), the once-per-start `online` post, and the
// worker_build / server_build fields on every task record and final post.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { buildIdentity, fetchServerBuild, findGitDir, formatWorkerBuild, readHeadCommit } from "../worker/build.mjs";

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
    assert.equal(result.unresolved, false, "no .git at all is a packaged install, not an unresolved checkout");
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
    assert.equal(unreachable.attempts, 2, "a network error is retried once, then recorded with the attempt count");
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

await test("T7 a hung /v1/version: one retry, daemon still starts within 6 s, server_build error mentions timeout", async () => {
  const fixture = new WorkerTestFixture("build-hung");
  try {
    fixture.linkTools(TOOLS);
    fixture.versionDelayMs = 20_000;
    await fixture.startBus([]);
    const startedAt = Date.now();
    const { code, stderr } = await runOnce(fixture, "w1");
    const elapsedMs = Date.now() - startedAt;
    assert.equal(code, 0, stderr);
    // 2 attempts x 2 s + 1 s between them = 5 s worst case; the bound the issue asks for is 6 s.
    assert.ok(elapsedMs < 6000, `startup took ${elapsedMs}ms; a hung /v1/version must not delay the first poll past 6 s`);
    assert.ok(elapsedMs >= 4500, `startup took ${elapsedMs}ms; the hung fetch was not retried (2 x 2 s + 1 s)`);
    assert.equal(fixture.versionRequests, 2, "a timeout is retried exactly once");
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
    assert.deepEqual(clean, { version: here.version, commit: head, dirty: false, source: "git", unresolved: false });

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

// A throwaway repository under tmpdir, with build.mjs + identity.json copied in so that
// `buildIdentity()` runs against IT (git is used here only to build the fixture).
function makeRepo(prefix) {
  // realpath: git writes the resolved path into worktree pointer files (macOS /var -> /private/var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "--initial-branch=main");
  git("config", "user.email", "test@test.com");
  git("config", "user.name", "Test");
  git("config", "core.hooksPath", "/dev/null");
  cpSync(join(ROOT, "vinci/worker/build.mjs"), join(root, "worker/build.mjs"));
  cpSync(join(ROOT, "vinci/identity.json"), join(root, "identity.json"));
  const load = () => import(pathToFileURL(join(root, "worker/build.mjs")).href);
  return { root, git, load };
}

await test("T9 HEAD is read from .git files: unborn, detached, packed ref, worktree gitdir pointer", async () => {
  const repo = makeRepo("worker-build-head-");
  try {
    // Unborn HEAD (`ref: refs/heads/main` with no ref file and no packed-refs): a .git exists but
    // no commit can be resolved => source package, unresolved true, explicit UNRESOLVED tag.
    const mod = await repo.load();
    const unborn = mod.buildIdentity();
    assert.equal(unborn.commit, null, JSON.stringify(unborn));
    assert.equal(unborn.source, "package");
    assert.equal(unborn.unresolved, true);
    assert.equal(mod.formatWorkerBuild(unborn), `${here.version}-UNRESOLVED`);

    writeFileSync(join(repo.root, "a.txt"), "a\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "one");
    const first = repo.git("rev-parse", "HEAD");
    writeFileSync(join(repo.root, "a.txt"), "b\n");
    repo.git("commit", "-q", "-am", "two");
    const second = repo.git("rev-parse", "HEAD");
    assert.notEqual(first, second);

    // Loose ref.
    assert.equal(existsSync(join(repo.root, ".git/refs/heads/main")), true);
    assert.equal(mod.buildIdentity().commit, second);

    // Packed ref: after `pack-refs --all` the loose file is gone and only packed-refs knows main.
    repo.git("pack-refs", "--all");
    assert.equal(existsSync(join(repo.root, ".git/refs/heads/main")), false, "fixture: ref must be packed");
    assert.match(readFileSync(join(repo.root, ".git/packed-refs"), "utf8"), new RegExp(`${second} refs/heads/main`));
    const packed = mod.buildIdentity();
    assert.equal(packed.commit, second, JSON.stringify(packed));
    assert.equal(packed.source, "git");
    assert.equal(packed.unresolved, false);

    // Detached HEAD: .git/HEAD holds the sha itself.
    repo.git("checkout", "-q", "--detach", first);
    assert.equal(readFileSync(join(repo.root, ".git/HEAD"), "utf8").trim(), first, "fixture: HEAD must be detached");
    assert.equal(mod.buildIdentity().commit, first);

    // Linked worktree: `.git` is a FILE with `gitdir: <main>/.git/worktrees/<name>`; HEAD lives
    // there, the branch ref lives in the main repository's refs (or packed-refs).
    const worktreeRoot = join(repo.root, "..", `${repo.root.split("/").pop()}-wt`);
    repo.git("worktree", "add", "-q", "-b", "wt-branch", worktreeRoot, second);
    try {
      assert.equal(readFileSync(join(worktreeRoot, ".git"), "utf8").startsWith("gitdir:"), true, "fixture: .git must be a pointer file");
      const dirs = mod.findGitDir(join(worktreeRoot, "worker"));
      assert.match(dirs.gitDir, /\/\.git\/worktrees\//, JSON.stringify(dirs));
      assert.equal(dirs.commonDir, join(repo.root, ".git"));
      assert.equal(mod.readHeadCommit(dirs), second);
      // The copied module resolves from ITS OWN location; the worktree checkout has the copies too.
      const wtMod = await import(pathToFileURL(join(worktreeRoot, "worker/build.mjs")).href);
      const wt = wtMod.buildIdentity();
      assert.equal(wt.commit, second, JSON.stringify(wt));
      assert.equal(wt.source, "git");
      // Pack the worktree branch too: the ref is now only in the MAIN repo's packed-refs.
      repo.git("pack-refs", "--all");
      assert.equal(existsSync(join(repo.root, ".git/refs/heads/wt-branch")), false, "fixture: ref must be packed");
      assert.equal(wtMod.readHeadCommit(wtMod.findGitDir(worktreeRoot)), second);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }

    // A HEAD that is not a sha and not a ref, and a ref that is not 40-hex: null, never garbage.
    writeFileSync(join(repo.root, ".git/HEAD"), "ref: refs/heads/nope\n");
    assert.equal(mod.readHeadCommit(mod.findGitDir(repo.root)), null);
    writeFileSync(join(repo.root, ".git/HEAD"), "abc123\n");
    assert.equal(mod.readHeadCommit(mod.findGitDir(repo.root)), null);
    assert.equal(readHeadCommit(findGitDir(repo.root)), null, "the module under test agrees with its copy");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

await test("T10 git refuses (dubious ownership, simulated by PATH-shadowing git): commit still resolves from .git/HEAD, dirty is null", async () => {
  const repo = makeRepo("worker-build-refuse-");
  const shadow = mkdtempSync(join(tmpdir(), "worker-build-gitstub-"));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(repo.root, "a.txt"), "a\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "one");
    const head = repo.git("rev-parse", "HEAD");
    // Make the checkout dirty in a way a WORKING git would report, so `dirty: null` below can
    // only come from the refusal, not from a clean tree.
    writeFileSync(join(repo.root, "a.txt"), "changed\n");
    assert.equal(repo.git("status", "--porcelain", "--untracked-files=no").length > 0, true);

    // The stub answers every invocation the way git answers an unprivileged user on a
    // root-owned checkout, and records the argv it saw.
    const argvLog = join(shadow, "argv.log");
    writeFileSync(
      join(shadow, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${argvLog}"\necho "fatal: detected dubious ownership in repository at '${repo.root}'" >&2\nexit 128\n`,
    );
    chmodSync(join(shadow, "git"), 0o755);
    process.env.PATH = `${shadow}:${originalPath}`;
    const probe = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
    assert.equal(probe.status, 128, "fixture: the stub must shadow git on PATH");
    assert.match(probe.stderr, /dubious ownership/);

    const mod = await repo.load();
    const identity = mod.buildIdentity();
    assert.equal(identity.commit, head, `commit must come from .git/HEAD, not git: ${JSON.stringify(identity)}`);
    assert.equal(identity.source, "git");
    assert.equal(identity.unresolved, false);
    assert.equal(identity.dirty, null, `git refused, so dirty is unknown, never false: ${JSON.stringify(identity)}`);
    assert.equal(mod.formatWorkerBuild(identity), head);
    // The one git call that was made carried safe.directory=* (the real fix for the box), and
    // no git call was made for the commit.
    const calls = readFileSync(argvLog, "utf8").trim().split("\n").filter((line) => !/^rev-parse HEAD$/.test(line));
    assert.equal(calls.length, 1, `expected exactly one git call (status), got: ${calls.join(" | ")}`);
    assert.match(calls[0], /^-c safe\.directory=\* -C \S+ status --porcelain --untracked-files=no$/, calls[0]);
  } finally {
    process.env.PATH = originalPath;
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(shadow, { recursive: true, force: true });
  }
});

await test("T11 daemon on a checkout whose HEAD cannot be resolved: online AND terminal posts say worker_build=<version>-UNRESOLVED", async () => {
  // The whole worker copied next to an identity.json, inside a fresh repo with an unborn HEAD:
  // a .git exists, no commit can be read.
  const copyRoot = mkdtempSync(join(tmpdir(), "worker-build-unresolved-"));
  const fixture = new WorkerTestFixture("build-unresolved");
  try {
    const init = spawnSync("git", ["-C", copyRoot, "init", "-q", "--initial-branch=main"], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    cpSync(join(ROOT, "vinci/worker"), join(copyRoot, "worker"), { recursive: true });
    cpSync(join(ROOT, "vinci/identity.json"), join(copyRoot, "identity.json"));
    const copied = await import(pathToFileURL(join(copyRoot, "worker/build.mjs")).href);
    const identity = copied.buildIdentity();
    assert.equal(identity.commit, null, JSON.stringify(identity));
    assert.equal(identity.unresolved, true);

    fixture.linkTools(TOOLS);
    fixture.createRepo("test", "repo");
    await fixture.startBus([handoff("41", "w1", "repo: test/repo\nevidence: none\ndeadline: 2020-01-01T00:00:00Z\n\nTask")]);
    const proc = spawn(
      "node",
      [join(copyRoot, "worker/worker.mjs"), "start", "--id", "w1", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir],
      { env: fixture.getEnv(), stdio: "pipe" },
    );
    let stderr = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolveClose) => proc.once("close", resolveClose));
    assert.equal(code, 0, stderr);
    const posts = fixture.getPostedMessages();
    const online = posts.find((post) => post.subject === "worker w1 online");
    assert.ok(online, JSON.stringify(posts));
    const tag = new RegExp(`(^| )worker_build=${here.version.replace(/\./g, "\\.")}-UNRESOLVED( |$)`);
    assert.match(online.body, tag, online.body);
    assert.doesNotMatch(online.body, new RegExp(`worker_build=${here.version.replace(/\./g, "\\.")}( |$)`), "a bare version would read as a resolved identity");
    const terminal = posts.find((post) => post.subject === "task 41 blocked");
    assert.ok(terminal, JSON.stringify(posts));
    assert.match(terminal.body, tag, terminal.body);
    assert.equal(fixture.getVinciCalls().length, 0);
  } finally {
    await fixture.cleanup();
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

await test("T12 fetchServerBuild retries once after ~1 s on timeout: a first request that hangs and a second that answers => the payload", async () => {
  let requests = 0;
  const server = createHttpServer((_request, response) => {
    requests += 1;
    if (requests === 1) return; // hang: never answer the first request
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ git_sha: "a".repeat(40), dirty: false }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const startedAt = Date.now();
    const result = await fetchServerBuild(base, { timeoutMs: 300, retryDelayMs: 1000 });
    const elapsedMs = Date.now() - startedAt;
    assert.deepEqual(result, { git_sha: "a".repeat(40), dirty: false }, JSON.stringify(result));
    assert.equal(requests, 2, "the hung request must be followed by exactly one retry");
    assert.ok(elapsedMs >= 1300 && elapsedMs < 3000, `retry must wait ~1 s after the timeout (took ${elapsedMs}ms)`);

    // Both attempts hang: `{ error, attempts: 2 }`, and only two requests were ever made.
    requests = 0;
    const server2 = createHttpServer(() => {});
    await new Promise((resolveListen) => server2.listen(0, "127.0.0.1", resolveListen));
    try {
      const failed = await fetchServerBuild(`http://127.0.0.1:${server2.address().port}`, { timeoutMs: 200, retryDelayMs: 100 });
      assert.match(failed.error, /timeout after 200ms/, JSON.stringify(failed));
      assert.equal(failed.attempts, 2);
    } finally {
      server2.closeAllConnections();
      await new Promise((resolveClose) => server2.close(resolveClose));
    }

    // A server ANSWER (non-2xx) is not retried.
    const server3 = createHttpServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolveListen) => server3.listen(0, "127.0.0.1", resolveListen));
    try {
      const notFound = await fetchServerBuild(`http://127.0.0.1:${server3.address().port}`, { timeoutMs: 200, retryDelayMs: 100 });
      assert.deepEqual(notFound, { error: `GET http://127.0.0.1:${server3.address().port}/v1/version failed: 404`, attempts: 1 });
    } finally {
      await new Promise((resolveClose) => server3.close(resolveClose));
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});
