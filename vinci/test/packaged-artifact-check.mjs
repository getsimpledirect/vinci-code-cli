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
  readlinkSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parse } from "unbash";

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
const authorityRoot = realpathSync(suppliedAuthorityRoot);

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

const launcherPath = assertExactRealPath(join(root, "vinci", "bin", "vinci"), "launcher");
if (!lstatSync(launcherPath).isFile()) refuse("launcher is not a regular file");
const launcherSource = readFileSync(launcherPath, "utf8");
const shell = parse(launcherSource);
const shellCommands = [];
const shellAssignments = [];
const shellErrors = [];
const visitedShellNodes = new WeakSet();
function walkShell(value) {
  if (!value || typeof value !== "object" || visitedShellNodes.has(value)) return;
  visitedShellNodes.add(value);
  if (value.type === "Script" && Array.isArray(value.errors)) shellErrors.push(...value.errors);
  if (value.type === "Command") shellCommands.push(value);
  if (value.type === "Assignment") shellAssignments.push(value);
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

function resolveImport(file, specifier) {
  const base = resolve(dirname(file), specifier);
  assertInsideRoot(base, `${relativeToRoot(file)} import ${specifier}`);
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
    if (source.includes("\uFFFD")) {
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
    function addFailure(message) {
      failures.push(`${relativeToRoot(file)} ${message}`);
    }
    function addModuleSpecifier(node, moduleSpecifier) {
      if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) {
        addFailure("uses a non-literal module specifier");
        return;
      }
      if (moduleSpecifier.text === "module" || moduleSpecifier.text === "node:module") {
        addFailure("imports Node module-loader authority; the static artifact proof refuses it");
      } else if (moduleSpecifier.text.startsWith(".")) {
        specifiers.push(moduleSpecifier.text);
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
          addFailure("uses dynamic/runtime module loading; the static artifact proof refuses it");
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          if (!isCommonJs) {
            addFailure("uses a CommonJS loader in an ESM module");
          } else if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
            addFailure("uses dynamic/runtime module loading; the static artifact proof refuses it");
          } else if (node.arguments[0].text === "module" || node.arguments[0].text === "node:module") {
            addFailure("loads Node module-loader authority; the static artifact proof refuses it");
          } else if (node.arguments[0].text.startsWith(".")) {
            specifiers.push(node.arguments[0].text);
          }
        }
      } else if (ts.isIdentifier(node) && (node.text === "eval" || node.text === "Function")) {
        addFailure("references a dynamic code loader; the static artifact proof refuses it");
      } else if (
        ts.isIdentifier(node)
        && (node.text === "require" || node.text === "createRequire")
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node && node.text === "require")
      ) {
        addFailure("aliases a runtime module loader; the static artifact proof refuses it");
      } else if (ts.isIdentifier(node) && node.text === "module" && !isAllowedCommonJsModuleReference(node)) {
        addFailure("uses module through an unverifiable runtime access");
      } else if (
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
      ) {
        addFailure("aliases a runtime module loader; the static artifact proof refuses it");
      } else if (
        ts.isElementAccessExpression(node)
        && ts.isIdentifier(node.expression)
        && ["Module", "module", "global", "globalThis"].includes(node.expression.text)
      ) {
        addFailure("uses computed runtime access that the static artifact proof cannot verify");
      } else if (
        !isCommonJs
        && ts.isIdentifier(node)
        && (node.text === "exports" || node.text === "module")
      ) {
        addFailure("uses CommonJS globals in an ESM module");
      } else if (
        isCommonJs
        && ts.isMetaProperty(node)
        && node.keywordToken === ts.SyntaxKind.ImportKeyword
      ) {
        addFailure("uses import.meta in a .cjs module");
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    for (const specifier of specifiers) {
      imports += 1;
      const dependency = resolveImport(file, specifier);
      if (!dependency) failures.push(`${relativeToRoot(file)} -> ${specifier}`);
      else if (/\.(?:cjs|js|mjs|ts)$/.test(dependency)) queue.push(dependency);
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
function compareAuthorityDirectory(artifactDirectory, relativeDirectory = "") {
  for (const entry of readdirSync(artifactDirectory).sort()) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
    const artifactPath = join(artifactDirectory, entry);
    const trustedPath = join(authorityRoot, ...relativePath.split("/"));
    if (!existsSync(trustedPath) && !lstatExists(trustedPath)) {
      authorityFailures.push(`${relativePath} is not present in the trusted executable authority`);
      continue;
    }
    const artifactStat = lstatSync(artifactPath);
    const trustedStat = lstatSync(trustedPath);
    if (artifactStat.isDirectory()) {
      if (!trustedStat.isDirectory() || trustedStat.isSymbolicLink()) {
        authorityFailures.push(`${relativePath} differs in type from the trusted executable authority`);
      } else {
        compareAuthorityDirectory(artifactPath, relativePath);
      }
    } else if (artifactStat.isSymbolicLink()) {
      authorityLinks += 1;
      if (!trustedStat.isSymbolicLink() || readlinkSync(artifactPath) !== readlinkSync(trustedPath)) {
        authorityFailures.push(`${relativePath} differs from the trusted executable authority`);
      }
    } else if (artifactStat.isFile()) {
      authorityFiles += 1;
      if (
        !trustedStat.isFile()
        || trustedStat.isSymbolicLink()
        || (artifactStat.mode & 0o111) !== (trustedStat.mode & 0o111)
        || artifactStat.size !== trustedStat.size
        || fileDigest(artifactPath) !== fileDigest(trustedPath)
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

compareAuthorityDirectory(root);
if (authorityFailures.length > 0) {
  const visible = authorityFailures.slice(0, 32);
  if (authorityFailures.length > visible.length) {
    visible.push(`… ${authorityFailures.length - visible.length} more authority mismatch(es)`);
  }
  refuse(`artifact violates the closed executable authority (${authorityFailures.length} mismatch(es))`, visible);
}

console.log(
  `  ✓ packaged artifact: ${manifest.dispatches.length} manifest-driven launcher dispatches; `
  + `${dispatchGraph.files} dispatch files/${dispatchGraph.imports} imports and `
  + `${extensionGraph.files} extension files/${extensionGraph.imports} imports resolve inside the tarball; `
  + `${authorityFiles} files/${authorityLinks} links match the closed executable authority`,
);
