// Fixtures use an INERT signature verifier and command transports. No keys, signing, AWS or HTTP.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { digest, envelope, etag, makeRecord, repository, repositoryId, stageJobName, validateActivation, validatePolicy, validateProducer, workflowPath } from "../scripts/release-candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = parse(readFileSync(join(root, ".github/workflows/vinci-release.yml"), "utf8"));
const buffer = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const fixtureVerifier = (_algorithm, bytes, key, signature) => key.toString() === "INERT PUBLIC FIXTURE" && signature.equals(Buffer.alloc(64)) && JSON.parse(bytes).schemaVersion === 1;
function fixture() {
  const now = Date.now(), created = now - 7200000;
  const event = { repository, repositoryId, source: "a".repeat(40), tag: "vinci-v0.0.58", ref: "refs/tags/vinci-v0.0.58", eventName: "push", operation: "candidate", runId: "101", runAttempt: "1" };
  const policyRaw = JSON.stringify({ schemaVersion: 1, owner: "thegeorgepu", environment: "vinci-release", protectedApprovalReviewed: true, tagOidcTrustReviewed: true, stagingExposureAndCostsApproved: true, retentionApproved: true, confirmedAt: new Date(created - 60000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), maxCandidateHours: 168, maxQaHours: 1, candidateRetentionDays: 14, receiptRetentionDays: 90 });
  const archive = Buffer.from("SYNTHETIC archive bytes, not a product package\n");
  const signed = { schemaVersion: 1, updaterSchemaVersion: 1, sequence: 44, channel: "beta", version: "0.0.58", minimumVersion: "0.0.09", mandatory: false, publishedAt: new Date(created).toISOString(), artifact: { url: "https://vinci-assets.s3.ca-central-1.amazonaws.com/vinci-code/vinci-code-0.0.58.tgz", sha256: digest(archive), size: archive.length } };
  const baseline = { ...signed, sequence: 43, version: "0.0.57" };
  const wrap = (value) => buffer({ signed: value, signature: Buffer.alloc(64).toString("base64") });
  const files = { "vinci-code-0.0.58.tgz": archive, "vinci-code-0.0.58.tgz.sha256": Buffer.from(`${digest(archive)}  vinci-code-0.0.58.tgz\n`), "vinci-code.tgz": archive, "install.sh": Buffer.from("synthetic retained installer\n"), "manifest-beta.json": wrap(signed), "live-before.json": wrap(baseline), "live-before.headers": Buffer.from('HTTP/2 200\r\nETag: "baseline-one"\r\n\r\n') };
  const publicKey = Buffer.from("INERT PUBLIC FIXTURE");
  const provenance = { schemaVersion: 1, dirty: false, sourceCommit: event.source, sourceTree: "b".repeat(40), inputSha256: "c".repeat(64) };
  const record = makeRecord({ event, policyRaw, files, provenance, publicKey, now: created, verifier: fixtureVerifier });
  const recordBytes = buffer(record);
  const qa = { schemaVersion: 1, owner: "thegeorgepu", completedAt: new Date(now - 30000).toISOString(), candidateReceiptSha256: digest(recordBytes), manifestSha256: digest(files["manifest-beta.json"]), archiveSha256: digest(archive), source: event.source, artifactId: "301", results: { cleanInstall: "PASS", upgrade: "PASS", rollback: "PASS" }, noModelCalls: true };
  const qaBytes = buffer(qa);
  return { event: { ...event, eventName: "workflow_dispatch", operation: "activate", runId: "201" }, policyRaw, recordBytes, files, publicKey, provenance,
    producer: { id: 101, run_attempt: 1, repository: { full_name: repository, id: Number(repositoryId) }, path: workflowPath, head_sha: event.source, head_branch: event.tag, status: "completed", conclusion: "success", event: "push" },
    artifact: { id: 301, expired: false, workflow_run: { id: 101, head_sha: event.source }, name: "vinci-signed-candidate-0.0.58-101-1", created_at: new Date(created).toISOString(), expires_at: new Date(now + 86400000).toISOString() }, jobs: { jobs: [{ name: stageJobName, conclusion: "success" }] },
    qaBytes, inputs: { runId: "101", runAttempt: "1", artifactId: "301", receiptSha256: digest(recordBytes), qaSha256: digest(qaBytes) },
    currentLive: files["live-before.json"], currentHeaders: files["live-before.headers"].toString(), stagedArchive: archive, now, verifier: fixtureVerifier };
}
function changeRecord(f, change) {
  const value = JSON.parse(f.recordBytes); change(value); f.recordBytes = buffer(value); f.inputs.receiptSha256 = digest(f.recordBytes);
  changeQa(f, (qa) => { qa.candidateReceiptSha256 = f.inputs.receiptSha256; });
}
function changeQa(f, change) {
  const value = JSON.parse(f.qaBytes); change(value); f.qaBytes = buffer(value); f.inputs.qaSha256 = digest(f.qaBytes);
}
test("Exact reviewed synthetic candidate produces only a conditional activation plan", () => {
  const f = fixture(), before = f.files["manifest-beta.json"];
  const plan = validateActivation(f);
  assert.equal(plan.manifestSha256, digest(before)); assert.equal(plan.baselineEtag, '"baseline-one"');
  assert.equal(f.files["manifest-beta.json"], before); assert.ok(Date.parse(plan.expiresAt) > f.now);
});
const refusals = [
  ["missing ops receipt", (f) => { f.policyRaw = ""; }],
  ["unconfirmed IAM/approval prerequisite", (f) => { const p = JSON.parse(f.policyRaw); p.tagOidcTrustReviewed = false; f.policyRaw = JSON.stringify(p); }],
  ["expired ops receipt", (f) => { const p = JSON.parse(f.policyRaw); p.expiresAt = new Date(f.now - 1).toISOString(); f.policyRaw = JSON.stringify(p); }],
  ["automatic push cannot activate", (f) => { f.event.eventName = "push"; }],
  ["candidate operation cannot activate", (f) => { f.event.operation = "candidate"; }],
  ["branch cannot activate", (f) => { f.event.ref = "refs/heads/main"; }],
  ["foreign repository", (f) => { f.event.repository = "other/repo"; }],
  ["foreign immutable repository ID", (f) => { f.event.repositoryId = "1"; }],
  ["changed release source", (f) => { f.event.source = "d".repeat(40); }],
  ["same staging/activation run", (f) => { f.event.runId = "101"; }],
  ["missing candidate receipt", (f) => { f.recordBytes = Buffer.alloc(0); }],
  ["changed reviewed receipt", (f) => { f.recordBytes = Buffer.concat([f.recordBytes, Buffer.from(" ")]); }],
  ["expired candidate receipt", (f) => { changeRecord(f, (r) => { r.expiresAt = new Date(f.now - 1).toISOString(); }); }],
  ["changed manifest bytes", (f) => { f.files["manifest-beta.json"] = Buffer.concat([f.files["manifest-beta.json"], Buffer.from(" ")]); }],
  ["changed archive bytes", (f) => { f.files["vinci-code-0.0.58.tgz"] = Buffer.from("changed"); }],
  ["changed installer bytes", (f) => { f.files["install.sh"] = Buffer.from("changed"); }],
  ["changed compatibility bytes", (f) => { f.files["vinci-code.tgz"] = Buffer.from("changed"); }],
  ["changed staged S3 object", (f) => { f.stagedArchive = Buffer.from("changed"); }],
  ["changed producer run attempt", (f) => { f.producer.run_attempt = 2; }],
  ["changed artifact ID", (f) => { f.artifact.id = 302; }],
  ["expired/deleted artifact metadata", (f) => { f.artifact.expired = true; }],
  ["missing artifact metadata", (f) => { f.artifact = {}; }],
  ["artifact retention expired", (f) => { f.artifact.expires_at = new Date(f.now - 1).toISOString(); }],
  ["artifact from another run", (f) => { f.artifact.workflow_run.id = 102; }],
  ["artifact name substitution", (f) => { f.artifact.name = "latest"; }],
  ["producer workflow substitution", (f) => { f.producer.path = ".github/workflows/untrusted.yml"; }],
  ["producer source substitution", (f) => { f.producer.head_sha = "e".repeat(40); }],
  ["failed staging run", (f) => { f.producer.conclusion = "failure"; }],
  ["failed staging job", (f) => { f.jobs.jobs[0].conclusion = "failure"; }],
  ["missing owner QA", (f) => { f.qaBytes = Buffer.alloc(0); }],
  ["changed reviewed QA receipt", (f) => { f.qaBytes = Buffer.concat([f.qaBytes, Buffer.from(" ")]); }],
  ["expired owner QA", (f) => { changeQa(f, (q) => { q.completedAt = new Date(f.now - 5400000).toISOString(); }); }],
  ["future owner QA", (f) => { changeQa(f, (q) => { q.completedAt = new Date(f.now + 10000).toISOString(); }); }],
  ["wrong owner", (f) => { changeQa(f, (q) => { q.owner = "another-owner"; }); }],
  ["failed install", (f) => { changeQa(f, (q) => { q.results.cleanInstall = "FAIL"; }); }],
  ["untested upgrade", (f) => { changeQa(f, (q) => { q.results.upgrade = "NOT TESTED"; }); }],
  ["failed rollback", (f) => { changeQa(f, (q) => { q.results.rollback = "FAIL"; }); }],
  ["QA for another manifest", (f) => { changeQa(f, (q) => { q.manifestSha256 = "0".repeat(64); }); }],
  ["QA not declaring no model calls", (f) => { changeQa(f, (q) => { q.noModelCalls = false; }); }],
  ["unexpected private-data field", (f) => { changeQa(f, (q) => { q.clipboard = "MUST NOT BE ACCEPTED"; }); }],
  ["changed live ETag", (f) => { f.currentHeaders = 'HTTP/2 200\r\nETag: "newer"\r\n\r\n'; }],
  ["changed live body with old ETag", (f) => { f.currentLive = Buffer.from("changed"); }],
  ["missing live ETag", (f) => { f.currentHeaders = "HTTP/2 200\r\n\r\n"; }],
  ["dirty provenance", (f) => { f.provenance.dirty = true; }],
  ["changed public trust root", (f) => { f.publicKey = Buffer.from("different"); }],
];
for (const [name, change] of refusals) test(`Refuses ${name}`, () => { const f = fixture(); change(f); assert.throws(() => validateActivation(f)); });
test("CLI defaults to real verification, never inert fixture acceptance", () => {
  const f = fixture(); assert.throws(() => envelope(f.files["manifest-beta.json"], f.publicKey));
  assert.throws(() => validateActivation({ ...f, verifier: undefined }));
});
test("Invalid synthetic signature is refused before an activation plan", () => {
  const f = fixture(); f.verifier = () => false; assert.throws(() => validateActivation(f), /Signature refused/);
});
test("Missing policy and excessive retention fail closed", () => {
  assert.throws(() => validatePolicy(""));
  const p = JSON.parse(fixture().policyRaw); p.candidateRetentionDays = 0; assert.throws(() => validatePolicy(JSON.stringify(p)));
});
test("Final redirect response ETag only; unsafe values refuse", () => {
  assert.equal(etag('HTTP/1.1 301\r\nETag: "old"\r\n\r\nHTTP/2 200\r\nETag: "final"\r\n\r\n'), '"final"');
  assert.throws(() => etag('HTTP/2 200\r\nETag: "bad value"\r\n\r\n'));
});
test("Workflow preserves protected approval/concurrency and separates operations", () => {
  assert.equal(workflow.jobs.publish.environment, "vinci-release"); assert.equal(workflow.jobs.activate.environment, "vinci-release");
  assert.equal(workflow.concurrency.group, "vinci-release"); assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.publish.permissions.contents, "read");
  assert.equal(workflow.jobs.activate.needs, undefined);
  assert.match(workflow.jobs.activate.if, /workflow_dispatch/); assert.match(workflow.jobs.activate.if, /inputs.operation == 'activate'/);
  assert.match(workflow.env.RELEASE_OPERATION, /workflow_dispatch.*candidate/);
  assert.equal(workflow.on.workflow_dispatch.inputs.operation.default, "candidate");
  assert.equal(workflow.env.AWS_MAX_ATTEMPTS, "1"); assert.equal(workflow.env.AWS_RETRY_MODE, "standard");
  const stage = workflow.jobs.publish.steps.map((s) => s.run ?? "").join("\n");
  assert.doesNotMatch(stage, /--key "?\$S3_PREFIX\/manifest-beta\.json|gh release create|aws s3 cp release\/vinci-code\.tgz|aws s3 cp release\/install\.sh/);
  const activation = workflow.jobs.activate.steps.map((s) => s.run ?? "").join("\n");
  assert.doesNotMatch(activation, /create-update-manifest|secretsmanager|private-key|npm (?:ci|install)|package\.sh/);
  const steps = workflow.jobs.activate.steps;
  assert.ok(steps.findIndex((s) => s.name?.startsWith("Refuse untrusted")) < steps.findIndex((s) => s.name?.startsWith("Download only the approved")));
  assert.ok(steps.every((s) => !s.uses?.startsWith("actions/download-artifact")));
  assert.ok(steps.every((s) => !s.with?.["artifact-ids"]));
  assert.ok(steps.findIndex((s) => s.name?.startsWith("Activate the reviewed")) < steps.findIndex((s) => s.name?.startsWith("Publish retained")));
});
test("Producer selection is verified before any candidate archive is read", () => {
  const f = fixture(); validateProducer(f); f.artifact.expired = true;
  assert.throws(() => validateProducer(f));
});
function shellFixture() {
  const folder = mkdtempSync(join(tmpdir(), "vinci-candidate-inert-"));
  mkdirSync(join(folder, "bin")); mkdirSync(join(folder, "release")); mkdirSync(join(folder, "activation")); mkdirSync(join(folder, "candidate"));
  const f = fixture();
  for (const [name, bytes] of Object.entries(f.files)) writeFileSync(join(folder, "release", name), bytes);
  writeFileSync(join(folder, "activation/manifest-beta.json"), f.files["manifest-beta.json"]);
  const executable = join(folder, "bin/aws");
  writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs'),crypto=require('node:crypto');const a=process.argv.slice(2);const b=a.includes('--body')?fs.readFileSync(a[a.indexOf('--body')+1]):Buffer.alloc(0);fs.appendFileSync(process.env.MOCK_CALLS,JSON.stringify({args:a,bodySha256:crypto.createHash('sha256').update(b).digest('hex')})+'\\n');if(process.env.MOCK_DENY==='1'||a.includes('--if-match')&&a[a.indexOf('--if-match')+1]!==process.env.MOCK_ETAG)process.exit(1);if(a[0]!=='s3api'||a[1]!=='put-object')process.exit(99);process.stdout.write('{}\\n');\n`);
  chmodSync(executable, 0o755);
  const calls = join(folder, "calls.jsonl"); writeFileSync(calls, "");
  const env = { PATH: `${join(folder, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: folder, TMPDIR: folder,
    S3_BUCKET: "fixture-bucket", S3_PREFIX: "vinci-code", VERSION: "0.0.58", LIVE_ETAG: '"baseline-one"', MOCK_ETAG: '"baseline-one"', MOCK_CALLS: calls,
    EXPECTED_MANIFEST_SHA256: digest(f.files["manifest-beta.json"]), CANDIDATE_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString() };
  return { folder, f, env, calls, run: (step, extra = {}) => spawnSync("bash", ["-c", step.run], { cwd: folder, env: { ...env, ...extra }, encoding: "utf8", timeout: 10000 }), read: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) };
}
test("Actual stage write body issues ONLY two versioned conditional puts", () => {
  const f = shellFixture();
  try {
    const step = workflow.jobs.publish.steps.find((s) => s.name === "Upload ONLY immutable versioned candidate objects");
    const result = f.run(step); assert.equal(result.status, 0, result.stderr);
    const calls = f.read(); assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.args[c.args.indexOf("--key") + 1]), ["vinci-code/vinci-code-0.0.58.tgz", "vinci-code/vinci-code-0.0.58.tgz.sha256"]);
    assert.ok(calls.every((c) => c.args[c.args.indexOf("--if-none-match") + 1] === "*"));
  } finally { rmSync(f.folder, { recursive: true }); }
});
for (const [name, extra, mutate, expectedExit, calls] of [
  ["exact reviewed bytes", {}, false, 0, 1],
  ["changed bytes after review", {}, true, 1, 0],
  ["expired authorization at write boundary", { CANDIDATE_EXPIRES_AT: "2000-01-01T00:00:00.000Z" }, false, 1, 0],
  ["concurrent ETag change", { MOCK_ETAG: '"newer"' }, false, 1, 1],
  ["denied/uncertain write, no retry", { MOCK_DENY: "1" }, false, 1, 1],
]) test(`Actual activation write body: ${name}`, () => {
  const f = shellFixture();
  try {
    if (mutate) writeFileSync(join(f.folder, "activation/manifest-beta.json"), "changed");
    const step = workflow.jobs.activate.steps.find((s) => s.name?.startsWith("Activate the reviewed"));
    const result = f.run(step, extra); assert.equal(result.status, expectedExit, result.stderr);
    const attempts = f.read(); assert.equal(attempts.length, calls);
    if (calls) { assert.equal(attempts[0].bodySha256, f.env.EXPECTED_MANIFEST_SHA256); assert.equal(attempts[0].args[attempts[0].args.indexOf("--if-match") + 1], '"baseline-one"'); }
  } finally { rmSync(f.folder, { recursive: true }); }
});
