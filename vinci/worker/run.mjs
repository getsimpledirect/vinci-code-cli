import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { resolveBin } from "./build.mjs";
import { canonicalize } from "./contracts/canonical.mjs";
import { readSessionState } from "./session-read.mjs";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

function command(commandName, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    let executable;
    try {
      executable = resolveBin(commandName);
    } catch (error) {
      if (options.allowFailure) {
        resolveCommand({ status: null, signal: null, stdout: options.rawStdout ? Buffer.alloc(0) : "", stderr: error.message });
      } else {
        rejectCommand(error);
      }
      return;
    }
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = options.rawStdout ? [] : "";
    let stderr = "";
    if (!options.rawStdout) child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (options.rawStdout) stdout.push(Buffer.from(chunk));
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let settled = false;
    child.once("error", (error) => {
      settled = true;
      if (options.allowFailure) resolveCommand({ status: null, signal: null, stdout: options.rawStdout ? Buffer.alloc(0) : "", stderr: error.message });
      else rejectCommand(error);
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      const result = {
        status,
        signal,
        stdout: options.rawStdout ? Buffer.concat(stdout) : stdout.trim(),
        stderr: stderr.trim(),
      };
      if (status === 0 || options.allowFailure) resolveCommand(result);
      else rejectCommand(new Error(`${commandName} ${args.join(" ")} failed: ${stderr.trim() || signal || status}`));
    });
  });
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalize(value)}\n`, "utf8");
}

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusiveDurable(path, bytes, mode = 0o600) {
  const descriptor = openSync(path, "wx", mode);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function decodeCanonicalRepoPath(bytes, label) {
  let path;
  try {
    path = utf8Decoder.decode(bytes);
  } catch {
    throw new Error(`${label}: path is not canonical UTF-8`);
  }
  if (!Buffer.from(path, "utf8").equals(bytes)) throw new Error(`${label}: path UTF-8 does not round-trip`);
  if (path.normalize("NFC") !== path) throw new Error(`${label}: path is not NFC-normalized`);
  if (path === "" || isAbsolute(path) || path.includes("\0")) throw new Error(`${label}: path is not repository-relative`);
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`${label}: path contains an aliasing component`);
  return path;
}

export function parseGitNulPaths(raw, label = "git path list") {
  if (!Buffer.isBuffer(raw)) throw new TypeError(`${label}: expected raw bytes`);
  if (raw.length === 0) return [];
  if (raw.at(-1) !== 0) throw new Error(`${label}: missing terminal NUL`);
  const paths = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    if (index === start) throw new Error(`${label}: empty path entry`);
    paths.push(decodeCanonicalRepoPath(raw.subarray(start, index), label));
    start = index + 1;
  }
  const seen = new Set();
  for (const path of paths) {
    if (seen.has(path)) throw new Error(`${label}: duplicate path ${JSON.stringify(path)}`);
    seen.add(path);
  }
  return paths;
}

function signalExitCode(code, signal) {
  if (typeof code === "number") return code;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGKILL") return 137;
  return 1;
}

function terminateProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function validateBranchName(branch) {
  // Defense in depth: task.mjs validates too, but this function must be safe standalone.
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch) || branch.includes("..") || /^refs[\/.]/.test(branch) || branch.includes("refs/") || branch.endsWith(".lock") || branch.endsWith("/") || branch === "HEAD") {
    throw new Error(`envelope branch ${branch} is not a plain git branch name`);
  }
}

// Move a local branch out of the way under stale/<branch>-<UTC stamp>-<6 hex>. Never deletes: a
// stale branch can be the only copy of an earlier attempt's work. The nonce keeps two renames in
// the same second apart; the destination is verified absent before `branch -m` (which would
// otherwise refuse, or with -M clobber). `stamp`/`nonce` are injectable for tests only.
export async function renameBranchAside(repoDir, branch, { stamp, nonce } = {}) {
  const stampText = stamp ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  let candidateNonce = nonce;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const asideName = `stale/${branch}-${stampText}-${candidateNonce ?? randomBytes(3).toString("hex")}`;
    const taken = await command("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${asideName}`], { allowFailure: true });
    if (taken.status === 0) {
      candidateNonce = null; // collision: draw a fresh nonce, never overwrite
      continue;
    }
    await command("git", ["-C", repoDir, "branch", "-m", branch, asideName]);
    return asideName;
  }
  throw new Error(`could not find a free stale/ name for ${branch}`);
}

// Never-pushed residue classification (divergence path). Returns { residue: true } only when ALL
// hold: (ii) the local branch does not track origin/<branch> (a branch that was pushed carries that
// upstream from `push --set-upstream`; the daemon's own default path `checkout -b worker/<id>
// origin/main` leaves the upstream at origin/MAIN, which is not evidence of a push), (iii) no live
// origin head contains its tip and no commit in <remoteTip>..<localSha> is reachable from any
// origin head. ALL origin heads are fetched by explicit full refspec first: a narrow-refspec cache
// (--single-branch) would otherwise leave a head outside its refspec invisible and misclassify
// work pushed there as never-pushed. If the branch has ANY configured upstream whose
// remote-tracking ref is still unresolvable after that fetch, fail closed: { residue: false,
// note } naming it. Any check error ⇒ { residue: false } (refuse as before, rename nothing).
async function classifyDivergedLocal(repoDir, branch, localSha, remoteTip) {
  const upstreamRemote = await command("git", ["-C", repoDir, "config", "--get", `branch.${branch}.remote`], { allowFailure: true });
  const upstreamMerge = await command("git", ["-C", repoDir, "config", "--get", `branch.${branch}.merge`], { allowFailure: true });
  for (const probe of [upstreamRemote, upstreamMerge]) if (probe.status !== 0 && probe.status !== 1) return { residue: false };
  const hasUpstream = upstreamRemote.status === 0 || upstreamMerge.status === 0;
  const tracksItself = upstreamRemote.status === 0 && upstreamMerge.status === 0 && upstreamRemote.stdout === "origin" && upstreamMerge.stdout === `refs/heads/${branch}`;
  if (tracksItself) return { residue: false };
  const refresh = await command("git", ["-C", repoDir, "fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"], { allowFailure: true });
  if (refresh.status !== 0) return { residue: false };
  if (hasUpstream) {
    const upstreamLabel = `${upstreamRemote.stdout || "?"}/${upstreamMerge.stdout || "?"}`;
    const trackingRef = upstreamRemote.stdout === "origin" && upstreamMerge.stdout.startsWith("refs/heads/")
      ? `refs/remotes/origin/${upstreamMerge.stdout.slice("refs/heads/".length)}`
      : null;
    const resolvable = trackingRef
      ? await command("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", trackingRef], { allowFailure: true })
      : { status: 1 };
    if (resolvable.status !== 0) return { residue: false, note: `upstream ${upstreamLabel} of ${branch} is not resolvable on origin; not treating it as never-pushed` };
  }
  const containing = await command("git", ["-C", repoDir, "for-each-ref", `--contains=${localSha}`, "refs/remotes/origin"], { allowFailure: true });
  if (containing.status !== 0 || containing.stdout) return { residue: false };
  const range = await command("git", ["-C", repoDir, "rev-list", "--count", `${remoteTip}..${localSha}`], { allowFailure: true });
  const unreachable = await command("git", ["-C", repoDir, "rev-list", "--count", `${remoteTip}..${localSha}`, "--not", "--remotes=origin"], { allowFailure: true });
  if (range.status !== 0 || unreachable.status !== 0) return { residue: false };
  const rangeCount = Number(range.stdout);
  if (!Number.isInteger(rangeCount) || rangeCount < 1) return { residue: false };
  return { residue: unreachable.stdout === range.stdout };
}

function blocked(reason, message) {
  return Object.assign(new Error(message), { blockedReason: reason });
}

function readCanonicalFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label}: unsafe file identity`);
  const bytes = readFileSync(path);
  let value;
  try {
    value = JSON.parse(utf8Decoder.decode(bytes));
  } catch (error) {
    throw new Error(`${label}: invalid canonical JSON: ${error.message}`);
  }
  if (!canonicalBytes(value).equals(bytes)) throw new Error(`${label}: bytes are not canonical JSON`);
  return { bytes, value };
}

function readSafeRegularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label}: unsafe file identity`);
  return readFileSync(path);
}

function directoryIdentity(path, label) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}: unsafe directory identity`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label}: directory is accessible outside its owner`);
  if (stat.nlink < 2) throw new Error(`${label}: invalid directory link count`);
  return { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
}

function ensurePrivateDirectory(path, label) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return directoryIdentity(path, label);
}

function requireSameDirectory(path, expected, label) {
  const current = directoryIdentity(path, label);
  if (canonicalize(current) !== canonicalize(expected)) throw new Error(`${label}: directory identity changed`);
}

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalize(actual) !== canonicalize(expected)) throw new Error(`${label}: unexpected fields`);
}

export function describeDebrisRootAnchor(stateDir, lineageId) {
  if (!/^[0-9a-f]{64}$/.test(lineageId)) throw new Error("debris lineage id must be 64 lowercase hex characters");
  const debrisRoot = join(stateDir, "debris");
  const identitiesRoot = join(debrisRoot, ".task-identities-v1");
  const debrisIdentity = directoryIdentity(debrisRoot, "debris root");
  const identitiesIdentity = directoryIdentity(identitiesRoot, "debris task identities root");
  return {
    schema: "vinci.worker-debris-root-identity/1",
    authority_admitted: true,
    lineage_id: lineageId,
    state_dir: resolve(stateDir),
    debris_root_path: resolve(debrisRoot),
    debris_root: debrisIdentity,
    task_identities_root: identitiesIdentity,
  };
}

function loadDebrisRootAnchor(stateDir) {
  const configured = process.env.VINCI_WORKER_DEBRIS_ROOT_ANCHOR;
  const configuredSha256 = process.env.VINCI_WORKER_DEBRIS_ROOT_ANCHOR_SHA256;
  if (!configured || !isAbsolute(configured)) throw new Error("debris root identity: VINCI_WORKER_DEBRIS_ROOT_ANCHOR must name an absolute externally provisioned file");
  if (!/^[0-9a-f]{64}$/.test(configuredSha256 ?? "")) throw new Error("debris root identity: VINCI_WORKER_DEBRIS_ROOT_ANCHOR_SHA256 must pin the exact provisioned bytes");
  const anchorPath = resolve(configured);
  const statePath = resolve(stateDir);
  const fromState = relative(statePath, anchorPath);
  if (fromState === "" || (!fromState.startsWith("..") && !isAbsolute(fromState))) {
    throw new Error("debris root identity: trust anchor must be outside the replaceable worker state directory");
  }
  const anchorStat = lstatSync(anchorPath);
  if (!anchorStat.isFile() || anchorStat.isSymbolicLink() || anchorStat.nlink !== 1 || (anchorStat.mode & 0o022) !== 0) {
    throw new Error("debris root identity: unsafe external trust anchor");
  }
  const record = readCanonicalFile(anchorPath, "debris root identity");
  if (sha256(record.bytes) !== configuredSha256) throw new Error("debris root identity: provisioned anchor digest mismatch");
  requireExactKeys(
    record.value,
    ["schema", "authority_admitted", "lineage_id", "state_dir", "debris_root_path", "debris_root", "task_identities_root"],
    "debris root identity",
  );
  if (record.value.schema !== "vinci.worker-debris-root-identity/1" || record.value.authority_admitted !== true) {
    throw new Error("debris root identity: authority is not admitted");
  }
  const expected = describeDebrisRootAnchor(stateDir, record.value.lineage_id);
  if (canonicalize(record.value) !== canonicalize(expected)) throw new Error("debris root identity: path replacement or rollback detected");
  return {
    identitiesRoot: join(stateDir, "debris", ".task-identities-v1"),
    anchorPath,
    anchorBytes: record.bytes,
  };
}

function establishTaskStorageAnchor(anchorRoot, taskId, taskOwnerRoot, taskRoot, generationsRoot, attemptsRoot) {
  const anchorPath = join(anchorRoot, `${taskId}.json`);
  const pathExisted = existsSync(taskOwnerRoot);
  if (!existsSync(anchorPath) && pathExisted) throw new Error("debris task identity: missing anchor for existing state");
  const storage = {
    task_root: ensurePrivateDirectory(taskOwnerRoot, "debris task root"),
    ledger_root: ensurePrivateDirectory(taskRoot, "debris ledger root"),
    generations_root: ensurePrivateDirectory(generationsRoot, "debris generations root"),
    attempts_root: ensurePrivateDirectory(attemptsRoot, "debris attempts root"),
  };
  const expected = { schema: "vinci.worker-debris-task-identity/1", task_id: taskId, storage };
  let record;
  if (existsSync(anchorPath)) {
    record = readCanonicalFile(anchorPath, "debris task identity");
    requireExactKeys(record.value, ["schema", "task_id", "storage"], "debris task identity");
    if (canonicalize(record.value) !== canonicalize(expected)) throw new Error("debris task identity: path replacement or rollback detected");
  } else {
    writeExclusiveDurable(anchorPath, canonicalBytes(expected));
    syncDirectory(anchorRoot);
    record = readCanonicalFile(anchorPath, "debris task identity");
  }
  return { storage, anchorPath, anchorBytes: record.bytes };
}

function requireUnchangedAnchor(path, expectedBytes, label) {
  const current = readCanonicalFile(path, label);
  if (!current.bytes.equals(expectedBytes)) throw new Error(`${label}: changed during capture`);
}

function syncTreeDirectories(root, relativePaths) {
  const directories = new Set([root]);
  for (const relativePath of relativePaths) {
    let current = dirname(join(root, relativePath));
    while (current.startsWith(root) && current !== root) {
      directories.add(current);
      current = dirname(current);
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) syncDirectory(directory);
}

function verifyDebrisGeneration(generationDir, expected) {
  directoryIdentity(generationDir, "debris generation");
  const manifestRecord = readCanonicalFile(join(generationDir, "manifest.json"), "debris manifest");
  const receiptRecord = readCanonicalFile(join(generationDir, "receipt.json"), "debris receipt");
  const manifest = manifestRecord.value;
  const receipt = receiptRecord.value;
  requireExactKeys(manifest, ["schema", "generation", "source_fingerprint", "captured_by_attempt", "source", "tracked_patch", "staged_patch", "untracked"], "debris manifest");
  requireExactKeys(receipt, ["schema", "generation", "source_fingerprint", "manifest_sha256", "task_id", "captured_by_attempt", "repo", "branch", "base_commit", "head", "tree", "storage"], "debris receipt");
  if (manifest.schema !== "vinci.worker-debris-generation/1") throw new Error("debris manifest: unsupported schema");
  requireExactKeys(manifest.source, ["task_id", "repo", "branch", "base_commit", "head", "tree", "tracked", "staged", "untracked", "tracked_patch_sha256", "staged_patch_sha256"], "debris manifest source");
  if (!Number.isSafeInteger(manifest.captured_by_attempt) || manifest.captured_by_attempt < 1) throw new Error("debris manifest: invalid capture attempt");
  const derivedFingerprint = sha256(Buffer.from(`vinci.worker-debris-source/1\0${canonicalize(manifest.source)}`, "utf8"));
  const derivedGeneration = sha256(Buffer.from(`vinci.worker-debris-generation/2\0${expected.taskId}\0${manifest.captured_by_attempt}\0${derivedFingerprint}`, "utf8"));
  if (manifest.source_fingerprint !== derivedFingerprint || manifest.generation !== derivedGeneration || basename(generationDir) !== derivedGeneration) {
    throw new Error("debris manifest: source identity mismatch");
  }
  if (manifest.source?.task_id !== expected.taskId || manifest.source?.repo !== expected.repo) throw new Error("debris manifest: task identity mismatch");
  if (receipt.schema !== "vinci.worker-debris-receipt/1") throw new Error("debris receipt: unsupported schema");
  if (receipt.generation !== manifest.generation || receipt.source_fingerprint !== derivedFingerprint) throw new Error("debris receipt: identity mismatch");
  if (receipt.manifest_sha256 !== sha256(manifestRecord.bytes)) throw new Error("debris receipt: manifest digest mismatch");
  for (const key of ["task_id", "repo", "branch", "base_commit", "head", "tree"]) {
    const sourceKey = key === "task_id" ? "task_id" : key;
    if (receipt[key] !== manifest.source[sourceKey]) throw new Error(`debris receipt: ${key} mismatch`);
  }
  if (receipt.captured_by_attempt !== manifest.captured_by_attempt) throw new Error("debris receipt: attempt mismatch");
  for (const [label, identity] of Object.entries(expected.storage)) {
    requireSameDirectory(expected.storagePaths[label], identity, `debris storage ${label}`);
  }
  if (canonicalize(receipt.storage) !== canonicalize(expected.storage)) throw new Error("debris receipt: storage identity mismatch");
  const trackedBytes = readSafeRegularFile(join(generationDir, "tracked.patch"), "debris tracked patch");
  const stagedBytes = readSafeRegularFile(join(generationDir, "staged.patch"), "debris staged patch");
  if (trackedBytes.length !== manifest.tracked_patch.size || sha256(trackedBytes) !== manifest.tracked_patch.sha256) throw new Error("debris generation: tracked patch mismatch");
  if (stagedBytes.length !== manifest.staged_patch.size || sha256(stagedBytes) !== manifest.staged_patch.sha256) throw new Error("debris generation: staged patch mismatch");
  const expectedStored = new Set();
  for (const file of manifest.untracked) {
    if (expectedStored.has(file.path)) throw new Error(`debris generation: duplicate stored file ${JSON.stringify(file.path)}`);
    expectedStored.add(file.path);
    const path = join(generationDir, "untracked", file.path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`debris generation: unsafe stored file ${JSON.stringify(file.path)}`);
    if ((stat.mode & 0o777) !== file.mode || stat.size !== file.size || sha256(readFileSync(path)) !== file.sha256) {
      throw new Error(`debris generation: stored file mismatch ${JSON.stringify(file.path)}`);
    }
  }
  const actualStored = [];
  const untrackedRoot = join(generationDir, "untracked");
  const walk = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`debris generation: unsafe stored object ${JSON.stringify(relative)}`);
      if (entry.isDirectory()) walk(path, relative);
      else if (entry.isFile()) actualStored.push(relative);
      else throw new Error(`debris generation: unsupported stored object ${JSON.stringify(relative)}`);
    }
  };
  if (expectedStored.size > 0) walk(untrackedRoot);
  if (canonicalize(actualStored.sort()) !== canonicalize([...expectedStored].sort())) throw new Error("debris generation: stored file inventory mismatch");
  const allowedTop = new Set(["COMMITTED", "manifest.json", "receipt.json", "staged.patch", "tracked.patch", ...(expectedStored.size > 0 ? ["untracked"] : [])]);
  let indexed = false;
  const indexedPath = join(generationDir, "INDEXED");
  if (existsSync(indexedPath)) {
    const indexedRecord = readCanonicalFile(indexedPath, "debris indexed marker");
    requireExactKeys(indexedRecord.value, ["schema", "generation", "receipt_sha256"], "debris indexed marker");
    const expectedIndexed = {
      schema: "vinci.worker-debris-indexed/1",
      generation: receipt.generation,
      receipt_sha256: sha256(receiptRecord.bytes),
    };
    if (canonicalize(indexedRecord.value) !== canonicalize(expectedIndexed)) throw new Error("debris indexed marker: identity mismatch");
    allowedTop.add("INDEXED");
    indexed = true;
  }
  const topEntries = readdirSync(generationDir).sort();
  if (canonicalize(topEntries) !== canonicalize([...allowedTop].sort())) throw new Error("debris generation: unexpected top-level object");
  const commit = readSafeRegularFile(join(generationDir, "COMMITTED"), "debris commit marker");
  if (!commit.equals(Buffer.from(`${sha256(receiptRecord.bytes)}\n`, "utf8"))) throw new Error("debris generation: commit marker mismatch");
  return { receipt, receiptBytes: receiptRecord.bytes, sourceFingerprint: derivedFingerprint, generation: derivedGeneration, generationDir, indexed };
}

function markGenerationIndexed(record) {
  if (record.indexed) return;
  const marker = canonicalBytes({
    schema: "vinci.worker-debris-indexed/1",
    generation: record.receipt.generation,
    receipt_sha256: sha256(record.receiptBytes),
  });
  writeExclusiveDurable(join(record.generationDir, "INDEXED"), marker);
  syncDirectory(record.generationDir);
  record.indexed = true;
}

async function collectDirtySnapshot(repoDir, repo, taskId, attempt) {
  const [trackedNames, stagedNames, untrackedNames, trackedPatch, stagedPatch, head, tree, branch] = await Promise.all([
    command("git", ["-C", repoDir, "diff", "--name-only", "-z", "HEAD"], { allowFailure: true, rawStdout: true }),
    command("git", ["-C", repoDir, "diff", "--name-only", "-z", "--cached"], { allowFailure: true, rawStdout: true }),
    command("git", ["-C", repoDir, "ls-files", "--others", "--exclude-standard", "-z"], { allowFailure: true, rawStdout: true }),
    command("git", ["-C", repoDir, "diff", "--binary", "HEAD"], { allowFailure: true, rawStdout: true }),
    command("git", ["-C", repoDir, "diff", "--binary", "--cached"], { allowFailure: true, rawStdout: true }),
    command("git", ["-C", repoDir, "rev-parse", "HEAD"], { allowFailure: true }),
    command("git", ["-C", repoDir, "rev-parse", "HEAD^{tree}"], { allowFailure: true }),
    command("git", ["-C", repoDir, "symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }),
  ]);
  const probes = [trackedNames, stagedNames, untrackedNames, trackedPatch, stagedPatch, head, tree];
  if (probes.some((probe) => probe.status !== 0)) throw new Error("quarantine: source capture failed; refusing to clean");
  const tracked = parseGitNulPaths(trackedNames.stdout, "quarantine tracked paths");
  const staged = parseGitNulPaths(stagedNames.stdout, "quarantine staged paths");
  const untrackedPaths = parseGitNulPaths(untrackedNames.stdout, "quarantine untracked paths");
  if (tracked.length === 0 && staged.length === 0 && untrackedPaths.length === 0) return null;
  const untracked = untrackedPaths.map((path) => {
    const source = join(repoDir, path);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`quarantine: unsupported untracked object ${JSON.stringify(path)}`);
    const bytes = readFileSync(source);
    return { path, bytes, mode: stat.mode & 0o777, size: stat.size, sha256: sha256(bytes), dev: String(stat.dev), ino: String(stat.ino) };
  });
  const source = {
    task_id: taskId,
    repo,
    branch: branch.status === 0 ? branch.stdout : null,
    base_commit: head.stdout,
    head: head.stdout,
    tree: tree.stdout,
    tracked,
    staged,
    untracked: untracked.map(({ path, mode, size, sha256: digest, dev, ino }) => ({ path, mode, size, sha256: digest, dev, ino })),
    tracked_patch_sha256: sha256(trackedPatch.stdout),
    staged_patch_sha256: sha256(stagedPatch.stdout),
  };
  const sourceFingerprint = sha256(Buffer.from(`vinci.worker-debris-source/1\0${canonicalize(source)}`, "utf8"));
  return {
    attempt,
    source,
    sourceFingerprint,
    generation: sha256(Buffer.from(`vinci.worker-debris-generation/2\0${taskId}\0${attempt}\0${sourceFingerprint}`, "utf8")),
    trackedPatch: trackedPatch.stdout,
    stagedPatch: stagedPatch.stdout,
    untracked,
  };
}

function indexEntry(record) {
  return {
    generation: record.receipt.generation,
    receipt_sha256: sha256(record.receiptBytes),
    source_fingerprint: record.receipt.source_fingerprint,
  };
}

function validateDebrisIndex(value, taskId) {
  requireExactKeys(value, ["schema", "task_id", "generations"], "debris index");
  if (value.schema !== "vinci.worker-debris-index/1" || value.task_id !== taskId || !Array.isArray(value.generations)) {
    throw new Error("debris index: invalid identity");
  }
  const seen = new Set();
  let previous = null;
  for (const entry of value.generations) {
    requireExactKeys(entry, ["generation", "receipt_sha256", "source_fingerprint"], "debris index entry");
    if (![entry.generation, entry.receipt_sha256, entry.source_fingerprint].every((item) => /^[0-9a-f]{64}$/.test(item))) {
      throw new Error("debris index: invalid digest field");
    }
    if (seen.has(entry.generation)) throw new Error("debris index: duplicate generation");
    if (previous !== null && previous >= entry.generation) throw new Error("debris index: generations are not in canonical order");
    seen.add(entry.generation);
    previous = entry.generation;
  }
}

function reconcileDebrisIndex(taskRoot, generationsRoot, taskId, repo, storage, storagePaths) {
  const generationNames = readdirSync(generationsRoot);
  const partial = generationNames.filter((name) => name.startsWith(".capture-"));
  if (partial.length > 0) throw new Error("quarantine: partial prior publication requires reconciliation");
  if (generationNames.some((name) => !/^[0-9a-f]{64}$/.test(name))) throw new Error("debris generations: unexpected object");
  const records = generationNames
    .sort()
    .map((generation) => verifyDebrisGeneration(join(generationsRoot, generation), { taskId, repo, storage, storagePaths }));
  const expected = { schema: "vinci.worker-debris-index/1", task_id: taskId, generations: records.map(indexEntry) };
  const indexPath = join(taskRoot, "index.json");
  if (!existsSync(indexPath)) {
    if (records.some((record) => record.indexed)) throw new Error("debris index: rollback omitted an indexed generation");
    if (records.length === 0) return { bytes: null, value: expected, records };
    const temp = join(taskRoot, `.index-recovery-${randomBytes(12).toString("hex")}.tmp`);
    writeExclusiveDurable(temp, canonicalBytes(expected));
    if (existsSync(indexPath)) throw new Error("debris index: appeared during recovery");
    renameSync(temp, indexPath);
    syncDirectory(taskRoot);
    for (const record of records) markGenerationIndexed(record);
    return { ...readCanonicalFile(indexPath, "debris index"), records };
  }
  const current = readCanonicalFile(indexPath, "debris index");
  validateDebrisIndex(current.value, taskId);
  const currentByGeneration = new Map(current.value.generations.map((entry) => [entry.generation, entry]));
  const expectedByGeneration = new Map(expected.generations.map((entry) => [entry.generation, entry]));
  for (const entry of current.value.generations) {
    const expectedEntry = expectedByGeneration.get(entry.generation);
    if (!expectedEntry || canonicalize(entry) !== canonicalize(expectedEntry)) throw new Error("debris index: committed-generation bijection mismatch");
  }
  for (const record of records) {
    if (record.indexed && !currentByGeneration.has(record.generation)) throw new Error("debris index: rollback omitted an indexed generation");
  }
  if (canonicalize(current.value) !== canonicalize(expected)) {
    const missing = records.filter((record) => !currentByGeneration.has(record.generation));
    if (missing.some((record) => record.indexed)) throw new Error("debris index: committed-generation bijection mismatch");
    const temp = join(taskRoot, `.index-recovery-${randomBytes(12).toString("hex")}.tmp`);
    writeExclusiveDurable(temp, canonicalBytes(expected));
    if (!readFileSync(indexPath).equals(current.bytes)) throw new Error("debris index: compare-and-swap conflict during recovery");
    renameSync(temp, indexPath);
    syncDirectory(taskRoot);
  }
  for (const record of records) markGenerationIndexed(record);
  return { ...readCanonicalFile(indexPath, "debris index"), records };
}

function publishDebrisIndex(taskRoot, taskId, receiptRecord, previousIndex) {
  const indexPath = join(taskRoot, "index.json");
  let index = structuredClone(previousIndex.value);
  if (previousIndex.bytes) {
    const current = readCanonicalFile(indexPath, "debris index");
    if (!current.bytes.equals(previousIndex.bytes)) throw new Error("debris index: compare-and-swap conflict");
  } else if (existsSync(indexPath)) {
    throw new Error("debris index: appeared during publication");
  }
  validateDebrisIndex(index, taskId);
  const entry = indexEntry(receiptRecord);
  const existing = index.generations.find((candidate) => candidate.generation === entry.generation);
  if (existing && canonicalize(existing) !== canonicalize(entry)) throw new Error("debris index: divergent generation");
  if (!existing) index.generations.push(entry);
  index.generations.sort((a, b) => (a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0));
  validateDebrisIndex(index, taskId);
  const temp = join(taskRoot, `.index-${randomBytes(12).toString("hex")}.tmp`);
  writeExclusiveDurable(temp, canonicalBytes(index));
  if (previousIndex.bytes) {
    const currentBytes = readFileSync(indexPath);
    if (!currentBytes.equals(previousIndex.bytes)) throw new Error("debris index: compare-and-swap conflict");
  } else if (existsSync(indexPath)) {
    throw new Error("debris index: compare-and-swap conflict");
  }
  renameSync(temp, indexPath);
  syncDirectory(taskRoot);
}

function attemptReceiptValue(taskId, attempt, generationRecord) {
  return {
    schema: "vinci.worker-debris-attempt-receipt/1",
    task_id: taskId,
    requested_attempt: attempt,
    disposition: generationRecord.receipt.captured_by_attempt === attempt ? "CAPTURED" : "REPLAYED",
    generation: generationRecord.receipt.generation,
    generation_receipt_sha256: sha256(generationRecord.receiptBytes),
    captured_by_attempt: generationRecord.receipt.captured_by_attempt,
  };
}

function validateAttemptReceipt(value, taskId, attempt, generationRecord) {
  requireExactKeys(
    value,
    ["schema", "task_id", "requested_attempt", "disposition", "generation", "generation_receipt_sha256", "captured_by_attempt"],
    "debris attempt receipt",
  );
  const expected = attemptReceiptValue(taskId, attempt, generationRecord);
  if (canonicalize(value) !== canonicalize(expected)) throw new Error("debris attempt receipt: identity mismatch");
}

function writeCurrentAttemptReceipt(taskRoot, bytes) {
  const currentPath = join(taskRoot, "current.json");
  const currentTemp = join(taskRoot, `.current-${randomBytes(12).toString("hex")}.tmp`);
  writeExclusiveDurable(currentTemp, bytes);
  renameSync(currentTemp, currentPath);
  syncDirectory(taskRoot);
}

function reconcileAttemptReceipts(taskRoot, attemptsRoot, taskId, generationRecords) {
  const byAttempt = new Map();
  for (const record of generationRecords) {
    const attempt = record.receipt.captured_by_attempt;
    if (byAttempt.has(attempt)) throw new Error("debris attempts: one attempt names multiple generations");
    byAttempt.set(attempt, record);
  }
  const entries = readdirSync(attemptsRoot).sort();
  for (const entry of entries) {
    if (!/^[1-9][0-9]*\.json$/.test(entry)) throw new Error("debris attempts: unexpected object");
    const attempt = Number(entry.slice(0, -5));
    if (!Number.isSafeInteger(attempt)) throw new Error("debris attempts: invalid attempt number");
    const record = byAttempt.get(attempt);
    if (!record) throw new Error("debris attempts: orphan receipt");
    const stored = readCanonicalFile(join(attemptsRoot, entry), "debris attempt receipt");
    validateAttemptReceipt(stored.value, taskId, attempt, record);
  }
  for (const [attempt, record] of byAttempt) {
    const path = join(attemptsRoot, `${attempt}.json`);
    if (!existsSync(path)) writeExclusiveDurable(path, canonicalBytes(attemptReceiptValue(taskId, attempt, record)));
  }
  syncDirectory(attemptsRoot);
  if (byAttempt.size === 0) {
    if (existsSync(join(taskRoot, "current.json"))) throw new Error("debris current receipt: orphan pointer");
    return;
  }
  let latestAttempt = 0;
  for (const attempt of byAttempt.keys()) latestAttempt = Math.max(latestAttempt, attempt);
  const latestBytes = readFileSync(join(attemptsRoot, `${latestAttempt}.json`));
  const currentPath = join(taskRoot, "current.json");
  if (!existsSync(currentPath) || !readFileSync(currentPath).equals(latestBytes)) writeCurrentAttemptReceipt(taskRoot, latestBytes);
}

function publishAttemptReceipt(taskRoot, attemptsRoot, taskId, attempt, generationRecord) {
  const value = attemptReceiptValue(taskId, attempt, generationRecord);
  const bytes = canonicalBytes(value);
  const path = join(attemptsRoot, `${attempt}.json`);
  if (existsSync(path)) {
    const current = readCanonicalFile(path, "debris attempt receipt");
    if (!current.bytes.equals(bytes)) throw new Error("debris attempt receipt: attempt already bound to different source");
  } else {
    writeExclusiveDurable(path, bytes);
    syncDirectory(attemptsRoot);
  }
  writeCurrentAttemptReceipt(taskRoot, bytes);
  return {
    ...value,
    attempt_receipt_sha256: sha256(bytes),
    generation_receipt: generationRecord.receipt,
  };
}

// Shared-tree quarantine (used by BOTH the prose default/branch paths and the digest path).
async function quarantineDirtyTree(stateDir, repoDir, repo, taskId, attempt) {
  // Shared-tree quarantine: a prior run that ended without committing (honest BLOCKED/
  // UNVERIFIED, or a kill) leaves tracked modifications and untracked files that make every
  // later checkout fail ("would be overwritten"). Preserve, never discard — a failed task's
  // working tree can be the only copy of its work — then hand this task a clean tree.
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) throw new Error(`unsafe taskId for debris path: ${taskId}`);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error(`unsafe attempt for debris receipt: ${attempt}`);
  const preliminary = await collectDirtySnapshot(repoDir, repo, taskId, attempt);
  if (!preliminary) return null;
  const debrisRoot = join(stateDir, "debris");
  if (!existsSync(debrisRoot)) throw new Error("debris root identity: deployment must provision the debris root and external trust anchor before capture");
  const rootAnchor = loadDebrisRootAnchor(stateDir);
  const lockPath = join(debrisRoot, ".capture.lock");
  const lock = openSync(lockPath, "wx", 0o600);
  let staging = null;
  try {
    writeFileSync(lock, canonicalBytes({ schema: "vinci.worker-debris-lock/1", pid: process.pid, task_id: taskId }));
    fsyncSync(lock);
    syncDirectory(debrisRoot);
    const snapshot = await collectDirtySnapshot(repoDir, repo, taskId, attempt);
    if (!snapshot || snapshot.sourceFingerprint !== preliminary.sourceFingerprint) {
      throw new Error("quarantine: source changed before exclusive capture");
    }

    const taskOwnerRoot = join(debrisRoot, taskId);
    const taskRoot = join(taskOwnerRoot, "ledger-v1");
    const generationsRoot = join(taskRoot, "generations");
    const attemptsRoot = join(taskRoot, "attempts");
    const taskAnchor = establishTaskStorageAnchor(rootAnchor.identitiesRoot, taskId, taskOwnerRoot, taskRoot, generationsRoot, attemptsRoot);
    const storage = taskAnchor.storage;
    const storagePaths = {
      task_root: taskOwnerRoot,
      ledger_root: taskRoot,
      generations_root: generationsRoot,
      attempts_root: attemptsRoot,
    };
    const partialTaskEntries = readdirSync(taskRoot).filter((name) => name.startsWith(".index-") || name.startsWith(".current-"));
    if (partialTaskEntries.length > 0) {
      throw new Error("quarantine: partial prior publication requires reconciliation");
    }
    syncTreeDirectories(debrisRoot, [join(taskId, "ledger-v1", "generations"), join(taskId, "ledger-v1", "attempts")]);
    const finalDir = join(generationsRoot, snapshot.generation);
    const previousIndex = reconcileDebrisIndex(taskRoot, generationsRoot, taskId, repo, storage, storagePaths);
    reconcileAttemptReceipts(taskRoot, attemptsRoot, taskId, previousIndex.records);
    const priorAttempt = previousIndex.records.find((record) => record.receipt.captured_by_attempt === attempt);
    if (priorAttempt && priorAttempt.generation !== snapshot.generation) {
      throw new Error("debris attempt receipt: attempt already bound to different source");
    }
    let verified;

    if (existsSync(finalDir)) {
      verified = verifyDebrisGeneration(finalDir, { taskId, repo, storage, storagePaths });
    } else {
      staging = join(generationsRoot, `.capture-${randomBytes(12).toString("hex")}.tmp`);
      mkdirSync(staging, { mode: 0o700 });
      writeExclusiveDurable(join(staging, "tracked.patch"), snapshot.trackedPatch);
      writeExclusiveDurable(join(staging, "staged.patch"), snapshot.stagedPatch);
      const relativeStored = ["tracked.patch", "staged.patch"];
      for (const file of snapshot.untracked) {
        const destination = join(staging, "untracked", file.path);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeExclusiveDurable(destination, file.bytes, file.mode);
        relativeStored.push(join("untracked", file.path));
        const source = join(repoDir, file.path);
        const stat = lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || String(stat.dev) !== file.dev || String(stat.ino) !== file.ino || stat.size !== file.size || sha256(readFileSync(source)) !== file.sha256) {
          throw new Error(`quarantine: source changed during capture ${JSON.stringify(file.path)}`);
        }
      }
      const [trackedAgain, stagedAgain, headAgain, treeAgain] = await Promise.all([
        command("git", ["-C", repoDir, "diff", "--binary", "HEAD"], { allowFailure: true, rawStdout: true }),
        command("git", ["-C", repoDir, "diff", "--binary", "--cached"], { allowFailure: true, rawStdout: true }),
        command("git", ["-C", repoDir, "rev-parse", "HEAD"], { allowFailure: true }),
        command("git", ["-C", repoDir, "rev-parse", "HEAD^{tree}"], { allowFailure: true }),
      ]);
      if (trackedAgain.status !== 0 || stagedAgain.status !== 0 || headAgain.status !== 0 || treeAgain.status !== 0
          || !trackedAgain.stdout.equals(snapshot.trackedPatch) || !stagedAgain.stdout.equals(snapshot.stagedPatch)
          || headAgain.stdout !== snapshot.source.head || treeAgain.stdout !== snapshot.source.tree) {
        throw new Error("quarantine: tracked source changed during capture");
      }
      const manifest = {
        schema: "vinci.worker-debris-generation/1",
        generation: snapshot.generation,
        source_fingerprint: snapshot.sourceFingerprint,
        captured_by_attempt: snapshot.attempt,
        source: snapshot.source,
        tracked_patch: { path: "tracked.patch", sha256: sha256(snapshot.trackedPatch), size: snapshot.trackedPatch.length },
        staged_patch: { path: "staged.patch", sha256: sha256(snapshot.stagedPatch), size: snapshot.stagedPatch.length },
        untracked: snapshot.untracked.map(({ path, mode, size, sha256: digest }) => ({ path, mode, size, sha256: digest })),
      };
      const manifestBytes = canonicalBytes(manifest);
      writeExclusiveDurable(join(staging, "manifest.json"), manifestBytes);
      const receipt = {
        schema: "vinci.worker-debris-receipt/1",
        generation: snapshot.generation,
        source_fingerprint: snapshot.sourceFingerprint,
        manifest_sha256: sha256(manifestBytes),
        task_id: taskId,
        captured_by_attempt: snapshot.attempt,
        repo,
        branch: snapshot.source.branch,
        base_commit: snapshot.source.base_commit,
        head: snapshot.source.head,
        tree: snapshot.source.tree,
        storage,
      };
      const receiptBytes = canonicalBytes(receipt);
      writeExclusiveDurable(join(staging, "receipt.json"), receiptBytes);
      writeExclusiveDurable(join(staging, "COMMITTED"), `${sha256(receiptBytes)}\n`);
      syncTreeDirectories(staging, [...relativeStored, "manifest.json", "receipt.json", "COMMITTED"]);
      if (existsSync(finalDir)) throw new Error("quarantine: generation appeared during no-replace publication");
      renameSync(staging, finalDir);
      staging = null;
      syncDirectory(generationsRoot);
      verified = verifyDebrisGeneration(finalDir, { taskId, repo, storage, storagePaths });
    }
    if (verified.generation !== snapshot.generation || verified.sourceFingerprint !== snapshot.sourceFingerprint) {
      throw new Error("quarantine: generation does not match the captured source");
    }

    publishDebrisIndex(taskRoot, taskId, verified, previousIndex);
    markGenerationIndexed(verified);
    const receipt = publishAttemptReceipt(taskRoot, attemptsRoot, taskId, attempt, verified);
    requireUnchangedAnchor(rootAnchor.anchorPath, rootAnchor.anchorBytes, "debris root identity");
    requireUnchangedAnchor(taskAnchor.anchorPath, taskAnchor.anchorBytes, "debris task identity");
    for (const [label, identity] of Object.entries(storage)) requireSameDirectory(storagePaths[label], identity, `debris storage ${label}`);
    const reset = await command("git", ["-C", repoDir, "reset", "--hard", "HEAD"], { allowFailure: true });
    if (reset.status !== 0) throw new Error(`quarantine: reset failed after durable capture: ${reset.stderr || reset.status}`);
    const clean = await command("git", ["-C", repoDir, "clean", "-fd"], { allowFailure: true });
    if (clean.status !== 0) throw new Error(`quarantine: clean failed after durable capture: ${clean.stderr || clean.status}`);
    return receipt;
  } finally {
    closeSync(lock);
    if (staging && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    unlinkSync(lockPath);
    syncDirectory(debrisRoot);
  }
}

export async function prepareRepository(stateDir, repo, taskId, branchOverride, baseCommit, baseRef, attempt = 1) {
  if (!REPO.test(repo)) throw new Error("repo must be in org/name form");
  const repoDir = join(stateDir, "repos", repo.split("/")[1]);
  const branch = branchOverride ?? `worker/${taskId}`;
  const base = (process.env.VINCI_WORKER_GIT_BASE ?? "https://github.com/").replace(/\/+$/, "");
  const cloneUrl = `${base}/${repo}.git`;
  const cached = existsSync(repoDir);

  // Wave 1B digest form: the handoff pinned an exact baseCommit that the task branch must be
  // created FROM (base_commit), not a pre-existing branch to continue. The branch name is still
  // held to the plain-branch rule, but it need not yet exist on origin; the checked-out tip is
  // the baseCommit rather than an origin head. Order of operations, fixed:
  //   validate names → clone (uncached) or QUARANTINE the dirty tree (cached; F5, reusing the
  //   shared-tree quarantine) → F4: `git fetch origin +refs/heads/<baseRef>:refs/remotes/origin/<baseRef>`
  //   MUST succeed (else BLOCKED base_ref_unavailable) → `merge-base --is-ancestor <baseCommit>
  //   refs/remotes/origin/<baseRef>` (else BLOCKED base_commit_unreachable; there is NO fallback
  //   to local objects: a commit this clone happens to hold is not a base origin vouches for) →
  //   F5: an existing local <targetBranch> goes through PR #22's handling (never-pushed residue
  //   renamed aside, a tracked/diverged branch refused) → only then `checkout -B`.
  if (baseCommit) {
    if (typeof baseCommit !== "string" || !/^[0-9a-f]{40}$/.test(baseCommit)) {
      throw new Error("base_commit must be a full 40-character lowercase hex SHA-1");
    }
    validateBranchName(branch);
    const legal = await command("git", ["check-ref-format", "--branch", branch], { allowFailure: true });
    if (legal.status !== 0) throw new Error(`envelope branch ${branch} is not a valid git branch name`);
    if (typeof baseRef !== "string" || baseRef === "") {
      throw blocked("base_ref_unavailable", "base_ref_unavailable: a pinned base_commit requires a base_ref to be fetched from origin");
    }
    validateBranchName(baseRef);
    const legalBase = await command("git", ["check-ref-format", "--branch", baseRef], { allowFailure: true });
    if (legalBase.status !== 0) throw blocked("base_ref_unavailable", `base_ref_unavailable: base_ref ${baseRef} is not a valid git branch name`);

    let debrisReceipt = null;
    if (cached) {
      debrisReceipt = await quarantineDirtyTree(stateDir, repoDir, repo, taskId, attempt);
    } else {
      mkdirSync(dirname(repoDir), { recursive: true });
      await command("git", ["clone", cloneUrl, repoDir]);
    }

    const fetched = await command("git", ["-C", repoDir, "fetch", "origin", `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`], { allowFailure: true });
    if (fetched.status !== 0) {
      throw blocked("base_ref_unavailable", `base_ref_unavailable: origin/${baseRef} could not be fetched from origin: ${fetched.stderr || fetched.status}`);
    }
    const isAncestor = await command("git", ["-C", repoDir, "merge-base", "--is-ancestor", baseCommit, `refs/remotes/origin/${baseRef}`], { allowFailure: true });
    if (isAncestor.status !== 0) {
      throw blocked("base_commit_unreachable", `base_commit_unreachable: base_commit ${baseCommit.slice(0, 8)} is not an ancestor of origin/${baseRef} (as fetched)`);
    }

    let aside = null;
    const local = await command("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true });
    if (local.status === 0) {
      const localSha = local.stdout;
      // Never reset away local-only commits: -B is destructive. A local branch that is an ancestor
      // of (or equal to) baseCommit loses nothing; anything else is divergence, classified by PR
      // #22's never-pushed-residue predicate against baseCommit as the tip it must rejoin.
      const anc = await command("git", ["-C", repoDir, "merge-base", "--is-ancestor", `refs/heads/${branch}`, baseCommit], { allowFailure: true });
      if (anc.status === 1) {
        const reason = `local branch ${branch} at ${localSha} has commits not on base_commit ${baseCommit}; refusing to reset (divergence)`;
        const verdict = await classifyDivergedLocal(repoDir, branch, localSha, baseCommit);
        if (!verdict.residue) throw blocked("branch_diverged", `branch_diverged: ${reason}${verdict.note ? `; ${verdict.note}` : ""}`);
        aside = await renameBranchAside(repoDir, branch);
        process.stderr.write(`vinci worker: never-pushed residue on ${branch} at ${localSha} renamed aside to ${aside}; continuing from base_commit ${baseCommit.slice(0, 8)}\n`);
      } else if (anc.status !== 0) {
        throw new Error(`ancestry check failed for ${branch} (${localSha} vs base_commit ${baseCommit}): ${anc.stderr || anc.status}`);
      }
    }
    await command("git", ["-C", repoDir, "checkout", "-B", branch, baseCommit]);
    return { branch, repoDir, aside, debrisReceipt };
  }


  if (branchOverride) {
    validateBranchName(branch);
    // git itself is the authority on ref-name legality; ask it rather than trusting our regex alone.
    const legal = await command("git", ["check-ref-format", "--branch", branch], { allowFailure: true });
    if (legal.status !== 0) throw new Error(`envelope branch ${branch} is not a valid git branch name`);
    // The envelope pinned the branch (e.g. continuing a held PR). Three cases, three different
    // reasons — the ledger and the operator attribution follow the reason (issue #19):
    //   (a) absent on origin       ⇒ "not found on origin" (BLOCKED before spawn, cost 0), regardless
    //       of any stale local branch of that name, which is renamed aside and named, never deleted;
    //   (b) local is an ancestor    ⇒ fast-forward to the remote tip;
    //   (c) local has commits not on the remote tip ⇒ refuse (divergence), naming both SHAs.
    // Existence is asked of origin LIVE (ls-remote) and BEFORE any fetch or clone: a fetch failure
    // must not mask case (a), and case (a) performs no transfer at all. A show-ref on refs/remotes/*
    // would trust stale local copies of branches deleted upstream.
    const remote = await command(
      "git",
      cached
        ? ["-C", repoDir, "ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]
        : ["ls-remote", "--exit-code", "--heads", cloneUrl, `refs/heads/${branch}`],
      { allowFailure: true },
    );
    if (remote.status !== 0) {
      // ls-remote --exit-code: 2 = ref not found; anything else is origin unreachable, a different fact.
      if (remote.status !== 2) throw new Error(`git ls-remote origin failed for ${branch}: ${remote.stderr || remote.status}`);
      let aside = "";
      const local = cached
        ? await command("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true })
        : { status: 1, stdout: "" };
      if (local.status === 0) {
        // Case (a) with a stale local branch (an earlier attempt's work): preserve it under a name
        // the record can cite, so the next attempt of this task does not trip over it.
        const asideName = await renameBranchAside(repoDir, branch);
        aside = ` (stale local branch ${branch} at ${local.stdout} renamed aside to ${asideName})`;
      }
      throw new Error(`envelope branch ${branch} not found on origin${aside}`);
    }
  }

  let debrisReceipt = null;
  if (cached) {
    // The default path works off origin/main and needs it fresh. The branch path fetches its
    // branch explicitly below (after the not-found gate) and never runs a general fetch first.
    if (!branchOverride) await command("git", ["-C", repoDir, "fetch", "origin"]);
    debrisReceipt = await quarantineDirtyTree(stateDir, repoDir, repo, taskId, attempt);
  } else {
    mkdirSync(dirname(repoDir), { recursive: true });
    await command("git", ["clone", cloneUrl, repoDir]);
  }

  if (branchOverride) {
    // Materialize the branch explicitly, by full refspec, BEFORE resolving its tip, and resolve
    // the tip from the LOCAL clone: ls-remote's SHA is a name origin knows, not necessarily an
    // object this clone has (a general fetch is only as wide as remote.origin.fetch).
    await command("git", ["-C", repoDir, "fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    const fetched = await command(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      { allowFailure: true },
    );
    if (fetched.status !== 0 || !/^[0-9a-f]{40}$/.test(fetched.stdout)) {
      throw new Error(`envelope branch ${branch} exists on origin but fetch did not materialize origin/${branch} locally`);
    }
    const remoteTip = fetched.stdout;
    const local = await command(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { allowFailure: true },
    );
    const localSha = local.status === 0 ? local.stdout : null;
    if (localSha) {
      // Never reset away local-only commits (a crashed prior attempt's work): -B is destructive.
      const anc = await command(
        "git",
        ["-C", repoDir, "merge-base", "--is-ancestor", `refs/heads/${branch}`, remoteTip],
        { allowFailure: true },
      );
      if (anc.status === 1) {
        const reason = `local branch ${branch} at ${localSha} has commits not on origin/${branch} at ${remoteTip}; refusing to reset (divergence)`;
        // Never-pushed residue (soak cohort 2 rows 11/11b: a Night-1 local branch, 2 ahead / 82
        // behind origin's rebuilt PR head, no upstream, on no origin head): move it aside so the
        // NEXT attempt can continue at origin/<branch>. This attempt is still refused — the rename
        // is a fact the record must carry, not something to paper over.
        const verdict = await classifyDivergedLocal(repoDir, branch, localSha, remoteTip);
        if (verdict.residue) {
          const asideName = await renameBranchAside(repoDir, branch);
          throw new Error(`${reason}; never-pushed residue renamed aside to ${asideName} — retry continues at origin/${branch}`);
        }
        throw new Error(verdict.note ? `${reason}; ${verdict.note}` : reason);
      }
      if (anc.status !== 0) throw new Error(`ancestry check failed for ${branch} (${localSha} vs origin/${branch} ${remoteTip}): ${anc.stderr || anc.status}`);
      // Case (b): local is an ancestor (or equal) ⇒ -B is a fast-forward to the remote tip.
    }
    await command("git", ["-C", repoDir, "checkout", "-B", branch, remoteTip]);
    return { branch, repoDir, debrisReceipt };
  }
  const localBranch = await command(
    "git",
    ["-C", repoDir, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { allowFailure: true },
  );
  if (localBranch.status === 0) await command("git", ["-C", repoDir, "checkout", branch]);
  else await command("git", ["-C", repoDir, "checkout", "-b", branch, "origin/main"]);
  return { branch, repoDir, debrisReceipt };
}

export function runVinci({ envelope, repoDir, stateDir, taskId, sessionId }) {
  const sessionDir = join(stateDir, "sessions", taskId);
  const pollMs = Number(process.env.VINCI_WORKER_LIMIT_POLL_MS) || 15_000;
  const killGraceMs = Number(process.env.VINCI_WORKER_KILL_GRACE_MS) || 30_000;
  const tools = Array.isArray(envelope.tools) && envelope.tools.length > 0 ? envelope.tools.join(",") : "read,grep,find,ls,bash,edit,write";
  mkdirSync(sessionDir, { recursive: true });

  return new Promise((resolveRun) => {
    const child = spawn(
      resolveBin("vinci"),
      [
        "-p",
        "--session-id",
        sessionId,
        "--session-dir",
        sessionDir,
        "--provider",
        envelope.provider,
        "--model",
        envelope.model,
        "--tools",
        tools,
        envelope.spec,
      ],
      // Post-0.0.51 rule (#18): a task NEVER runs under a self-updating launcher. The daemon
      // probes `vinci --version` immediately before this spawn and records it as the task's
      // `vinci_binary`; with VINCI_UPDATE_DISABLED=1 the launcher cannot swap its payload between
      // that probe and this run, so the recorded version IS the executed version by construction.
      // Updates are an operator action (`vinci update`, as the deploy recipe already does).
      {
        cwd: repoDir,
        detached: true,
        env: { ...process.env, VINCI_UPDATE_DISABLED: "1" },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    let limitTripped = null;
    let killTimer;
    let settled = false;

    const tripLimit = (limit) => {
      if (limitTripped || settled) return;
      limitTripped = limit;
      terminateProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), killGraceMs);
      killTimer.unref();
    };

    const runtimeTimer = setTimeout(() => tripLimit("max_runtime_s"), envelope.max_runtime_s * 1000);
    runtimeTimer.unref();
    const pollTimer = setInterval(() => {
      if (envelope.deadline && Date.now() >= Date.parse(envelope.deadline)) {
        tripLimit("deadline");
        return;
      }
      if (readSessionState(sessionDir, sessionId).costUsd >= envelope.budget_usd) tripLimit("budget_usd");
    }, pollMs);
    pollTimer.unref();

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(runtimeTimer);
      clearInterval(pollTimer);
      if (killTimer) clearTimeout(killTimer);
      const session = readSessionState(sessionDir, sessionId);
      if (!limitTripped && session.costUsd >= envelope.budget_usd) limitTripped = "budget_usd";
      if (!limitTripped && envelope.deadline && Date.now() >= Date.parse(envelope.deadline)) limitTripped = "deadline";
      resolveRun({
        exit_code: signalExitCode(code, signal),
        limit_tripped: limitTripped,
        cost_usd: session.costUsd,
        outcome: session.outcome,
        harness_stops: session.harnessStops,
      });
    };
    child.once("error", () => finish(1, null));
    child.once("close", finish);
  });
}

export async function readHead(repoDir) {
  const result = await command("git", ["-C", repoDir, "rev-parse", "HEAD"], { allowFailure: true });
  return result.status === 0 ? result.stdout : null;
}

export async function readHeadBlocker(repoDir) {
  const exists = await command("git", ["-C", repoDir, "cat-file", "-e", "HEAD:BLOCKER.md"], {
    allowFailure: true,
  });
  if (exists.status !== 0) return null;
  const contents = await command("git", ["-C", repoDir, "show", "HEAD:BLOCKER.md"], { allowFailure: true });
  return contents.status === 0 && contents.stdout.trim() ? "BLOCKER.md at HEAD is non-empty" : null;
}

// F6 output modes (ExecutionSpec `output`; prose envelopes have none and behave as `branch`):
//   none     — nothing durable: no push, no PR, no patch. `publish: "none"`.
//   patch    — `git format-patch --stdout <baseCommit>..HEAD`, returned as `patch` for the evidence
//              bundle (`<attempt>.patch`); NO push. `publish: "patch"`.
//   artifact — the produced files (tracked changes vs baseCommit + untracked files), returned as
//              `artifacts` for the evidence bundle (artifacts.json); NO push. `publish: "artifact"`.
//   branch   — push refs/heads/<branch>; a PR ONLY when the promotion is pull_request (prose:
//              `evidence: pr`). `publish: "pushed" | "push_failed"`.
// F7: the PR base and the evidence diff use the pinned baseRef / baseCommit on the digest path;
// the prose path keeps `main` / `origin/main...HEAD`.
// A BLOCKER.md at HEAD suppresses only the PR (never the push on the branch mode: the agent's
// work and its stated blocker must be on the record — measured 2026-08-27) and is reported as
// blocker_reason on every mode.
export async function publish({ envelope, repoDir, branch, taskId, limitTripped, baseRef, baseCommit }) {
  const mode = envelope.output ?? "branch";
  const blockerReason = await readHeadBlocker(repoDir);
  const withBlocker = (result) => (blockerReason ? { ...result, blocker_reason: blockerReason } : result);
  if (mode === "none") return withBlocker({ publish: "none", pr: null });
  if (mode === "patch") {
    const range = baseCommit ? `${baseCommit}..HEAD` : "origin/main..HEAD";
    const patch = await command("git", ["-C", repoDir, "format-patch", "--stdout", range], { allowFailure: true });
    if (patch.status !== 0) return withBlocker({ publish: "patch_failed", pr: null, patch: null, publish_error: patch.stderr || String(patch.status) });
    return withBlocker({ publish: "patch", pr: null, patch: patch.stdout ? `${patch.stdout}\n` : "" });
  }
  if (mode === "artifact") {
    const base = baseCommit ?? "origin/main";
    const changed = await command("git", ["-C", repoDir, "diff", "--name-only", "-z", base], { allowFailure: true, rawStdout: true });
    const untracked = await command("git", ["-C", repoDir, "ls-files", "--others", "--exclude-standard", "-z"], { allowFailure: true, rawStdout: true });
    if (changed.status !== 0 || untracked.status !== 0) {
      return withBlocker({ publish: "artifact_failed", pr: null, artifacts: null, publish_error: changed.stderr || untracked.stderr || "file listing failed" });
    }
    let files;
    try {
      const combined = [
        ...parseGitNulPaths(changed.stdout, "artifact tracked paths"),
        ...parseGitNulPaths(untracked.stdout, "artifact untracked paths"),
      ];
      const unique = new Set();
      for (const path of combined) {
        if (unique.has(path)) throw new Error(`duplicate path ${JSON.stringify(path)}`);
        unique.add(path);
      }
      files = [...unique].sort();
    } catch (error) {
      return withBlocker({ publish: "artifact_failed", pr: null, artifacts: null, publish_error: error.message });
    }
    return withBlocker({ publish: "artifact", pr: null, artifacts: files });
  }
  if (mode !== "branch") throw new Error(`unknown output mode ${JSON.stringify(mode)}`);

  const push = await command("git", ["-C", repoDir, "push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`], {
    allowFailure: true,
  });
  const result = { publish: push.status === 0 ? "pushed" : "push_failed", pr: null };
  if (blockerReason) return { ...result, publish: push.status === 0 ? "blocked" : "push_failed", blocker_reason: blockerReason };
  if (limitTripped) return result;
  // Digest path: a PR is PROMOTION (promotion: pull_request), never implied by evidence. Prose
  // path: `evidence: pr` keeps its meaning.
  const promotesPr = envelope.promotion !== undefined ? envelope.promotion === "pull_request" : envelope.evidence === "pr";
  if (push.status !== 0 || !promotesPr) return result;

  const created = await command(
    "gh",
    [
      "pr",
      "create",
      "--base",
      baseRef ?? "main",
      "--head",
      branch,
      "--title",
      `Worker task ${taskId}`,
      "--body",
      `Unattended Vinci worker result for task ${taskId}.`,
    ],
    { cwd: repoDir, allowFailure: true },
  );
  if (created.status === 0) result.pr = created.stdout.split("\n").find((line) => PR_URL.test(line)) ?? null;
  const createErr = `${created.stderr ?? ""}${created.stdout ?? ""}`;
  if (result.pr === null && (created.status === 0 || /already exists|already has|pull request for/i.test(createErr))) {
    // A PR may already exist for this branch (by-reference tasks continue held PRs); an
    // existing PR IS the evidence — creation failing must not classify the task UNVERIFIED.
    // Auth/network failures do NOT take this path: they stay visible as pr:null.
    const listed = await command("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url"], { cwd: repoDir, allowFailure: true });
    try {
      const parsed = JSON.parse(listed.stdout ?? "[]");
      if (Array.isArray(parsed) && parsed[0]?.url) result.pr = parsed[0].url;
    } catch { /* no JSON, no PR */ }
  }
  return result;
}

// Outcome precedence — machine-observed events outrank the model's narrative about itself
// (issues #5/#6: the harness refused the required work mid-run and the outcome entry still said DONE).
//   1. non-zero exit or a tripped limit                         => FAILED
//   2. any harness stop in the session (see HARNESS_STOP_PATTERNS) => BLOCKED, even over DONE + PR
//   3. outcome BLOCKED/WAITING, or BLOCKER.md at HEAD            => BLOCKED
//   4. outcome DONE_UNVERIFIED                                    => UNVERIFIED
//   5. outcome DONE and a PR exists                               => COMPLETED
//   6. anything else (incl. evidence: none, exit 0 alone)         => UNVERIFIED (produced, unassessed)
export function finalState({ exitCode, limitTripped, outcome, blocker, pr, harnessStops }) {
  if (exitCode !== 0 || limitTripped) return "FAILED";
  if (Array.isArray(harnessStops) && harnessStops.length > 0) return "BLOCKED";
  if (outcome?.state === "BLOCKED" || outcome?.state === "WAITING" || blocker) return "BLOCKED";
  if (outcome?.state === "DONE_UNVERIFIED") return "UNVERIFIED";
  if (outcome?.state === "DONE" && pr) return "COMPLETED";
  return "UNVERIFIED";
}

export { command, resolveBin };
