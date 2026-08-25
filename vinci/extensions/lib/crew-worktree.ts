import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

const MAX_SNAPSHOT_FILES = 500;
const MAX_SNAPSHOT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

const MAX_TEMP_COPY_FILES = 5_000;
const MAX_TEMP_COPY_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEMP_COPY_BYTES = 200 * 1024 * 1024;
const TEMP_COPY_PATCH_PREFIX = "VINCI_TEMP_COPY_PATCH_V1\n";
const TEMP_COPY_DIRECTORY_PREFIX = "vinci-agent-";
const ALWAYS_EXCLUDED_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  "target",
  "coverage",
  ".DS_Store",
]);

type TempCopyWorktree = {
  kind: "temp-copy";
  root: string;
  cwd: string;
  branch: string;
  baselineFingerprints: Record<string, string>;
  ignorePatterns: string[];
};

type GitWorktree = {
  /** Missing on legacy/orphan records created outside this module; those are Git worktrees. */
  kind?: "git";
  root: string;
  cwd: string;
  branch: string;
};

export type CrewWorktree = GitWorktree | TempCopyWorktree;

export type CrewFileChange = {
  path: string;
  status: "added" | "modified" | "deleted";
  contentBytes?: Uint8Array;
  mode?: number;
};

export type CrewPatch = {
  kind: "git" | "temp-copy";
  diff: string;
  paths: string[];
  deletedPaths: string[];
  baselineFingerprints: Record<string, string>;
  ignorePatterns?: string[];
  fileChanges?: CrewFileChange[];
};

export type OrphanedTempCopyResult = {
  workspaceFound: boolean;
  worktree?: CrewWorktree;
};

type TempCopyFile = {
  path: string;
  source: string;
};

type EncodedTempCopyChange = {
  path: string;
  status: CrewFileChange["status"];
  baselineFingerprint: string;
  mode?: number;
  contentEncoding?: "utf8" | "base64";
  content?: string;
};

type EncodedTempCopyPatch = {
  kind: "temp-copy";
  version: 1;
  changes: EncodedTempCopyChange[];
};

export type VerifierInvocation = {
  executable: string;
  args: string[];
  cwd: string;
};

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
}

function findRepoRoot(cwd: string): string | undefined {
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
    if (root) return root;
  } catch {
    /* not a Git working tree */
  }
  return undefined;
}

function repoRoot(cwd: string): string {
  const root = findRepoRoot(cwd);
  if (root) return root;
  throw new Error("Crew requires a Git repository.");
}

function safeRepoPath(root: string, path: string): string {
  if (!path || path.includes("\0") || isAbsolute(path)) throw new Error(`Unsafe repository path: ${path || "(empty)"}`);
  const full = resolve(root, path);
  const fromRoot = relative(root, full);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Unsafe repository path: ${path}`);
  }
  return full;
}

function newPathMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function normalizedPatchPath(path: string): string {
  if (!path || path.includes("\0") || path.includes("\\") || posix.isAbsolute(path)) {
    throw new Error(`Unsafe repository path: ${path || "(empty)"}`);
  }
  const normalized = posix.normalize(path).replace(/\/$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Unsafe repository path: ${path}`);
  }
  return normalized;
}

function isSeedOnlyPath(path: string): boolean {
  const name = basename(path);
  return name === ".env" || name.startsWith(".env.");
}

function nulList(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function fingerprint(root: string, path: string): string {
  const full = safeRepoPath(root, path);
  try {
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      return `content:${createHash("sha256").update(readlinkSync(full)).digest("hex")}`;
    }
    if (!stat.isFile()) return "non-file";
    return `content:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return "missing";
    throw error;
  }
}

function tempCopyFingerprint(root: string, path: string): string {
  const full = safeRepoPath(root, path);
  try {
    const stat = lstatSync(full);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      return `symlink:${mode.toString(8)}:${createHash("sha256").update(readlinkSync(full)).digest("hex")}`;
    }
    if (!stat.isFile()) return `non-file:${mode.toString(8)}`;
    return `file:${mode.toString(8)}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return "missing";
    throw error;
  }
}

function projectTooLargeError(): Error {
  return new Error(
    "This project is too large for agents without version tracking (over 5,000 files / 200 MB, or a file over 20 MB). " +
      "Try turning on version history, or run this in a smaller folder.",
  );
}

function globSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[\\^$.[\]{}()+|]/g, "\\$&");
    }
  }
  return source;
}

function ignoreRules(patterns: string[]): Array<{ negated: boolean; expression: RegExp }> {
  const rules: Array<{ negated: boolean; expression: RegExp }> = [];
  for (const rawPattern of patterns) {
    let pattern = rawPattern.trim();
    if (!pattern || pattern.startsWith("#")) continue;
    const negated = pattern.startsWith("!");
    if (negated) pattern = pattern.slice(1);
    if (!pattern) continue;
    if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith("/");
    if (anchored) pattern = pattern.slice(1);
    if (!pattern) continue;
    const prefix = anchored || pattern.includes("/") ? "^" : "(?:^|/)";
    rules.push({ negated, expression: new RegExp(`${prefix}${globSource(pattern)}(?:$|/)`) });
  }
  return rules;
}

function isIgnored(path: string, rules: Array<{ negated: boolean; expression: RegExp }>): boolean {
  if (ALWAYS_EXCLUDED_NAMES.has(basename(path))) return true;
  let ignored = false;
  for (const rule of rules) {
    if (rule.expression.test(path)) ignored = !rule.negated;
  }
  return ignored;
}

function loadTopLevelIgnorePatterns(root: string): string[] {
  const path = join(root, ".gitignore");
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return [];
    if (stat.size > MAX_TEMP_COPY_FILE_BYTES) throw projectTooLargeError();
    return readFileSync(path, "utf8").split(/\r?\n/);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
}

function scanTempCopyFiles(root: string, patterns: string[]): TempCopyFile[] {
  const files: TempCopyFile[] = [];
  const rules = ignoreRules(patterns);
  // Resolve the root once: on macOS os.tmpdir() (/var/...) is itself a symlink to /private/var/...,
  // so comparing a realpath'd entry against an unresolved root would falsely read as "outside".
  const resolvedRoot = realpathSync(root);
  let totalBytes = 0;
  const walk = (directory: string, prefix: string, seedOnly: boolean): void => {
    const resolvedDirectory = realpathSync(directory);
    if (!pathIsInside(resolvedRoot, resolvedDirectory)) throw new Error("Crew cannot copy files through a link outside this project.");
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = normalizedPatchPath(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (ALWAYS_EXCLUDED_NAMES.has(entry.name)) continue;
      const source = join(directory, entry.name);
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(source, path, seedOnly || isIgnored(path, rules));
        continue;
      }
      if (!stat.isFile()) continue;
      if ((seedOnly || isIgnored(path, rules)) && !isSeedOnlyPath(path)) continue;
      if (files.length >= MAX_TEMP_COPY_FILES || stat.size > MAX_TEMP_COPY_FILE_BYTES) throw projectTooLargeError();
      totalBytes += stat.size;
      if (totalBytes > MAX_TEMP_COPY_BYTES) throw projectTooLargeError();
      files.push({ path, source });
    }
  };
  walk(root, "", false);
  return files;
}

function copyTempCopyFiles(sourceRoot: string, files: TempCopyFile[], targetRoot: string): Record<string, string> {
  const baselineFingerprints = newPathMap<string>();
  const resolvedSourceRoot = realpathSync(sourceRoot);
  let totalBytes = 0;
  for (const file of files) {
    const stat = lstatSync(file.source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEMP_COPY_FILE_BYTES) throw projectTooLargeError();
    const resolvedSource = realpathSync(file.source);
    if (!pathIsInside(resolvedSourceRoot, resolvedSource)) throw new Error("Crew cannot copy files through a link outside this project.");
    const target = safeRepoPath(targetRoot, file.path);
    mkdirSync(dirname(target), { recursive: true });
    try {
      copyFileSync(resolvedSource, target, constants.COPYFILE_FICLONE);
    } catch {
      copyFileSync(resolvedSource, target);
    }
    chmodSync(target, stat.mode & 0o777);
    const copiedStat = lstatSync(target);
    totalBytes += copiedStat.size;
    if (!copiedStat.isFile() || copiedStat.size > MAX_TEMP_COPY_FILE_BYTES || totalBytes > MAX_TEMP_COPY_BYTES) {
      rmSync(targetRoot, { recursive: true, force: true });
      throw projectTooLargeError();
    }
    baselineFingerprints[file.path] = tempCopyFingerprint(targetRoot, file.path);
  }
  return baselineFingerprints;
}

function encodeContent(content: Uint8Array): Pick<EncodedTempCopyChange, "content" | "contentEncoding"> {
  const buffer = Buffer.from(content);
  const text = buffer.toString("utf8");
  return Buffer.from(text, "utf8").equals(buffer)
    ? { contentEncoding: "utf8", content: text }
    : { contentEncoding: "base64", content: buffer.toString("base64") };
}

function encodeTempCopyPatch(changes: CrewFileChange[], baselineFingerprints: Record<string, string>): string {
  if (!changes.length) return "";
  const encoded: EncodedTempCopyPatch = {
    kind: "temp-copy",
    version: 1,
    changes: changes.map((change) => ({
      path: change.path,
      status: change.status,
      baselineFingerprint: Object.hasOwn(baselineFingerprints, change.path) ? baselineFingerprints[change.path] : "missing",
      ...(change.mode === undefined ? {} : { mode: change.mode }),
      ...(change.contentBytes === undefined ? {} : encodeContent(change.contentBytes)),
    })),
  };
  return `${TEMP_COPY_PATCH_PREFIX}${JSON.stringify(encoded, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTempCopyPatch(
  diff: string,
): { changes: CrewFileChange[]; baselineFingerprints: Record<string, string> } | undefined {
  if (!diff.startsWith(TEMP_COPY_PATCH_PREFIX)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(diff.slice(TEMP_COPY_PATCH_PREFIX.length));
  } catch {
    throw new Error("The saved agent patch is damaged and cannot be applied safely.");
  }
  if (!isRecord(payload) || payload.kind !== "temp-copy" || payload.version !== 1 || !Array.isArray(payload.changes)) {
    throw new Error("The saved agent patch is not a supported temp-copy patch.");
  }
  if (payload.changes.length > MAX_TEMP_COPY_FILES) throw projectTooLargeError();
  const changes: CrewFileChange[] = [];
  const baselineFingerprints = newPathMap<string>();
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const candidate of payload.changes) {
    if (
      !isRecord(candidate) ||
      typeof candidate.path !== "string" ||
      (candidate.status !== "added" && candidate.status !== "modified" && candidate.status !== "deleted") ||
      typeof candidate.baselineFingerprint !== "string"
    ) {
      throw new Error("The saved agent patch contains an invalid file change.");
    }
    const path = normalizedPatchPath(candidate.path);
    if (seen.has(path) || isSeedOnlyPath(path)) {
      throw new Error("The saved agent patch contains an invalid file change.");
    }
    seen.add(path);
    baselineFingerprints[path] = candidate.baselineFingerprint;
    if (candidate.status === "deleted") {
      if (candidate.mode !== undefined || candidate.contentEncoding !== undefined || candidate.content !== undefined) {
        throw new Error("The saved agent patch contains an invalid file change.");
      }
      changes.push({ path, status: candidate.status });
      continue;
    }
    if (
      typeof candidate.mode !== "number" ||
      !Number.isInteger(candidate.mode) ||
      candidate.mode < 0 ||
      candidate.mode > 0o777 ||
      (candidate.contentEncoding !== "utf8" && candidate.contentEncoding !== "base64") ||
      typeof candidate.content !== "string"
    ) {
      throw new Error(`The saved agent patch has invalid content or permissions for ${path}.`);
    }
    const contentBytes = Buffer.from(candidate.content, candidate.contentEncoding);
    if (contentBytes.byteLength > MAX_TEMP_COPY_FILE_BYTES) throw projectTooLargeError();
    totalBytes += contentBytes.byteLength;
    if (totalBytes > MAX_TEMP_COPY_BYTES) throw projectTooLargeError();
    changes.push({ path, status: candidate.status, contentBytes, mode: candidate.mode });
  }
  return { changes, baselineFingerprints };
}

function pathIsInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return !fromRoot || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

/** Remove temp-copy workspaces left behind by crashed non-Git helpers. */
export function sweepStaleTempCopies(maxAgeMs = 24 * 60 * 60 * 1000): { removed: number } {
  const tempRoot = realpathSync(tmpdir());
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of readdirSync(tempRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(TEMP_COPY_DIRECTORY_PREFIX)) continue;
    const candidate = join(tempRoot, entry.name);
    try {
      const stat = lstatSync(candidate);
      if (!stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
      const resolved = realpathSync(candidate);
      if (dirname(resolved) !== tempRoot || !basename(resolved).startsWith(TEMP_COPY_DIRECTORY_PREFIX)) continue;
      rmSync(resolved, { recursive: true, force: true });
      removed++;
    } catch {
      /* cleanup is best-effort; one inaccessible entry must not stop the sweep */
    }
  }
  return { removed };
}

/** Locate one crashed helper's temp-copy without guessing when no unique candidate exists. */
export function findOrphanedTempCopyWorktree(
  helperId: number,
  recovery?: { baselineFingerprints: Record<string, string>; ignorePatterns: string[] },
): OrphanedTempCopyResult {
  const tempRoot = realpathSync(tmpdir());
  const safeId = String(helperId).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "helper";
  const prefix = `${TEMP_COPY_DIRECTORY_PREFIX}${safeId}-`;
  const matches: string[] = [];
  for (const entry of readdirSync(tempRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix) || !entry.isDirectory()) continue;
    const candidate = join(tempRoot, entry.name);
    try {
      const resolved = realpathSync(candidate);
      if (dirname(resolved) === tempRoot && basename(resolved).startsWith(prefix)) matches.push(resolved);
    } catch {
      /* a workspace removed by the stale sweep or another process is not recoverable */
    }
  }
  if (matches.length !== 1) return { workspaceFound: false };
  if (!recovery) return { workspaceFound: true };
  const root = matches[0];
  return {
    workspaceFound: true,
    worktree: {
      kind: "temp-copy",
      root,
      cwd: root,
      branch: "",
      baselineFingerprints: { ...recovery.baselineFingerprints },
      ignorePatterns: recovery.ignorePatterns.slice(),
    },
  };
}

function assertSafePathParents(root: string, target: string): void {
  const resolvedRoot = realpathSync(root);
  let existingParent = dirname(target);
  for (;;) {
    try {
      const resolvedParent = realpathSync(existingParent);
      if (!pathIsInside(resolvedRoot, resolvedParent)) throw new Error(`Unsafe repository path: ${relative(root, target)}`);
      if (!lstatSync(resolvedParent).isDirectory()) throw new Error(`Unsafe repository path: ${relative(root, target)}`);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") throw error;
      const next = dirname(existingParent);
      if (next === existingParent) throw error;
      existingParent = next;
    }
  }
}

function headFingerprint(root: string, path: string): string {
  safeRepoPath(root, path);
  try {
    const content = execFileSync("git", ["show", `HEAD:${path}`], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return `content:${createHash("sha256").update(content).digest("hex")}`;
  } catch {
    return "missing";
  }
}

function copyUntrackedFiles(sourceRoot: string, targetRoot: string): void {
  // Drop regenerable dependency/build dirs BEFORE the cap. `--exclude-standard` only honours
  // .gitignore, so a freshly scaffolded project (no .gitignore yet) reports every file under
  // node_modules as untracked — 2301 of them in a live session, which blew the 500 cap and made
  // EVERY agent fail instantly. These dirs must never be copied into a worktree anyway: they're
  // large and the agent can regenerate them.
  const paths = nulList(git(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"])).filter(
    (path) => !path.split("/").some((segment) => ALWAYS_EXCLUDED_NAMES.has(segment)),
  );
  if (paths.length > MAX_SNAPSHOT_FILES) {
    throw new Error(`Crew snapshot has ${paths.length} untracked files; the safe limit is ${MAX_SNAPSHOT_FILES}.`);
  }
  let totalBytes = 0;
  for (const path of paths) {
    const source = safeRepoPath(sourceRoot, path);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Crew cannot safely snapshot non-regular untracked path: ${path}`);
    }
    if (stat.size > MAX_SNAPSHOT_FILE_BYTES) {
      throw new Error(`Crew cannot snapshot untracked file larger than 10 MiB: ${path}`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error("Crew untracked snapshot exceeds the 50 MiB safety limit.");
    }
    const target = safeRepoPath(targetRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function commitSnapshot(worktreeRoot: string): void {
  git(worktreeRoot, ["add", "-A"]);
  git(worktreeRoot, [
    "-c",
    "user.name=Vinci Crew",
    "-c",
    "user.email=crew@localhost",
    "commit",
    "-q",
    "--allow-empty",
    "--no-gpg-sign",
    "-m",
    "Vinci Crew private snapshot",
  ]);
}

/** Create an isolated helper checkout seeded from the caller's exact tracked + safe untracked state. */
export function createCrewWorktree(cwd: string, id: string, runTag: string): CrewWorktree {
  const foundRoot = findRepoRoot(cwd);
  if (!foundRoot) {
    const sourceRoot = realpathSync(cwd);
    const ignorePatterns = loadTopLevelIgnorePatterns(sourceRoot);
    const files = scanTempCopyFiles(sourceRoot, ignorePatterns);
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "helper";
    const safeRunTag = runTag.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "run";
    const root = mkdtempSync(join(tmpdir(), `${TEMP_COPY_DIRECTORY_PREFIX}${safeId}-${safeRunTag}-`));
    try {
      const baselineFingerprints = copyTempCopyFiles(sourceRoot, files, root);
      return { kind: "temp-copy", root, cwd: root, branch: "", baselineFingerprints, ignorePatterns };
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  const sourceRoot = realpathSync(foundRoot);
  const relativeCwd = relative(sourceRoot, realpathSync(cwd));
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Crew working directory is outside the Git repository.");
  }
  const branch = `vinci/helper-${id}-${runTag}`;
  const root = mkdtempSync(join(tmpdir(), `vinci-helper-${id}-`));
  try {
    git(sourceRoot, ["worktree", "add", "-q", "-b", branch, root, "HEAD"]);
    const trackedDiff = git(sourceRoot, ["diff", "--binary", "HEAD", "--"]);
    if (trackedDiff.trim()) git(root, ["apply", "--binary", "-"], trackedDiff);
    copyUntrackedFiles(sourceRoot, root);
    commitSnapshot(root);
    return { kind: "git", root, cwd: relativeCwd ? join(root, relativeCwd) : root, branch };
  } catch (error) {
    try {
      git(sourceRoot, ["worktree", "remove", "--force", root]);
    } catch {
      rmSync(root, { recursive: true, force: true });
    }
    try {
      git(sourceRoot, ["branch", "-D", branch]);
    } catch {
      /* the branch may not have been created */
    }
    throw error;
  }
}

/** Capture only helper-authored changes relative to the private snapshot commit. */
export function captureCrewPatch(worktree: CrewWorktree): CrewPatch {
  if (worktree.kind === "temp-copy") {
    const currentFiles = scanTempCopyFiles(worktree.root, worktree.ignorePatterns);
    const currentByPath = new Map<string, TempCopyFile>();
    for (const file of currentFiles) {
      const path = normalizedPatchPath(file.path);
      if (isSeedOnlyPath(path)) continue;
      if (currentByPath.has(path)) throw new Error(`Crew found two files with the same normalized path: ${path}`);
      currentByPath.set(path, { ...file, path });
    }
    const baselines = newPathMap<string>();
    for (const [rawPath, baseline] of Object.entries(worktree.baselineFingerprints)) {
      const path = normalizedPatchPath(rawPath);
      if (isSeedOnlyPath(path)) continue;
      if (Object.hasOwn(baselines, path)) throw new Error(`Crew found two files with the same normalized path: ${path}`);
      baselines[path] = baseline;
    }
    const changedPaths = new Set<string>();
    for (const [path, baseline] of Object.entries(baselines)) {
      const current = currentByPath.get(path);
      if (!current) {
        const full = safeRepoPath(worktree.root, path);
        try {
          const stat = lstatSync(full);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error(`Crew cannot safely capture a file replaced by a non-regular path: ${path}`);
          }
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
          if (code !== "ENOENT") throw error;
        }
        changedPaths.add(path);
      } else if (tempCopyFingerprint(worktree.root, path) !== baseline) {
        changedPaths.add(path);
      }
    }
    for (const path of currentByPath.keys()) {
      if (!Object.hasOwn(baselines, path)) changedPaths.add(path);
    }

    const paths = [...changedPaths].sort();
    const baselineFingerprints = newPathMap<string>();
    let capturedBytes = 0;
    const fileChanges: CrewFileChange[] = paths.map((path) => {
      const current = currentByPath.get(path);
      const baseline = Object.hasOwn(baselines, path) ? baselines[path] : "missing";
      baselineFingerprints[path] = baseline;
      if (!current) return { path, status: "deleted" };
      const stat = lstatSync(current.source);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Crew cannot safely capture a non-regular file: ${path}`);
      }
      const contentBytes = readFileSync(current.source);
      if (contentBytes.byteLength > MAX_TEMP_COPY_FILE_BYTES) throw projectTooLargeError();
      capturedBytes += contentBytes.byteLength;
      if (capturedBytes > MAX_TEMP_COPY_BYTES) throw projectTooLargeError();
      return {
        path,
        status: baseline === "missing" ? "added" : "modified",
        contentBytes,
        mode: stat.mode & 0o777,
      };
    });
    return {
      kind: "temp-copy",
      diff: encodeTempCopyPatch(fileChanges, baselineFingerprints),
      paths,
      deletedPaths: fileChanges.filter((change) => change.status === "deleted").map((change) => change.path),
      baselineFingerprints,
      ignorePatterns: worktree.ignorePatterns.slice(),
      fileChanges,
    };
  }

  git(worktree.root, ["add", "-A"]);
  const diff = git(worktree.root, ["diff", "--cached", "--binary", "HEAD", "--"]);
  const paths = nulList(git(worktree.root, ["diff", "--cached", "--name-only", "-z", "HEAD", "--"]));
  const statuses = nulList(git(worktree.root, ["diff", "--cached", "--name-status", "-z", "HEAD", "--"]));
  const deletedPaths: string[] = [];
  for (let index = 0; index < statuses.length; ) {
    const status = statuses[index++];
    const path = statuses[index++];
    if (!status || !path) break;
    if (status.startsWith("D")) deletedPaths.push(path);
    if (status.startsWith("R") || status.startsWith("C")) index++;
  }
  const baselineFingerprints = newPathMap<string>();
  for (const path of paths) baselineFingerprints[path] = headFingerprint(worktree.root, path);
  return {
    kind: "git",
    diff,
    paths,
    deletedPaths,
    baselineFingerprints,
  };
}

export function removeCrewWorktree(cwd: string, worktree: CrewWorktree): void {
  if (worktree.kind === "temp-copy") {
    let root: string;
    try {
      root = realpathSync(worktree.root);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return;
      throw error;
    }
    const tempRoot = realpathSync(tmpdir());
    if (root === tempRoot || !pathIsInside(tempRoot, root) || !basename(root).startsWith(TEMP_COPY_DIRECTORY_PREFIX)) {
      throw new Error("Refusing to remove a temp-copy workspace outside Vinci's private temporary directory.");
    }
    rmSync(root, { recursive: true, force: true });
    return;
  }

  let root: string;
  try {
    root = repoRoot(cwd);
  } catch {
    root = cwd;
  }
  // Resolve where the branch lives BEFORE removing the worktree. When `cwd` IS the worktree
  // (#193's stale-ctx fallback), `root` resolves to the worktree's own — soon-deleted — directory,
  // and a `git branch -D` run from there ENOENTs into the best-effort catch, silently leaking the
  // vinci/helper-* branch in the main repo. The common dir names the main repo while the worktree
  // still exists to be asked.
  let branchRoot = root;
  try {
    branchRoot = dirname(git(worktree.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
  } catch {
    /* fall back to root — a plain repo cwd resolves the branch fine from there */
  }
  try {
    git(root, ["worktree", "remove", "--force", worktree.root]);
  } catch {
    rmSync(worktree.root, { recursive: true, force: true });
  }
  try {
    git(branchRoot, ["branch", "-D", worktree.branch]);
  } catch {
    /* cleanup is best-effort */
  }
}

export function crewChangedPaths(cwd: string, patch: CrewPatch): string[] {
  if (patch.kind === "temp-copy") {
    const root = realpathSync(cwd);
    return patch.paths.filter((rawPath) => {
      const path = normalizedPatchPath(rawPath);
      return (
        !Object.hasOwn(patch.baselineFingerprints, path) ||
        tempCopyFingerprint(root, path) !== patch.baselineFingerprints[path]
      );
    });
  }
  const root = repoRoot(cwd);
  return patch.paths.filter(
    (path) => !Object.hasOwn(patch.baselineFingerprints, path) || fingerprint(root, path) !== patch.baselineFingerprints[path],
  );
}

export function crewPathsUnchanged(cwd: string, patch: CrewPatch): boolean {
  return crewChangedPaths(cwd, patch).length === 0;
}

export function applyCrewPatch(cwd: string, diff: string): void {
  if (!diff.trim()) throw new Error("Crew patch is empty.");
  const tempCopyPatch = parseTempCopyPatch(diff);
  if (tempCopyPatch) {
    const root = realpathSync(cwd);
    type ValidatedChange = CrewFileChange & { baselineFingerprint: string; target: string };
    type JournalEntry = {
      change: ValidatedChange;
      applied: boolean;
      originalBytes?: Uint8Array;
      originalMode?: number;
      staged?: string;
    };
    const validated: ValidatedChange[] = [];
    const stalePaths: string[] = [];
    for (const change of tempCopyPatch.changes) {
      const path = normalizedPatchPath(change.path);
      const target = safeRepoPath(root, path);
      assertSafePathParents(root, target);
      if (!Object.hasOwn(tempCopyPatch.baselineFingerprints, path)) {
        throw new Error(`The saved agent patch has no baseline for ${path}.`);
      }
      const baselineFingerprint = tempCopyPatch.baselineFingerprints[path];
      const currentFingerprint = tempCopyFingerprint(root, path);
      if (
        currentFingerprint !== baselineFingerprint ||
        (change.status === "added" ? currentFingerprint !== "missing" : !currentFingerprint.startsWith("file:"))
      ) {
        stalePaths.push(path);
      }
      validated.push({ ...change, path, target, baselineFingerprint });
    }
    if (stalePaths.length) {
      throw new Error(`The agent patch was not applied because these files changed meanwhile: ${stalePaths.join(", ")}`);
    }

    const journal: JournalEntry[] = [];
    const createdDirectories: string[] = [];
    const stagingDirectories = new Set<string>();
    try {
      for (const change of validated) {
        if (tempCopyFingerprint(root, change.path) !== change.baselineFingerprint) {
          throw new Error(`The agent patch was not applied because this file changed meanwhile: ${change.path}`);
        }
        if (change.status === "added") {
          journal.push({ change, applied: false });
          continue;
        }
        const stat = lstatSync(change.target);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`The agent patch was not applied because this file is no longer regular: ${change.path}`);
        }
        const originalBytes = readFileSync(change.target);
        if (tempCopyFingerprint(root, change.path) !== change.baselineFingerprint) {
          throw new Error(`The agent patch was not applied because this file changed meanwhile: ${change.path}`);
        }
        journal.push({ change, applied: false, originalBytes, originalMode: stat.mode & 0o777 });
      }
      for (const entry of journal) {
        if (tempCopyFingerprint(root, entry.change.path) !== entry.change.baselineFingerprint) {
          throw new Error(`The agent patch was not applied because this file changed meanwhile: ${entry.change.path}`);
        }
      }

      for (const entry of journal) {
        const { change } = entry;
        if (change.status === "deleted") continue;
        if (change.contentBytes === undefined || change.mode === undefined) {
          throw new Error(`The agent patch has no content or permissions for ${change.path}.`);
        }
        const missingParents: string[] = [];
        for (let parent = dirname(change.target); parent !== root; parent = dirname(parent)) {
          try {
            lstatSync(parent);
            break;
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
            if (code !== "ENOENT") throw error;
            missingParents.push(parent);
          }
        }
        for (const parent of missingParents.reverse()) {
          mkdirSync(parent);
          createdDirectories.push(parent);
        }
        assertSafePathParents(root, change.target);
        const stagingDirectory = mkdtempSync(join(dirname(change.target), ".vinci-crew-"));
        stagingDirectories.add(stagingDirectory);
        const staged = join(stagingDirectory, "content");
        writeFileSync(staged, change.contentBytes, { mode: 0o600 });
        chmodSync(staged, change.mode);
        entry.staged = staged;
      }

      for (const entry of journal) {
        const { change } = entry;
        if (change.status === "deleted") continue;
        if (tempCopyFingerprint(root, change.path) !== change.baselineFingerprint) {
          throw new Error(`This file changed while the agent patch was applying: ${change.path}`);
        }
        assertSafePathParents(root, change.target);
        if (!entry.staged) throw new Error(`The agent patch was not staged for ${change.path}.`);
        renameSync(entry.staged, change.target);
        entry.applied = true;
      }
      for (const entry of journal) {
        const { change } = entry;
        if (change.status !== "deleted") continue;
        if (tempCopyFingerprint(root, change.path) !== change.baselineFingerprint) {
          throw new Error(`This file changed while the agent patch was applying: ${change.path}`);
        }
        assertSafePathParents(root, change.target);
        rmSync(change.target);
        entry.applied = true;
      }
      for (const stagingDirectory of stagingDirectories) {
        rmSync(stagingDirectory, { recursive: true, force: true });
      }
      return;
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const entry of [...journal].reverse()) {
        if (!entry.applied) continue;
        const { change } = entry;
        try {
          if (change.status === "added") {
            rmSync(change.target, { force: true });
          } else {
            if (entry.originalBytes === undefined || entry.originalMode === undefined) {
              throw new Error("missing rollback journal entry");
            }
            const rollbackDirectory = mkdtempSync(join(dirname(change.target), ".vinci-crew-rollback-"));
            try {
              const rollbackFile = join(rollbackDirectory, "content");
              writeFileSync(rollbackFile, entry.originalBytes, { mode: 0o600 });
              chmodSync(rollbackFile, entry.originalMode);
              renameSync(rollbackFile, change.target);
            } finally {
              rmSync(rollbackDirectory, { recursive: true, force: true });
            }
          }
        } catch {
          rollbackFailures.push(change.path);
        }
      }
      for (const stagingDirectory of stagingDirectories) {
        try {
          rmSync(stagingDirectory, { recursive: true, force: true });
        } catch {
          rollbackFailures.push(relative(root, stagingDirectory));
        }
      }
      for (const directory of [...createdDirectories].reverse()) {
        try {
          rmSync(directory);
        } catch {
          rollbackFailures.push(relative(root, directory));
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      if (rollbackFailures.length) {
        const pathsToCheck = [...new Set([...validated.map((change) => change.path), ...rollbackFailures])].join(", ");
        throw new Error(
          `${message}. Rollback failed, so some changes may be partially applied. Check these project paths: ${pathsToCheck}`,
        );
      }
      throw new Error(`${message}. The partial apply was rolled back cleanly.`);
    }
  }
  const root = repoRoot(cwd);
  git(root, ["apply", "--check", "--binary", "-"], diff);
  git(root, ["apply", "--binary", "-"], diff);
}

function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"' && index + 1 < command.length) word += command[++index];
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\" && index + 1 < command.length) {
      word += command[++index];
      continue;
    }
    if (/\s/.test(character)) {
      if (word) words.push(word);
      word = "";
      continue;
    }
    if (/[;&|<>`$]/.test(character)) return null;
    word += character;
  }
  if (quote) return null;
  if (word) words.push(word);
  return words;
}

/** Parse one direct verifier command, optionally preceded by one safe `cd path &&`. */
export function parseVerifierInvocation(command: string, cwd: string): VerifierInvocation | null {
  let body = command.trim();
  let executionCwd = cwd;
  const prefix = body.match(/^cd\s+("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^&|;\n]+?)\s*&&\s*/);
  if (prefix) {
    const cdWords = shellWords(prefix[0].replace(/\s*&&\s*$/, ""));
    if (!cdWords || cdWords.length !== 2 || cdWords[0] !== "cd") return null;
    const target = resolve(cwd, cdWords[1]);
    const fromRoot = relative(cwd, target);
    if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return null;
    executionCwd = target;
    body = body.slice(prefix[0].length).trim();
  }
  const words = shellWords(body);
  if (!words?.length) return null;
  const executable = words.shift();
  return executable ? { executable, args: words, cwd: executionCwd } : null;
}

export function runCrewVerifier(worktree: CrewWorktree, command: string): { passed: boolean; output: string } {
  const invocation = parseVerifierInvocation(command, worktree.cwd);
  if (!invocation) return { passed: false, output: "The verifier command is not a safe direct command." };
  try {
    const output = execFileSync(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { passed: true, output };
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "") : "";
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "") : "";
    const message = error instanceof Error ? error.message : String(error);
    return { passed: false, output: `${stdout}${stderr || message}`.trim() };
  }
}

export function isConsequentialCrewPatch(patch: CrewPatch): boolean {
  if (patch.deletedPaths.length) return true;
  return patch.paths.some((path) =>
    /(^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|Dockerfile|[^/]+\.tf|\.github\/|infra\/)|(?:^|\/)(?:tsconfig|vite\.config|vitest\.config|eslint\.config|biome)\b/i.test(
      path,
    ),
  );
}
