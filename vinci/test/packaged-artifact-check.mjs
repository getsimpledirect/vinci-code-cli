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
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  || manifest.schema !== "vinci.launcher-dispatches/v1"
  || !Array.isArray(manifest.dispatches)
  || manifest.dispatches.length === 0
  || Object.keys(manifest).sort().join(",") !== "dispatches,schema"
) {
  refuse("dispatch manifest has the wrong schema or no dispatches");
}

const commands = new Set();
const nodeTargets = [];
for (const [index, entry] of manifest.dispatches.entries()) {
  const label = `dispatches[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) refuse(`${label} must be an object`);
  if (typeof entry.command !== "string" || !/^[a-z][a-z0-9-]*$/.test(entry.command)) {
    refuse(`${label}.command is invalid`);
  }
  if (commands.has(entry.command)) refuse(`duplicate dispatch command ${entry.command}`);
  commands.add(entry.command);
  if (entry.kind === "node") {
    if (Object.keys(entry).sort().join(",") !== "command,kind,target") refuse(`${label} has unknown or missing fields`);
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
  } else if (entry.kind === "external") {
    if (Object.keys(entry).sort().join(",") !== "command,kind,targetVariable") refuse(`${label} has unknown or missing fields`);
    if (entry.targetVariable !== "_vinci_vac_cli" || entry.command !== "verify") {
      refuse(`${label} is not the reviewed external verification dispatch`);
    }
  } else {
    refuse(`${label}.kind must be node or external`);
  }
}

const launcherPath = assertExactRealPath(join(root, "vinci", "bin", "vinci"), "launcher");
if (!lstatSync(launcherPath).isFile()) refuse("launcher is not a regular file");
const launcherLines = readFileSync(launcherPath, "utf8").split("\n");
const seenMarkers = new Set();
let pendingMarker = null;

function expectedExec(entry) {
  return entry.kind === "node"
    ? `exec node "\${VINCI}/${entry.target}" "$@"`
    : `exec "\${${entry.targetVariable}}" "$@"`;
}

for (const [index, raw] of launcherLines.entries()) {
  const line = raw.trim();
  const marker = line.match(/^# vinci-dispatch: ([a-z][a-z0-9-]*)$/);
  if (marker) {
    if (pendingMarker) refuse(`dispatch marker ${pendingMarker} is not followed immediately by its exec`);
    pendingMarker = marker[1];
    continue;
  }
  if (!line || line.startsWith("#")) continue;
  const containsExec = /(^|[;&|()\s])exec([;&|()\s]|$)/.test(line);
  if (pendingMarker) {
    const entry = manifest.dispatches.find((candidate) => candidate.command === pendingMarker);
    if (!entry) refuse(`launcher marker ${pendingMarker} is absent from the dispatch manifest`);
    if (line !== expectedExec(entry)) {
      refuse(`launcher dispatch ${pendingMarker} does not use its exact reviewed exec`, [`line ${index + 1}: ${line}`]);
    }
    if (seenMarkers.has(pendingMarker)) refuse(`duplicate launcher dispatch marker ${pendingMarker}`);
    seenMarkers.add(pendingMarker);
    pendingMarker = null;
    continue;
  }
  // Reject every unmarked exec, regardless of whether it spells Node as `node`, `/usr/bin/node`,
  // an environment variable, or a split/partial replacement. A new dispatch cannot silently fall
  // outside discovery: it must be added to the manifest and use the canonical marked form.
  if (containsExec) refuse("launcher contains an unmanifested exec", [`line ${index + 1}: ${line}`]);
}
if (pendingMarker) refuse(`dispatch marker ${pendingMarker} has no exec`);
const missingMarkers = manifest.dispatches.filter((entry) => !seenMarkers.has(entry.command)).map((entry) => entry.command);
if (missingMarkers.length > 0) refuse("dispatch manifest entries are not reachable from the launcher", missingMarkers);

const STATIC_FROM = /(?:^|[;\n])\s*(?:import|export)\s+[^;]*?\sfrom\s+["'](\.[^"']+)["']/g;
const SIDE_EFFECT_IMPORT = /(?:^|[;\n])\s*import\s+["'](\.[^"']+)["']/g;
const DYNAMIC_LOAD = /\b(?:import|require)\s*\(|\bcreateRequire\b|\bModule\s*\.\s*_load\b/;

function resolveImport(file, specifier) {
  const base = resolve(dirname(file), specifier);
  assertInsideRoot(base, `${relativeToRoot(file)} import ${specifier}`);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.json`,
    join(base, "index.ts"),
    join(base, "index.js"),
    join(base, "index.mjs"),
  ]) {
    if (!existsSync(candidate)) continue;
    assertExactRealPath(candidate, `${relativeToRoot(file)} import ${specifier}`);
    if (!lstatSync(candidate).isFile()) continue;
    return candidate;
  }
  return null;
}

function checkGraph(entryFiles, label) {
  const queue = [...entryFiles];
  const visited = new Set();
  const failures = [];
  let imports = 0;
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    const codeWithoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (DYNAMIC_LOAD.test(codeWithoutComments)) {
      failures.push(`${relativeToRoot(file)} uses dynamic/runtime module loading; the static artifact proof refuses it`);
    }
    const specifiers = [
      ...codeWithoutComments.matchAll(STATIC_FROM),
      ...codeWithoutComments.matchAll(SIDE_EFFECT_IMPORT),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      imports += 1;
      const dependency = resolveImport(file, specifier);
      if (!dependency) failures.push(`${relativeToRoot(file)} -> ${specifier}`);
      else if (/\.(?:js|mjs|ts)$/.test(dependency)) queue.push(dependency);
    }
  }
  if (failures.length > 0) refuse(`${label} has ${failures.length} unverifiable dependency edge(s)`, failures);
  return { files: visited.size, imports };
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
    } else if (/\.(?:ts|mjs|js)$/.test(entry)) {
      extensionEntries.push(path);
    }
  }
}
collectSources(extensionsRoot);
const extensionGraph = checkGraph(extensionEntries, "shipped extension graph");

const dispatchEntries = nodeTargets.map((entry) => {
  const path = assertExactRealPath(join(root, "vinci", ...entry.target.split("/")), `dispatch target ${entry.command}`);
  if (!lstatSync(path).isFile()) refuse(`dispatch target ${entry.command} is not a regular file`);
  return path;
});
const dispatchGraph = checkGraph(dispatchEntries, "launcher dispatch graph");

console.log(
  `  ✓ packaged artifact: ${manifest.dispatches.length} manifest-bound launcher dispatches; `
  + `${dispatchGraph.files} dispatch files/${dispatchGraph.imports} imports and `
  + `${extensionGraph.files} extension files/${extensionGraph.imports} imports resolve inside the tarball`,
);
