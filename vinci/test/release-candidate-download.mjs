// Inert HTTP responses only. The two extraction controls run real stdlib Python on synthetic ZIPs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { digest } from "../scripts/release-candidate.mjs";
import { canonicalArchiveUrl, downloadCandidate, downloadPolicy, LIMITS, redirectTarget, selectArtifact } from "../scripts/release-candidate-download.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function fixture(realZip = false) {
  const folder = mkdtempSync(join(tmpdir(), "vinci-exact-id-test-"));
  let zip = Buffer.from("INERT ZIP, extractor mocked"), receiptSha256 = "c".repeat(64);
  if (realZip) {
    const path = join(folder, "fixture.zip");
    const output = JSON.parse(execFileSync("python3", ["-I", join(root, "vinci/test/release-candidate-extract.py"), "--fixture", path], { encoding: "utf8", timeout: 20000 }));
    zip = readFileSync(path); receiptSha256 = output.receiptSha256;
  }
  const now = Date.now(), source = "a".repeat(40), tag = "vinci-v0.0.58";
  const event = { repository: "getsimpledirect/vinci-code-cli", repositoryId: "1345288037", source, tag, ref: `refs/tags/${tag}`, eventName: "workflow_dispatch", operation: "activate", runId: "201", runAttempt: "1" };
  const artifact = { id: 301, name: "vinci-signed-candidate-0.0.58-101-1", size_in_bytes: zip.length, expired: false,
    created_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 86400000).toISOString(), digest: `sha256:${digest(zip)}`,
    workflow_run: { id: 101, head_sha: source }, archive_download_url: canonicalArchiveUrl("301") };
  const other = { ...artifact, id: 302, name: "unapproved-other", archive_download_url: canonicalArchiveUrl("302") };
  const context = { event, artifact, producer: { id: 101, run_attempt: 1, repository: { full_name: event.repository, id: 1345288037 }, path: ".github/workflows/vinci-release.yml", head_sha: source, head_branch: tag, status: "completed", conclusion: "success", event: "push" },
    jobs: { jobs: [{ name: "Stage signed candidate", conclusion: "success" }] }, inputs: { runId: "101", runAttempt: "1", artifactId: "301", receiptSha256 } };
  const catalog = { total_count: 2, artifacts: [artifact, other] };
  const policy = { schemaVersion: 1, owner: "thegeorgepu", environment: "vinci-release", protectedApprovalReviewed: true, tagOidcTrustReviewed: true, stagingExposureAndCostsApproved: true, retentionApproved: true, confirmedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), maxCandidateHours: 168, maxQaHours: 24, candidateRetentionDays: 14, receiptRetentionDays: 90, artifactDownloadHosts: ["cdn.example.invalid"] };
  const calls = [], state = { after: false, extracts: 0, mode: "normal" };
  async function request(url, options) {
    calls.push({ url, options }); assert.equal(options.redirect, "manual"); assert.equal(options.method, "GET");
    if (state.mode === "timeout") throw new DOMException("INERT transfer timeout", "TimeoutError");
    if (url.endsWith("/actions/runs/101")) return Response.json(state.mode === "fresh-wrong-run" ? { ...context.producer, id: 102 } : state.mode === "post-attempt-change" && state.after ? { ...context.producer, run_attempt: 2 } : context.producer);
    if (url.includes("/artifacts?")) {
      if (state.mode === "api-denied") return new Response("INERT denied", { status: 403 });
      if (state.mode === "post-duplicate" && state.after) return Response.json({ total_count: 3, artifacts: [...catalog.artifacts, { ...other, id: 303, name: artifact.name }] });
      return Response.json(catalog);
    }
    if (url.endsWith("/artifacts/301")) return Response.json(state.mode === "post-change" && state.after ? { ...artifact, name: "changed" } : artifact);
    if (url === canonicalArchiveUrl("301")) return new Response(null, { status: state.mode === "api-direct-body" ? 200 : 302, headers: state.mode === "missing-location" ? {} : { location: state.redirect ?? "https://cdn.example.invalid/approved.zip?signature=INERT" } });
    if (url.startsWith("https://cdn.example.invalid/")) {
      assert.equal(options.headers.authorization, undefined, "Never forward token to archive host"); state.after = true;
      const body = state.mode === "short" ? zip.subarray(0, zip.length - 1) : state.mode === "long" ? Buffer.concat([zip, Buffer.from("x")]) : zip;
      const headers = state.mode === "long" ? {} : { "content-length": String(state.mode === "wrong-length" ? zip.length + 1 : zip.length) };
      if (state.mode === "encoding") headers["content-encoding"] = "gzip";
      return new Response(body, { status: state.mode === "second-redirect" ? 302 : 200, headers });
    }
    throw Error("INERT unexpected request path");
  }
  const extractor = async (path, destination, version, sha) => { state.extracts++; assert.equal(digest(readFileSync(path)), digest(zip)); assert.equal(version, "0.0.58"); assert.equal(sha, receiptSha256); assert.equal(destination, join(realpathSync(folder), "candidate")); return { mocked: true }; };
  return { folder, zip, context, artifact, other, catalog, policy, state, calls, request,
    options: () => ({ context, policyRaw: JSON.stringify(policy), token: "INERT_TOKEN", workspace: folder, request, ...(realZip ? {} : { extractor }) }) };
}
test("Only approved ID is transferred; unrelated catalog artifact is never requested", async () => {
  const f = fixture(); try {
    const receipt = await downloadCandidate(f.options());
    assert.equal(receipt.artifactId, "301"); assert.equal(receipt.onlyApprovedIdRequested, true); assert.equal(f.state.extracts, 1);
    assert.equal(f.calls.filter(c => c.url.endsWith("/zip")).length, 1);
    assert.ok(f.calls.every(c => !c.url.includes("/302")));
    assert.equal(f.calls.filter(c => c.url.startsWith("https://api.github.com/")).length, 7);
    assert.ok(f.calls.filter(c => c.url.startsWith("https://api.github.com/")).every(c => c.options.headers.authorization === "Bearer INERT_TOKEN"));
  } finally { rmSync(f.folder, { recursive: true }); }
});
const negative = [
  ["wrong run", f => { f.context.producer.id = 102; }],
  ["wrong attempt", f => { f.context.producer.run_attempt = 2; }],
  ["failed producer", f => { f.context.producer.conclusion = "failure"; }],
  ["wrong metadata ID", f => { f.artifact.id = 302; }],
  ["wrong source", f => { f.artifact.workflow_run.head_sha = "b".repeat(40); }],
  ["expired artifact", f => { f.artifact.expired = true; }],
  ["missing selected artifact", f => { f.catalog.artifacts = [f.other]; f.catalog.total_count = 1; }],
  ["duplicate selected ID", f => { f.catalog.artifacts.push({ ...f.artifact }); f.catalog.total_count++; }],
  ["duplicate candidate name", f => { f.other.name = f.artifact.name; }],
  ["truncated catalog", f => { f.catalog.total_count = 3; }],
  ["oversized catalog", f => { f.catalog.total_count = 101; }],
  ["untrusted artifact endpoint", f => { f.artifact.archive_download_url = "https://evil.example.invalid/301.zip"; }],
  ["artifact size too large", f => { f.artifact.size_in_bytes = LIMITS.archiveBytes + 1; }],
  ["bad digest algorithm", f => { f.artifact.digest = "md5:bad"; }],
  ["wrong API archive digest", f => { f.artifact.digest = `sha256:${"0".repeat(64)}`; }],
  ["missing Ops host allowance", f => { f.policy.artifactDownloadHosts = []; }],
  ["wildcard Ops host", f => { f.policy.artifactDownloadHosts = ["*.example.invalid"]; }],
  ["unsafe HTTP redirect", f => { f.state.redirect = "http://cdn.example.invalid/x"; }],
  ["unapproved redirect host", f => { f.state.redirect = "https://other.example.invalid/x"; }],
  ["redirect credentials", f => { f.state.redirect = "https://name:secret@cdn.example.invalid/x"; }],
  ["redirect port", f => { f.state.redirect = "https://cdn.example.invalid:8443/x"; }],
  ["redirect fragment", f => { f.state.redirect = "https://cdn.example.invalid/x#fragment"; }],
  ["missing redirect", f => { f.state.mode = "missing-location"; }],
  ["unexpected direct API body", f => { f.state.mode = "api-direct-body"; }],
  ["second redirect", f => { f.state.mode = "second-redirect"; }],
  ["API access refusal", f => { f.state.mode = "api-denied"; }],
  ["modeled timeout", f => { f.state.mode = "timeout"; }],
  ["truncated archive body", f => { f.state.mode = "short"; }],
  ["oversized archive stream", f => { f.state.mode = "long"; }],
  ["wrong advertised body length", f => { f.state.mode = "wrong-length"; }],
  ["unexpected content encoding", f => { f.state.mode = "encoding"; }],
  ["changed post-transfer metadata", f => { f.state.mode = "post-change"; }],
  ["post-transfer duplicate name", f => { f.state.mode = "post-duplicate"; }],
  ["fresh API run mismatch", f => { f.state.mode = "fresh-wrong-run"; }],
  ["post-transfer attempt change", f => { f.state.mode = "post-attempt-change"; }],
];
for (const [name, change] of negative) test(`ID-only transfer refuses ${name}`, async () => {
  const f = fixture(); try { change(f); await assert.rejects(downloadCandidate(f.options())); assert.equal(f.state.extracts, 0); assert.ok(f.calls.every(c => !c.url.includes("/302"))); }
  finally { rmSync(f.folder, { recursive: true }); }
});
test("Existing/symlink output cannot be overwritten and no request occurs", async () => {
  const f = fixture(); try {
    const outside = join(f.folder, "outside"); mkdirSync(outside); writeFileSync(join(outside, "sentinel"), "preserve"); symlinkSync(outside, join(f.folder, "candidate"));
    await assert.rejects(downloadCandidate(f.options())); assert.equal(f.calls.length, 0); assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "preserve");
  } finally { rmSync(f.folder, { recursive: true }); }
});
test("Absent token and canceled deadline cannot trigger requests", async () => {
  const f = fixture(); try {
    await assert.rejects(downloadCandidate({ ...f.options(), token: "" }));
    await assert.rejects(downloadCandidate({ ...f.options(), signal: AbortSignal.abort() })); assert.equal(f.calls.length, 0);
  } finally { rmSync(f.folder, { recursive: true }); }
});
test("Actual Python extraction receives only the selected synthetic ZIP", async () => {
  const f = fixture(true); try {
    const receipt = await downloadCandidate(f.options());
    assert.equal(receipt.extraction.reviewedReceiptMatched, true);
    assert.equal(receipt.extraction.incompleteMarkerAbsent, true);
    assert.equal(Object.keys(receipt.extraction.files).length, 10);
    assert.equal(digest(readFileSync(join(f.folder, "candidate/candidate.json"))), f.context.inputs.receiptSha256);
    assert.ok(f.calls.every(c => !c.url.includes("/302")));
  } finally { rmSync(f.folder, { recursive: true }); }
});
test("Actual extractor refuses a different reviewed receipt without a completion result", async () => {
  const f = fixture(true); try {
    f.context.inputs.receiptSha256 = "0".repeat(64);
    await assert.rejects(downloadCandidate(f.options()));
    assert.ok(readFileSync(join(f.folder, "candidate/.INCOMPLETE")).length === 0);
  } finally { rmSync(f.folder, { recursive: true }); }
});
test("Activation removes unsupported action input without a pin/permission change", () => {
  const workflow = parse(readFileSync(join(root, ".github/workflows/vinci-release.yml"), "utf8"));
  const activation = workflow.jobs.activate;
  assert.deepEqual(activation.permissions, { contents: "write", actions: "read", "id-token": "write" });
  assert.equal(activation.environment, "vinci-release");
  assert.ok(activation.steps.every(s => !s.uses?.startsWith("actions/download-artifact") && !s.with?.["artifact-ids"]));
  const step = activation.steps.find(s => s.name?.startsWith("Download only the approved"));
  assert.equal(step.run, "node vinci/scripts/release-candidate-download.mjs"); assert.equal(step.env.GH_TOKEN, "${{ github.token }}");
  const legacy = workflow.jobs.publish.steps.find(s => s.uses?.startsWith("actions/download-artifact"));
  assert.equal(legacy.uses, "actions/download-artifact@fa0a91b85d4f404e444e00e005971372dc801d16"); assert.equal(legacy.with.name, "vinci-release-payload");
});
for (const mode of ["selected-only", "duplicate-name"]) test(`Actual downloader CLI with inert HTTP: ${mode}`, () => {
  const f = fixture(true);
  try {
    if (mode === "duplicate-name") f.other.name = f.artifact.name;
    for (const [name, value] of Object.entries({ "producer-run.json": f.context.producer, "candidate-artifact.json": f.artifact, "producer-jobs.json": f.context.jobs })) writeFileSync(join(f.folder, name), JSON.stringify(value));
    mkdirSync(join(f.folder, "bin"));
    const git = join(f.folder, "bin/git");
    writeFileSync(git, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]!=='rev-parse'||!['HEAD','${"a".repeat(40)}^{commit}'].includes(a[1]))process.exit(99);process.stdout.write('${"a".repeat(40)}\\n');\n`); chmodSync(git, 0o755);
    const calls = join(f.folder, "cli-calls.jsonl"); writeFileSync(calls, "");
    const config = join(f.folder, "cli-fixture.json");
    writeFileSync(config, JSON.stringify({ producer: f.context.producer, catalog: f.catalog, artifact: f.artifact, zip: join(f.folder, "fixture.zip"), calls }));
    const preload = join(f.folder, "inert-http.mjs");
    writeFileSync(preload, `import assert from 'node:assert/strict';import{readFileSync,appendFileSync}from'node:fs';const d=JSON.parse(readFileSync(process.env.ID_FIXTURE_CONFIG));globalThis.fetch=async(url,options)=>{appendFileSync(d.calls,JSON.stringify({url,authorizationPresent:!!options.headers.authorization})+'\\n');assert.equal(options.redirect,'manual');if(url.endsWith('/actions/runs/101'))return Response.json(d.producer);if(url.includes('/artifacts?'))return Response.json(d.catalog);if(url.endsWith('/artifacts/301'))return Response.json(d.artifact);if(url.endsWith('/artifacts/301/zip'))return new Response(null,{status:302,headers:{location:'https://cdn.example.invalid/301.zip'}});if(url==='https://cdn.example.invalid/301.zip'){assert.equal(options.headers.authorization,undefined);return new Response(readFileSync(d.zip),{headers:{'content-length':String(d.artifact.size_in_bytes)}});}throw Error('INERT unexpected route');};\n`);
    const env = { PATH: `${join(f.folder, "bin")}:${process.env.PATH}`, HOME: f.folder, TMPDIR: f.folder, PI_OFFLINE: "1", ID_FIXTURE_CONFIG: config,
      GITHUB_REPOSITORY: f.context.event.repository, GITHUB_REPOSITORY_ID: "1345288037", GITHUB_SHA: f.context.event.source, GITHUB_REF: f.context.event.ref, GITHUB_REF_NAME: f.context.event.tag,
      GITHUB_EVENT_NAME: "workflow_dispatch", RELEASE_OPERATION: "activate", GITHUB_RUN_ID: "201", GITHUB_RUN_ATTEMPT: "1",
      CANDIDATE_RUN_ID: "101", CANDIDATE_RUN_ATTEMPT: "1", CANDIDATE_ARTIFACT_ID: "301", CANDIDATE_RECEIPT_SHA256: f.context.inputs.receiptSha256, VINCI_SIGNED_QA_POLICY: JSON.stringify(f.policy), GH_TOKEN: "INERT_TOKEN" };
    const r = spawnSync(process.execPath, ["--import", preload, join(root, "vinci/scripts/release-candidate-download.mjs")], { cwd: f.folder, env, encoding: "utf8", timeout: 20000 });
    const records = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.ok(records.every(v => !v.url.includes("/302")));
    if (mode === "selected-only") {
      assert.equal(r.status, 0, r.stderr); const receipt = JSON.parse(readFileSync(join(f.folder, "artifact-download-receipt.json")));
      assert.equal(receipt.artifactId, "301"); assert.equal(receipt.extraction.reviewedReceiptMatched, true);
      assert.equal(records.filter(v => v.url.endsWith("/zip")).length, 1);
    } else {
      assert.equal(r.status, 1); assert.equal(records.filter(v => v.url.endsWith("/zip")).length, 0);
      assert.equal(JSON.parse(readFileSync(join(f.folder, "artifact-download-refusal.json"))).status, "REFUSED");
    }
  } finally { rmSync(f.folder, { recursive: true }); }
});
