// #18: `vinci_binary` — the version of the `vinci` BINARY the daemon spawns (`<PATH vinci>
// --version`), as opposed to `vinci_version` / `worker_build`, which name the daemon CHECKOUT.
// Computed at start, re-checked before every task, stamped on the task record, the online post and
// every terminal post; a change between two tasks posts exactly one drift status.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";
import { formatVinciBinary, vinciBinaryVersion } from "../worker/build.mjs";

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
const changePosts = (fixture, workerId) =>
  fixture.getPostedMessages().filter((post) => post.subject.startsWith(`worker ${workerId} vinci binary changed`));

await test("U1 vinciBinaryVersion(): resolves the PATH binary, runs --version with VINCI_UPDATE_DISABLED=1, returns {version, path}", async () => {
  const fixture = new WorkerTestFixture("binver-unit");
  try {
    fixture.linkTools(TOOLS);
    const probes = join(fixture.tempDir, "version-probes.txt");
    const env = fixture.getEnv({ FAKE_VINCI_VERSION: "1.2.3-probe", FAKE_VINCI_VERSION_RECORD: probes, VINCI_UPDATE_DISABLED: "" });
    const result = withEnv(env, () => vinciBinaryVersion());
    assert.deepEqual(result, { version: "1.2.3-probe", path: join(fixture.toolsDir, "vinci") });
    assert.equal(formatVinciBinary(result), "1.2.3-probe");
    const recorded = readFileSync(probes, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0].argv, ["--version"]);
    assert.equal(recorded[0].updateDisabled, "1", "the probe must run with VINCI_UPDATE_DISABLED=1");

    // No binary on PATH: {error}, never throws.
    const missing = withEnv({ ...env, PATH: join(fixture.tempDir, "empty-path") }, () => vinciBinaryVersion());
    assert.match(missing.error, /Executable not found on PATH: vinci/, JSON.stringify(missing));
    assert.match(formatVinciBinary(missing), /^unknown: /);

    // Non-zero exit: {error} naming the exit code.
    const broken = withEnv({ ...env, FAKE_VINCI_VERSION_EXIT: "3" }, () => vinciBinaryVersion());
    assert.match(broken.error, /--version exited 3/, JSON.stringify(broken));

    // A hung --version: the timeout fires and is reported; never throws.
    const startedAt = Date.now();
    const hung = withEnv({ ...env, FAKE_VINCI_VERSION_SLEEP: "5000" }, () => vinciBinaryVersion({ timeoutMs: 500 }));
    assert.ok(Date.now() - startedAt < 4000, "the probe must be bounded by timeoutMs");
    assert.match(hung.error, /timeout after 500ms/, JSON.stringify(hung));
    assert.equal(formatVinciBinary({}), "unknown");
    assert.equal(formatVinciBinary(null), "unknown");
  } finally {
    await fixture.cleanup();
  }
});

await test("T1 online post carries vinci_binary=<v>; task record carries vinci_binary {version, path}; final post carries vinci_binary=", async () => {
  const fixture = new WorkerTestFixture("binver-online");
  try {
    fixture.linkTools(TOOLS);
    fixture.createRepo("test", "repo");
    await fixture.startBus([handoff("41", "w1")]);
    const { code, stderr } = await runOnce(fixture, "w1", { FAKE_VINCI_VERSION: "0.0.52" });
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

    const finals = posts.filter((post) => /^task 41 /.test(post.subject) && !/claimed$/.test(post.subject));
    assert.equal(finals.length, 1, JSON.stringify(posts));
    assert.match(finals[0].body, /(^| )vinci_binary=0\.0\.52( |$)/, finals[0].body);
    assert.match(finals[0].body, /(^| )worker_build=/, finals[0].body);
    assert.equal(changePosts(fixture, "w1").length, 0, "no change post when the version is stable");
    // The version probe is not a task run.
    assert.equal(fixture.getVinciCalls().length, 1);
  } finally {
    await fixture.cleanup();
  }
});

await test("T2 the binary self-updates between two tasks: exactly one 'vinci binary changed' post, each record names the binary that ran it", async () => {
  const fixture = new WorkerTestFixture("binver-change");
  try {
    fixture.linkTools(TOOLS);
    fixture.createRepo("test", "repo");
    const versionFile = join(fixture.tempDir, "fake-vinci-version.txt");
    writeFileSync(versionFile, "0.0.51\n");
    await fixture.startBus([handoff("51", "w1"), handoff("52", "w1"), handoff("53", "w1")]);
    // Every -p run "self-updates" the launcher to 0.0.52; the probe before task 52 sees it.
    const { code, stderr } = await runOnce(fixture, "w1", { FAKE_VINCI_VERSION_FILE: versionFile, FAKE_VINCI_SELF_UPDATE_TO: "0.0.52" });
    assert.equal(code, 0, stderr);
    const posts = fixture.getPostedMessages();
    assert.match(posts.find((post) => post.subject === "worker w1 online").body, /(^| )vinci_binary=0\.0\.51( |$)/);

    const changes = changePosts(fixture, "w1");
    assert.equal(changes.length, 1, JSON.stringify(posts.map((post) => post.subject)));
    assert.equal(changes[0].kind, "status");
    assert.equal(changes[0].subject, "worker w1 vinci binary changed 0.0.51 -> 0.0.52");
    assert.match(changes[0].body, /(^| )vinci_binary=0\.0\.52( |$)/, changes[0].body);
    assert.match(changes[0].body, /(^| )previous=0\.0\.51( |$)/, changes[0].body);
    // Posted before task 52's claim, after task 51's terminal post.
    const subjects = posts.map((post) => post.subject);
    assert.ok(subjects.indexOf(changes[0].subject) > subjects.findIndex((subject) => /^task 51 (completed|failed|blocked|unverified)$/.test(subject)));
    assert.ok(subjects.indexOf(changes[0].subject) < subjects.indexOf("task 52 claimed"));

    assert.equal(readTask(fixture, "51").vinci_binary.version, "0.0.51");
    assert.equal(readTask(fixture, "52").vinci_binary.version, "0.0.52");
    assert.equal(readTask(fixture, "53").vinci_binary.version, "0.0.52");
    const finalFor = (id) => posts.find((post) => new RegExp(`^task ${id} `).test(post.subject) && !/claimed$/.test(post.subject));
    assert.match(finalFor("51").body, /(^| )vinci_binary=0\.0\.51( |$)/, finalFor("51").body);
    assert.match(finalFor("52").body, /(^| )vinci_binary=0\.0\.52( |$)/, finalFor("52").body);
    assert.match(finalFor("53").body, /(^| )vinci_binary=0\.0\.52( |$)/, finalFor("53").body);
  } finally {
    await fixture.cleanup();
  }
});

await test("T3 --version fails: daemon still starts, online post says vinci_binary=unknown: …, record carries {error}, early blocker carries it too", async () => {
  const fixture = new WorkerTestFixture("binver-fail");
  try {
    fixture.linkTools(TOOLS);
    fixture.createRepo("test", "repo");
    await fixture.startBus([
      handoff("61", "w1", "repo: test/repo\nevidence: none\ndeadline: 2020-01-01T00:00:00Z\n\nTask"),
    ]);
    const { code, stderr } = await runOnce(fixture, "w1", { FAKE_VINCI_VERSION_EXIT: "2" });
    assert.equal(code, 0, stderr);
    const posts = fixture.getPostedMessages();
    const online = posts.filter((post) => post.subject === "worker w1 online");
    assert.equal(online.length, 1, JSON.stringify(posts));
    assert.match(online[0].body, /(^| )vinci_binary=unknown: .*--version exited 2/, online[0].body);
    const blocker = posts.find((post) => post.subject === "task 61 blocked");
    assert.ok(blocker, JSON.stringify(posts));
    assert.match(blocker.body, /deadline is in the past/);
    assert.match(blocker.body, /(^| )vinci_binary=unknown: .*--version exited 2/, blocker.body);
    const snapshot = readTask(fixture, "61");
    assert.equal(snapshot.vinci_binary.version, undefined);
    assert.match(snapshot.vinci_binary.error, /--version exited 2/, JSON.stringify(snapshot.vinci_binary));
    // Same failure at start and per task: not a change.
    assert.equal(changePosts(fixture, "w1").length, 0);
    assert.equal(fixture.getVinciCalls().length, 0);
  } finally {
    await fixture.cleanup();
  }
});
