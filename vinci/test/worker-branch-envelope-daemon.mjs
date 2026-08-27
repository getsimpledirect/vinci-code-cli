// Daemon-level binding for the envelope branch header: worker.mjs must pass envelope.branch
// into prepareRepository (a unit test on prepareRepository alone would stay green if the call
// site dropped it), and a hostile branch value must land as a classifiable FAILED, not run.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerTestFixture } from "./lib/worker-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER = join(ROOT, "vinci/bin/vinci");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
const f = new WorkerTestFixture("branch-envelope-daemon");
const run = () => new Promise((resolve) => {
  const child = spawn("bash", [LAUNCHER, "worker", "start", "--id", "w1", "--server", f.busUrl(), "--once", "--state-dir", f.tempDir], { env: f.getEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  child.on("exit", (status) => { clearTimeout(timer); resolve({ status, stderr }); });
});
try {
  f.linkTools(TOOLS); f.createRepo("test", "repo");
  const bare = join(f.reposDir, "test", "repo.git");
  // A pre-existing "held PR" branch on origin, one commit ahead of main.
  const seed = join(f.tempDir, "seed-held");
  execFileSync("git", ["clone", "-q", bare, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "t"]);
  execFileSync("git", ["-C", seed, "checkout", "-qb", "worker/held"]);
  execFileSync("bash", ["-c", `echo held > ${seed}/held.txt`]);
  execFileSync("git", ["-C", seed, "add", "."]);
  execFileSync("git", ["-C", seed, "commit", "-qm", "held work"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "worker/held"]);
  const heldTip = execFileSync("git", ["-C", seed, "rev-parse", "HEAD"]).toString().trim();

  await f.startBus([{ message_id: "m1", to_agent: "worker:w1", kind: "handoff", subject: "held",
    body: "repo: test/repo\nevidence: none\nbranch: worker/held\n\ncontinue held work", ts: new Date(Date.now()-1000).toISOString(), posted_by: "x" }]);
  // seed cursor behavior: fixture default seeds cursor before messages? first-run cursor skips old.
  // Post ts must be AFTER cursor: rely on VINCI_TEST_NO_CURSOR_SEED unset default (fixture seeds past cursor).
  let r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.getVinciCalls().length, 1, "the held-branch handoff must run");
  const repoDir = join(f.tempDir, "repos", "repo");
  const headRef = execFileSync("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
  const headSha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"]).toString().trim();
  assert.equal(headRef, "worker/held", "daemon must check out the ENVELOPE branch, not worker/<taskId>");
  assert.equal(headSha, heldTip, "checkout must sit on the held branch's remote tip");

  // Hostile branch: parse fails → classifiable FAILED post, and vinci never runs.
  f.busMessages.push({ message_id: "m2", to_agent: "worker:w1", kind: "handoff", subject: "hostile",
    body: "repo: test/repo\nevidence: none\nbranch: +main\n\nnever run", ts: new Date().toISOString(), posted_by: "x" });
  r = await run();
  assert.equal(f.getVinciCalls().length, 1, "a hostile branch header must never reach the agent");
  const posts = f.getPostedMessages();
  const final = posts.filter((m) => /m2/.test(JSON.stringify(m))).map((m) => JSON.stringify(m)).join("\n");
  // Parse failures classify as BLOCKED by design: a bad envelope is the SENDER's defect to fix.
  assert.match(final, /BLOCKED|blocked/, `hostile branch must land as a classifiable BLOCKED, got: ${final.slice(0, 300)}`);
  assert.match(final, /branch/, "the terminal post must name the branch defect so the sender can fix it");
  console.log("PASS worker-branch-envelope-daemon");
} finally {
  await f.cleanup();
}
