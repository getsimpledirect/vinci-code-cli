// Actual CLI and workflow shell boundaries. Public-key verification/remote transports are INERT.
// No key generation, signing, HTTP, AWS, provider, install or product build occurs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { digest, makeRecord, PROVENANCE_MAX_BYTES, repository, repositoryId, stageJobName, workflowPath } from "../scripts/release-candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "vinci/scripts/release-candidate.mjs");
const publicKey = readFileSync(process.env.VINCI_CANDIDATE_TEST_PUBLIC_KEY ?? join(root, "vinci/updater/public-key.pem"));
const referenceArchive = process.env.VINCI_CANDIDATE_TEST_ARCHIVE;
const json = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const suppliedProvenance = referenceArchive ? execFileSync("tar", ["-xOf", referenceArchive, "vinci/dist/source-identity.json"], { maxBuffer: PROVENANCE_MAX_BYTES, timeout: 30000 }) : undefined;
const provenance = suppliedProvenance ? JSON.parse(suppliedProvenance) : { schemaVersion: 1, dirty: false, sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), inputSha256: "c".repeat(64), inputs: Array.from({ length: 629 }, (_, n) => ({ path: `synthetic/${n}.ts`, sha256: "d".repeat(64) })) };
function padded(value, size) {
  const empty = json({ ...value, padding: "" });
  assert.ok(empty.length <= size);
  const bytes = json({ ...value, padding: "x".repeat(size - empty.length) });
  assert.equal(bytes.length, size); return bytes;
}
const realistic = suppliedProvenance ?? padded(provenance, 115734);
assert.ok(realistic.length > 65536 && realistic.length <= 1024 * 1024);
const verifyFixture = (_algorithm, bytes, _key, signature) => signature.equals(Buffer.alloc(64)) && JSON.parse(bytes).schemaVersion === 1;
const wrap = (value) => json({ signed: value, signature: Buffer.alloc(64).toString("base64") });
function syntheticArchive(folder, bytes) {
  const input = join(folder, "archive-input"); mkdirSync(join(input, "vinci/dist"), { recursive: true });
  if (bytes) writeFileSync(join(input, "vinci/dist/source-identity.json"), bytes);
  else writeFileSync(join(input, "vinci/dist/missing-provenance.txt"), "No provenance in this synthetic archive.\n");
  const archive = join(folder, "input.tgz");
  execFileSync("tar", ["-czf", archive, "-C", input, "vinci"], { timeout: 30000 });
  return archive;
}
function setup(command, variant) {
  const folder = mkdtempSync(join(tmpdir(), "vinci-candidate-cli-"));
  for (const dir of ["bin", "release", "vinci/updater"]) mkdirSync(join(folder, dir), { recursive: true });
  writeFileSync(join(folder, "vinci/updater/public-key.pem"), publicKey);
  const git = join(folder, "bin/git");
  writeFileSync(git, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]!=='rev-parse'||!['HEAD',${JSON.stringify(`${provenance.sourceCommit}^{commit}`)}].includes(a[1]))process.exit(99);process.stdout.write(${JSON.stringify(`${provenance.sourceCommit}\n`)});\n`); chmodSync(git, 0o755);
  const preload = join(folder, "inert-public-verifier.mjs");
  writeFileSync(preload, `import assert from 'node:assert/strict';import crypto from 'node:crypto';import {syncBuiltinESMExports} from 'node:module';assert.equal(process.env.SYNTHETIC_SIGNATURE_FIXTURE,'1');crypto.verify=(_a,bytes,key,sig)=>crypto.createHash('sha256').update(key).digest('hex')===${JSON.stringify(digest(publicKey))}&&sig.equals(Buffer.alloc(64))&&JSON.parse(bytes).schemaVersion===1;syncBuiltinESMExports();globalThis.fetch=()=>{throw Error('Fixture has no network');};\n`);
  let archive;
  if (variant === "realistic" && referenceArchive) { archive = join(folder, "input.tgz"); copyFileSync(referenceArchive, archive); }
  else {
    const bytes = variant === "realistic" ? realistic : variant === "at-bound" ? padded(provenance, PROVENANCE_MAX_BYTES) : variant === "oversized" ? padded(provenance, PROVENANCE_MAX_BYTES + 1) : variant === "malformed" ? Buffer.from("{malformed".padEnd(115734, "x")) : variant === "missing" ? undefined : variant === "invalid-schema" ? padded({ ...provenance, schemaVersion: 99 }, 115734) : padded({ ...provenance, sourceCommit: "e".repeat(40) }, 115734);
    archive = syntheticArchive(folder, bytes);
  }
  const bytes = readFileSync(archive), version = "0.0.57", now = Date.now(), created = now - 1000;
  const policyRaw = JSON.stringify({ schemaVersion: 1, owner: "thegeorgepu", environment: "vinci-release", protectedApprovalReviewed: true, tagOidcTrustReviewed: true, stagingExposureAndCostsApproved: true, retentionApproved: true, confirmedAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), maxCandidateHours: 168, maxQaHours: 24, candidateRetentionDays: 14, receiptRetentionDays: 90 });
  const event = { repository, repositoryId, source: provenance.sourceCommit, tag: `vinci-v${version}`, ref: `refs/tags/vinci-v${version}`, eventName: "push", operation: "candidate", runId: "101", runAttempt: "1" };
  const signed = { schemaVersion: 1, updaterSchemaVersion: 1, sequence: 44, channel: "beta", version, minimumVersion: "0.0.09", mandatory: false, publishedAt: new Date(created).toISOString(), artifact: { url: `https://vinci-assets.s3.ca-central-1.amazonaws.com/vinci-code/vinci-code-${version}.tgz`, sha256: digest(bytes), size: bytes.length } };
  const files = { [`vinci-code-${version}.tgz`]: bytes, [`vinci-code-${version}.tgz.sha256`]: Buffer.from(`${digest(bytes)}  vinci-code-${version}.tgz\n`), "vinci-code.tgz": bytes, "install.sh": Buffer.from("synthetic retained installer, never run\n"), "manifest-beta.json": wrap(signed), "live-before.json": wrap({ ...signed, sequence: 43, version: "0.0.56" }), "live-before.headers": Buffer.from('HTTP/2 200\r\nETag: "baseline-one"\r\n\r\n') };
  for (const [name, value] of Object.entries(files)) writeFileSync(join(folder, "release", name), value);
  const env = { PATH: `${join(folder, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: folder, TMPDIR: folder, PI_OFFLINE: "1", SYNTHETIC_SIGNATURE_FIXTURE: "1", GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: repositoryId, GITHUB_SHA: provenance.sourceCommit, GITHUB_REF: event.ref, GITHUB_REF_NAME: event.tag, GITHUB_EVENT_NAME: command === "record" ? "push" : "workflow_dispatch", GITHUB_RUN_ID: command === "record" ? "101" : "201", GITHUB_RUN_ATTEMPT: "1", RELEASE_OPERATION: command === "record" ? "candidate" : "activate", VINCI_SIGNED_QA_POLICY: policyRaw, GITHUB_OUTPUT: join(folder, "outputs.txt") };
  if (command === "verify-activation") {
    mkdirSync(join(folder, "candidate"));
    for (const [name, value] of Object.entries(files)) writeFileSync(join(folder, "candidate", name), value);
    const recordBytes = json(makeRecord({ event, policyRaw, files, provenance, publicKey, now: created, verifier: verifyFixture }));
    writeFileSync(join(folder, "candidate/candidate.json"), recordBytes);
    const qa = json({ schemaVersion: 1, owner: "thegeorgepu", completedAt: new Date(now).toISOString(), candidateReceiptSha256: digest(recordBytes), manifestSha256: digest(files["manifest-beta.json"]), archiveSha256: digest(bytes), source: provenance.sourceCommit, artifactId: "301", results: { cleanInstall: "PASS", upgrade: "PASS", rollback: "PASS" }, noModelCalls: true });
    Object.assign(env, { CANDIDATE_RUN_ID: "101", CANDIDATE_RUN_ATTEMPT: "1", CANDIDATE_ARTIFACT_ID: "301", CANDIDATE_RECEIPT_SHA256: digest(recordBytes), QA_RECEIPT_SHA256: digest(qa), QA_RECEIPT_BASE64: qa.toString("base64") });
    writeFileSync(join(folder, "producer-run.json"), json({ id: 101, run_attempt: 1, repository: { full_name: repository, id: Number(repositoryId) }, path: workflowPath, head_sha: event.source, head_branch: event.tag, status: "completed", conclusion: "success", event: "push" }));
    writeFileSync(join(folder, "candidate-artifact.json"), json({ id: 301, expired: false, workflow_run: { id: 101, head_sha: event.source }, name: `vinci-signed-candidate-${version}-101-1`, created_at: new Date(created).toISOString(), expires_at: new Date(now + 86400000).toISOString() }));
    writeFileSync(join(folder, "producer-jobs.json"), json({ jobs: [{ name: stageJobName, conclusion: "success" }] }));
    writeFileSync(join(folder, "activation-live.json"), files["live-before.json"]); writeFileSync(join(folder, "activation-live.headers"), files["live-before.headers"]); writeFileSync(join(folder, "activation-staged.tgz"), bytes);
  }
  return { folder, env, files, preload, archiveSha256: digest(bytes), command, variant,
    run: (helper = cli, mockCrypto = true) => spawnSync(process.execPath, [...(mockCrypto ? ["--import", preload] : []), helper, command], { cwd: folder, env, encoding: "utf8", timeout: 30000 }) };
}
function report(f, result, mockCrypto, rejectedControl = false) {
  if (!process.env.VINCI_CANDIDATE_CLI_EVIDENCE) return;
  appendFileSync(process.env.VINCI_CANDIDATE_CLI_EVIDENCE, `${JSON.stringify({ node: process.version, command: f.command, variant: f.variant, archiveSha256: f.archiveSha256, inertSignatureAdapter: mockCrypto, rejected64KiBControl: rejectedControl, exit: result.status, stderr: result.stderr.trim(), receiptExists: existsSync(join(f.folder, "candidate/candidate.json")), activationPlanExists: existsSync(join(f.folder, "activation/plan.json")), realisticProvenanceBytes: realistic.length })}\n`);
}
for (const command of ["record", "verify-activation"]) for (const variant of ["realistic", "at-bound", "oversized", "malformed", "missing", "invalid-schema", "wrong-commit"]) {
  test(`Actual CLI ${command}: ${variant} provenance`, () => {
    const f = setup(command, variant);
    try {
      const result = f.run(); report(f, result, true);
      const output = join(f.folder, command === "record" ? "candidate/candidate.json" : "activation/plan.json");
      if (["realistic", "at-bound"].includes(variant)) {
        assert.equal(result.status, 0, result.stderr); assert.ok(existsSync(output));
        const value = JSON.parse(readFileSync(output));
        if (command === "record") { assert.equal(value.source, provenance.sourceCommit); assert.equal(value.tree, provenance.sourceTree); }
        else { assert.equal(value.manifestSha256, digest(f.files["manifest-beta.json"])); assert.equal(digest(readFileSync(join(f.folder, "activation/manifest-beta.json"))), value.manifestSha256); }
      } else {
        assert.equal(result.status, 1); assert.equal(existsSync(output), false);
        if (variant === "oversized") assert.match(result.stderr, /ENOBUFS/);
        else assert.doesNotMatch(result.stderr, /ENOBUFS/);
      }
    } finally { rmSync(f.folder, { recursive: true }); }
  });
}
for (const command of ["record", "verify-activation"]) {
  test(`Actual CLI ${command}: real verification still rejects an inert signature after realistic extraction`, () => {
    const f = setup(command, "realistic");
    try { const r = f.run(cli, false); report(f, r, false); assert.equal(r.status, 1); assert.match(r.stderr, /Signature refused/); assert.equal(existsSync(join(f.folder, command === "record" ? "candidate/candidate.json" : "activation/plan.json")), false); }
    finally { rmSync(f.folder, { recursive: true }); }
  });
  test(`Rejected 64KiB actual CLI ${command}: preserved negative control`, { skip: !process.env.VINCI_CANDIDATE_REJECTED_HELPER }, () => {
    const f = setup(command, "realistic");
    try { const r = f.run(process.env.VINCI_CANDIDATE_REJECTED_HELPER); report(f, r, true, true); assert.equal(r.status, 1); assert.match(r.stderr, /ENOBUFS/); }
    finally { rmSync(f.folder, { recursive: true }); }
  });
}
test("Provenance bound agrees with existing workflow, independently of envelope/receipt limits", () => {
  assert.equal(PROVENANCE_MAX_BYTES, 1024 * 1024);
  const workflow = parse(readFileSync(join(root, ".github/workflows/vinci-release.yml"), "utf8"));
  const bind = workflow.jobs.publish.steps.find((s) => s.name?.startsWith("Bind the downloaded"));
  assert.match(bind.run, /maxBuffer:\s*1024\s*\*\s*1024/);
});

const rollback = parse(readFileSync(join(root, ".github/workflows/vinci-rollback.yml"), "utf8"));
function rollbackFixture(mode) {
  const folder = mkdtempSync(join(tmpdir(), "vinci-rollback-inert-"));
  for (const name of ["bin", "release", "receipt"]) mkdirSync(join(folder, name));
  const target = json({ signed: { version: "0.0.57", sequence: 44 }, signature: "INERT" });
  writeFileSync(join(folder, "release/manifest-beta.json"), target);
  const state = join(folder, "state.json"), calls = join(folder, "calls.jsonl");
  writeFileSync(calls, ""); writeFileSync(state, json({ etag: mode === "precondition" ? '"other"' : '"baseline-one"', body: json({ signed: { version: "0.0.56", sequence: 43 } }).toString("base64") }));
  const aws = join(folder, "bin/aws");
  writeFileSync(aws, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.MOCK_CALLS,JSON.stringify({tool:'aws',args:a})+'\\n');const s=JSON.parse(fs.readFileSync(process.env.MOCK_STATE));if(a[1]==='head-object'){process.stdout.write('{}\\n');process.exit(0);}if(a[1]!=='put-object')process.exit(99);if(process.env.MOCK_MODE==='denied'||s.etag!==a[a.indexOf('--if-match')+1]){process.stderr.write('INERT refused or stale precondition\\n');process.exit(1);}s.body=fs.readFileSync(a[a.indexOf('--body')+1]).toString('base64');s.etag='"committed"';fs.writeFileSync(process.env.MOCK_STATE,JSON.stringify(s));if(process.env.MOCK_MODE.startsWith('lost')){process.stderr.write('INERT response lost after commit\\n');process.exit(1);}process.stdout.write('{}\\n');\n`); chmodSync(aws, 0o755);
  const curl = join(folder, "bin/curl");
  writeFileSync(curl, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.MOCK_CALLS,JSON.stringify({tool:'curl',args:a})+'\\n');const mode=process.env.MOCK_MODE;if(mode==='lost-diagnostic-connect-timeout'||mode==='lost-diagnostic-total-timeout'){if(a[a.indexOf('--connect-timeout')+1]!=='5'||a[a.indexOf('--max-time')+1]!=='15'||a[a.indexOf('--retry')+1]!=='0')process.exit(99);fs.appendFileSync(process.env.MOCK_CALLS,JSON.stringify({tool:'curl-result',exit:28,mode})+'\\n');process.stderr.write('INERT diagnostic timeout (modeled exit 28)\\n');process.exit(28);}if(mode==='lost-diagnostic-fails'){fs.appendFileSync(process.env.MOCK_CALLS,JSON.stringify({tool:'curl-result',exit:1,mode})+'\\n');process.stderr.write('INERT diagnostic unavailable\\n');process.exit(1);}const s=JSON.parse(fs.readFileSync(process.env.MOCK_STATE));if(a.includes('-D'))fs.writeFileSync(a[a.indexOf('-D')+1],'HTTP/2 200\\r\\nETag: '+s.etag+'\\r\\n\\r\\n');process.stdout.write(Buffer.from(s.body,'base64'));\n`); chmodSync(curl, 0o755);
  const env = { PATH: `${join(folder, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: folder, TMPDIR: folder, S3_BUCKET: "fixture", S3_PREFIX: "vinci-code", MANIFEST_URL: "https://fixture.invalid/manifest", LIVE_ETAG: '"baseline-one"', VERSION: "0.0.57", NEXT_SEQ: "44", MOCK_STATE: state, MOCK_CALLS: calls, MOCK_MODE: mode, AWS_MAX_ATTEMPTS: "1", AWS_RETRY_MODE: "standard" };
  const write = rollback.jobs.rollback.steps.find((s) => s.name?.startsWith("Publish the manifest"));
  const verifyStep = rollback.jobs.rollback.steps.find((s) => s.name?.startsWith("Verify the LIVE manifest"));
  return { folder, state, target, env, calls, write, verifyStep, run: (step) => spawnSync("bash", ["-c", step.run], { cwd: folder, env, encoding: "utf8", timeout: 10000 }) };
}
for (const mode of ["lost-response", "lost-diagnostic-fails", "lost-diagnostic-connect-timeout", "lost-diagnostic-total-timeout", "denied", "precondition"]) test(`Actual rollback shell: ${mode} remains UNRESOLVED without retry`, () => {
  const f = rollbackFixture(mode);
  try {
    const r = f.run(f.write); assert.equal(r.status, 1); assert.match(r.stdout, /outcome is UNRESOLVED/); assert.doesNotMatch(r.stdout, /nothing was activated|changed under us/);
    const status = JSON.parse(readFileSync(join(f.folder, "receipt/activation-status.json")));
    assert.equal(status.status, "UNRESOLVED"); assert.equal(status.automaticRetries, 0); assert.match(status.nextAction, /Reconcile/);
    const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter((v) => v.tool === "aws" && v.args[1] === "put-object").length, 1);
    assert.equal(calls.filter((v) => v.tool === "curl").length, 1);
    const diagnostic = calls.find((v) => v.tool === "curl").args;
    assert.equal(diagnostic[diagnostic.indexOf("--connect-timeout") + 1], "5");
    assert.equal(diagnostic[diagnostic.indexOf("--max-time") + 1], "15");
    assert.equal(diagnostic[diagnostic.indexOf("--retry") + 1], "0");
    if (mode.includes("timeout")) {
      assert.equal(calls.find((v) => v.tool === "curl-result").exit, 28);
      assert.match(r.stderr, /modeled exit 28/);
      assert.equal(readFileSync(join(f.folder, "receipt/live-divergent.json")).length, 0);
    }
    if (mode === "lost-diagnostic-fails") {
      assert.equal(calls.find((v) => v.tool === "curl-result").exit, 1);
      assert.match(r.stderr, /diagnostic unavailable/);
      assert.equal(readFileSync(join(f.folder, "receipt/live-divergent.json")).length, 0);
    }
    if (mode.startsWith("lost")) assert.equal(digest(Buffer.from(JSON.parse(readFileSync(f.state)).body, "base64")), digest(f.target));
  } finally { rmSync(f.folder, { recursive: true }); }
});
test("Actual rollback shell acknowledges a write without claiming live verification, then verifies bytes separately", () => {
  const f = rollbackFixture("success");
  try {
    assert.equal(f.run(f.write).status, 0);
    assert.equal(JSON.parse(readFileSync(join(f.folder, "receipt/activation-status.json"))).status, "WRITE_ACKNOWLEDGED_PENDING_LIVE_VERIFICATION");
    const verified = f.run(f.verifyStep); assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(readFileSync(join(f.folder, "receipt/activation-status.json"))).status, "LIVE_BYTES_VERIFIED");
  } finally { rmSync(f.folder, { recursive: true }); }
});
test("Rollback keeps existing approval/role/concurrency and explicitly disables SDK retries", () => {
  assert.equal(rollback.jobs.rollback.environment, "vinci-release"); assert.equal(rollback.concurrency.group, "vinci-release"); assert.equal(rollback.concurrency["cancel-in-progress"], false);
  assert.equal(rollback.jobs.rollback.env.AWS_MAX_ATTEMPTS, "1"); assert.equal(rollback.jobs.rollback.env.AWS_RETRY_MODE, "standard");
  assert.deepEqual(rollback.jobs.rollback.permissions, { contents: "read", "id-token": "write" });
});
