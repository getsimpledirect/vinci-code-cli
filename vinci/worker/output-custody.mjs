import { createHash } from "node:crypto";

import { command } from "./exec.mjs";
import { parseGitNulPaths } from "./run.mjs";

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Post-run capture bounds prevent unbounded memory and evidence archive growth. They never
// refuse compute: oversized/local-only output keeps its inventory and an incomplete receipt.
export const OUTPUT_CAPTURE_LIMITS = Object.freeze({ files: 256, file_bytes: 8 * 1024 * 1024, total_bytes: 64 * 1024 * 1024 });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (repoDir, args, maxOutputBytes = 1024 * 1024) => command("git", ["-C", repoDir, "--literal-pathspecs", ...args], {
  allowFailure: true, rawStdout: true, maxOutputBytes, timeoutMs: 30000,
});

function treeEntries(raw) {
  const entries = new Map();
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    const record = raw.subarray(start, index);
    const tab = record.indexOf(9);
    const header = record.subarray(0, tab).toString("ascii").split(" ");
    if (tab < 0 || header.length !== 3 || !COMMIT.test(header[2])) throw new Error("invalid Git tree record");
    const [path] = parseGitNulPaths(Buffer.concat([record.subarray(tab + 1), Buffer.from([0])]), "artifact tree path");
    if (entries.has(path)) throw new Error(`duplicate artifact tree path ${JSON.stringify(path)}`);
    entries.set(path, { mode: header[0], type: header[1], oid: header[2] });
    start = index + 1;
  }
  if (start !== raw.length) throw new Error("unterminated Git tree record");
  return entries;
}

export async function prepareOutputCustody({ mode, repoDir, publication, baseCommit, head, attempt }) {
  const custody = {
    schema: "vinci.worker-output-custody/1", mode, status: "local_only", durable: false,
    base_commit: baseCommit ?? null, head: head ?? null, reason: null,
  };
  const extraFiles = {};
  if (mode === "none") return { custody: { ...custody, status: "not_required", reason: "output:none" }, extraFiles };
  if (mode === "branch") {
    const verified = COMMIT.test(head ?? "") && publication.remote_readback_verified === true
      && publication.pushed_sha === head && publication.remote_sha_after === head
      && typeof publication.remote_url === "string" && publication.remote_url.length > 0
      && /^[0-9a-f]{64}$/.test(publication.remote_transport_sha256 ?? "")
      && typeof publication.remote_ref === "string" && publication.remote_ref.startsWith("refs/heads/");
    return {
      custody: {
        ...custody, status: verified ? "remote_verified" : "local_only", durable: verified,
        remote_url: publication.remote_url ?? null, remote_ref: publication.remote_ref ?? null,
        remote_transport_sha256: publication.remote_transport_sha256 ?? null,
        remote_measurement: publication.remote_measurement ?? null,
        observed_sha: publication.remote_sha_after ?? null,
        reason: verified ? null : "exact remote/ref/head readback is unavailable",
      }, extraFiles,
    };
  }
  custody.limits = OUTPUT_CAPTURE_LIMITS;
  if (!COMMIT.test(baseCommit ?? "") || !COMMIT.test(head ?? "")) {
    return { custody: { ...custody, status: "incomplete", reason: "output capture requires exact base and head commits" }, extraFiles };
  }
  if (mode === "patch") {
    if (publication.publish !== "patch" || typeof publication.patch !== "string" || !publication.patch.trim() || head === baseCommit) {
      return { custody: { ...custody, status: "incomplete", reason: "patch publication failed or produced no patch" }, extraFiles };
    }
    // A full binary diff reconstructs the exact output tree from the named base. Keep the
    // existing format-patch member too; a textual summary alone is never custody proof.
    const diff = await git(repoDir, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", baseCommit, head], OUTPUT_CAPTURE_LIMITS.total_bytes);
    if (diff.status !== 0 || diff.stdout.length === 0) {
      return { custody: { ...custody, status: "incomplete", reason: diff.stderr || "patch has no reconstructable tree changes" }, extraFiles };
    }
    const member = `${attempt}.output.patch`;
    extraFiles[member] = diff.stdout;
    return { custody: { ...custody, status: "pending_upload", reason: "output bundle has not landed", capture: { member, bytes: diff.stdout.length, sha256: sha256(diff.stdout), format: "git-diff-binary-full-index" } }, extraFiles };
  }
  if (mode !== "artifact") throw new Error(`unknown output custody mode ${JSON.stringify(mode)}`);
  const files = publication.artifacts;
  if (publication.publish !== "artifact" || !Array.isArray(files) || files.length === 0) {
    return { custody: { ...custody, status: "incomplete", reason: "artifact publication failed or produced no files" }, extraFiles };
  }
  if (files.length > OUTPUT_CAPTURE_LIMITS.files) {
    return { custody: { ...custody, status: "incomplete", reason: `artifact inventory exceeds ${OUTPUT_CAPTURE_LIMITS.files} files` }, extraFiles };
  }
  const manifest = {
    schema: "vinci.worker-artifact-capture/1", base_commit: baseCommit, head,
    inventory_source: "git tracked changes and untracked path inventory",
    capture_source: "immutable committed Git blobs; never worktree path reads",
    limits: OUTPUT_CAPTURE_LIMITS, entries: [],
  };
  let totalBytes = 0;
  const incomplete = [];
  try {
    const [tree, baseTree, dirty] = await Promise.all([
      git(repoDir, ["ls-tree", "-r", "-z", "--full-tree", head, "--", ...files]),
      git(repoDir, ["ls-tree", "-r", "-z", "--full-tree", baseCommit, "--", ...files]),
      git(repoDir, ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", head, "--", ...files]),
    ]);
    if ([tree, baseTree, dirty].some((result) => result.status !== 0)) throw new Error("artifact Git snapshot lookup failed");
    const current = treeEntries(tree.stdout);
    const base = treeEntries(baseTree.stdout);
    const dirtyPaths = new Set(parseGitNulPaths(dirty.stdout, "artifact uncommitted paths"));
    for (const [index, path] of files.entries()) {
      const entry = { path };
      const blob = current.get(path);
      let reason = null;
      if (dirtyPaths.has(path)) reason = "uncommitted working-tree/index changes are not captured";
      else if (!blob && base.has(path)) entry.status = "committed_deletion";
      else if (!blob) reason = "untracked path has no committed blob";
      else if (!["100644", "100755"].includes(blob.mode) || blob.type !== "blob") reason = `unsupported committed object mode ${blob.mode}`;
      else {
        const sizeResult = await git(repoDir, ["cat-file", "-s", blob.oid], 1024);
        const size = Number(sizeResult.stdout.toString("ascii").trim());
        if (sizeResult.status !== 0 || !Number.isSafeInteger(size) || size < 0) reason = "committed blob size is unavailable";
        else if (size > OUTPUT_CAPTURE_LIMITS.file_bytes) reason = `committed blob exceeds ${OUTPUT_CAPTURE_LIMITS.file_bytes} bytes per file`;
        else if (totalBytes + size > OUTPUT_CAPTURE_LIMITS.total_bytes) reason = `artifact capture exceeds ${OUTPUT_CAPTURE_LIMITS.total_bytes} total bytes`;
        else {
          const content = await git(repoDir, ["cat-file", "blob", blob.oid], size + 1024);
          if (content.status !== 0 || content.stdout.length !== size) reason = "committed blob capture failed";
          else {
            const member = `artifact-${String(index + 1).padStart(4, "0")}.bin`;
            extraFiles[member] = content.stdout;
            Object.assign(entry, { status: "captured", commit: head, blob_oid: blob.oid, mode: blob.mode, member, bytes: size, sha256: sha256(content.stdout) });
            totalBytes += size;
          }
        }
      }
      if (reason) { entry.status = "not_captured"; entry.reason = reason; incomplete.push(`${JSON.stringify(path)}: ${reason}`); }
      manifest.entries.push(entry);
    }
    const unchanged = await git(repoDir, ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", head, "--", ...files]);
    if (unchanged.status !== 0 || !unchanged.stdout.equals(dirty.stdout)) incomplete.push("working-tree/index inventory changed during capture");
  } catch (error) {
    incomplete.push(error.message);
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  extraFiles["artifact-capture.json"] = manifestBytes;
  return {
    custody: {
      ...custody, status: incomplete.length ? "incomplete" : "pending_upload",
      reason: incomplete.length ? incomplete.join("; ") : "output bundle has not landed",
      capture: { member: "artifact-capture.json", sha256: sha256(manifestBytes), captured_bytes: totalBytes, entries: manifest.entries },
    }, extraFiles,
  };
}

export function settleOutputCustody(custody, evidence) {
  if (custody.status !== "pending_upload") return custody;
  if (evidence?.uploaded === true && typeof evidence.uri === "string" && evidence.uri.length > 0 && /^[0-9a-f]{64}$/.test(evidence.sha256 ?? "")) {
    return { ...custody, status: "bundle_uploaded", durable: true, reason: null, bundle_uri: evidence.uri, bundle_sha256: evidence.sha256 };
  }
  return { ...custody, status: "local_only", reason: evidence?.error ?? "output bundle upload is not configured" };
}

export function custodyTerminalState(state, custody) {
  return state === "COMPLETED" && !custody.durable && custody.status !== "not_required" ? "UNVERIFIED" : state;
}

export function outputRemotePostFields(custody) {
  if (custody?.status !== "remote_verified") return [];
  try {
    const encoded = encodeURIComponent(custody.remote_url);
    if (encoded.length <= 512) return [`output_remote=${encoded}`];
  } catch { /* The exact identity remains in the receipt; an unencodable display uses its digest. */ }
  return [`output_remote=sha256:${custody.remote_transport_sha256}`, "output_remote_digest_only=true"];
}
