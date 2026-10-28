// No network, build, signing or credential operations. CLI always uses the real public-key verifier.
import assert from "node:assert/strict";
import { createHash, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repository = "getsimpledirect/vinci-code-cli";
export const repositoryId = "1345288037";
export const workflowPath = ".github/workflows/vinci-release.yml";
export const stageJobName = "Stage signed candidate";
// Same bounded provenance extraction as the existing release workflow's payload-binding step.
export const PROVENANCE_MAX_BYTES = 1024 * 1024;
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = /^[a-f0-9]{64}$/;
const sha = /^[a-f0-9]{40}$/;
const decimal = /^[1-9][0-9]{0,17}$/;
const stamp = (value) => {
  assert.equal(typeof value, "string");
  const time = Date.parse(value);
  assert.ok(Number.isFinite(time), "Invalid timestamp");
  return time;
};
const age = (created, expires, now, maximum) => {
  const start = stamp(created), end = stamp(expires);
  assert.ok(start <= now && end > now && end > start && end - start <= maximum, "Expired, future or excessive receipt lifetime");
};
const id = (value) => { assert.match(String(value), decimal, "Invalid immutable ID"); return String(value); };
export function validatePolicy(raw, now = Date.now()) {
  assert.equal(typeof raw, "string");
  assert.ok(raw.length > 0 && raw.length <= 8192, "Ops policy is missing or oversized");
  const policy = JSON.parse(raw);
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.owner, "thegeorgepu");
  assert.equal(policy.environment, "vinci-release");
  for (const name of ["protectedApprovalReviewed", "tagOidcTrustReviewed", "stagingExposureAndCostsApproved", "retentionApproved"]) {
    assert.equal(policy[name], true, `Ops prerequisite not confirmed: ${name}`);
  }
  assert.ok(stamp(policy.confirmedAt) <= now && stamp(policy.expiresAt) > now, "Ops confirmation is not current");
  for (const [key, low, high] of [["maxCandidateHours", 1, 168], ["maxQaHours", 1, 168], ["candidateRetentionDays", 1, 14], ["receiptRetentionDays", 1, 90]]) {
    assert.ok(Number.isSafeInteger(policy[key]) && policy[key] >= low && policy[key] <= high, `Invalid ${key}`);
  }
  assert.ok(policy.maxCandidateHours <= policy.candidateRetentionDays * 24, "Retention shorter than candidate authorization");
  return { ...policy, sha256: digest(raw) };
}
export function validateEvent(event, operation) {
  assert.equal(event.repository, repository);
  assert.equal(String(event.repositoryId), repositoryId);
  assert.match(event.source, sha);
  assert.match(event.tag, /^vinci-v[0-9]+\.[0-9]+\.[0-9]+$/);
  assert.equal(event.ref, `refs/tags/${event.tag}`);
  if (operation === "candidate") {
    assert.ok(event.eventName === "push" || event.eventName === "workflow_dispatch" && event.operation === "candidate");
  } else {
    assert.equal(operation, "activate");
    assert.equal(event.eventName, "workflow_dispatch", "Activation requires a separate manual run");
    assert.equal(event.operation, "activate");
  }
  id(event.runId); id(event.runAttempt);
}
export function envelope(bytes, publicKey, verifier = verify) {
  assert.ok(bytes.length <= 65536, "Oversized signed envelope");
  const value = JSON.parse(bytes.toString());
  assert.equal(typeof value.signature, "string");
  assert.match(value.signature, /^[A-Za-z0-9+/]+={0,2}$/);
  const signature = Buffer.from(value.signature, "base64");
  assert.equal(signature.length, 64);
  assert.equal(verifier(null, Buffer.from(JSON.stringify(value.signed)), publicKey, signature), true, "Signature refused");
  const signed = value.signed;
  assert.equal(signed.schemaVersion, 1); assert.equal(signed.updaterSchemaVersion, 1);
  assert.ok(Number.isSafeInteger(signed.sequence) && signed.sequence > 0);
  assert.equal(signed.channel, "beta"); assert.equal(typeof signed.mandatory, "boolean");
  assert.match(signed.version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  assert.match(signed.minimumVersion, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  stamp(signed.publishedAt);
  assert.match(signed.artifact.sha256, hex);
  assert.ok(Number.isSafeInteger(signed.artifact.size) && signed.artifact.size > 0);
  return signed;
}
export function etag(headers) {
  const blocks = headers.trim().split(/\r?\n\r?\n/);
  const found = blocks.at(-1).match(/^etag:\s*("[A-Za-z0-9._:-]+")\s*$/im);
  assert.ok(found, "Missing or unsafe final-response ETag");
  return found[1];
}
function archiveName(version) { return `vinci-code-${version}.tgz`; }
function archiveUrl(version) { return `https://vinci-assets.s3.ca-central-1.amazonaws.com/vinci-code/${archiveName(version)}`; }
function expectedNames(version) {
  return [archiveName(version), `${archiveName(version)}.sha256`, "vinci-code.tgz", "install.sh", "manifest-beta.json", "live-before.json", "live-before.headers"];
}
function bundleFiles(directory, version) {
  const result = {};
  for (const name of expectedNames(version)) {
    const file = join(directory, name);
    assert.ok(realpathSync(file).startsWith(`${realpathSync(directory)}/`), "Refuse bundle symlink escape");
    result[name] = readFileSync(file);
  }
  return result;
}
function checkFiles(record, files) {
  assert.deepEqual(Object.keys(record.files).sort(), expectedNames(record.version).sort());
  for (const [name, expected] of Object.entries(record.files)) {
    assert.match(expected, hex); assert.equal(digest(files[name]), expected, `Changed candidate file: ${name}`);
  }
}
function checkArchive(signed, files, version) {
  const archive = files[archiveName(version)];
  assert.equal(signed.version, version);
  assert.equal(signed.mandatory, false);
  assert.equal(signed.artifact.url, archiveUrl(version));
  assert.equal(signed.artifact.sha256, digest(archive));
  assert.equal(signed.artifact.size, archive.length);
  assert.equal(digest(files["vinci-code.tgz"]), digest(archive), "Compatibility copy differs");
  const sidecar = files[`${archiveName(version)}.sha256`].toString().trim();
  assert.equal(sidecar, `${digest(archive)}  ${archiveName(version)}`, "Checksum sidecar differs");
}
export function makeRecord({ event, policyRaw, files, provenance, publicKey, now = Date.now(), verifier = verify }) {
  validateEvent(event, "candidate");
  const policy = validatePolicy(policyRaw, now);
  const version = event.tag.slice("vinci-v".length);
  const signed = envelope(files["manifest-beta.json"], publicKey, verifier);
  const baseline = envelope(files["live-before.json"], publicKey, verifier);
  checkArchive(signed, files, version);
  assert.equal(signed.sequence, baseline.sequence + 1);
  assert.ok(signed.sequence > baseline.sequence && Number.isSafeInteger(signed.sequence));
  assert.equal(provenance.schemaVersion, 1); assert.equal(provenance.dirty, false);
  assert.equal(provenance.sourceCommit, event.source); assert.match(provenance.sourceTree, sha);
  assert.match(provenance.inputSha256, hex);
  const expires = Math.min(now + policy.maxCandidateHours * 3600000, stamp(policy.expiresAt));
  const record = {
    schemaVersion: 1, repository, repositoryId, workflowPath,
    producerRunId: id(event.runId), producerRunAttempt: id(event.runAttempt),
    tag: event.tag, source: event.source, tree: provenance.sourceTree, inputSha256: provenance.inputSha256,
    version, policySha256: policy.sha256, publicKeySha256: digest(publicKey),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString(),
    baseline: { sha256: digest(files["live-before.json"]), etag: etag(files["live-before.headers"].toString()), sequence: baseline.sequence },
    files: Object.fromEntries(expectedNames(version).map((name) => [name, digest(files[name])])),
  };
  checkFiles(record, files);
  return record;
}
export function validateProducer({ event, producer, artifact, jobs, inputs, now = Date.now() }) {
  validateEvent(event, "activate");
  assert.equal(String(producer.id), id(inputs.runId)); assert.equal(String(producer.run_attempt), id(inputs.runAttempt));
  assert.equal(producer.repository?.full_name, repository); assert.equal(String(producer.repository?.id), repositoryId);
  assert.equal(producer.path, workflowPath); assert.equal(producer.head_sha, event.source);
  assert.equal(producer.head_branch, event.tag); assert.equal(producer.status, "completed"); assert.equal(producer.conclusion, "success");
  assert.ok(["push", "workflow_dispatch"].includes(producer.event));
  assert.equal(jobs.jobs.filter((job) => job.name === stageJobName && job.conclusion === "success").length, 1);
  assert.equal(String(artifact.id), id(inputs.artifactId)); assert.equal(artifact.expired, false);
  assert.equal(String(artifact.workflow_run?.id), id(inputs.runId)); assert.equal(artifact.workflow_run?.head_sha, event.source);
  assert.equal(artifact.name, `vinci-signed-candidate-${event.tag.slice(7)}-${id(inputs.runId)}-${id(inputs.runAttempt)}`);
  assert.ok(stamp(artifact.expires_at) > now && stamp(artifact.created_at) <= now);
}
export function validateActivation({ event, policyRaw, recordBytes, files, publicKey, provenance, producer, artifact, jobs, qaBytes, inputs, currentLive, currentHeaders, stagedArchive, now = Date.now(), verifier = verify }) {
  validateEvent(event, "activate");
  const policy = validatePolicy(policyRaw, now);
  assert.match(inputs.receiptSha256, hex); assert.equal(digest(recordBytes), inputs.receiptSha256, "Unreviewed candidate receipt");
  assert.match(inputs.qaSha256, hex); assert.equal(digest(qaBytes), inputs.qaSha256, "Unreviewed QA receipt");
  assert.ok(recordBytes.length < 65536 && qaBytes.length < 16384);
  const record = JSON.parse(recordBytes.toString()), qa = JSON.parse(qaBytes.toString());
  assert.equal(record.schemaVersion, 1); assert.equal(record.repository, repository); assert.equal(record.repositoryId, repositoryId);
  assert.equal(record.workflowPath, workflowPath); assert.equal(record.policySha256, policy.sha256);
  assert.equal(record.publicKeySha256, digest(publicKey));
  assert.equal(record.tag, event.tag); assert.equal(record.source, event.source); assert.equal(record.version, event.tag.slice(7));
  assert.notEqual(String(event.runId), id(record.producerRunId), "Activation cannot reuse the staging run");
  assert.equal(id(record.producerRunId), id(inputs.runId)); assert.equal(id(record.producerRunAttempt), id(inputs.runAttempt));
  age(record.createdAt, record.expiresAt, now, policy.maxCandidateHours * 3600000);
  validateProducer({ event, producer, artifact, jobs, inputs, now });
  checkFiles(record, files);
  const signed = envelope(files["manifest-beta.json"], publicKey, verifier);
  const baseline = envelope(files["live-before.json"], publicKey, verifier);
  checkArchive(signed, files, record.version);
  assert.equal(signed.sequence, record.baseline.sequence + 1);
  assert.equal(baseline.sequence, record.baseline.sequence);
  assert.equal(digest(files["live-before.json"]), record.baseline.sha256);
  assert.equal(etag(files["live-before.headers"].toString()), record.baseline.etag);
  assert.equal(digest(stagedArchive), signed.artifact.sha256); assert.equal(stagedArchive.length, signed.artifact.size);
  assert.equal(digest(currentLive), record.baseline.sha256, "Live body changed since signing");
  assert.equal(etag(currentHeaders), record.baseline.etag, "Live ETag changed since signing");
  envelope(currentLive, publicKey, verifier);
  assert.equal(provenance.schemaVersion, 1); assert.equal(provenance.dirty, false);
  assert.equal(provenance.sourceCommit, record.source); assert.equal(provenance.sourceTree, record.tree); assert.equal(provenance.inputSha256, record.inputSha256);
  assert.deepEqual(Object.keys(qa).sort(), ["schemaVersion", "owner", "completedAt", "candidateReceiptSha256", "manifestSha256", "archiveSha256", "source", "artifactId", "results", "noModelCalls"].sort());
  assert.equal(qa.schemaVersion, 1); assert.equal(qa.owner, policy.owner); assert.equal(qa.noModelCalls, true);
  assert.equal(qa.candidateReceiptSha256, inputs.receiptSha256); assert.equal(qa.manifestSha256, digest(files["manifest-beta.json"]));
  assert.equal(qa.archiveSha256, signed.artifact.sha256); assert.equal(qa.source, event.source); assert.equal(id(qa.artifactId), id(inputs.artifactId));
  assert.ok(stamp(qa.completedAt) >= stamp(record.createdAt) && stamp(qa.completedAt) <= now && now - stamp(qa.completedAt) <= policy.maxQaHours * 3600000, "Expired/future QA receipt");
  assert.deepEqual(qa.results, { cleanInstall: "PASS", upgrade: "PASS", rollback: "PASS" });
  const expiresAt = new Date(Math.min(stamp(record.expiresAt), stamp(policy.expiresAt), stamp(qa.completedAt) + policy.maxQaHours * 3600000)).toISOString();
  return { schemaVersion: 1, manifestSha256: digest(files["manifest-beta.json"]), receiptSha256: inputs.receiptSha256, qaSha256: inputs.qaSha256, baselineEtag: record.baseline.etag, expiresAt, createdAt: new Date(now).toISOString(), version: record.version };
}
export function eventFromEnv() {
  const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(source, execFileSync("git", ["rev-parse", `${process.env.GITHUB_SHA}^{commit}`], { encoding: "utf8" }).trim(), "Checkout differs from event commit");
  return { repository: process.env.GITHUB_REPOSITORY, repositoryId: process.env.GITHUB_REPOSITORY_ID, source,
    ref: process.env.GITHUB_REF, tag: process.env.GITHUB_REF_NAME,
    eventName: process.env.GITHUB_EVENT_NAME, operation: process.env.RELEASE_OPERATION,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT };
}
function provenanceAt(archive) {
  return JSON.parse(execFileSync("tar", ["-xOf", archive, "vinci/dist/source-identity.json"], { maxBuffer: PROVENANCE_MAX_BYTES, timeout: 30000 }).toString());
}
function output(name, value) {
  assert.match(String(value), /^[A-Za-z0-9._:"-]+$/);
  const file = process.env.GITHUB_OUTPUT;
  if (file) writeFileSync(file, `${name}=${value}\n`, { flag: "a" });
}
function main(command) {
  const policyRaw = process.env.VINCI_SIGNED_QA_POLICY ?? "";
  const event = eventFromEnv();
  const policy = validatePolicy(policyRaw);
  if (command === "preflight") {
    validateEvent(event, process.env.RELEASE_OPERATION ?? "candidate");
    output("retention_days", policy.candidateRetentionDays);
    output("receipt_retention_days", policy.receiptRetentionDays);
    if (event.operation === "activate") {
      id(process.env.CANDIDATE_RUN_ID); id(process.env.CANDIDATE_RUN_ATTEMPT); id(process.env.CANDIDATE_ARTIFACT_ID);
      assert.match(process.env.CANDIDATE_RECEIPT_SHA256 ?? "", hex); assert.match(process.env.QA_RECEIPT_SHA256 ?? "", hex);
      assert.ok((process.env.QA_RECEIPT_BASE64 ?? "").length > 0 && process.env.QA_RECEIPT_BASE64.length < 22000);
      assert.ok(typeof process.env.ACTIVATION_REASON === "string" && process.env.ACTIVATION_REASON.length >= 3 && process.env.ACTIVATION_REASON.length <= 500 && !/[\u0000-\u001f\u007f]/.test(process.env.ACTIVATION_REASON), "A bounded activation reason is required");
    }
    return;
  }
  if (command === "select-candidate") {
    validateProducer({ event,
      producer: JSON.parse(readFileSync("producer-run.json")), artifact: JSON.parse(readFileSync("candidate-artifact.json")), jobs: JSON.parse(readFileSync("producer-jobs.json")),
      inputs: { runId: process.env.CANDIDATE_RUN_ID, runAttempt: process.env.CANDIDATE_RUN_ATTEMPT, artifactId: process.env.CANDIDATE_ARTIFACT_ID } });
    return;
  }
  const directory = resolve(command === "record" ? "release" : "candidate");
  const version = event.tag.slice(7), files = bundleFiles(directory, version);
  const publicKey = readFileSync("vinci/updater/public-key.pem");
  const provenance = provenanceAt(join(directory, archiveName(version)));
  if (command === "record") {
    const record = makeRecord({ event, policyRaw, files, provenance, publicKey });
    mkdirSync("candidate", { recursive: false });
    for (const name of expectedNames(version)) copyFileSync(join(directory, name), join("candidate", name));
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    writeFileSync("candidate/candidate.json", bytes, { flag: "wx" });
    output("receipt_sha256", digest(bytes)); output("manifest_sha256", digest(files["manifest-beta.json"]));
    return;
  }
  assert.equal(command, "verify-activation");
  const encoded = process.env.QA_RECEIPT_BASE64 ?? "", qaBytes = Buffer.from(encoded, "base64");
  assert.equal(qaBytes.toString("base64"), encoded, "QA receipt encoding must be canonical");
  const plan = validateActivation({ event, policyRaw, files, publicKey, provenance,
    recordBytes: readFileSync(join(directory, "candidate.json")),
    producer: JSON.parse(readFileSync("producer-run.json")), artifact: JSON.parse(readFileSync("candidate-artifact.json")), jobs: JSON.parse(readFileSync("producer-jobs.json")),
    qaBytes, inputs: { runId: process.env.CANDIDATE_RUN_ID, runAttempt: process.env.CANDIDATE_RUN_ATTEMPT, artifactId: process.env.CANDIDATE_ARTIFACT_ID, receiptSha256: process.env.CANDIDATE_RECEIPT_SHA256, qaSha256: process.env.QA_RECEIPT_SHA256 },
    currentLive: readFileSync("activation-live.json"), currentHeaders: readFileSync("activation-live.headers", "utf8"), stagedArchive: readFileSync("activation-staged.tgz") });
  mkdirSync("activation", { recursive: false });
  writeFileSync("activation/manifest-beta.json", files["manifest-beta.json"], { flag: "wx", mode: 0o444 });
  writeFileSync("activation/qa-receipt.json", qaBytes, { flag: "wx" });
  writeFileSync("activation/plan.json", `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
  output("live_etag", plan.baselineEtag); output("manifest_sha256", plan.manifestSha256); output("version", plan.version); output("expires_at", plan.expiresAt);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv[2]); }
  catch (error) { console.error(`Release candidate refused: ${error.message}`); process.exitCode = 1; }
}
