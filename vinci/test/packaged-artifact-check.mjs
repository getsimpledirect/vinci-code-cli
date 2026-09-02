#!/usr/bin/env node
// Verify the unpacked release artifact, never the repository tree. This check is deliberately
// static: executing a launcher or module supplied by the artifact would turn verification into
// execution of the thing under review. CI separately exercises the trusted, freshly built artifact
// through bounded product probes after this structural check succeeds.
//
// Usage: node vinci/test/packaged-artifact-check.mjs <unpacked-artifact-root>
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire, isBuiltin } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parse } from "unbash";
import { runtimePackageExcludes } from "../scripts/runtime-package-closure.mjs";

function refuse(message, details = []) {
  console.error(`✗ packaged artifact: ${message}`);
  for (const detail of details) console.error(`    ${detail}`);
  process.exit(1);
}

const suppliedRoot = process.argv[2];
if (!suppliedRoot || !existsSync(suppliedRoot)) {
  console.error("usage: packaged-artifact-check.mjs <unpacked-artifact-root>");
  process.exit(2);
}
if (lstatSync(suppliedRoot).isSymbolicLink() || !lstatSync(suppliedRoot).isDirectory()) {
  refuse("artifact root must be a real directory, not a symlink or file");
}
const root = realpathSync(suppliedRoot);
const suppliedAuthorityRoot = process.env.VINCI_PACKAGED_AUTHORITY_ROOT
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
if (
  !existsSync(suppliedAuthorityRoot)
  || lstatSync(suppliedAuthorityRoot).isSymbolicLink()
  || !lstatSync(suppliedAuthorityRoot).isDirectory()
) {
  refuse("trusted executable authority root must be a real directory");
}
const authorityGitRoot = realpathSync(suppliedAuthorityRoot);

const expectedAuthorityRepository = "https://github.com/getsimpledirect/vinci-code-cli";

function gitOutput(args) {
  const result = spawnSync("git", ["-C", authorityGitRoot, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    timeout: 10_000,
  });
  if (result.status !== 0) {
    refuse("trusted executable authority must be a readable Git checkout", [
      `git ${args.join(" ")}: ${(result.stderr || result.stdout || "failed").trim()}`,
    ]);
  }
  return result.stdout.trim();
}

function normalizedRemote(remote) {
  return remote
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

function readAuthorityGitIdentity() {
  const topLevel = realpathSync(gitOutput(["rev-parse", "--show-toplevel"]));
  if (topLevel !== authorityGitRoot) {
    refuse("trusted executable authority root must be the Git worktree root", [topLevel]);
  }
  const remote = normalizedRemote(gitOutput(["remote", "get-url", "origin"]));
  if (remote !== expectedAuthorityRepository) {
    refuse("trusted executable authority has the wrong repository identity", [remote]);
  }
  const status = gitOutput(["status", "--porcelain=v1", "--untracked-files=no"]);
  if (status !== "") refuse("trusted executable authority has tracked modifications", status.split("\n"));
  return {
    commit: gitOutput(["rev-parse", "HEAD"]),
    tree: gitOutput(["rev-parse", "HEAD^{tree}"]),
    remote,
  };
}

const initialAuthorityGitIdentity = readAuthorityGitIdentity();

function readTrackedAuthorityEntries() {
  const result = spawnSync("git", ["-C", authorityGitRoot, "ls-tree", "-rz", "--full-tree", "HEAD"], {
    encoding: "buffer",
    env: { PATH: process.env.PATH ?? "" },
    timeout: 10_000,
  });
  if (result.status !== 0) {
    refuse("trusted executable authority Git tree cannot be read", [result.stderr.toString("utf8").trim()]);
  }
  const entries = new Map();
  for (const record of result.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, object] = record.slice(0, tab).split(" ");
    entries.set(record.slice(tab + 1), { mode, type, object });
  }
  return entries;
}

const authorityObjectFormat = gitOutput(["rev-parse", "--show-object-format"]);
if (authorityObjectFormat !== "sha1" && authorityObjectFormat !== "sha256") {
  refuse("trusted executable authority uses an unsupported Git object format", [authorityObjectFormat]);
}
const trackedAuthorityEntries = readTrackedAuthorityEntries();

// A clean Git status is an authority for tracked source, but not for ignored build output or
// node_modules. Reconstruct the real release tree from immutable HEAD blobs and lockfile-verified
// packages so a concurrent replacement of ignored executable content cannot become the reference
// that an attacker-controlled artifact is compared against. Small synthetic test authorities do
// not have the production build contract; for those, every shipped byte must be tracked instead.
const productionAuthorityMarkers = [
  "package-lock.json",
  "vinci/build.sh",
  "vinci/identity.json",
  "packages/agent/package.json",
  "packages/ai/package.json",
  "packages/coding-agent/package.json",
  "packages/orchestrator/package.json",
  "packages/tui/package.json",
];
const reconstructAuthority = productionAuthorityMarkers.every((path) => trackedAuthorityEntries.has(path));
let reconstructedAuthorityRoot = null;

function checkedCommand(command, args, options, label) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, HUSKY: "0" },
    timeout: 120_000,
    maxBuffer: 100 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    refuse(`trusted executable authority ${label} failed`, [
      `${command} ${args.join(" ")}: ${(result.stderr || result.stdout || "failed").trim()}`,
    ]);
  }
  return result;
}

if (reconstructAuthority) {
  reconstructedAuthorityRoot = realpathSync(mkdtempSync(join(tmpdir(), "vinci-packaged-authority-head-")));
  process.on("exit", () => rmSync(reconstructedAuthorityRoot, { recursive: true, force: true }));
  const archive = checkedCommand(
    "git",
    ["-C", authorityGitRoot, "archive", "--format=tar", initialAuthorityGitIdentity.commit],
    { encoding: "buffer" },
    "Git archive",
  );
  checkedCommand(
    "tar",
    ["-xf", "-", "-C", reconstructedAuthorityRoot],
    { input: archive.stdout },
    "Git archive extraction",
  );
  checkedCommand(
    "npm",
    ["ci", "--offline", "--no-audit", "--no-fund"],
    { cwd: reconstructedAuthorityRoot },
    "locked dependency reconstruction",
  );
  checkedCommand(
    "bash",
    [join(reconstructedAuthorityRoot, "vinci", "build.sh")],
    { cwd: reconstructedAuthorityRoot },
    "build reconstruction",
  );
}
const authorityRoot = reconstructedAuthorityRoot ?? authorityGitRoot;

function gitBlobObject(contents) {
  return createHash(authorityObjectFormat)
    .update(`blob ${contents.length}\0`)
    .update(contents)
    .digest("hex");
}

function relativeToRoot(path) {
  return relative(root, path).split(sep).join("/");
}

function assertInsideRoot(path, label) {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  refuse(`${label} escapes the artifact root`, [path]);
}

// lstat every segment and compare directory entries literally. That makes a case-only typo fail
// on default macOS filesystems too, and prevents a packaged symlink from redirecting a dependency
// walk into the builder's checkout or another repository.
function assertExactRealPath(path, label) {
  assertInsideRoot(path, label);
  const rel = relative(root, path);
  let cursor = root;
  for (const segment of rel.split(sep)) {
    if (!segment || segment === ".") continue;
    if (!readdirSync(cursor).includes(segment)) refuse(`${label} has wrong case or is missing`, [relativeToRoot(path)]);
    cursor = join(cursor, segment);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) refuse(`${label} must not traverse a symlink`, [relativeToRoot(cursor)]);
  }
  return cursor;
}

function readJson(path, label) {
  assertExactRealPath(path, label);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    refuse(`${label} is malformed JSON`, [error.message]);
  }
  return value;
}

const identity = readJson(join(root, "vinci", "identity.json"), "vinci/identity.json");
if (identity?.productName !== "Vinci Code" || identity?.command !== "vinci") {
  refuse("artifact identity is not Vinci Code", ["expected productName=Vinci Code and command=vinci"]);
}

const manifestPath = join(root, "vinci", "dispatch-manifest.json");
const manifest = readJson(manifestPath, "vinci/dispatch-manifest.json");
if (
  !manifest
  || typeof manifest !== "object"
  || Array.isArray(manifest)
  || manifest.schema !== "vinci.node-dispatches/v1"
  || !Array.isArray(manifest.dispatches)
  || manifest.dispatches.length === 0
  || Object.keys(manifest).sort().join(",") !== "dispatches,schema"
) {
  refuse("dispatch manifest has the wrong schema or no dispatches");
}

const commands = new Set();
const nodeTargets = [];
const requiredDispatchCommands = ["report-wrong", "worker"];
for (const [index, entry] of manifest.dispatches.entries()) {
  const label = `dispatches[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) refuse(`${label} must be an object`);
  if (typeof entry.command !== "string" || !/^[a-z][a-z0-9-]*$/.test(entry.command)) {
    refuse(`${label}.command is invalid`);
  }
  if (commands.has(entry.command)) refuse(`duplicate dispatch command ${entry.command}`);
  commands.add(entry.command);
  if (Object.keys(entry).sort().join(",") !== "command,target") refuse(`${label} has unknown or missing fields`);
  if (
    typeof entry.target !== "string"
    || entry.target.length === 0
    || isAbsolute(entry.target)
    || entry.target.split("/").some((part) => part === "" || part === "." || part === "..")
    || !/^[A-Za-z0-9._/-]+$/.test(entry.target)
  ) {
    refuse(`${label}.target must be a normalized relative path inside vinci`);
  }
  nodeTargets.push(entry);
}
const manifestCommands = [...commands].sort();
if (
  manifestCommands.length !== requiredDispatchCommands.length
  || manifestCommands.some((command, index) => command !== requiredDispatchCommands[index])
) {
  refuse("dispatch manifest command set differs from the reviewed launcher gate", [
    `expected ${requiredDispatchCommands.join(", ")}; found ${manifestCommands.join(", ") || "none"}`,
  ]);
}

const launcherPath = assertExactRealPath(join(root, "vinci", "bin", "vinci"), "launcher");
if (!lstatSync(launcherPath).isFile()) refuse("launcher is not a regular file");
const launcherSource = readFileSync(launcherPath, "utf8");
const shell = parse(launcherSource);
const shellCommands = [];
const shellAssignments = [];
const shellCases = [];
const shellErrors = [];
const visitedShellNodes = new WeakSet();
function walkShell(value) {
  if (!value || typeof value !== "object" || visitedShellNodes.has(value)) return;
  visitedShellNodes.add(value);
  if (value.type === "Script" && Array.isArray(value.errors)) shellErrors.push(...value.errors);
  if (value.type === "Command") shellCommands.push(value);
  if (value.type === "Assignment") shellAssignments.push(value);
  if (value.type === "Case") shellCases.push(value);
  if ("parts" in value && Array.isArray(value.parts)) {
    for (const part of value.parts) walkShell(part);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "parts") walkShell(child);
  }
}
walkShell(shell);
if (shellErrors.length > 0) {
  refuse("launcher has malformed or unverifiable Bash syntax", shellErrors.map((error) => error.message));
}

function parameterReferences(word) {
  const references = new Set();
  const visited = new WeakSet();
  function visit(value) {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (value.type === "ParameterExpansion" && typeof value.parameter === "string") {
      references.add(value.parameter);
    } else if (value.type === "SimpleExpansion") {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.text);
      if (match) references.add(match[1]);
    }
    if ("parts" in value && Array.isArray(value.parts)) {
      for (const part of value.parts) visit(part);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "parts") visit(child);
    }
  }
  visit(word);
  return [...references];
}

// Track the complete connected assignment graph around the artifact roots. Both directions matter:
// the real launcher derives VINCI from ROOT and ROOT from SELF, while later aliases derive from any
// of those three. Treating the graph flow-insensitively is intentionally conservative: if a branch
// can make a variable artifact-root-equivalent, it can never become an unreviewed executable target.
const assignmentLinks = new Map();
function linkVariables(left, right) {
  if (!assignmentLinks.has(left)) assignmentLinks.set(left, new Set());
  if (!assignmentLinks.has(right)) assignmentLinks.set(right, new Set());
  assignmentLinks.get(left).add(right);
  assignmentLinks.get(right).add(left);
}
for (const assignment of shellAssignments) {
  if (!assignment.name) continue;
  const words = [assignment.value, ...(assignment.array ?? [])].filter(Boolean);
  for (const word of words) {
    for (const reference of parameterReferences(word)) linkVariables(assignment.name, reference);
  }
}
const reviewedProfileExportCapture = `$(
      set +eu
      set -a
      . "$VINCI_PROFILE_SOURCE" >&2
      set +a
      export -p
    )`;
for (const assignment of shellAssignments) {
  if (assignment.name === "VINCI_PROFILE") {
    if (assignment.value?.value !== "${HOME:-}/.vinci-code.env") {
      refuse("launcher repurposes the reviewed profile path", [assignment.text]);
    }
  } else if (assignment.name === "VINCI_PROFILE_SOURCE") {
    if (assignment.value?.value !== "${VINCI_PROFILE_WRAP:-$VINCI_PROFILE}") {
      refuse("launcher repurposes the reviewed profile source", [assignment.text]);
    }
  } else if (
    assignment.name === "VINCI_PROFILE_EXPORTS"
    && assignment.value?.value !== ""
    && assignment.value?.value !== reviewedProfileExportCapture
  ) {
    refuse("launcher repurposes the reviewed profile eval payload", [assignment.text]);
  }
}
const vinciPathVariables = new Set(["VINCI", "ROOT", "SELF"]);
let addedVariable = true;
while (addedVariable) {
  addedVariable = false;
  for (const variable of [...vinciPathVariables]) {
    for (const linked of assignmentLinks.get(variable) ?? []) {
      if (!vinciPathVariables.has(linked)) {
        vinciPathVariables.add(linked);
        addedVariable = true;
      }
    }
  }
}

const safePathConsumers = new Set([
  "[", "test", "echo", "printf", "sed", "head", "tail", "cat", "cp", "mv", "rm", "chmod",
  "cd", "dirname", "readlink", "basename", "_vinci_updater_version", "_vinci_version_is_newer",
]);
let resolverCalls = 0;
let maintenanceCalls = 0;
let manifestExecs = 0;
let externalExecs = 0;
let profileSyntaxChecks = 0;
let profileSources = 0;
let profileEvals = 0;
function wordsEqual(words, expected) {
  return words.length === expected.length && words.every((word, index) => word?.value === expected[index]);
}
const dispatchGateCases = shellCases.filter((candidate) => {
  if (candidate.word?.value !== "${1:-}" || candidate.items?.length !== 1) return false;
  const item = candidate.items[0];
  const patterns = (item.pattern ?? []).map((pattern) => pattern.value).sort();
  if (
    patterns.length !== requiredDispatchCommands.length
    || patterns.some((pattern, index) => pattern !== requiredDispatchCommands[index])
  ) return false;
  return shellCommands.some((command) => (
    command.pos >= item.body.pos
    && command.end <= item.body.end
    && command.name?.value === "node"
    && wordsEqual(command.suffix, [
      "${VINCI}/scripts/resolve-dispatch.mjs",
      "${VINCI}/dispatch-manifest.json",
      "$1",
    ])
  ));
});
if (dispatchGateCases.length !== 1) {
  refuse("launcher must gate manifest resolution on exactly the reviewed packaged commands", [
    requiredDispatchCommands.join(", "),
  ]);
}
for (const command of shellCommands) {
  const name = command.name?.value;
  const words = [command.name, ...command.suffix].filter(Boolean);
  const detail = `line ${launcherSource.slice(0, command.pos).split("\n").length}: ${launcherSource.slice(command.pos, command.end).trim()}`;
  if (
    name === "node"
    && wordsEqual(command.suffix, [
      "${VINCI}/scripts/reap-heal-temp.mjs",
      "${_vinci_home}/updater",
      "$$",
    ])
  ) {
    maintenanceCalls += 1;
    continue;
  }
  if (
    name === "node"
    && wordsEqual(command.suffix, [
      "${VINCI}/scripts/resolve-dispatch.mjs",
      "${VINCI}/dispatch-manifest.json",
      "$1",
    ])
  ) {
    resolverCalls += 1;
    continue;
  }
  if (name === "node") {
    refuse("launcher contains an unreviewed Node execution form", [detail]);
  }
  if (name === "sh") {
    if (wordsEqual(command.suffix, ["-n", "$VINCI_PROFILE"])) profileSyntaxChecks += 1;
    else refuse("launcher contains an unreviewed shell execution form", [detail]);
    continue;
  }
  if (name === "." || name === "source") {
    if (name === "." && wordsEqual(command.suffix, ["$VINCI_PROFILE_SOURCE"])) profileSources += 1;
    else refuse("launcher contains an unreviewed shell source form", [detail]);
    continue;
  }
  if (name === "eval") {
    if (wordsEqual(command.suffix, ["$VINCI_PROFILE_EXPORTS"])) profileEvals += 1;
    else refuse("launcher contains an unreviewed shell eval form", [detail]);
    continue;
  }
  if (name === "bash" || name === "env") {
    refuse("launcher contains an unreviewed shell execution form", [detail]);
  }
  if (name === "command") {
    if (command.suffix.length === 2 && command.suffix[0]?.value === "-v") continue;
    refuse("launcher contains an unreviewed command wrapper", [detail]);
  }
  if (name?.includes("/")) {
    refuse("launcher contains an unreviewed path executable", [detail]);
  }
  if (name === "exec") {
    if (wordsEqual(command.suffix, ["node", "${VINCI}/${_vinci_dispatch_target}", "$@"])) {
      manifestExecs += 1;
    } else if (wordsEqual(command.suffix, ["${_vinci_vac_cli}", "$@"])) {
      externalExecs += 1;
    } else {
      refuse("launcher contains an unmanifested executable dispatch", [detail]);
    }
    continue;
  }
  const usesVinciPath = words.some((word) => (
    parameterReferences(word).some((variable) => vinciPathVariables.has(variable))
  ));
  if (usesVinciPath && name !== "${PI[@]}" && !safePathConsumers.has(name)) {
    refuse("launcher contains an unmanifested executable dispatch", [detail]);
  }
}
if (
  resolverCalls !== 1
  || maintenanceCalls > 1
  || manifestExecs !== 1
  || externalExecs !== 1
  || profileSyntaxChecks > 1
  || profileSources > 1
  || profileEvals > 1
) {
  refuse("launcher does not contain exactly one reviewed manifest resolver, node exec, and external exec", [
    `resolver=${resolverCalls}, maintenance=${maintenanceCalls}, node-exec=${manifestExecs}, `
      + `external-exec=${externalExecs}, profile-syntax=${profileSyntaxChecks}, `
      + `profile-source=${profileSources}, profile-eval=${profileEvals}`,
  ]);
}

function resolveImportCandidates(base, label) {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    join(base, "index.ts"),
    join(base, "index.js"),
    join(base, "index.mjs"),
    join(base, "index.cjs"),
  ]) {
    if (!existsSync(candidate)) continue;
    assertExactRealPath(candidate, label);
    if (!lstatSync(candidate).isFile()) continue;
    return candidate;
  }
  return null;
}

function resolveImport(file, specifier) {
  const base = resolve(dirname(file), specifier);
  const label = `${relativeToRoot(file)} import ${specifier}`;
  assertInsideRoot(base, label);
  const direct = resolveImportCandidates(base, label);
  if (direct !== null) return direct;
  // A relative directory import (`require("../")`) loads the directory's package.json main.
  const manifestPath = join(base, "package.json");
  if (existsSync(manifestPath) && lstatSync(base).isDirectory() && lstatSync(manifestPath).isFile()) {
    let main;
    try {
      main = JSON.parse(readFileSync(manifestPath, "utf8")).main;
    } catch {
      return null;
    }
    if (typeof main === "string" && main !== "") {
      const mainBase = resolve(base, main);
      assertInsideRoot(mainBase, label);
      return resolveImportCandidates(mainBase, label);
    }
  }
  return null;
}

// Bare resolution depends only on the importing directory, the specifier, and the loader kind, so
// one Node resolution per distinct edge is enough, and every edge of one file resolves in a single
// child process. Binding every shipped package rather than only the five workspaces makes the
// resolver spawn the dominant cost of this check: per-edge spawning took the fixture suite from
// 41s to 138s and timed out unrelated tests.
const bareResolutionCache = new Map();

function bareResolutionCacheKey(file, specifier, isCommonJs) {
  return `${isCommonJs ? "cjs" : "esm"}\0${dirname(file)}\0${specifier}`;
}

// Resolve one file's bare specifiers in a single child. Resolution semantics are identical to the
// per-edge form: the child runs with cwd = the importing file's directory, ESM edges resolve
// through import.meta.resolve from there and CommonJS edges through createRequire(file).resolve.
function resolveBareBatch(file, requests) {
  const expression = "import{createRequire}from'node:module';import{pathToFileURL}from'node:url';"
    + "import{readFileSync}from'node:fs';"
    + "const input=JSON.parse(readFileSync(0,'utf8'));"
    + "const required=createRequire(pathToFileURL(input.file));"
    + "const out=[];"
    + "for(const request of input.requests){"
    + "try{out.push({ok:true,value:request.commonJs?required.resolve(request.specifier)"
    + ":import.meta.resolve(request.specifier)});}catch{out.push({ok:false});}}"
    + "process.stdout.write(JSON.stringify(out));";
  const resolved = spawnSync(process.execPath, ["--input-type=module", "--eval", expression], {
    cwd: dirname(file),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    input: JSON.stringify({ file, requests }),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  if (resolved.status !== 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(resolved.stdout);
  } catch {
    return null;
  }
  return Array.isArray(parsed) && parsed.length === requests.length ? parsed : null;
}

// Populate the cache for every not-yet-resolved edge of one file. A batch that fails for any reason
// (crash, timeout, unparsable output) caches nothing; each edge then falls back to its own child
// process, so a batch failure can never turn an unresolvable edge into a pass.
function primeBareResolutions(file, bareSpecifiers) {
  const requests = [];
  const seen = new Set();
  for (const { specifier, commonJs } of bareSpecifiers) {
    if (isBuiltin(specifier)) continue;
    const key = bareResolutionCacheKey(file, specifier, commonJs);
    if (bareResolutionCache.has(key) || seen.has(key)) continue;
    seen.add(key);
    requests.push({ specifier, commonJs, key });
  }
  if (requests.length === 0) return;
  const results = resolveBareBatch(file, requests);
  if (results === null) return;
  for (const [index, request] of requests.entries()) {
    const result = results[index];
    bareResolutionCache.set(
      request.key,
      result?.ok === true
        ? interpretBareResolution(result.value, request.commonJs)
        : { error: "does not resolve" },
    );
  }
}

function resolveBareSpecifier(file, specifier, isCommonJs) {
  if (isBuiltin(specifier)) return { builtin: true };
  const cacheKey = bareResolutionCacheKey(file, specifier, isCommonJs);
  const cached = bareResolutionCache.get(cacheKey);
  if (cached) return cached;
  const resolution = resolveBareSpecifierUncached(file, specifier, isCommonJs);
  bareResolutionCache.set(cacheKey, resolution);
  return resolution;
}

function resolveBareSpecifierUncached(file, specifier, isCommonJs) {
  const expression = isCommonJs
    ? "import{createRequire}from'node:module';import{pathToFileURL}from'node:url';process.stdout.write(createRequire(pathToFileURL(process.argv[1])).resolve(process.argv[2]))"
    : "process.stdout.write(import.meta.resolve(process.argv[1]))";
  const args = isCommonJs
    ? ["--input-type=module", "--eval", expression, file, specifier]
    : ["--input-type=module", "--eval", expression, specifier];
  const resolved = spawnSync(process.execPath, args, {
    cwd: dirname(file),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    timeout: 5_000,
  });
  if (resolved.status !== 0) return { error: "does not resolve" };
  return interpretBareResolution(resolved.stdout, isCommonJs);
}

function interpretBareResolution(output, isCommonJs) {
  let path = output;
  if (!isCommonJs) {
    if (!path.startsWith("file:")) return { error: `resolves to unsupported URL ${path}` };
    try {
      path = fileURLToPath(path);
    } catch (error) {
      return { error: `has an invalid resolution: ${error.message}` };
    }
  }
  if (!existsSync(path)) return { error: "resolves to a missing file" };
  let canonical;
  try {
    canonical = realpathSync(path);
  } catch (error) {
    return { error: `has no canonical target: ${error.message}` };
  }
  const rel = relative(root, canonical);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    return { error: "resolves outside the artifact root" };
  }
  return { path: canonical };
}

function bareSpecifierPackageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const enclosingManifestCache = new Map();

// The package.json that governs a shipped file is the nearest one at or above its directory inside
// the artifact; null when none is found before the artifact root.
function enclosingPackageManifest(file) {
  let directory = dirname(file);
  const visitedDirectories = [];
  let found = null;
  while (directory === root || directory.startsWith(`${root}${sep}`)) {
    if (enclosingManifestCache.has(directory)) {
      found = enclosingManifestCache.get(directory);
      break;
    }
    visitedDirectories.push(directory);
    const candidate = join(directory, "package.json");
    if (lstatExists(candidate) && lstatSync(candidate).isFile()) {
      try {
        found = JSON.parse(readFileSync(candidate, "utf8"));
      } catch {
        found = null;
      }
      break;
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  for (const visitedDirectory of visitedDirectories) enclosingManifestCache.set(visitedDirectory, found);
  return found && typeof found === "object" ? found : null;
}

// Whether the importing package's own manifest declares the bare target optional: listed under
// optionalDependencies, or a peer dependency marked optional in peerDependenciesMeta.
function isManifestOptionalEdge(file, specifier) {
  const manifest = enclosingPackageManifest(file);
  if (manifest === null) return false;
  const name = bareSpecifierPackageName(specifier);
  const optionalDependencies = manifest.optionalDependencies;
  if (optionalDependencies && typeof optionalDependencies === "object" && name in optionalDependencies) return true;
  const peerMeta = manifest.peerDependenciesMeta;
  return Boolean(peerMeta && typeof peerMeta === "object" && peerMeta[name]?.optional === true);
}

// Whether a load expression sits lexically inside a try block (not its catch or finally clause).
function isTryGuarded(node) {
  let cursor = node;
  while (cursor.parent) {
    if (ts.isTryStatement(cursor.parent) && cursor.parent.tryBlock === cursor) return true;
    cursor = cursor.parent;
  }
  return false;
}

// Node's default resolution conditions for a plain `node` process (the launcher passes no
// --conditions). Targets reachable only under other conditions ("source", "types", "browser",
// "development", ...) are never loaded by the shipped launcher; they are existence-checked but not
// traversed as executable entry points.
const nodeDefaultConditions = new Set(["node", "import", "require", "default", "module-sync", "node-addons"]);

function checkGraph(entryFiles, label, { strict = true, bindBare = false } = {}) {
  const queue = [...entryFiles];
  const visited = new Set();
  const failures = [];
  let imports = 0;
  let optionalAbsent = 0;
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    if (strict && source.includes("\uFFFD")) {
      failures.push(`${relativeToRoot(file)} is not valid UTF-8`);
      continue;
    }
    const extension = file.includes(".") ? file.slice(file.lastIndexOf(".")) : "";
    const isCommonJs = extension === ".cjs";
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      extension === ".ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    if ((sourceFile.parseDiagnostics ?? []).length > 0) {
      failures.push(`${relativeToRoot(file)} has malformed executable module syntax`);
      continue;
    }
    const specifiers = [];
    const bareSpecifiers = [];
    function addFailure(message) {
      failures.push(`${relativeToRoot(file)} ${message}`);
    }
    function addModuleSpecifier(node, moduleSpecifier) {
      if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) {
        addFailure("uses a non-literal module specifier");
        return;
      }
      if (strict && (moduleSpecifier.text === "module" || moduleSpecifier.text === "node:module")) {
        addFailure("imports Node module-loader authority; the static artifact proof refuses it");
      } else if (moduleSpecifier.text.startsWith(".")) {
        specifiers.push({ specifier: moduleSpecifier.text, guarded: false });
      } else if (bindBare) {
        bareSpecifiers.push({ specifier: moduleSpecifier.text, commonJs: false, guarded: false });
      }
    }
    const constantCandidates = new Map();
    const reassignedConstants = new Set();
    function collectConstantCandidates(node) {
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
        && ts.isVariableDeclarationList(node.parent)
        && (node.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        if (constantCandidates.has(node.name.text)) reassignedConstants.add(node.name.text);
        else constantCandidates.set(node.name.text, node.initializer);
      } else if (
        ts.isBinaryExpression(node)
        && ts.isIdentifier(node.left)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        reassignedConstants.add(node.left.text);
      }
      ts.forEachChild(node, collectConstantCandidates);
    }
    collectConstantCandidates(sourceFile);
    for (const name of reassignedConstants) constantCandidates.delete(name);
    const constantStrings = new Map();
    function staticPropertyName(node) {
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isIdentifier(node)) return constantStrings.get(node.text) ?? null;
      if (ts.isParenthesizedExpression(node)) return staticPropertyName(node.expression);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = staticPropertyName(node.left);
        const right = staticPropertyName(node.right);
        return left === null || right === null ? null : left + right;
      }
      if (ts.isTemplateExpression(node)) {
        let value = node.head.text;
        for (const span of node.templateSpans) {
          const expression = staticPropertyName(span.expression);
          if (expression === null) return null;
          value += expression + span.literal.text;
        }
        return value;
      }
      return null;
    }
    let addedConstant = true;
    while (addedConstant) {
      addedConstant = false;
      for (const [name, initializer] of constantCandidates) {
        if (constantStrings.has(name)) continue;
        const value = staticPropertyName(initializer);
        if (value !== null) {
          constantStrings.set(name, value);
          addedConstant = true;
        }
      }
    }
    function hasExportModifier(node) {
      return node.modifiers?.some((modifier) => (
        modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword
      )) ?? false;
    }
    function isAllowedCommonJsModuleReference(node) {
      return isCommonJs
        && ts.isPropertyAccessExpression(node.parent)
        && node.parent.expression === node
        && node.parent.name.text === "exports";
    }
    function visit(node) {
      if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
        if (isCommonJs) addFailure("uses ESM import/export syntax in a .cjs module");
        addModuleSpecifier(node, node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node) || ts.isExportAssignment(node) || hasExportModifier(node)) {
        if (isCommonJs) addFailure("uses ESM export syntax in a .cjs module");
      } else if (ts.isImportEqualsDeclaration(node)) {
        addFailure("uses runtime import-equals loading; the static artifact proof refuses it");
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (strict) {
            addFailure("uses dynamic/runtime module loading; the static artifact proof refuses it");
          } else if (node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
            const guarded = isTryGuarded(node);
            if (node.arguments[0].text.startsWith(".")) specifiers.push({ specifier: node.arguments[0].text, guarded });
            else if (bindBare) bareSpecifiers.push({ specifier: node.arguments[0].text, commonJs: false, guarded });
          }
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          if (!isCommonJs && strict) {
            addFailure("uses a CommonJS loader in an ESM module");
          } else if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
            if (strict) addFailure("uses dynamic/runtime module loading; the static artifact proof refuses it");
          } else if (strict && (node.arguments[0].text === "module" || node.arguments[0].text === "node:module")) {
            addFailure("loads Node module-loader authority; the static artifact proof refuses it");
          } else if (node.arguments[0].text.startsWith(".")) {
            specifiers.push({ specifier: node.arguments[0].text, guarded: isTryGuarded(node) });
          } else if (bindBare) {
            bareSpecifiers.push({ specifier: node.arguments[0].text, commonJs: true, guarded: isTryGuarded(node) });
          }
        }
      } else if (strict && ts.isIdentifier(node) && (node.text === "eval" || node.text === "Function")) {
        addFailure("references a dynamic code loader; the static artifact proof refuses it");
      } else if (strict && (
        ts.isIdentifier(node)
        && (node.text === "require" || node.text === "createRequire")
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node && node.text === "require")
      )) {
        addFailure("aliases a runtime module loader; the static artifact proof refuses it");
      } else if (strict && ts.isIdentifier(node) && node.text === "module" && !isAllowedCommonJsModuleReference(node)) {
        addFailure("uses module through an unverifiable runtime access");
      } else if (strict && (
        (
          ts.isPropertyAccessExpression(node)
          && [
            "require", "_load", "createRequire", "eval", "Function", "constructor",
            "getBuiltinModule", "mainModule",
          ].includes(node.name.text)
        )
        || (
          ts.isElementAccessExpression(node)
          && [
            "require", "_load", "createRequire", "eval", "Function", "constructor",
            "getBuiltinModule", "mainModule",
          ].includes(
            staticPropertyName(node.argumentExpression),
          )
        )
      )) {
        addFailure("aliases a runtime module loader; the static artifact proof refuses it");
      } else if (strict && (
        ts.isElementAccessExpression(node)
        && ts.isIdentifier(node.expression)
        && ["Module", "module", "global", "globalThis"].includes(node.expression.text)
      )) {
        addFailure("uses computed runtime access that the static artifact proof cannot verify");
      } else if (strict && (
        !isCommonJs
        && ts.isIdentifier(node)
        && (node.text === "exports" || node.text === "module")
      )) {
        addFailure("uses CommonJS globals in an ESM module");
      } else if (strict && (
        isCommonJs
        && ts.isMetaProperty(node)
        && node.keywordToken === ts.SyntaxKind.ImportKeyword
      )) {
        addFailure("uses import.meta in a .cjs module");
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    for (const { specifier, guarded } of specifiers) {
      imports += 1;
      const dependency = resolveImport(file, specifier);
      if (dependency) {
        if (/\.(?:cjs|js|mjs|ts)$/.test(dependency)) queue.push(dependency);
        continue;
      }
      // A relative target cannot leave the artifact (assertInsideRoot refuses escapes), so its
      // absence is a runtime-integrity signal, not a parent-directory edge. In the non-strict
      // package entry graph a load the author wrapped in try/catch (platform-specific native
      // binaries, WASI fallbacks) is a declared optional; everywhere else it is a missing edge.
      if (!strict && guarded) {
        optionalAbsent += 1;
        continue;
      }
      failures.push(`${relativeToRoot(file)} -> ${specifier}`);
    }
    primeBareResolutions(file, bareSpecifiers);
    for (const { specifier, commonJs, guarded } of bareSpecifiers) {
      imports += 1;
      const resolution = resolveBareSpecifier(file, specifier, commonJs);
      if (!resolution.error) {
        // Bind AND traverse: a file reached through a bare edge (a deep subpath of a legacy package
        // without an exports map, for instance) has its own bare imports, and they are only closed
        // if it is walked like any other reachable module.
        if (resolution.path && /\.(?:cjs|js|mjs|ts)$/.test(resolution.path)) queue.push(resolution.path);
        continue;
      }
      // An edge that resolves anywhere but inside the artifact is the hostile-parent case and is
      // refused regardless of how the importing package describes it. An edge that resolves
      // nowhere is tolerated only when the importing package declares it optional, by manifest
      // (optionalDependencies, peerDependenciesMeta.optional) or by guarding the load with
      // try/catch; an undeclared, unguarded, absent dependency is a missing edge.
      if (
        resolution.error === "does not resolve"
        && (guarded || isManifestOptionalEdge(file, specifier))
      ) {
        optionalAbsent += 1;
        continue;
      }
      failures.push(`${relativeToRoot(file)} -> ${specifier} ${resolution.error}`);
    }
  }
  if (failures.length > 0) refuse(`${label} has ${failures.length} unverifiable dependency edge(s)`, failures);
  return { files: visited.size, imports, optionalAbsent, paths: visited };
}

const extensionsRoot = assertExactRealPath(join(root, "vinci", "extensions"), "vinci/extensions");
if (!lstatSync(extensionsRoot).isDirectory()) refuse("vinci/extensions is not a directory");
const extensionEntries = [];
function collectSources(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) refuse("extension tree contains a symlink", [relativeToRoot(path)]);
    if (stat.isDirectory()) {
      if (entry !== "node_modules") collectSources(path);
    } else if (/\.(?:ts|cjs|mjs|js)$/.test(entry)) {
      extensionEntries.push(path);
    }
  }
}
collectSources(extensionsRoot);
const extensionGraph = checkGraph(extensionEntries, "shipped extension graph");

const resolverPath = assertExactRealPath(
  join(root, "vinci", "scripts", "resolve-dispatch.mjs"),
  "launcher manifest resolver",
);
if (!lstatSync(resolverPath).isFile()) refuse("launcher manifest resolver is not a regular file");
const maintenanceEntries = [];
if (maintenanceCalls === 1) {
  const maintenancePath = assertExactRealPath(
    join(root, "vinci", "scripts", "reap-heal-temp.mjs"),
    "launcher maintenance helper",
  );
  if (!lstatSync(maintenancePath).isFile()) refuse("launcher maintenance helper is not a regular file");
  maintenanceEntries.push(maintenancePath);
}
const dispatchEntries = [resolverPath, ...maintenanceEntries, ...nodeTargets.map((entry) => {
  const path = assertExactRealPath(join(root, "vinci", ...entry.target.split("/")), `dispatch target ${entry.command}`);
  if (!lstatSync(path).isFile()) refuse(`dispatch target ${entry.command} is not a regular file`);
  return path;
})];
const dispatchGraph = checkGraph(dispatchEntries, "launcher dispatch graph");
const reviewedExecutablePaths = new Set(
  [...dispatchGraph.paths, ...extensionGraph.paths].map((path) => relativeToRoot(path)),
);

// The parser checks above provide useful, local diagnostics for malformed launchers and dependency
// graphs. They are not the trust boundary: shell and JavaScript both expose many equivalent ways to
// acquire execution authority (PATH shadowing, command composers, reflection, VM contexts, workers,
// and child processes). Trying to enumerate every spelling is an open denylist and has repeatedly
// produced false certifications.
//
// Close that class of bug by binding every file and symlink that actually shipped to the trusted
// build tree that is running this checker. An artifact may contain only byte-identical source/build
// outputs at the same paths; an extra loader, a changed launcher, a rewritten package.json, or a
// modified dependency therefore fails independently of which runtime primitive reaches it. Missing
// required entry points and dependency edges are still diagnosed by the structural checks above.
function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const authorityFailures = [];
let authorityFiles = 0;
let authorityLinks = 0;
let requiredAuthorityEntries = 0;
const artifactPackageManifests = [];
const packageEntryFiles = new Set();

function containedCanonicalRelative(base, path, label) {
  let canonical;
  try {
    canonical = realpathSync(path);
  } catch (error) {
    authorityFailures.push(`${label} has no resolvable canonical target: ${error.message}`);
    return null;
  }
  const rel = relative(base, canonical);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    return rel.split(sep).join("/");
  }
  authorityFailures.push(`${label} resolves outside its root`);
  return null;
}

function isPackageRootManifest(relativePath) {
  if (relativePath === "package.json" || /^packages\/[^/]+\/package\.json$/.test(relativePath)) return true;
  const parts = relativePath.split("/");
  const nodeModules = parts.lastIndexOf("node_modules");
  if (nodeModules === -1 || parts.at(-1) !== "package.json") return false;
  const packageParts = parts.slice(nodeModules + 1, -1);
  return packageParts.length === 1 || (packageParts.length === 2 && packageParts[0].startsWith("@"));
}

function compareAuthorityDirectory(artifactDirectory, relativeDirectory = "") {
  for (const entry of readdirSync(artifactDirectory).sort()) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
    const artifactPath = join(artifactDirectory, entry);
    if (!isAllowedReleasePath(relativePath)) {
      authorityFailures.push(`${relativePath} is outside the calculated production release surface`);
      continue;
    }
    if (belongsToExcludedPackage(relativePath)) {
      authorityFailures.push(`${relativePath} belongs to a package outside the production runtime closure`);
      continue;
    }
    const trusted = authoritySnapshot.get(relativePath);
    if (!trusted) {
      authorityFailures.push(`${relativePath} is not present in the trusted executable authority`);
      continue;
    }
    const artifactStat = lstatSync(artifactPath);
    if (artifactStat.isDirectory()) {
      if (trusted.type !== "directory") {
        authorityFailures.push(`${relativePath} differs in type from the trusted executable authority`);
      } else {
        compareAuthorityDirectory(artifactPath, relativePath);
      }
    } else if (artifactStat.isSymbolicLink()) {
      authorityLinks += 1;
      if (trusted.type !== "symlink" || readlinkSync(artifactPath) !== trusted.link) {
        authorityFailures.push(`${relativePath} differs from the trusted executable authority`);
      } else {
        const artifactTarget = containedCanonicalRelative(root, artifactPath, `${relativePath} artifact symlink`);
        if (artifactTarget !== null && trusted.canonical !== null && artifactTarget !== trusted.canonical) {
          authorityFailures.push(`${relativePath} symlink resolves to a different trusted path`);
        }
      }
    } else if (artifactStat.isFile()) {
      authorityFiles += 1;
      if (isPackageRootManifest(relativePath)) {
        artifactPackageManifests.push(artifactPath);
      }
      if (
        trusted.type !== "file"
        || artifactStat.nlink !== 1
        || trusted.nlink !== 1
        || (artifactStat.mode & 0o111) !== trusted.executableMode
        || artifactStat.size !== trusted.size
        || fileDigest(artifactPath) !== trusted.digest
      ) {
        authorityFailures.push(`${relativePath} differs from the trusted executable authority`);
      }
    } else {
      authorityFailures.push(`${relativePath} has an unsupported artifact file type`);
    }
  }
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// Completeness is the other half of source authority. Node searches parent directories when a bare
// dependency is absent, so comparing only files present in the payload lets an omitted dependency
// resolve to attacker-controlled code above the install root. Derive the required release surface
// from the trusted package layout and lockfile, then require every selected file and symlink. This is
// package-wide closure: no dependency name is singled out, and nested runtime packages are covered.
const releaseAuthorityRoots = [
  "package.json",
  "node_modules",
  "packages/agent/dist",
  "packages/agent/package.json",
  "packages/ai/dist",
  "packages/ai/package.json",
  "packages/coding-agent/dist",
  "packages/coding-agent/package.json",
  "packages/orchestrator/dist",
  "packages/orchestrator/package.json",
  "packages/tui/dist",
  "packages/tui/package.json",
  "vinci/bin",
  "vinci/extensions",
  "vinci/themes",
  "vinci/assets",
  "vinci/updater",
  "vinci/worker",
  "vinci/scripts/report-wrong.mjs",
  "vinci/scripts/reap-heal-temp.mjs",
  "vinci/scripts/resolve-dispatch.mjs",
  "vinci/dispatch-manifest.json",
  "vinci/identity.json",
  "vinci/NOTICE",
];
const packageLockPath = join(authorityRoot, "package-lock.json");
const runtimePackageExclusions = lstatExists(packageLockPath)
  ? new Set(runtimePackageExcludes(authorityRoot))
  : null;

function belongsToExcludedPackage(relativePath) {
  if (runtimePackageExclusions === null) return false;
  let cursor = relativePath;
  while (cursor) {
    if (runtimePackageExclusions.has(cursor)) return true;
    const slash = cursor.lastIndexOf("/");
    if (slash === -1) return false;
    cursor = cursor.slice(0, slash);
  }
  return false;
}

function excludedFromReleaseAuthority(relativePath) {
  if (
    /\.map$/.test(relativePath)
    || relativePath === "vinci/worker/README.md"
    || relativePath === "node_modules/.package-lock.json"
  ) return true;
  const nestedPath = `/${relativePath}`;
  if (/\/node_modules\/(?:\.cache|\.vite|\.bin)(?:\/|$)/.test(nestedPath)) return true;
  if (/\/node_modules\/ssh2\/test(?:\/|$)/.test(nestedPath)) return true;
  return belongsToExcludedPackage(relativePath);
}

function isAllowedReleasePath(relativePath) {
  return [...releaseAuthorityRoots, ...reviewedExecutablePaths].some((releaseRoot) => (
    relativePath === releaseRoot
    || relativePath.startsWith(`${releaseRoot}/`)
    || releaseRoot.startsWith(`${relativePath}/`)
  ));
}

const authoritySnapshot = new Map();

function requiresGitHeadBinding(relativePath) {
  return !reconstructAuthority;
}

function snapshotAuthorityEntry(relativePath) {
  if (!isAllowedReleasePath(relativePath) || excludedFromReleaseAuthority(relativePath)) return;
  const trustedPath = join(authorityRoot, ...relativePath.split("/"));
  if (!lstatExists(trustedPath)) return;
  const before = lstatSync(trustedPath);
  if (before.isDirectory() && !before.isSymbolicLink()) {
    const children = readdirSync(trustedPath).sort();
    authoritySnapshot.set(relativePath, { type: "directory", children });
    for (const entry of children) snapshotAuthorityEntry(`${relativePath}/${entry}`);
  } else if (before.isSymbolicLink()) {
    const link = readlinkSync(trustedPath);
    const tracked = trackedAuthorityEntries.get(relativePath);
    if (!tracked && requiresGitHeadBinding(relativePath)) {
      authorityFailures.push(`${relativePath} authority symlink is not tracked by Git HEAD`);
    }
    if (tracked && (tracked.mode !== "120000" || tracked.type !== "blob" || gitBlobObject(Buffer.from(link)) !== tracked.object)) {
      authorityFailures.push(`${relativePath} authority symlink does not match Git HEAD`);
    }
    authoritySnapshot.set(relativePath, {
      type: "symlink",
      link,
      canonical: containedCanonicalRelative(authorityRoot, trustedPath, `${relativePath} authority symlink`),
    });
  } else if (before.isFile()) {
    const contents = readFileSync(trustedPath);
    const digest = createHash("sha256").update(contents).digest("hex");
    const after = lstatSync(trustedPath);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      authorityFailures.push(`${relativePath} changed while the trusted authority snapshot was captured`);
    }
    const tracked = trackedAuthorityEntries.get(relativePath);
    const expectedGitMode = (before.mode & 0o111) === 0 ? "100644" : "100755";
    if (!tracked && requiresGitHeadBinding(relativePath)) {
      authorityFailures.push(`${relativePath} authority file is not tracked by Git HEAD`);
    }
    if (
      tracked
      && (
        tracked.mode !== expectedGitMode
        || tracked.type !== "blob"
        || gitBlobObject(contents) !== tracked.object
      )
    ) {
      authorityFailures.push(`${relativePath} authority file does not match Git HEAD`);
    }
    authoritySnapshot.set(relativePath, {
      type: "file",
      digest,
      executableMode: before.mode & 0o111,
      nlink: before.nlink,
      size: before.size,
    });
  }
}

for (const relativePath of new Set(releaseAuthorityRoots.map((path) => path.split("/")[0]))) {
  snapshotAuthorityEntry(relativePath);
}

function requireAuthorityEntry(relativePath) {
  if (excludedFromReleaseAuthority(relativePath)) return;
  const trusted = authoritySnapshot.get(relativePath);
  if (!trusted) {
    authorityFailures.push(`${relativePath} is absent from the trusted package layout`);
    return;
  }
  if (trusted.type === "directory") {
    for (const entry of trusted.children) {
      requireAuthorityEntry(`${relativePath}/${entry}`);
    }
    return;
  }
  requiredAuthorityEntries += 1;
  const artifactPath = join(root, ...relativePath.split("/"));
  if (!lstatExists(artifactPath)) {
    authorityFailures.push(`${relativePath} required by the trusted package layout is missing`);
  }
}

compareAuthorityDirectory(root);

function collectConditionalTargets(value, label, targets, nodeResolvable = true) {
  if (value === null) return;
  if (typeof value === "string") {
    targets.push({ label, target: value, nodeResolvable });
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      collectConditionalTargets(entry, `${label}[${index}]`, targets, nodeResolvable);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      // Keys starting with "." (exports subpaths) or "#" (imports specifiers) name entry points;
      // every other key is a resolution condition that only applies when Node evaluates it.
      const isCondition = !key.startsWith(".") && !key.startsWith("#");
      collectConditionalTargets(
        entry,
        `${label}.${key}`,
        targets,
        nodeResolvable && (!isCondition || nodeDefaultConditions.has(key)),
      );
    }
    return;
  }
  authorityFailures.push(`${label} has an invalid package entry target`);
}

function wildcardTargetPattern(target) {
  let source = "^";
  let captures = 0;
  for (const character of target) {
    if (character === "*") {
      source += captures === 0 ? "(.+)" : "\\1";
      captures += 1;
    } else {
      source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function concreteWildcardTargets(packageRoot, normalized) {
  const pattern = wildcardTargetPattern(normalized);
  const matches = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(path);
      else if (stat.isFile() || stat.isSymbolicLink()) {
        const packageRelative = relative(packageRoot, path).split(sep).join("/");
        if (pattern.test(packageRelative)) matches.push(path);
      }
    }
  };
  visit(packageRoot);
  return matches;
}

function isExecutablePackageEntry(path) {
  const name = basename(path);
  if (/\.d\.(?:cts|mts|ts)$/.test(name)) return false;
  const extension = extname(name);
  return extension === "" || [".cjs", ".js", ".mjs", ".ts"].includes(extension);
}

function validatePackageManifest(manifestPath) {
  const relativeManifest = relativeToRoot(manifestPath);
  const packageRoot = dirname(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    authorityFailures.push(`${relativeManifest} is malformed JSON: ${error.message}`);
    return;
  }
  const targets = [];
  if (manifest.main !== undefined) {
    if (typeof manifest.main === "string") {
      targets.push({ label: "main", target: manifest.main, legacy: true, resolveLegacy: true });
    }
    else authorityFailures.push(`${relativeManifest} main has the wrong type`);
  }
  if (manifest.bin !== undefined) {
    if (typeof manifest.bin === "string") targets.push({ label: "bin", target: manifest.bin, legacy: true });
    else if (manifest.bin && typeof manifest.bin === "object" && !Array.isArray(manifest.bin)) {
      for (const [name, target] of Object.entries(manifest.bin)) {
        if (typeof target === "string") targets.push({ label: `bin.${name}`, target, legacy: true });
        else authorityFailures.push(`${relativeManifest} bin.${name} has the wrong type`);
      }
    } else authorityFailures.push(`${relativeManifest} bin has the wrong type`);
  }
  if (manifest.imports !== undefined) collectConditionalTargets(manifest.imports, "imports", targets);
  if (manifest.exports !== undefined) collectConditionalTargets(manifest.exports, "exports", targets);

  for (const { label, target, legacy = false, resolveLegacy = false, nodeResolvable = true } of targets) {
    if (!legacy && !target.startsWith("./")) {
      if (label.startsWith("imports")) {
        const resolution = resolveBareSpecifier(manifestPath, target, false);
        if (resolution.error) {
          authorityFailures.push(`${relativeManifest} ${label} external target ${target} ${resolution.error}`);
        } else if (nodeResolvable && resolution.path && isExecutablePackageEntry(resolution.path)) {
          packageEntryFiles.add(resolution.path);
        }
        continue;
      }
      authorityFailures.push(`${relativeManifest} ${label} target ${target} is not package-relative`);
      continue;
    }
    const normalized = target.startsWith("./") ? target.slice(2) : target;
    if (isAbsolute(normalized) || normalized.split("/").some((part) => part === "." || part === "..")) {
      authorityFailures.push(`${relativeManifest} ${label} target ${target} escapes or is not normalized`);
      continue;
    }
    if (normalized.includes("*")) {
      // Expand the open caller substitution over the finite shipped package. Every concrete
      // executable target is an entry point and must have its complete static import graph bound.
      for (const targetPath of concreteWildcardTargets(packageRoot, normalized)) {
        const canonical = containedCanonicalRelative(
          root,
          targetPath,
          `${relativeManifest} ${label} wildcard target ${target}`,
        );
        if (nodeResolvable && canonical !== null && isExecutablePackageEntry(canonical)) {
          packageEntryFiles.add(join(root, ...canonical.split("/")));
        }
      }
      continue;
    }
    let targetPath = join(packageRoot, ...normalized.split("/"));
    if (resolveLegacy) {
      try {
        targetPath = createRequire(manifestPath).resolve(targetPath);
      } catch {
        // Preserve the literal path so the ordinary missing/non-file diagnostic below owns refusal.
      }
    }
    if (legacy && !lstatExists(targetPath)) {
      targetPath = [".js", ".json", ".node"].map((extension) => `${targetPath}${extension}`).find(lstatExists)
        ?? targetPath;
    }
    if (!lstatExists(targetPath)) {
      authorityFailures.push(`${relativeManifest} ${label} target ${target} is missing`);
      continue;
    }
    const canonical = containedCanonicalRelative(root, targetPath, `${relativeManifest} ${label} target ${target}`);
    // A target that exists but is not a regular file (a legacy folder mapping such as "./lib/",
    // or an empty main) is not something Node's exports/imports resolution can load: folder
    // mappings were removed in Node 17, and a legacy main directory has already been resolved to
    // its concrete entry above. Nothing executable hides behind it, so it is neither traversed
    // nor refused; a target escaping the artifact was refused by containedCanonicalRelative.
    if (canonical === null || !lstatSync(join(root, ...canonical.split("/"))).isFile()) continue;
    if (nodeResolvable && isExecutablePackageEntry(canonical)) {
      packageEntryFiles.add(join(root, ...canonical.split("/")));
    }
  }
}

for (const manifestPath of artifactPackageManifests) validatePackageManifest(manifestPath);
const packageEntryGraph = checkGraph(packageEntryFiles, "package entry graph", { strict: false, bindBare: true });
if (runtimePackageExclusions === null) {
  for (const relativePath of authoritySnapshot.keys()) {
    if (!relativePath.includes("/")) requireAuthorityEntry(relativePath);
  }
} else {
  for (const relativePath of releaseAuthorityRoots) requireAuthorityEntry(relativePath);
}
if (authorityFailures.length > 0) {
  const visible = authorityFailures.slice(0, 32);
  if (authorityFailures.length > visible.length) {
    visible.push(`… ${authorityFailures.length - visible.length} more authority mismatch(es)`);
  }
  refuse(`artifact violates the closed executable authority (${authorityFailures.length} mismatch(es))`, visible);
}

const finalAuthorityGitIdentity = readAuthorityGitIdentity();
if (
  finalAuthorityGitIdentity.commit !== initialAuthorityGitIdentity.commit
  || finalAuthorityGitIdentity.tree !== initialAuthorityGitIdentity.tree
  || finalAuthorityGitIdentity.remote !== initialAuthorityGitIdentity.remote
) {
  refuse("trusted executable authority identity changed during verification", [
    `before ${initialAuthorityGitIdentity.commit}/${initialAuthorityGitIdentity.tree}`,
    `after ${finalAuthorityGitIdentity.commit}/${finalAuthorityGitIdentity.tree}`,
  ]);
}

console.log(
  `  ✓ packaged artifact: ${manifest.dispatches.length} manifest-driven launcher dispatches; `
  + `${dispatchGraph.files} dispatch files/${dispatchGraph.imports} imports and `
  + `${extensionGraph.files} extension files/${extensionGraph.imports} imports resolve inside the tarball; `
  + `${packageEntryGraph.files} package entry files/${packageEntryGraph.imports} imports bind inside the tarball `
  + `(${packageEntryGraph.optionalAbsent} declared-optional edge(s) absent everywhere); `
  + `${authorityFiles} files/${authorityLinks} links match the closed executable authority; `
  + `${requiredAuthorityEntries} required entries close parent-directory dependency resolution`,
);
