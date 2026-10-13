import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// Attach read-only to an operator-selected existing synthetic task. No seeding,
// decisions, worker execution, credential discovery or fallback service.
const root = fileURLToPath(new URL("../..", import.meta.url));
const runId = process.env.VINCI_RUNTIME_SHARED_RUN, config = process.env.VINCI_RUNTIME_CONFIG;
assert.ok(process.env.VINCI_RUNTIME_SHARED_FIXTURE === "local-synthetic-task" && config && isAbsolute(config) && typeof runId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(runId), "Shared task qualification refused. Select the owned private profile and exact existing synthetic run before retrying.");
assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === "--revoked", "Use the read-only terminal qualifier or explicit --revoked authority control.");
const revoked = process.argv[2] === "--revoked";
function artifactParts(value) {
  assert.ok(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value));
  const match = value.match(/^(.+):v([1-9][0-9]{0,8})$/); assert.ok(match, "The artifact must retain its actual canonical version binding.");
  return [match[1], match[2]];
}
async function command(args) {
  const result = await new Promise(resolve => execFile("bash", [join(root, "vinci/bin/vinci"), "runtime", ...args, "--json"], { cwd: root, env: { PATH: process.env.PATH, VINCI_RUNTIME_CONFIG: config, VINCI_NO_BOOTSTRAP_HEAL: "1", VINCI_UPDATE_DISABLED: "1" }, timeout: 10000, maxBuffer: 262144, encoding: "utf8" }, (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr })));
  assert.equal(result.status, revoked ? 77 : 0, "The actual Bash client must return the expected current-authority result.");
  if (revoked) { assert.equal(result.stdout, ""); assert.match(result.stderr, /authority_refused/); return null; }
  return JSON.parse(result.stdout);
}
const trials = [];
for (let trial = 1; trial <= 3; trial++) {
  const detail = await command(["inspect", runId]), events = await command(["events", runId]), response = await command(["receipt", runId]);
  if (revoked) {
    const artifact = process.env.VINCI_RUNTIME_SHARED_ARTIFACT;
    await command(["export", runId, ...artifactParts(artifact)]);
    trials.push({ trial, currentAuthorityRefused: true, readCommands: 4 }); continue;
  }
  const snapshot = detail.view.snapshot, receipt = response.receipt;
  assert.equal(snapshot.run.runId, runId); assert.equal(snapshot.run.state, "TERMINAL");
  assert.equal(snapshot.revision, events.revision); assert.equal(events.events.length, events.revision);
  assert.ok(events.revision <= 1000 && events.events.every((event, index) => event.runId === runId && event.sequence === index + 1));
  const value = (event, key) => event.payload[key]?.value;
  const completed = events.events.filter(event => event.type === "run.completed"); assert.equal(completed.length, 1);
  assert.equal(receipt.runId, runId); assert.equal(receipt.digest, value(completed[0], "receiptDigest")); assert.match(receipt.digest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.finalState, value(completed[0], "terminalState")); assert.equal(receipt.objective, detail.input);
  const created = events.events.find(event => event.type === "run.created"), owner = value(created, "workspaceId");
  assert.equal(receipt.workspace.kind, "personal"); assert.equal(receipt.workspace.workspaceId, owner); assert.equal(receipt.workspace.ownerId, owner);
  assert.ok(!("organizationId" in receipt.workspace)); assert.equal(receipt.requester.kind, "user"); assert.equal(receipt.requester.userId, owner);
  assert.ok(Array.isArray(receipt.artifactsProduced) && receipt.artifactsProduced.length > 0 && receipt.artifactsProduced.length <= 20);
  const artifacts = [];
  for (const boundId of receipt.artifactsProduced) {
    const [artifactId, version] = artifactParts(boundId), exported = await command(["export", runId, artifactId, version]);
    const persisted = events.events.filter(event => event.type === "artifact.persisted" && value(event, "artifactId") === boundId); assert.equal(persisted.length, 1);
    assert.equal(exported.artifactId, artifactId); assert.equal(exported.version, Number(version)); assert.equal(typeof exported.content, "string");
    const bytes = Buffer.byteLength(exported.content); assert.ok(bytes <= 65536);
    const digest = createHash("sha256").update(exported.content).digest("hex"); assert.equal(exported.digest, digest); assert.equal(value(persisted[0], "contentDigest"), digest);
    artifacts.push({ boundId, digest, bytes });
  }
  trials.push({ trial, revision: snapshot.revision, eventCount: events.events.length, finalState: receipt.finalState, verdict: receipt.verdict, receiptDigest: receipt.digest, artifacts });
}
console.log(JSON.stringify({ evidence: "existing_shared_synthetic_task_cli", measuredAt: execFileSync("date", ["-u", "+%Y-%m-%dT%H:%M:%SZ"], { encoding: "utf8" }).trim(), runId, actualBashLauncher: true, trials, mutationCommands: 0, deployed: false, nativeDevice: false }));
