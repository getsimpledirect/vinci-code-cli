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
  if (!word?.text) return [];
  return [...word.text.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}|([A-Za-z_][A-Za-z0-9_]*))/g)]
    .map((match) => match[1] ?? match[2]);
}

// Track every variable that can carry a path rooted at VINCI. The pass is deliberately
// flow-insensitive: if any branch can assign such a path, using that variable as an executable
// target is unreviewed. This catches indirection regardless of quoting or line layout.
const vinciPathVariables = new Set(["VINCI"]);
let addedVariable = true;
while (addedVariable) {
  addedVariable = false;
  for (const assignment of shellAssignments) {
    const words = [assignment.value, ...(assignment.array ?? [])].filter(Boolean);
    if (
      assignment.name
      && !vinciPathVariables.has(assignment.name)
      && words.some((word) => parameterReferences(word).some((name) => vinciPathVariables.has(name)))
    ) {
      vinciPathVariables.add(assignment.name);
      addedVariable = true;
    }
  }
}

const safePathConsumers = new Set([
  "[", "test", "echo", "printf", "sed", "head", "tail", "cat", "cp", "mv", "rm", "chmod",
  "dirname", "readlink", "basename", "_vinci_updater_version", "_vinci_version_is_newer",
]);
let resolverCalls = 0;
let manifestExecs = 0;
let externalExecs = 0;
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
      "${VINCI}/scripts/resolve-dispatch.mjs",
      "${VINCI}/dispatch-manifest.json",
      "$1",
    ])
  ) {
    resolverCalls += 1;
    continue;
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
if (resolverCalls !== 1 || manifestExecs !== 1 || externalExecs !== 1) {
  refuse("launcher does not contain exactly one reviewed manifest resolver, node exec, and external exec", [
    `resolver=${resolverCalls}, node-exec=${manifestExecs}, external-exec=${externalExecs}`,
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
      if (moduleSpecifier.text.startsWith(".")) specifiers.push(moduleSpecifier.text);
    }
    function staticPropertyName(node) {
      if (ts.isStringLiteralLike(node)) return node.text;
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
          } else if (node.arguments[0].text.startsWith(".")) {
            specifiers.push(node.arguments[0].text);
          }
        } else if (ts.isIdentifier(node.expression) && (node.expression.text === "eval" || node.expression.text === "Function")) {
          addFailure("uses dynamic/runtime module loading; the static artifact proof refuses it");
        }
      } else if (
        ts.isIdentifier(node)
        && (node.text === "require" || node.text === "createRequire")
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node && node.text === "require")
      ) {
        addFailure("aliases a runtime module loader; the static artifact proof refuses it");
      } else if (ts.isIdentifier(node) && node.text === "module" && !isAllowedCommonJsModuleReference(node)) {
        addFailure("uses module through an unverifiable runtime access");
      } else if (
        (ts.isPropertyAccessExpression(node) && ["require", "_load", "createRequire"].includes(node.name.text))
        || (
          ts.isElementAccessExpression(node)
          && ["require", "_load", "createRequire", "eval", "Function"].includes(
            staticPropertyName(node.argumentExpression),
          )
        )
      ) {
        addFailure("aliases a runtime module loader; the static artifact proof refuses it");
      } else if (
        ts.isElementAccessExpression(node)
        && ts.isIdentifier(node.expression)
        && ["module", "global", "globalThis"].includes(node.expression.text)
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
const dispatchEntries = [resolverPath, ...nodeTargets.map((entry) => {
  const path = assertExactRealPath(join(root, "vinci", ...entry.target.split("/")), `dispatch target ${entry.command}`);
  if (!lstatSync(path).isFile()) refuse(`dispatch target ${entry.command} is not a regular file`);
  return path;
})];
const dispatchGraph = checkGraph(dispatchEntries, "launcher dispatch graph");

console.log(
  `  ✓ packaged artifact: ${manifest.dispatches.length} manifest-driven launcher dispatches; `
  + `${dispatchGraph.files} dispatch files/${dispatchGraph.imports} imports and `
  + `${extensionGraph.files} extension files/${extensionGraph.imports} imports resolve inside the tarball`,
);
