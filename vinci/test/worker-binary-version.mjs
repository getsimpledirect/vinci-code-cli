// #18: `vinci_binary` — the version of the `vinci` BINARY the daemon spawns (`<PATH vinci>
// --version`), as opposed to `vinci_version` / `worker_build`, which name the daemon CHECKOUT.
// Probed under a minimal env at start and immediately before every spawn; stamped on the task
// record, the online post and every terminal post; task spawns run with VINCI_UPDATE_DISABLED=1;
// version->version changes are announced once each, persisted across restarts.
//
// The fake launcher's "install" is `$HOME/fake-vinci-version.json` (see the fixture): the base
// answer plus `flips` that apply once a marker path exists, which is how a test makes "the
// operator updated the launcher between X and Y" happen for any X and Y the daemon does.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";
import { formatVinciBinary, probeEnv, vinciBinaryVersion } from "../worker/build.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
const WORKER = join(ROOT, "vinci/worker/worker.mjs");

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ worker-binary-version: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ worker-binary-version: ${name}: ${error.stack ?? error.message}`);
  }
}
process.on("beforeExit", () => {
  if (failed > 0) process.exitCode = 1;
});

function runOnce(fixture, workerId, overrides = {}) {
  const proc = spawn(
    "node",
    [WORKER, "start", "--id", workerId, "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir],
    { env: fixture.getEnv(overrides), stdio: "pipe" },
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
    subject: "binary version task",
    body,
    ts: "2026-08-28T10:00:00Z",
    posted_by: "scheduler",
  };
}

// The fake launcher's install file lives under the fixture's HOME (= <tempDir>/home).
function installFake(fixture, install) {
  const home = join(fixture.tempDir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "fake-vinci-version.json"), `${JSON.stringify(install)}\n`);
}

// Run fn with process.env swapped for the fixture's env (vinciBinaryVersion reads process.env).
function withEnv(env, fn) {
  const saved = process.env;
  process.env = env;
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

const readTask = (fixture, id) => JSON.parse(readFileSync(join(fixture.tempDir, "tasks", `${id}.json`), "utf8"));
const readAnnounced = (fixture) => JSON.parse(readFileSync(join(fixture.tempDir, "vinci-binary.json"), "utf8"));
const changePosts = (posts, workerId) => posts.filter((post) => post.subject.startsWith(`worker ${workerId} vinci binary changed`));
const onlinePost = (posts, workerId) => posts.find((post) => post.subject === `worker ${workerId} online`);
const finalFor = (posts, id) => posts.find((post) => new RegExp(`^task ${id} `).test(post.subject) && !/claimed$/.test(post.subject));
// Every -p run must have executed the version its task record names, under VINCI_UPDATE_DISABLED=1.
function assertRunsMatchRecords(fixture) {
  const runs = fixture.getVinciCalls();
  assert.ok(runs.length > 0, "expected at least one task run");
  for (const run of runs) {
    const taskId = run.argv[run.argv.indexOf("--session-id") + 1];
    assert.equal(run.updateDisabled, "1", `task ${taskId} spawned without VINCI_UPDATE_DISABLED=1: ${JSON.stringify(run)}`);
    assert.equal(readTask(fixture, taskId).vinci_binary.version, run.version, `task ${taskId}: recorded vinci_binary != the version the payload executed`);
  }
}

await test("U1 vinciBinaryVersion(): PATH-resolved binary, minimal probe env (no daemon secrets), {version, path}; error forms never throw", async () => {
  const fixture = new WorkerTestFixture("binver-unit");
  try {
    fixture.linkTools(TOOLS);
    const probes = join(fixture.tempDir, "version-probes.txt");
    installFake(fixture, { version: "1.2.3-probe", record: probes });
    const planted = {
      VINCI_BUS_TOKEN: "bus-secret",
      VINCI_GOVERNOR_TOKEN: "gov-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GITHUB_TOKEN: "gh-secret",
      OPENROUTER_API_KEY: "provider-secret",
      VINCI_UPDATE_DISABLED: "0",
    };
    const env = fixture.getEnv(planted);
    const result = withEnv(env, () => vinciBinaryVersion());
    assert.deepEqual(result, { version: "1.2.3-probe", path: join(fixture.toolsDir, "vinci") });
    assert.equal(formatVinciBinary(result), "1.2.3-probe");

    const recorded = readFileSync(probes, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0].argv, ["--version"]);
    const seen = recorded[0].env;
    assert.equal(seen.VINCI_UPDATE_DISABLED, "1", "the probe must run with VINCI_UPDATE_DISABLED=1 (the daemon's own 0 must not win)");
    for (const key of Object.keys(planted)) {
      if (key === "VINCI_UPDATE_DISABLED") continue;
      assert.equal(key in seen, false, `planted secret ${key} reached the launcher`);
    }
    const allowed = new Set(["PATH", "HOME", "TMPDIR", "LANG", "VINCI_UPDATE_DISABLED"]);
    // macOS CoreFoundation stamps __CF_USER_TEXT_ENCODING into every process it links into; it
    // is not inherited from the daemon (it appears under `env -i` too).
    const leaked = Object.keys(seen).filter((key) => !allowed.has(key) && !key.startsWith("__CF_"));
    assert.deepEqual(leaked, [], `non-allowlisted variables reached the launcher: ${leaked.join(", ")}`);
    assert.equal(seen.PATH, env.PATH);
    assert.equal(seen.HOME, env.HOME);
    assert.deepEqual(Object.keys(probeEnv({ PATH: "p", HOME: "h", FOO: "x" })).sort(), ["HOME", "PATH", "VINCI_UPDATE_DISABLED"]);

    // No binary on PATH: {error}, never throws.
    const missing = withEnv({ ...env, PATH: join(fixture.tempDir, "empty-path") }, () => vinciBinaryVersion());
    assert.match(missing.error, /Executable not found on PATH: vinci/, JSON.stringify(missing));
    assert.match(formatVinciBinary(missing), /^unknown: /);

    // Non-zero exit: {error} naming the exit code.
    installFake(fixture, { version: "1.2.3-probe", exit: 3 });
    const broken = withEnv(env, () => vinciBinaryVersion());
    assert.match(broken.error, /--version exited 3/, JSON.stringify(broken));

    // Not a version token (a banner): {error: "unparseable version: <first 40 chars>"}.
    installFake(fixture, { version: "vinci 1.2.3 (build 42) some very long banner text here" });
    const banner = withEnv(env, () => vinciBinaryVersion());
    assert.equal(banner.error, "unparseable version: vinci 1.2.3 (build 42) some very long ba", JSON.stringify(banner));
    assert.equal(banner.version, undefined);
    for (const bad of ["1.2", "v1.2.3", "1.2.3 dirty", "1.2.3-"]) {
      installFake(fixture, { version: bad });
      assert.match(withEnv(env, () => vinciBinaryVersion()).error ?? "", /^unparseable version: /, `expected ${JSON.stringify(bad)} to be rejected`);
    }
    for (const good of ["0.0.52", "10.20.30", "1.2.3-rc.1", "0.0.0-fake"]) {
      installFake(fixture, { version: good });
      assert.equal(withEnv(env, () => vinciBinaryVersion()).version, good);
    }

    // A hung --version: the timeout fires and is reported; never throws.
    installFake(fixture, { version: "1.2.3-probe", sleep: 5000 });
    const startedAt = Date.now();
    const hung = withEnv(env, () => vinciBinaryVersion({ timeoutMs: 500 }));
    assert.ok(Date.now() - startedAt < 4000, "the probe must be bounded by timeoutMs");
    assert.match(hung.error, /timeout after 500ms/, JSON.stringify(hung));
    assert.equal(formatVinciBinary({}), "unknown");
    assert.equal(formatVinciBinary(null), "unknown");
  } finally {
    await fixture.cleanup();
  }
});

await test("T1 online post, task record and final post carry vinci_binary; the task spawn runs with VINCI_UPDATE_DISABLED=1 so the launcher cannot self-update under it", async () => {
  const fixture = new WorkerTestFixture("binver-online");
  try {
    fixture.linkTools(TOOLS);
    fixture.createRepo("test", "repo");
    installFake(fixture, { version: "0.0.52" });
    await fixture.startBus([handoff("41", "w1")]);
    // An un-disabled launcher would update itself to 9.9.9 BEFORE executing the payload.
    const { code, stderr } = await runOnce(fixture, "w1", { FAKE_VINCI_SELF_UPDATE_TO: "9.9.9" });
    assert.equal(code, 0, stderr);
    const posts = fixture.getPostedMessages();
    const online = posts.filter((post) => post.subject === "worker w1 online");
    assert.equal(online.length, 1, JSON.stringify(posts));
    assert.match(online[0].body, /(^| )vinci_binary=0\.0\.52( |$)/, online[0].body);
    assert.match(online[0].body, /(^| )worker_build=/, "worker_build stays next to vinci_binary");

    const snapshot = readTask(fixture, "41");
    assert.ok(snapshot.terminal, JSON.stringify(snapshot));
    assert.deepEqual(snapshot.vinci_binary, { version: "0.0.52", path: join(fixture.toolsDir, "vinci") });
    assert.equal(typeof snapshot.vinci_version, "string", "vinci_version (checkout identity) is kept");
    assert.equal(snapshot.vinci_version, snapshot.worker_build.version);

    const final = finalFor(posts, "41");
    assert.ok(final, JSON.stringify(posts));
    assert.match(final.body, /(^| )vinci_binary=0\.0\.52( |$)/, final.body);
    assert.match(final.body, /(^| )worker_build=/, final.body);
    assert.equal(changePosts(posts, "w1").length, 0, "no change post when the version is stable");

    // The version probe is not a task run; the one run executed 0.0.52 under VINCI_UPDATE_DISABLED=1.
    const runs = fixture.getVinciCalls();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].updateDisabled, "1", JSON.stringify(runs[0]));
    assert.equal(runs[0].version, "0.0.52", `the launcher self-updated under a task: ${JSON.stringify(runs[0])}`);
    assertRunsMatchRecords(fixture);
    assert.deepEqual(readAnnounced(fixture).version, "0.0.52", "the first successful probe is persisted as the baseline");
  } finally {
    await fixture.cleanup();
  }
});

await test("T2 operator update between two tasks: exactly one change post, each record names the binary that executed it", async () => {
  const fixture = new WorkerTestFixture("binver-change");
  try {
    fixture.linkTools(TOOLS);
    fixture.createRepo("test", "repo");
    // The launcher becomes 0.0.52 once task 51's session transcript exists, i.e. after task 51
    // ran and before anything of task 52 is probed.
    installFake(fixture, {
      version: "0.0.51",
      flips: [{ whenExists: join(fixture.tempDir, "sessions", "51", "51", "session.jsonl"), version: "0.0.52" }],
    });
    await fixture.startBus([handoff("51", "w1"), handoff("52", "w1"), handoff("53", "w1")]);
    const { code, stderr } = await runOnce(fixture, "w1");
    assert.equal(code, 0, stderr);
    const posts = fixture.getPostedMessages();
    assert.match(onlinePost(posts, "w1").body, /(^| )vinci_binary=0\.0\.51( |$)/);

    const changes = changePosts(posts, "w1");
    assert.equal(changes.length, 1, JSON.stringify(posts.map((post) => post.subject)));
    assert.equal(changes[0].kind, "status");
    assert.equal(changes[0].subject, "worker w1 vinci binary changed 0.0.51 -> 0.0.52");
    assert.match(changes[0].body, /(^| )vinci_binary=0\.0\.52( |$)/, changes[0].body);
    assert.match(changes[0].body, /(^| )previous=0\.0\.51( |$)/, changes[0].body);
    // Posted after task 51's terminal post and after task 52 was claimed (the probe is pre-spawn).
    const subjects = posts.map((post) => post.subject);
    const at = subjects.indexOf(changes[0].subject);
    assert.ok(at > subjects.findIndex((subject) => /^task 51 (completed|failed|blocked|unverified)$/.test(subject)), subjects.join(" | "));
    assert.ok(at > subjects.indexOf("task 52 claimed"), subjects.join(" | "));
    assert.ok(at < subjects.findIndex((subject) => /^task 52 (completed|failed|blocked|unverified)$/.test(subject)), subjects.join(" | "));

    assert.equal(readTask(fixture, "51").vinci_binary.version, "0.0.51");
    assert.equal(readTask(fixture, "52").vinci_binary.version, "0.0.52");
    assert.equal(readTask(fixture, "53").vinci_binary.version, "0.0.52");
    assert.match(finalFor(posts, "51").body, /(^| )vinci_binary=0\.0\.51( |$)/, finalFor(posts, "51").body);
    assert.match(finalFor(posts, "52").body, /(^| )vinci_binary=0\.0\.52( |$)/, finalFor(posts, "52").body);
    assert.match(finalFor(posts, "53").body, /(^| )vinci_binary=0\.0\.52( |$)/, finalFor(posts, "53").body);
    assertRunsMatchRecords(fixture);
    assert.equal(readAnnounced(fixture).version, "0.0.52");
  } finally {
    await fixture.cleanup();
  }
});

await test("T3 update between repo prep and spawn: the record carries the pre-spawn probe (the executed version), not the startup one", async () => {
  const fixture = new WorkerTestFixture("binver-prespawn");
  try {
    fixture.linkTools(TOOLS);
    fixture.createRepo("test", "repo");
    // The clone directory exists only after prepareRepository: a probe before it says 0.0.51,
    // a probe after it (and the run itself) says 0.0.52.
    const cloneDir = join(fixture.tempDir, "repos", "repo");
    assert.equal(existsSync(cloneDir), false);
    installFake(fixture, { version: "0.0.51", flips: [{ whenExists: cloneDir, version: "0.0.52" }] });
    await fixture.startBus([handoff("71", "w1")]);
    const { code, stderr } = await runOnce(fixture, "w1");
    assert.equal(code, 0, stderr);
    const posts = fixture.getPostedMessages();
    assert.match(onlinePost(posts, "w1").body, /(^| )vinci_binary=0\.0\.51( |$)/, "the online post is the startup probe");
    assert.equal(readTask(fixture, "71").vinci_binary.version, "0.0.52", "the task record must be the pre-spawn probe");
    assert.match(finalFor(posts, "71").body, /(^| )vinci_binary=0\.0\.52( |$)/, finalFor(posts, "71").body);
    assert.equal(fixture.getVinciCalls()[0].version, "0.0.52");
    assertRunsMatchRecords(fixture);
    const changes = changePosts(posts, "w1");
    assert.equal(changes.length, 1, JSON.stringify(posts.map((post) => post.subject)));
    assert.equal(changes[0].subject, "worker w1 vinci binary changed 0.0.51 -> 0.0.52");
  } finally {
    await fixture.cleanup();
  }
});

await test("T4 probe error at start, recovery before spawn: daemon starts, online/early-blocker say unknown:…, record carries {error} or the recovered version, ZERO change posts", async () => {
  const fixture = new WorkerTestFixture("binver-error");
  try {
    fixture.linkTools(TOOLS);
    fixture.createRepo("test", "repo");
    // Startup probe fails (exit 2); once task 62's clone exists the launcher answers 0.0.52.
    installFake(fixture, { version: "0.0.52", exit: 2, flips: [{ whenExists: join(fixture.tempDir, "repos", "repo"), exit: 0 }] });
    await fixture.startBus([
      handoff("61", "w1", "repo: test/repo\nevidence: none\ndeadline: 2020-01-01T00:00:00Z\n\nTask"),
      handoff("62", "w1"),
    ]);
    const { code, stderr } = await runOnce(fixture, "w1");
    assert.equal(code, 0, stderr);
    const posts = fixture.getPostedMessages();
    const online = posts.filter((post) => post.subject === "worker w1 online");
    assert.equal(online.length, 1, JSON.stringify(posts));
    assert.match(online[0].body, /(^| )vinci_binary=unknown: .*--version exited 2/, online[0].body);

    // 61 never spawns: it carries the last observed probe (the startup error) on record and post.
    const blocker = posts.find((post) => post.subject === "task 61 blocked");
    assert.ok(blocker, JSON.stringify(posts));
    assert.match(blocker.body, /deadline is in the past/);
    assert.match(blocker.body, /(^| )vinci_binary=unknown: .*--version exited 2/, blocker.body);
    const early = readTask(fixture, "61");
    assert.equal(early.vinci_binary.version, undefined);
    assert.match(early.vinci_binary.error, /--version exited 2/, JSON.stringify(early.vinci_binary));

    // 62 spawns: the pre-spawn probe recovered; recovery from an error is a baseline, not a change.
    assert.equal(readTask(fixture, "62").vinci_binary.version, "0.0.52");
    assert.match(finalFor(posts, "62").body, /(^| )vinci_binary=0\.0\.52( |$)/, finalFor(posts, "62").body);
    assertRunsMatchRecords(fixture);
    assert.equal(changePosts(posts, "w1").length, 0, JSON.stringify(posts.map((post) => post.subject)));
    assert.equal(readAnnounced(fixture).version, "0.0.52");
  } finally {
    await fixture.cleanup();
  }
});

await test("T5 announced identity is persisted: error never resets it; A->B once even across a restart and a failed post; A->B->A is two", async () => {
  const fixture = new WorkerTestFixture("binver-persist");
  try {
    fixture.linkTools(TOOLS);
    fixture.createRepo("test", "repo");
    await fixture.startBus([]);
    const postsSince = (from) => fixture.getPostedMessages().slice(from);
    let mark = 0;

    // Run 1: baseline A. No change post.
    installFake(fixture, { version: "0.0.51" });
    assert.equal((await runOnce(fixture, "w1")).code, 0);
    assert.equal(changePosts(postsSince(mark), "w1").length, 0);
    assert.equal(readAnnounced(fixture).version, "0.0.51");
    mark = fixture.getPostedMessages().length;

    // Run 2: probe errors. Recorded as unknown, not announced, baseline untouched.
    installFake(fixture, { version: "0.0.51", exit: 1 });
    assert.equal((await runOnce(fixture, "w1")).code, 0);
    assert.match(onlinePost(postsSince(mark), "w1").body, /vinci_binary=unknown: /);
    assert.equal(changePosts(postsSince(mark), "w1").length, 0, "an {error} must never be announced as a change");
    assert.equal(readAnnounced(fixture).version, "0.0.51", "an {error} must never reset the last-announced value");
    mark = fixture.getPostedMessages().length;

    // Run 3: recovered to A. Still no change.
    installFake(fixture, { version: "0.0.51" });
    assert.equal((await runOnce(fixture, "w1")).code, 0);
    assert.equal(changePosts(postsSince(mark), "w1").length, 0, "error-then-recover to the same version is not a change");
    mark = fixture.getPostedMessages().length;

    // Run 4: the launcher is now B, but the bus refuses the change post. The daemon still runs
    // (exit 0, a task is processed) and the baseline stays A so the post is retried.
    installFake(fixture, { version: "0.0.52" });
    fixture.busMessages.push(handoff("81", "w1"));
    fixture.failPostSubjects = /vinci binary changed/;
    const run4 = await runOnce(fixture, "w1");
    assert.equal(run4.code, 0, run4.stderr);
    assert.equal(changePosts(postsSince(mark), "w1").length, 0);
    // Attempted at start, refused; retried before task 81's spawn, refused again.
    assert.equal(fixture.failedPosts.length, 2, "the change post is attempted at start and retried before the spawn");
    assert.ok(fixture.failedPosts.every((post) => post.subject === "worker w1 vinci binary changed 0.0.51 -> 0.0.52"));
    assert.match(run4.stderr, /vinci binary change post failed, will retry/);
    assert.ok(readTask(fixture, "81").terminal, "a refused change post must not fail the task");
    assert.equal(readTask(fixture, "81").vinci_binary.version, "0.0.52");
    assert.equal(readAnnounced(fixture).version, "0.0.51", "a failed post must not advance the announced identity");
    fixture.failPostSubjects = null;
    mark = fixture.getPostedMessages().length;

    // Run 5: restart, still B, bus healthy: the change is announced exactly once, then persisted.
    assert.equal((await runOnce(fixture, "w1")).code, 0);
    let changes = changePosts(postsSince(mark), "w1");
    assert.equal(changes.length, 1, JSON.stringify(postsSince(mark).map((post) => post.subject)));
    assert.equal(changes[0].subject, "worker w1 vinci binary changed 0.0.51 -> 0.0.52");
    assert.equal(readAnnounced(fixture).version, "0.0.52");
    mark = fixture.getPostedMessages().length;

    // Run 6: still B: nothing more (once per change, not once per start).
    assert.equal((await runOnce(fixture, "w1")).code, 0);
    assert.equal(changePosts(postsSince(mark), "w1").length, 0);
    mark = fixture.getPostedMessages().length;

    // Run 7: back to A: a second change (A->B->A is two).
    installFake(fixture, { version: "0.0.51" });
    assert.equal((await runOnce(fixture, "w1")).code, 0);
    changes = changePosts(postsSince(mark), "w1");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].subject, "worker w1 vinci binary changed 0.0.52 -> 0.0.51");
    assert.equal(changePosts(fixture.getPostedMessages(), "w1").length, 2, "A->B->A is exactly two announcements over the whole history");
    assert.equal(readAnnounced(fixture).version, "0.0.51");
  } finally {
    await fixture.cleanup();
  }
});
