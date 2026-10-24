// Exercise output custody through the real launcher/worker against local Git and offline bus,
// provider and uploader fixtures. Read uploaded archive members, not just task metadata.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkerTestFixture } from "./lib/worker-fixture.mjs";
import { executionSpecDigest, workOrderDigest } from "../worker/contracts/digest.mjs";
import { custodyTerminalState, OUTPUT_CAPTURE_LIMITS, outputRemotePostFields } from "../worker/output-custody.mjs";
import { remoteTransportIdentity } from "../worker/publisher.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = join(ROOT, "vinci/test/fixtures/worker-test-tools");
const VECTORS = join(ROOT, "vinci/test/fixtures/contract-vectors");
const BINARY = Buffer.from([0, 255, 13, 10, 4, 128]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();

async function scenario(name, { output = "branch", upload = true, uploadExit = 0, metadataStatus = null, producer = "binary", outcome = "DONE", exitCode = 0, cleanRoom = false, badReadback = false, missingRemoteUrl = false } = {}, verify) {
  if (process.env.VINCI_CUSTODY_CASE && process.env.VINCI_CUSTODY_CASE !== name) return;
  const fixture = new WorkerTestFixture(`custody-${name}`);
  try {
    const { origin } = fixture.createRepo("getsimpledirect", "vinci-contracts", { files: { "result.bin": Buffer.from([0, 1, 2]) } });
    const baseCommit = git(origin, "rev-parse", "main");
    if (cleanRoom) git(origin, "update-ref", `refs/heads/feat/${name}`, baseCommit);
    fixture.linkTools(TOOLS);
    fixture.evidencePostStatus = metadataStatus;
    const order = JSON.parse(readFileSync(join(VECTORS, "work-order-1-minimal/input.json"), "utf8"));
    order.id = `wo-custody-${name}`;
    order.expiresAt = new Date(Date.now() + 7200000).toISOString();
    const spec = {
      ...JSON.parse(readFileSync(join(VECTORS, "execution-spec-1-minimal/input.json"), "utf8")),
      workOrderId: order.id, workOrderDigest: workOrderDigest(order), baseCommit,
      targetBranch: `feat/${name}`, requiredCapabilities: [], output,
      resourceBounds: { budgetMicrousd: 12500000, maxRuntimeS: 60, deadline: new Date(Date.now() + 3600000).toISOString() },
      promotion: output === "branch" ? "pull_request" : "none",
    };
    const registry = { [order.id]: { work_order: order, execution_spec: spec } };
    fixture.workOrderPrograms[order.id] = fixture.evidenceProgramId;
    await fixture.startBus([{
      message_id: name, to_agent: "worker:w1", kind: "handoff", subject: name,
      body: JSON.stringify({ work_order_id: order.id, contract_digest: workOrderDigest(order), execution_spec_digest: executionSpecDigest(spec) }),
      ts: new Date().toISOString(), posted_by: "fixture",
    }], registry);
    const ownTools = join(fixture.tempDir, "own-tools");
    mkdirSync(ownTools);
    const secretPath = join(fixture.tempDir, "outside-output.txt");
    writeFileSync(secretPath, "must never become artifact bytes\n");
    writeFileSync(join(ownTools, "vinci"), `#!/usr/bin/env node
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("0.0.0-fake"); process.exit(0); }
const sessionId = argv[argv.indexOf("--session-id") + 1];
const sessionDir = join(argv[argv.indexOf("--session-dir") + 1], sessionId);
mkdirSync(sessionDir, { recursive: true });
const git = (...args) => execFileSync("git", args, { stdio: "pipe" });
git("config", "user.email", "fixture@vinci.test"); git("config", "user.name", "fixture");
const producer = ${JSON.stringify(producer)};
if (producer === "symlink") { unlinkSync("result.bin"); symlinkSync(${JSON.stringify(secretPath)}, "result.bin"); }
else if (producer === "deleted") unlinkSync("result.bin");
else writeFileSync("result.bin", producer === "large" ? Buffer.alloc(${OUTPUT_CAPTURE_LIMITS.file_bytes + 1}, 7) : Buffer.from(${JSON.stringify([...BINARY])}));
git("add", "--", "result.bin"); git("commit", "-qm", "fixture output");
if (producer === "dirty") writeFileSync("result.bin", "local bytes differ from committed bytes");
if (producer === "untracked") writeFileSync("report.txt", "untracked deliverable");
const entry = { type: "custom", customType: "vinci-task-outcome", data: { schemaVersion: 1, taskId: sessionId, state: ${JSON.stringify(outcome)}, reason: "fixture", changedFiles: [], verificationStatus: "passed", verificationCommand: "offline fixture", usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0, providers: [], models: [] }, recordedAt: new Date().toISOString() } };
writeFileSync(join(sessionDir, "session.jsonl"), JSON.stringify({ type: "session", id: sessionId }) + "\\n" + JSON.stringify(entry) + "\\n");
process.exit(${exitCode});
`, { mode: 0o755 });
    if (badReadback || missingRemoteUrl) {
      const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
      writeFileSync(join(ownTools, "git"), `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (${missingRemoteUrl} && args.slice(-3).join(" ") === "remote get-url origin") process.exit(1);
if (${badReadback} && existsSync(${JSON.stringify(join(fixture.tempDir, "pushed"))}) && args.includes("ls-remote") && args.at(-1) === ${JSON.stringify(`refs/heads/feat/${name}`)}) { console.log(${JSON.stringify(`${"0".repeat(40)}\trefs/heads/feat/${name}`)}); process.exit(0); }
const child = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
if (child.status === 0 && args.includes("push")) writeFileSync(${JSON.stringify(join(fixture.tempDir, "pushed"))}, "pushed");
process.exit(child.status ?? 1);
`, { mode: 0o755 });
    }
    const proc = spawn("bash", [join(ROOT, "vinci/bin/vinci"), "worker", "start", "--id", "w1", "--server", fixture.busUrl(), "--once", "--state-dir", fixture.tempDir, ...(cleanRoom ? ["--clean-room", "--disk-floor-mb", "0"] : [])], {
      env: fixture.getEnv({
        PATH: `${ownTools}:${fixture.toolsDir}:${process.env.PATH}`,
        VINCI_WORKER_ALLOWED_PROVIDERS: "openrouter,vinci",
        VINCI_EVIDENCE_URI_PREFIX: upload ? "s3://offline-evidence/worker/" : "",
        FAKE_AWS_EXIT: String(uploadExit), FAKE_AWS_RECORD: join(fixture.tempDir, "aws.jsonl"),
      }), stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (bytes) => { stderr += bytes; });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 60000);
    const status = await new Promise((resolve) => proc.once("close", resolve));
    clearTimeout(timer);
    assert.equal(status, 0, stderr);
    const task = JSON.parse(readFileSync(join(fixture.tempDir, "tasks", `${name}.json`), "utf8"));
    assert.equal(fixture.getPostedMessages().filter((message) => message.subject === `task ${name} ${task.state.toLowerCase()}`).length, 1, "one terminal per attempt");
    const archive = upload ? JSON.parse(readFileSync(join(fixture.tempDir, "aws.jsonl"), "utf8").trim()).argv[3] : null;
    const member = (path) => execFileSync("tar", ["xzOf", archive, `./${path}`]);
    const listing = () => execFileSync("tar", ["tzf", archive]).toString();
    await verify({ task, fixture, member, listing, baseCommit, origin });
    console.log(`PASS output custody ${name}`);
  } finally {
    spawnSync("chmod", ["-R", "u+w", fixture.tempDir]);
    await fixture.cleanup();
  }
}

await scenario("branch", { upload: false }, ({ task, origin, fixture }) => {
  assert.equal(task.state, "COMPLETED", JSON.stringify(task));
  assert.equal(task.output_custody.status, "remote_verified");
  assert.equal(task.output_custody.durable, true);
  assert.equal(task.output_custody.remote_url, `file://${origin}`);
  assert.equal(task.output_custody.remote_ref, "refs/heads/feat/branch");
  assert.equal(git(origin, "rev-parse", task.output_custody.remote_ref), task.output_custody.observed_sha);
  assert.equal(task.output_custody.observed_sha, task.head);
  assert.match(fixture.getPostedMessages().at(-1).body, /output_custody=remote_verified output_durable=true/);
  assert.match(fixture.getPostedMessages().at(-1).body, /output_ref="refs\/heads\/feat\/branch" output_sha=[0-9a-f]{40}/);
});
await scenario("cleanroom", { cleanRoom: true, upload: false }, ({ task, origin }) => {
  assert.equal(task.state, "COMPLETED", JSON.stringify(task));
  assert.equal(task.output_custody.status, "remote_verified");
  assert.equal(task.output_custody.observed_sha, git(origin, "rev-parse", "feat/cleanroom"));
});
await scenario("branch-unverified", { upload: false, missingRemoteUrl: true }, ({ task, fixture }) => {
  assert.ok(task.pr, "old outcome/PR checks pass");
  assert.equal(task.publish, "pushed", "push and SHA readback still pass");
  assert.equal(task.output_custody.durable, false, "missing exact remote identity cannot establish custody");
  assert.equal(task.state, "UNVERIFIED", "missing output custody demotes an otherwise completed run");
  assert.equal(fixture.getPostedMessages().at(-1).refs, undefined);
});
await scenario("readback", { cleanRoom: true, upload: false, badReadback: true }, ({ task }) => {
  assert.equal(task.state, "UNVERIFIED");
  assert.equal(task.publish, "remote_readback_mismatch");
  assert.equal(task.pr, null);
  assert.equal(task.output_custody.durable, false);
});
await scenario("patch", { output: "patch" }, ({ task, member, fixture, baseCommit, origin }) => {
  const receipt = task.output_custody;
  assert.equal(receipt.status, "bundle_uploaded");
  assert.equal(receipt.durable, true);
  assert.equal(receipt.base_commit, baseCommit);
  const patch = member(receipt.capture.member);
  assert.equal(sha256(patch), receipt.capture.sha256);
  assert.match(patch.toString(), /GIT binary patch/);
  assert.match(receipt.bundle_uri, /^s3:\/\/offline-evidence\//);
  const recovered = join(fixture.tempDir, "recovered");
  execFileSync("git", ["clone", "-q", origin, recovered]);
  execFileSync("git", ["-C", recovered, "apply", "--binary", "--index", "-"], { input: patch });
  assert.deepEqual(readFileSync(join(recovered, "result.bin")), BINARY, "binary patch reconstructs actual output bytes");
  assert.equal(git(recovered, "write-tree"), git(join(fixture.tempDir, "repos", "vinci-contracts"), "rev-parse", `${task.head}^{tree}`));
  assert.equal(JSON.parse(member("result.json")).output_custody.status, "pending_upload", "pre-terminal bundle cannot claim its own upload");
});
await scenario("patch-local", { output: "patch", upload: false }, ({ task }) => {
  assert.equal(task.state, "UNVERIFIED");
  assert.equal(task.output_custody.status, "local_only");
  assert.equal(task.output_custody.durable, false);
});
await scenario("patch-upload-failed", { output: "patch", uploadExit: 1 }, ({ task }) => {
  assert.equal(task.output_custody.status, "local_only");
  assert.equal(task.output_custody.bundle_uri, undefined);
  assert.equal(task.output_custody.durable, false);
});
await scenario("artifact", { output: "artifact" }, ({ task, member }) => {
  assert.equal(task.output_custody.status, "bundle_uploaded");
  const manifest = JSON.parse(member("artifact-capture.json"));
  const [entry] = manifest.entries;
  assert.equal(entry.status, "captured");
  assert.equal(entry.commit, task.head);
  assert.deepEqual(member(entry.member), BINARY, "archive contains exact binary artifact bytes");
  assert.equal(entry.sha256, sha256(BINARY));
  assert.equal(sha256(member("artifact-capture.json")), task.output_custody.capture.sha256);
  assert.deepEqual(manifest.limits, OUTPUT_CAPTURE_LIMITS);
});
for (const [producer, reason] of [["untracked", /untracked path/], ["dirty", /uncommitted/], ["symlink", /mode 120000/], ["large", /exceeds 8388608/]]) {
  await scenario(`artifact-${producer}`, { output: "artifact", producer }, ({ task, listing, member }) => {
    assert.equal(task.state, "UNVERIFIED");
    assert.equal(task.output_custody.status, "incomplete");
    assert.equal(task.output_custody.durable, false);
    assert.match(task.output_custody.reason, reason);
    assert.ok(task.artifacts.includes("result.bin"), "local path inventory remains available");
    if (producer === "symlink" || producer === "large" || producer === "dirty") assert.doesNotMatch(listing(), /artifact-0001.bin/, "unsupported bytes never enter the archive");
    if (producer === "untracked") assert.ok(JSON.parse(member("artifacts.json")).files.includes("report.txt"));
  });
}
await scenario("artifact-deletion", { output: "artifact", producer: "deleted" }, ({ task, member }) => {
  assert.equal(task.output_custody.status, "bundle_uploaded");
  assert.deepEqual(JSON.parse(member("artifact-capture.json")).entries, [{ path: "result.bin", status: "committed_deletion" }]);
});
await scenario("artifact-ledger-refused", { output: "artifact", metadataStatus: 422 }, ({ task, fixture }) => {
  assert.equal(task.output_custody.status, "bundle_uploaded", "landed bytes survive metadata rejection");
  assert.equal(task.state, "UNVERIFIED");
  assert.equal(task.evidence_error, "Bus POST failed: 422");
  assert.equal(fixture.getPostedMessages().at(-1).refs, undefined);
});
await scenario("none", { output: "none", upload: false }, ({ task }) => {
  assert.equal(task.output_custody.status, "not_required");
  assert.equal(task.output_custody.durable, false, "none does not fabricate durable output");
});
for (const [name, outcome, exitCode, expected] of [["blocked", "BLOCKED", 0, "BLOCKED"], ["failed", "DONE", 3, "FAILED"]]) {
  await scenario(name, { outcome, exitCode, uploadExit: 1 }, ({ task }) => {
    assert.equal(task.state, expected);
    assert.equal(task.output_custody.status, "remote_verified", "observed remote work survives non-success and upload failure");
    assert.equal(task.evidence_error, "S3 upload failed");
  });
}
assert.equal(custodyTerminalState("COMPLETED", { durable: false, status: "local_only" }), "UNVERIFIED");
assert.equal(custodyTerminalState("COMPLETED", { durable: true, status: "bundle_uploaded" }), "COMPLETED");
assert.equal(custodyTerminalState("FAILED", { durable: false, status: "incomplete" }), "FAILED");
assert.equal(custodyTerminalState("BLOCKED", { durable: false, status: "incomplete" }), "BLOCKED");
const credentialUrl = "https://user:password@example.test/owner/repo.git?token=private#secret";
assert.deepEqual(remoteTransportIdentity(credentialUrl), { remote_url: "https://example.test/owner/repo.git", remote_transport_sha256: sha256(credentialUrl) });
assert.equal(remoteTransportIdentity("git@example.test:owner/repo.git").remote_url, "ssh://example.test/owner/repo.git");
const spacedIdentity = "file:///a repository/with whitespace.git";
const spacedField = outputRemotePostFields({ status: "remote_verified", remote_url: spacedIdentity, remote_transport_sha256: sha256(spacedIdentity) });
assert.equal(spacedField.length, 1);
assert.doesNotMatch(spacedField[0], /\s/, "remote field must remain one whitespace-delimited token");
assert.equal(decodeURIComponent(spacedField[0].slice("output_remote=".length)), spacedIdentity, "bounded remote display must round-trip exactly");
const longIdentity = `https://example.test/${"repository/".repeat(100)}`;
assert.deepEqual(outputRemotePostFields({ status: "remote_verified", remote_url: longIdentity, remote_transport_sha256: sha256(longIdentity) }), [
  `output_remote=sha256:${sha256(longIdentity)}`, "output_remote_digest_only=true",
], "long identity must explicitly use its exact digest instead of a silently truncated URL");
