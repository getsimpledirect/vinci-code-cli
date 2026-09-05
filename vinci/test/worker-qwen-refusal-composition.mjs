// Production negative composition only: the real Qwen extension currently refuses before
// readiness/registration. Fixture services and upload transport are not provider evidence.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CLAIM_PATHS_WITH_TTL, FakeGovernor, WorkerTestFixture } from "./lib/worker-fixture.mjs";
import { provisionWorkerDebrisAuthority } from "./lib/worker-debris-authority-fixture.mjs";
import { executionSpecDigest, workOrderDigest } from "../worker/contracts/digest.mjs";

const root = resolve(import.meta.dirname, "../..");
const launcher = join(root, "vinci/bin/vinci");
for (const explicitLauncherSelection of [false, true]) {
const fixture = new WorkerTestFixture(`qwen-refusal-composition-${explicitLauncherSelection ? "explicit" : "default"}`);
const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL });
const authority = provisionWorkerDebrisAuthority(fixture.tempDir, "6".repeat(64));
const taskId = "qwen-refusal";
const workOrderId = "job_qwen_refusal";
const records = join(fixture.tempDir, "actual-launches.jsonl");
const denied = join(fixture.tempDir, "network-denied.jsonl");
const awsRecords = join(fixture.tempDir, "aws.jsonl");
const jsonLines = (path) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
let bundlePath;
try {
  fixture.linkTools(join(root, "vinci/test/fixtures/worker-test-tools"));
  fixture.recordGit();
  // Unlink the synthetic producer before writing a recording exec shim. Never write through it.
  unlinkSync(join(fixture.toolsDir, "vinci"));
  const recorder = join(fixture.tempDir, "record-launch.cjs");
  writeFileSync(recorder, `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(records)}, JSON.stringify({at:Date.now(), argv:process.argv.slice(2), selected:process.env.VINCI_QWEN_SELECTED, workOrder:process.env.VINCI_QWEN_WORK_ORDER_ID, run:process.env.VINCI_QWEN_RUN_ID, attempt:process.env.VINCI_QWEN_ATTEMPT_ID, secretFd:process.env.VINCI_QWEN_SECRET_FD}) + "\\n");
`);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(fixture.toolsDir, "vinci"), `#!/bin/bash\n${quote(process.execPath)} ${quote(recorder)} "$@"\nexec /bin/bash ${quote(launcher)} "$@" --offline --no-extensions --no-skills --no-prompt-templates --no-themes\n`, { mode: 0o700 });
  // Node network guard is inherited by daemon, CLI, extensions, and fixture tools. Git is
  // separately restricted to the file protocol. No ambient provider credentials are inherited.
  const guard = join(fixture.tempDir, "network-guard.cjs");
  writeFileSync(guard, `const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");
const dgram = require("node:dgram");
const reject = (host) => { fs.appendFileSync(${JSON.stringify(denied)}, JSON.stringify({host:String(host)}) + "\\n"); throw new Error("unexpected network destination: " + host); };
const local = (host) => ["127.0.0.1", "::1", "localhost"].includes(host);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === "object" ? first : {port:first, host:typeof args[1] === "string" ? args[1] : "localhost"};
  if (!options.path && !local(options.host ?? "localhost")) reject(options.host);
  return connect.apply(this,args);
};
const lookup = dns.lookup;
dns.lookup = function(host,...args) { if (!local(host)) reject(host); return lookup.call(this,host,...args); };
const promiseLookup = dns.promises.lookup;
dns.promises.lookup = async function(host,...args) { if (!local(host)) reject(host); return promiseLookup.call(this,host,...args); };
for (const name of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveTxt", "reverse"]) {
  dns[name] = (host) => reject(host);
  dns.promises[name] = async (host) => reject(host);
}
dgram.createSocket = () => reject("UDP");
`);
  const { origin } = fixture.createRepo("getsimpledirect", "vinci-contracts");
  const baseCommit = execFileSync("git", ["--git-dir", origin, "rev-parse", "main"], { encoding: "utf8" }).trim();
  const vectors = join(root, "vinci/test/fixtures/contract-vectors");
  const goldenOrder = JSON.parse(readFileSync(join(vectors, "work-order-1-minimal/input.json"), "utf8"));
  const goldenSpec = JSON.parse(readFileSync(join(vectors, "execution-spec-1-minimal/input.json"), "utf8"));
  assert.equal(workOrderDigest(goldenOrder), goldenSpec.workOrderDigest);
  const order = { ...goldenOrder, id: workOrderId, expiresAt: new Date(Date.now() + 7_200_000).toISOString() };
  const contractDigest = workOrderDigest(order);
  const spec = {
    ...goldenSpec, workOrderId, workOrderDigest: contractDigest, baseCommit,
    modelClass: "qwen-refusal", requiredCapabilities: [], inputArtifacts: [], output: "none", promotion: "none",
    resourceBounds: { ...goldenSpec.resourceBounds, maxRuntimeS: 45, deadline: new Date(Date.now() + 3_600_000).toISOString() },
  };
  const specDigest = executionSpecDigest(spec);
  authority.reserveTask(taskId);
  await governor.start();
  await fixture.startBus([{
    message_id: taskId, to_agent: "worker:w1", kind: "handoff", subject: "Qwen production refusal",
    body: JSON.stringify({ work_order_id: workOrderId, contract_digest: contractDigest, execution_spec_digest: specDigest }),
    ts: new Date().toISOString(), posted_by: "fixture:scheduler",
  }], { [workOrderId]: { work_order: order, execution_spec: spec } });
  const home = join(fixture.tempDir, "home");
  mkdirSync(home, { recursive: true });
  const secret = join(fixture.tempDir, "synthetic-secret");
  writeFileSync(secret, "synthetic-refusal-test-only\n", { mode: 0o600 });
  const env = {
    PATH: `${fixture.toolsDir}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home,
    LANG: "C", LC_ALL: "C", NODE_OPTIONS: `--require=${guard}`,
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", VINCI_SOURCE_CLI: "1",
    VINCI_NO_BOOTSTRAP_HEAL: "1", VINCI_UPDATE_DISABLED: "1", VINCI_NO_RESUME: "1",
    VINCI_NO_VERIFY: "1", VINCI_TOOL_BOOTSTRAP: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file",
    VINCI_BUS_TOKEN: "test-token", VINCI_GOVERNOR_TOKEN: "gov-token",
    VINCI_WORKER_GIT_BASE: `file://${fixture.reposDir}/`,
    VINCI_WORKER_ALLOWED_PROVIDERS: "qwen-h200",
    VINCI_WORKER_MODEL_CLASSES: JSON.stringify({ "qwen-refusal": { provider: "qwen-h200", model: "Qwen/Qwen3.8-27B" } }),
    VINCI_QWEN_SECRET_REF: `file:${secret}`,
    VINCI_EVIDENCE_URI_PREFIX: "s3://fixture-evidence/worker/", FAKE_AWS_RECORD: awsRecords,
    FAKE_GH_RECORD: join(fixture.tempDir, "gh-calls.txt"),
  };
  // Both an empty environment and stale daemon selectors must use the validated envelope.
  // The launcher chooses its extension from env before forwarding the worker's CLI selectors.
  if (explicitLauncherSelection) { env.VINCI_PROVIDER = "openrouter"; env.VINCI_MODEL = "inherited/wrong-model"; }
  for (const [name, value] of Object.entries(process.env)) if (name.startsWith("VINCI_WORKER_DEBRIS_")) env[name] = value;
  env.VINCI_WORKER_DEBRIS_AUTHORITY_CAPABILITY_FD = "3";
  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn("/bin/bash", [launcher, "worker", "start", "--id", "w1", "--server", fixture.busUrl(), "--governor", governor.url, "--once", "--state-dir", fixture.tempDir], {
      env, stdio: ["ignore", "pipe", "pipe", authority.capabilityFd],
    });
    authority.releaseCapabilityToChild();
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", rejectRun);
    child.once("close", (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, output }); });
  });
  const state = JSON.parse(readFileSync(join(fixture.tempDir, "tasks", `${taskId}.json`), "utf8"));
  console.log(JSON.stringify({ explicitLauncherSelection, run: result, state, acquires: governor.acquires, releases: governor.releases, evidence: fixture.evidencePosts, posts: fixture.postedMessages, launches: jsonLines(records), denied: jsonLines(denied) }, null, 2));
  assert.equal(result.code, 0, result.output);
  assert.equal(result.signal, null);
  assert.deepEqual(jsonLines(denied), [], "unexpected network attempt fails the composition");
  assert.match(result.output, /qwen_dispatcher_unavailable/, "both launcher environments must reach the production extension refusal");
  assert.match(result.output, /Unknown provider "qwen-h200"/);
  assert.equal(fixture.contractRequests.length, 1);
  assert.equal(governor.acquires.length, 1);
  assert.equal(governor.claims.length, 1);
  assert.equal(governor.releases.length, 1);
  assert.equal(governor.releases[0].outcome, "failed");
  assert.equal(governor.holderAttemptId, null);
  // The immutable WorkOrder, not its transport message, is the lease subject.
  assert.equal(governor.acquires[0].work_order_id, workOrderId);
  assert.notEqual(governor.acquires[0].work_order_id, taskId);
  assert.equal(governor.acquires[0].attempt_id, `${taskId}/1`);
  assert.equal(governor.claims[0].attempt_id, `${taskId}/1`);
  const launches = jsonLines(records).filter((record) => record.argv.includes("-p"));
  assert.equal(launches.length, 1, "exactly one actual attempt and no fallback");
  assert.equal(launches[0].selected, "1");
  assert.equal(launches[0].workOrder, workOrderId);
  assert.equal(launches[0].attempt, `${taskId}/1`);
  assert.equal(launches[0].run, `${taskId}-qwen-attempt-1`);
  assert.equal(launches[0].secretFd, "3");
  assert(governor.hits.find((hit) => hit.url === "/v1/governor/claim-paths").at <= launches[0].at);
  assert.equal(state.state, "FAILED", JSON.stringify(state.outcome));
  assert.equal(state.terminal, true);
  assert.equal(state.cost_usd, 0);
  assert.equal(state.exit_code, 1);
  assert.equal(state.head, baseCommit);
  assert.equal(state.outcome.no_commit, true);
  assert.match(state.outcome.reason, /^no_commit:/);
  const terminals = fixture.postedMessages.filter((post) => post.in_reply_to === taskId && post.outcome);
  assert.equal(terminals.length, 1, "one attributable terminal");
  assert.equal(terminals[0].outcome, "FAILED");
  assert.match(terminals[0].body, new RegExp(`contract=${workOrderId}@${contractDigest.slice(0, 8)}`));
  const uploads = jsonLines(awsRecords);
  assert.equal(uploads.length, 1);
  bundlePath = uploads[0].argv[3];
  const bundleResult = JSON.parse(execFileSync("tar", ["xzOf", bundlePath, "./result.json"], { encoding: "utf8" }));
  assert.equal(bundleResult.state, state.state);
  assert.equal(bundleResult.terminal, false);
  assert.equal(bundleResult.contract_digest, contractDigest);
  assert.equal(bundleResult.execution_spec_digest, specDigest);
  assert.equal(bundleResult.work_order_id, workOrderId);
  assert.equal(bundleResult.session_id, launches[0].run);
  const economics = JSON.parse(execFileSync("tar", ["xzOf", bundlePath, "./economics-summary.json"], { encoding: "utf8" }));
  assert.equal(economics.work_order_id, workOrderId);
  assert.equal(economics.attempt_label, `${taskId}/1`);
  assert.equal(economics.session_id, launches[0].run);
  assert.equal((economics.usage ?? []).length, 0);
  assert.equal(economics.route.initial_provider, null);
  assert.deepEqual(economics.route.escalations, []);
  assert.equal(execFileSync("tar", ["xzOf", bundlePath, "./session.jsonl"], { encoding: "utf8" }), "");
  assert.equal(fixture.gitTransferCalls().filter((args) => args.includes("push")).length, 0);
  assert.equal(fixture.getVinciCalls().length, 0, "synthetic terminal producer never ran");
  console.log(`PASS worker-qwen-refusal-composition ${explicitLauncherSelection ? "stale-env overridden" : "default-env selected"}: real dispatcher refusal, correct WorkOrder lease, FAILED terminal and local evidence; no accepted Qwen outcome or provider network attempt`);
} finally {
  authority.cleanup();
  await governor.close();
  await fixture.cleanup();
  if (bundlePath) { rmSync(bundlePath, { force: true }); rmSync(bundlePath.replace(/\.tgz$/, ""), { recursive: true, force: true }); }
}
}
