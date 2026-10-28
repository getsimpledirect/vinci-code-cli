// Explicit ID-only transfer. CLI has no transport/extraction bypass; tests inject inert adapters.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eventFromEnv, repository, validatePolicy, validateProducer } from "./release-candidate.mjs";

export const LIMITS = Object.freeze({ archiveBytes: 64 * 1024 * 1024, metadataBytes: 2 * 1024 * 1024, catalogEntries: 100, totalMs: 60000, extractionMs: 20000 });
const hex = /^[a-f0-9]{64}$/;
const id = (value) => { if (typeof value === "number") assert.ok(Number.isSafeInteger(value)); assert.match(String(value), /^[1-9][0-9]{0,17}$/); return String(value); };
const api = "https://api.github.com";
export function canonicalArchiveUrl(artifactId) { return `${api}/repos/${repository}/actions/artifacts/${id(artifactId)}/zip`; }
function identity(artifact) {
  return { id: id(artifact.id), name: artifact.name, size: artifact.size_in_bytes, expired: artifact.expired,
    created: artifact.created_at, expires: artifact.expires_at, digest: artifact.digest ?? null,
    run: id(artifact.workflow_run?.id), source: artifact.workflow_run?.head_sha, archive: artifact.archive_download_url };
}
export function selectArtifact(context, catalog, artifact = context.artifact, now = Date.now()) {
  validateProducer({ ...context, artifact, now });
  assert.match(context.inputs.receiptSha256, hex, "Reviewed candidate receipt digest required");
  assert.ok(Number.isSafeInteger(catalog.total_count) && catalog.total_count >= 1 && catalog.total_count <= LIMITS.catalogEntries, "Unbounded or empty artifact catalog");
  assert.ok(Array.isArray(catalog.artifacts) && catalog.artifacts.length === catalog.total_count, "Incomplete/paginated artifact catalog");
  const ids = catalog.artifacts.map((value) => id(value.id));
  assert.equal(new Set(ids).size, ids.length, "Duplicate artifact ID");
  const selected = catalog.artifacts.filter((value) => id(value.id) === id(context.inputs.artifactId));
  assert.equal(selected.length, 1, "Missing or duplicate approved artifact");
  assert.equal(catalog.artifacts.filter((value) => value.name === artifact.name).length, 1, "Ambiguous artifact name");
  const value = identity(artifact);
  assert.deepEqual(identity(selected[0]), value, "Catalog and selected artifact identity differ");
  assert.equal(value.archive, canonicalArchiveUrl(context.inputs.artifactId), "Unexpected artifact endpoint");
  assert.ok(Number.isSafeInteger(value.size) && value.size > 0 && value.size <= LIMITS.archiveBytes, "Artifact archive size exceeds limit");
  if (value.digest !== null) assert.match(value.digest, /^sha256:[a-f0-9]{64}$/, "Unsupported artifact digest");
  return value;
}
export function downloadPolicy(raw, now = Date.now()) {
  const policy = validatePolicy(raw, now);
  const hosts = policy.artifactDownloadHosts;
  assert.ok(Array.isArray(hosts) && hosts.length >= 1 && hosts.length <= 8, "Ops-reviewed artifact redirect hosts required");
  assert.equal(new Set(hosts).size, hosts.length);
  for (const host of hosts) {
    assert.equal(typeof host, "string"); assert.ok(host.length <= 253);
    assert.match(host, /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/);
    assert.equal(isIP(host), 0); assert.ok(!host.endsWith(".localhost") && !host.endsWith(".local") && host !== "api.github.com");
  }
  return policy;
}
export function redirectTarget(value, policy) {
  assert.equal(typeof value, "string"); assert.ok(value.length <= 16384 && !/[\u0000-\u0020\u007f-\u009f\\]/.test(value), "Unsafe archive redirect");
  let url; try { url = new URL(value); } catch { throw Error("Invalid archive redirect"); }
  assert.equal(url.protocol, "https:"); assert.equal(url.username, ""); assert.equal(url.password, ""); assert.equal(url.hash, "");
  assert.ok(url.port === "" || url.port === "443");
  assert.ok(policy.artifactDownloadHosts.includes(url.hostname), "Unapproved archive redirect host");
  return url.href;
}
async function bytes(response, maximum, signal) {
  assert.ok(response.body, "Missing response body");
  const length = response.headers.get("content-length");
  if (length !== null) assert.ok(/^[0-9]+$/.test(length) && Number(length) <= maximum, "Response exceeds byte limit");
  const chunks = []; let size = 0;
  for await (const value of response.body) {
    signal.throwIfAborted(); size += value.length; assert.ok(size <= maximum, "Response exceeds byte limit"); chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}
function extract(zip, destination, version, receiptSha256, timeout, context) {
  const script = join(dirname(fileURLToPath(import.meta.url)), "extract-release-candidate.py");
  const output = execFileSync("python3", ["-I", script, "--archive", zip, "--destination", destination, "--version", version, "--receipt-sha256", receiptSha256,
    "--source", context.event.source, "--run-id", String(context.inputs.runId), "--run-attempt", String(context.inputs.runAttempt)],
    { timeout, maxBuffer: 65536, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" } });
  return JSON.parse(output);
}
export async function downloadCandidate({ context, policyRaw, token, workspace, request = globalThis.fetch, extractor = extract, now = () => Date.now(), signal: suppliedSignal }) {
  const started = now(), deadline = started + LIMITS.totalMs;
  const signal = suppliedSignal ?? AbortSignal.timeout(LIMITS.totalMs);
  const policy = downloadPolicy(policyRaw, started);
  validateProducer({ ...context, now: started });
  if (extractor === extract) execFileSync("python3", ["-I", "-c", "import sys; assert sys.version_info >= (3, 10)"], { timeout: 5000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  assert.match(context.inputs.receiptSha256, hex);
  assert.equal(typeof token, "string"); assert.ok(token.length >= 1 && token.length <= 4096 && !/[\r\n\u0000]/.test(token), "Artifact read token required");
  const base = await realpath(workspace), destination = join(base, "candidate");
  try { await lstat(destination); throw Error("Candidate destination already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const apiHeaders = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  async function get(url, headers) {
    signal.throwIfAborted(); assert.ok(now() < deadline, "Artifact transfer deadline expired");
    return request(url, { method: "GET", headers, redirect: "manual", credentials: "omit", signal });
  }
  async function json(url) {
    const response = await get(url, apiHeaders);
    assert.equal(response.status, 200, "Artifact metadata request refused");
    return JSON.parse((await bytes(response, LIMITS.metadataBytes, signal)).toString());
  }
  const runId = id(context.inputs.runId), artifactId = id(context.inputs.artifactId);
  const producerUrl = `${api}/repos/${repository}/actions/runs/${runId}`;
  const catalogUrl = `${api}/repos/${repository}/actions/runs/${runId}/artifacts?per_page=${LIMITS.catalogEntries}`;
  const metadataUrl = `${api}/repos/${repository}/actions/artifacts/${artifactId}`;
  const producer = await json(producerUrl), catalog = await json(catalogUrl), metadata = await json(metadataUrl);
  const selected = selectArtifact({ ...context, producer }, catalog, metadata, now());
  assert.deepEqual(selected, identity(context.artifact), "Selected metadata changed since preflight");
  const response = await get(canonicalArchiveUrl(artifactId), apiHeaders);
  assert.equal(response.status, 302, "Expected one authenticated archive redirect");
  const target = redirectTarget(response.headers.get("location"), policy);
  await response.body?.cancel();
  const archive = await get(target, { accept: "application/zip" }); // Never forward the GitHub token.
  assert.equal(archive.status, 200, "Archive transfer refused or redirected again");
  assert.ok(!archive.headers.get("content-encoding") || archive.headers.get("content-encoding") === "identity", "Unexpected archive encoding");
  const advertised = archive.headers.get("content-length");
  if (advertised !== null) assert.equal(Number(advertised), selected.size, "Archive length differs from selected metadata");
  assert.ok(archive.body, "Missing archive body");
  const temporary = await mkdtemp(join(tmpdir(), "vinci-approved-artifact-")); await chmod(temporary, 0o700);
  const zip = join(temporary, "approved.zip");
  try {
    const handle = await open(zip, "wx", 0o600), hash = createHash("sha256"); let size = 0;
    try {
      for await (const chunk of archive.body) {
        signal.throwIfAborted(); assert.ok(now() < deadline, "Artifact transfer deadline expired");
        size += chunk.length; assert.ok(size <= selected.size && size <= LIMITS.archiveBytes, "Archive stream exceeds selected size");
        hash.update(chunk); await handle.writeFile(chunk);
      }
    } finally { await handle.close(); }
    assert.equal(size, selected.size, "Truncated artifact archive");
    const archiveSha256 = hash.digest("hex");
    if (selected.digest) assert.equal(`sha256:${archiveSha256}`, selected.digest, "Artifact API digest differs");
    const afterProducer = await json(producerUrl), afterCatalog = await json(catalogUrl), afterMetadata = await json(metadataUrl);
    assert.deepEqual(selectArtifact({ ...context, producer: afterProducer }, afterCatalog, afterMetadata, now()), selected, "Artifact identity changed during transfer");
    downloadPolicy(policyRaw, now()); signal.throwIfAborted();
    const remaining = Math.min(LIMITS.extractionMs, deadline - now()); assert.ok(remaining > 0, "Artifact deadline expired before extraction");
    const extraction = await extractor(zip, destination, context.event.tag.slice(7), context.inputs.receiptSha256, remaining, context);
    assert.ok(now() < deadline, "Artifact deadline expired during extraction");
    return { schemaVersion: 1, artifactId, producerRunId: runId, producerRunAttempt: String(context.inputs.runAttempt), artifactName: selected.name,
      archiveSha256, archiveBytes: size, apiDigestPresent: selected.digest !== null, receiptSha256: context.inputs.receiptSha256,
      identityRecheckedAfterTransfer: true, onlyApprovedIdRequested: true, redirects: 1, authorizationForwardedToRedirect: false,
      extraction, source: context.event.source, policySha256: policy.sha256 };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function main() {
  const context = { event: eventFromEnv(), producer: JSON.parse(await readFile("producer-run.json")), artifact: JSON.parse(await readFile("candidate-artifact.json")),
    jobs: JSON.parse(await readFile("producer-jobs.json")), inputs: { runId: process.env.CANDIDATE_RUN_ID, runAttempt: process.env.CANDIDATE_RUN_ATTEMPT, artifactId: process.env.CANDIDATE_ARTIFACT_ID, receiptSha256: process.env.CANDIDATE_RECEIPT_SHA256 } };
  const receipt = await downloadCandidate({ context, policyRaw: process.env.VINCI_SIGNED_QA_POLICY ?? "", token: process.env.GH_TOKEN, workspace: process.cwd() });
  await writeFile("artifact-download-receipt.json", `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`Verified exact artifact ID ${receipt.artifactId}; bounded candidate extraction complete.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async () => {
    // Never echo token, signed redirect query, response body or raw fetch error into logs.
    try { await writeFile("artifact-download-refusal.json", '{"schemaVersion":1,"status":"REFUSED","automaticRetries":0}\n', { flag: "wx", mode: 0o600 }); } catch {}
    console.error("Artifact download refused; inspect retained metadata and approved limits. No automatic retry."); process.exitCode = 1;
  });
}
