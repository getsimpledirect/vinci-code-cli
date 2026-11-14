// Fixtures use an INERT signature verifier and command transports. No keys, signing, AWS or HTTP.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { downloadPolicy } from "../scripts/release-candidate-download.mjs";
import { digest, envelope, etag, makeRecord, repository, repositoryId, stageJobName, validateActivation, validatePolicy, validateProducer, workflowPath } from "../scripts/release-candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = parse(readFileSync(join(root, ".github/workflows/vinci-release.yml"), "utf8"));
const buffer = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const fixtureVerifier = (_algorithm, bytes, key, signature) => key.toString() === "INERT PUBLIC FIXTURE" && signature.equals(Buffer.alloc(64)) && JSON.parse(bytes).schemaVersion === 1;
function fixture() {
  const now = Date.now(), created = now - 7200000;
  const event = { repository, repositoryId, source: "a".repeat(40), tag: "vinci-v0.0.58", ref: "refs/tags/vinci-v0.0.58", eventName: "push", operation: "candidate", runId: "101", runAttempt: "1" };
  const policyRaw = JSON.stringify({ schemaVersion: 1, owner: "thegeorgepu", environment: "vinci-release", protectedApprovalReviewed: true, tagOidcTrustReviewed: true, stagingExposureAndCostsApproved: true, retentionApproved: true, confirmedAt: new Date(created - 60000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), maxCandidateHours: 168, maxQaHours: 1, candidateRetentionDays: 14, receiptRetentionDays: 90, artifactDownloadHosts: ["cdn.example.invalid"] });
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
function preflight(policyRaw) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10000 });
  assert.equal(head.status, 0, head.stderr);
  return spawnSync(process.execPath, [join(root, "vinci/scripts/release-candidate.mjs"), "preflight"], {
    cwd: root, encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, VINCI_SIGNED_QA_POLICY: policyRaw,
      GITHUB_SHA: head.stdout.trim(), GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: repositoryId,
      GITHUB_REF: "refs/tags/vinci-v0.0.58", GITHUB_REF_NAME: "vinci-v0.0.58", GITHUB_EVENT_NAME: "push",
      RELEASE_OPERATION: "candidate", GITHUB_RUN_ID: "101", GITHUB_RUN_ATTEMPT: "1" },
  });
}
for (const [name, hosts] of [
  ["absence of both lists", undefined], ["empty", []], ["wildcard", ["*.example.invalid"]], ["null", null], ["wrong type", "cdn.example.invalid"],
  ["duplicate", ["cdn.example.invalid", "cdn.example.invalid"]], ["too many", Array.from({ length: 9 }, (_, n) => `cdn${n}.example.invalid`)],
  ["IP address", ["127.0.0.1"]], ["local host", ["cdn.local"]], ["API host", ["api.github.com"]], ["URL", ["https://cdn.example.invalid"]],
]) test(`Policy host parity refuses ${name} host policy before signing`, () => {
  const f = fixture(), policy = JSON.parse(f.policyRaw);
  if (hosts === undefined) { delete policy.artifactDownloadHosts; delete policy.artifactDownloadHostPatterns; }
  else policy.artifactDownloadHosts = hosts;
  const raw = JSON.stringify(policy); let message;
  assert.throws(() => validatePolicy(raw, f.now), (error) => { message = error.message; return true; }, `validatePolicy must refuse ${name} host policy`);
  assert.throws(() => downloadPolicy(raw, f.now), (error) => error.message === message, "Downloader must use the same refusal message");
  const result = preflight(raw);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, `Release candidate refused: ${message}\n`);
});
test("Policy host parity accepts valid exact hosts in both validators and real preflight", () => {
  const f = fixture();
  assert.deepEqual(validatePolicy(f.policyRaw, f.now), downloadPolicy(f.policyRaw, f.now));
  const result = preflight(f.policyRaw); assert.equal(result.status, 0, result.stderr);
  const steps = workflow.jobs.publish.steps;
  assert.ok(steps.findIndex((s) => s.id === "policy") < steps.findIndex((s) => s.id === "sign"));
});
for (const upgrade of ["PASS", "FAIL"]) test(`QA receipt CLI exact bytes: upgrade ${upgrade} is ${upgrade === "PASS" ? "accepted" : "refused"} by activation`, () => {
  const f = fixture(), fields = JSON.parse(f.qaBytes), folder = mkdtempSync(join(tmpdir(), "vinci-qa-receipt-"));
  try {
    const path = join(folder, "qa-receipt.json");
    const result = spawnSync(process.execPath, [join(root, "vinci/scripts/make-qa-receipt.mjs"),
      "--candidate-receipt-sha256", fields.candidateReceiptSha256, "--manifest-sha256", fields.manifestSha256,
      "--archive-sha256", fields.archiveSha256, "--source", fields.source, "--artifact-id", fields.artifactId,
      "--completed-at", fields.completedAt, "--clean-install", "PASS", "--upgrade", upgrade, "--rollback", "PASS", "--output", path],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const bytes = readFileSync(path), lines = result.stdout.trim().split("\n");
    assert.deepEqual(lines, [`sha256=${digest(bytes)}`, `base64=${bytes.toString("base64")}`]);
    assert.deepEqual(Buffer.from(lines[1].slice(7), "base64"), bytes);
    assert.deepEqual(JSON.parse(bytes), { ...fields, results: { ...fields.results, upgrade } });
    f.qaBytes = bytes; f.inputs.qaSha256 = digest(bytes);
    if (upgrade === "PASS") assert.equal(validateActivation(f).qaSha256, digest(bytes));
    else assert.throws(() => validateActivation(f), (error) => error.code === "ERR_ASSERTION" && error.actual.upgrade === "FAIL" && error.expected.upgrade === "PASS");
  } finally { rmSync(folder, { recursive: true }); }
});
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
  writeFileSync(join(folder, "package.json"), '{"type":"commonjs"}\n');
  mkdirSync(join(folder, "bin")); mkdirSync(join(folder, "release")); mkdirSync(join(folder, "activation")); mkdirSync(join(folder, "candidate"));
  const f = fixture();
  for (const [name, bytes] of Object.entries(f.files)) {
    writeFileSync(join(folder, "release", name), bytes); writeFileSync(join(folder, "candidate", name), bytes);
  }
  writeFileSync(join(folder, "candidate/candidate.json"), f.recordBytes);
  writeFileSync(join(folder, "activation/manifest-beta.json"), f.files["manifest-beta.json"]);
  const executable = join(folder, "bin/aws");
  writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs'),crypto=require('node:crypto');const a=process.argv.slice(2);const b=a.includes('--body')?fs.readFileSync(a[a.indexOf('--body')+1]):Buffer.alloc(0);fs.appendFileSync(process.env.MOCK_CALLS,JSON.stringify({args:a,bodySha256:crypto.createHash('sha256').update(b).digest('hex')})+'\\n');if(process.env.MOCK_DENY==='1'||a.includes('--if-match')&&a[a.indexOf('--if-match')+1]!==process.env.MOCK_ETAG)process.exit(1);if(a[0]==='s3'&&a[1]==='cp'){if(process.env.MOCK_FAIL_COPY==='1')process.exit(1);if(!a[3].startsWith('s3://'))fs.writeFileSync(a[3],process.env.MOCK_CORRUPT_INSTALLER==='1'?'changed installer':fs.readFileSync('candidate/install.sh'));process.exit(0);}if(a[0]!=='s3api'||a[1]!=='put-object')process.exit(99);process.stdout.write('{}\\n');\n`);
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
for (const [name, extra, expectedExit, count] of [
  ["verified bytes", {}, 0, 2], ["changed remote installer", { MOCK_CORRUPT_INSTALLER: "1" }, 1, 2],
  ["refused immutable upload", { MOCK_DENY: "1" }, 1, 1],
]) test(`Actual pre-manifest installer staging: ${name}`, () => {
  const f = shellFixture();
  try {
    const step = workflow.jobs.activate.steps.find((s) => s.name?.startsWith("Stage and verify immutable installer"));
    const result = f.run(step, extra); assert.equal(result.status, expectedExit, result.stderr);
    const calls = f.read(); assert.equal(calls.length, count);
    assert.equal(calls[0].args[calls[0].args.indexOf("--key") + 1], "vinci-code/install-0.0.58.sh");
    assert.equal(calls[0].args[calls[0].args.indexOf("--if-none-match") + 1], "*");
    assert.equal(calls[0].bodySha256, digest(f.f.files["install.sh"]));
    assert.ok(calls.every((c) => !c.args.includes("vinci-code/manifest-beta.json")));
    if (extra.MOCK_CORRUPT_INSTALLER) assert.match(result.stderr, /Staged installer differs from the reviewed candidate/);
    if (expectedExit === 0) assert.match(result.stdout, /Versioned installer verified: sha256/);
  } finally { rmSync(f.folder, { recursive: true }); }
});
for (const deny of [false, true]) test(`Actual post-manifest publish uploads the verified bytes with put-object only: ${deny ? "failure exits non-zero" : "success"}`, () => {
  const f = shellFixture();
  try {
    rmSync(join(f.folder, "release"), { recursive: true });
    const archive = f.f.files["vinci-code-0.0.58.tgz"], installer = f.f.files["install.sh"];
    writeFileSync(join(f.folder, "activation-staged.tgz"), archive);
    writeFileSync(join(f.folder, "activation/staged-install.sh"), installer);
    const step = workflow.jobs.activate.steps.find((s) => s.name?.startsWith("Publish retained tested installer"));
    const result = f.run(step, { MOCK_DENY: deny ? "1" : "0" });
    assert.equal(result.status, deny ? 1 : 0, result.stderr);
    const calls = f.read();
    assert.deepEqual(calls.map((c) => c.args), [
      ["s3api", "put-object", "--bucket", "fixture-bucket", "--key", "vinci-code/vinci-code.tgz", "--body", "activation-staged.tgz"],
      ...(!deny ? [["s3api", "put-object", "--bucket", "fixture-bucket", "--key", "vinci-code/install.sh", "--body", "activation/staged-install.sh"]] : []),
    ]);
    assert.equal(calls[0].bodySha256, digest(archive));
    if (!deny) assert.equal(calls[1].bodySha256, digest(installer));
    assert.ok(!calls.some((c) => c.args[0] === "s3" && c.args[1] === "cp"), "no S3-to-S3 copy (needs s3:GetObjectTagging)");
  } finally { rmSync(f.folder, { recursive: true }); }
});
test("Post-manifest recovery catches failed steps and continued notes failure after receipt retention", () => {
  const steps = workflow.jobs.activate.steps, stage = steps.findIndex((s) => s.name?.startsWith("Stage and verify immutable installer"));
  const activate = steps.findIndex((s) => s.id === "activate_manifest");
  const recovery = steps.at(-1);
  assert.ok(stage > steps.findIndex((s) => s.id === "reviewed") && stage < activate);
  assert.ok(steps.findIndex((s) => s.name?.startsWith("Retain sanitized")) < steps.length - 1);
  assert.match(recovery.if, /steps\.activate_manifest\.outcome == 'success'/);
  assert.match(recovery.if, /failure\(\) \|\| steps\.public_notes\.outcome == 'failure'/);
  assert.equal(steps.find((s) => s.id === "public_notes")["continue-on-error"], true);
  const result = spawnSync("bash", ["-c", recovery.run], { env: {}, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1); assert.match(result.stdout, /vinci-rollback\.yml/);
});
const postManifestSteps = [
  ["VERIFY_LIVE_OUTCOME", "verify_live", "Verify exact live bytes before publishing public entry points"],
  ["PUBLISH_ENTRY_POINTS_OUTCOME", "publish_entry_points", "Publish retained tested installer and compatibility bytes only after activation"],
  ["GITHUB_RELEASE_OUTCOME", "github_release", "GitHub Release with the shipped artifacts"],
  ["PUBLIC_NOTES_OUTCOME", "public_notes", "Public release notes"],
  ["RETAIN_RECEIPT_OUTCOME", "retain_receipt", "Retain sanitized activation or refusal receipt"],
];
const successfulPostManifestOutcomes = Object.fromEntries(postManifestSteps.map(([key]) => [key, "success"]));
function runRecovery(outcomes) {
  return spawnSync("bash", ["-c", workflow.jobs.activate.steps.at(-1).run], { env: outcomes, encoding: "utf8", timeout: 10000 });
}
function assertIncompleteRecovery(result) {
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^::error::Activation completion is "INCOMPLETE".*$/m);
}
function assertLiveRecovery(result) {
  assertIncompleteRecovery(result);
  assert.match(result.stdout, /^::error::.*Do not roll back\./m, 'A post-live-only failure must say "Do not roll back."');
  assert.doesNotMatch(result.stdout, /vinci-rollback\.yml/, "A post-live-only failure must not route to rollback");
  assert.match(result.stdout, /release is live.*live manifest matched the reviewed bytes.*archive and install script were published/);
}
function assertRollbackRecovery(result) {
  assertIncompleteRecovery(result);
  assert.match(result.stdout, /Inspect the live manifest and retained receipt/);
  assert.match(result.stdout, /vinci\/RELEASE-ACTIVATION-RISK\.md/);
  assert.match(result.stdout, /^::error::.*vinci-rollback\.yml for an authorized rollback before retrying/m);
  assert.doesNotMatch(result.stdout, /Do not roll back|release is live/);
}
test("Post-manifest recovery C1: notes failure repairs publication without rollback", () => {
  const result = runRecovery({ ...successfulPostManifestOutcomes, PUBLIC_NOTES_OUTCOME: "failure" });
  assertLiveRecovery(result);
  assert.match(result.stdout, /^::error::.*Public release notes \(failure\)/m);
  assert.match(result.stdout, /publish the note to the public releases repository by hand/i);
  assert.match(result.stdout, /fix PUBLIC_RELEASES_TOKEN/);
  assert.match(result.stdout, /vinci\/release-notes\/README\.md/);
  assert.doesNotMatch(result.stdout, /Create the GitHub Release|receipt artifact was not retained/);
});
test("Post-manifest recovery C2: live verification failure names later steps as skipped", () => {
  const result = runRecovery({ VERIFY_LIVE_OUTCOME: "failure", PUBLISH_ENTRY_POINTS_OUTCOME: "skipped",
    GITHUB_RELEASE_OUTCOME: "skipped", PUBLIC_NOTES_OUTCOME: "skipped", RETAIN_RECEIPT_OUTCOME: "success" });
  assertRollbackRecovery(result);
  assert.match(result.stdout, /^::error::.*Verify exact live bytes before publishing public entry points \(failure\)/m);
  for (const [, , name] of postManifestSteps.slice(1, 4)) {
    assert.ok(result.stdout.split("\n").some((line) => line.startsWith("::error::") && line.includes(`${name} (skipped)`)));
    assert.ok(!result.stdout.includes(`${name} (failure)`));
  }
});
test("Post-manifest recovery C3: entry point publication failure requires live-path recovery", () => {
  const result = runRecovery({ ...successfulPostManifestOutcomes, PUBLISH_ENTRY_POINTS_OUTCOME: "failure",
    GITHUB_RELEASE_OUTCOME: "skipped", PUBLIC_NOTES_OUTCOME: "skipped" });
  assertRollbackRecovery(result);
  assert.match(result.stdout, /^::error::.*Publish retained tested installer and compatibility bytes only after activation \(failure\)/m);
});
test("Post-manifest recovery C4: GitHub Release failure repairs the release without rollback", () => {
  const result = runRecovery({ ...successfulPostManifestOutcomes, GITHUB_RELEASE_OUTCOME: "failure", PUBLIC_NOTES_OUTCOME: "skipped" });
  assertLiveRecovery(result);
  assert.match(result.stdout, /^::error::.*GitHub Release with the shipped artifacts \(failure\)/m);
  assert.match(result.stdout, /Create the GitHub Release for the tag with the retained artifacts/);
  assert.match(result.stdout, /^::error::.*Public release notes \(skipped\)/m);
  assert.match(result.stdout, /^::error::.*Then publish the skipped public release note by hand/m);
  assert.doesNotMatch(result.stdout, /fix PUBLIC_RELEASES_TOKEN|receipt artifact was not retained/);
});
test("Post-manifest recovery repairs missing receipt retention without rollback", () => {
  const result = runRecovery({ ...successfulPostManifestOutcomes, RETAIN_RECEIPT_OUTCOME: "failure" });
  assertLiveRecovery(result);
  assert.match(result.stdout, /^::error::.*Retain sanitized activation or refusal receipt \(failure\)/m);
  assert.match(result.stdout, /receipt artifact was not retained; record the run id/);
  assert.doesNotMatch(result.stdout, /fix PUBLIC_RELEASES_TOKEN|Create the GitHub Release/);
});
test("Post-manifest recovery names and repairs every post-live failure", () => {
  const result = runRecovery({ ...successfulPostManifestOutcomes, GITHUB_RELEASE_OUTCOME: "failure",
    PUBLIC_NOTES_OUTCOME: "failure", RETAIN_RECEIPT_OUTCOME: "failure" });
  assertLiveRecovery(result);
  for (const [, , name] of postManifestSteps.slice(2)) {
    assert.ok(result.stdout.split("\n").some((line) => line.startsWith("::error::") && line.includes(`${name} (failure)`)));
  }
  assert.match(result.stdout, /Create the GitHub Release for the tag with the retained artifacts/);
  assert.match(result.stdout, /fix PUBLIC_RELEASES_TOKEN/);
  assert.match(result.stdout, /receipt artifact was not retained; record the run id/);
});
for (const [key, , name] of postManifestSteps) for (const outcome of [undefined, "", "cancelled", "unexpected"]) {
  test(`Post-manifest recovery C5: ${key} ${outcome === undefined ? "unset" : JSON.stringify(outcome)} fails safe`, () => {
    const outcomes = { ...successfulPostManifestOutcomes, PUBLIC_NOTES_OUTCOME: "failure" };
    if (outcome === undefined) delete outcomes[key];
    else outcomes[key] = outcome;
    const result = runRecovery(outcomes);
    assertRollbackRecovery(result);
    assert.ok(result.stdout.split("\n").some((line) => line.startsWith("::error::") && line.includes(`${name} (${outcome || "unknown"})`)));
  });
}
for (const key of ["VERIFY_LIVE_OUTCOME", "PUBLISH_ENTRY_POINTS_OUTCOME"]) {
  test(`Post-manifest recovery refuses to claim the release is live when ${key} is skipped`, () => {
    const result = runRecovery({ ...successfulPostManifestOutcomes, [key]: "skipped", PUBLIC_NOTES_OUTCOME: "failure" });
    assertRollbackRecovery(result);
    const name = postManifestSteps.find(([candidate]) => candidate === key)[2];
    assert.ok(result.stdout.split("\n").some((line) => line.startsWith("::error::") && line.includes(`${name} (skipped)`)));
  });
}
// Old-head control (C7): the recovery text before this change, kept verbatim. It must fail the C1
// assertion on its rollback guidance, which shows C1 checks the behaviour this change introduced.
const oldRecoveryRun = `echo '::error::Activation completion is "INCOMPLETE" after the manifest write. Inspect the live manifest and retained receipt; follow vinci/RELEASE-ACTIVATION-RISK.md and use vinci-rollback.yml for an authorized rollback before retrying.'
exit 1
`;
test("Post-manifest recovery C7: the previous recovery text fails C1 on its rollback guidance", () => {
  const result = spawnSync("bash", ["-c", oldRecoveryRun], { env: { ...successfulPostManifestOutcomes, PUBLIC_NOTES_OUTCOME: "failure" }, encoding: "utf8", timeout: 10000 });
  assertIncompleteRecovery(result);
  assert.throws(() => assertLiveRecovery(result), (error) => error instanceof assert.AssertionError && error.message === 'A post-live-only failure must say "Do not roll back."');
});
test("Post-manifest recovery C6: every outcome is wired to the named step and the trigger is unchanged", () => {
  const steps = workflow.jobs.activate.steps, recovery = steps.at(-1);
  assert.equal(recovery.if, "${{ !cancelled() && steps.activate_manifest.outcome == 'success' && (failure() || steps.public_notes.outcome == 'failure') }}");
  assert.deepEqual(recovery.env, Object.fromEntries(postManifestSteps.map(([key, id]) => [key, `\${{ steps.${id}.outcome }}`])));
  const reads = [...new Set([...recovery.run.matchAll(/\$(?:\{)?([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]))];
  assert.deepEqual(reads.sort(), Object.keys(recovery.env).sort());
  const activate = steps.findIndex((step) => step.id === "activate_manifest");
  assert.deepEqual(steps.slice(activate + 1, -1).map((step) => [step.id, step.name]), postManifestSteps.map(([, id, name]) => [id, name]));
  assert.equal(steps.find((step) => step.id === "retain_receipt").if, "${{ !cancelled() && steps.policy.outcome == 'success' }}");
});
test("Candidate identity summary prints the record and policy deadlines", () => {
  const f = shellFixture();
  try {
    const record = JSON.parse(f.f.recordBytes), policy = JSON.parse(f.f.policyRaw), path = join(f.folder, "summary.txt");
    const step = workflow.jobs.publish.steps.find((s) => s.name?.startsWith("Candidate identity"));
    assert.equal(step.env.CANDIDATE_EXPIRES_AT, "${{ steps.record.outputs.expires_at }}");
    assert.equal(step.env.POLICY_EXPIRES_AT, "${{ steps.record.outputs.policy_expires_at }}");
    const result = f.run(step, { GITHUB_STEP_SUMMARY: path, RECEIPT_SHA256: digest(f.f.recordBytes),
      MANIFEST_SHA256: digest(f.f.files["manifest-beta.json"]), CANDIDATE_ARTIFACT_ID: "301",
      CANDIDATE_EXPIRES_AT: record.expiresAt, POLICY_EXPIRES_AT: policy.expiresAt });
    assert.equal(result.status, 0, result.stderr);
    const summary = readFileSync(path, "utf8");
    assert.ok(summary.includes(`Candidate expiresAt: ${record.expiresAt}`));
    assert.ok(summary.includes(`Policy expiresAt: ${policy.expiresAt}`));
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
