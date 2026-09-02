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
const launcherSource = readFileSync(launcherPath, "utf8");
const launcherLines = launcherSource.split("\n");
const seenMarkers = new Set();
const reviewedDispatchLines = new Set();
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
    reviewedDispatchLines.add(index + 1);
    pendingMarker = null;
    continue;
  }
  // This quick check produces the clearest error for ordinary edits. The structural scan below is
  // the authority and also catches shell-equivalent spellings such as e""xec.
  if (containsExec) refuse("launcher contains an unmanifested executable dispatch", [`line ${index + 1}: ${line}`]);
}
if (pendingMarker) refuse(`dispatch marker ${pendingMarker} has no exec`);
const missingMarkers = manifest.dispatches.filter((entry) => !seenMarkers.has(entry.command)).map((entry) => entry.command);
if (missingMarkers.length > 0) refuse("dispatch manifest entries are not reachable from the launcher", missingMarkers);

// Tokenize shell words before looking for commands. Matching source text is insufficient here:
// quotes can be concatenated inside one shell word (`e""xec`) and a dispatch can omit `exec`
// entirely (`node "$VINCI/missing.mjs"; exit $?`). This intentionally recognizes only the shell
// structure needed to prove executable dispatches. Unterminated quotes/escapes refuse rather than
// producing a partial view.
function scanShellCommands(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  let atWordBoundary = true;
  const operators = [";;&", ";;", ";&", "&&", "||", "|&", "<<", ">>", "<&", ">&", ";", "&", "|", "(", ")", "{", "}", "<", ">"];

  while (index < source.length) {
    const char = source[index];
    if (char === "\n") {
      tokens.push({ type: "separator", value: "\n", line });
      index += 1;
      line += 1;
      atWordBoundary = true;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      atWordBoundary = true;
      continue;
    }
    if (char === "#" && atWordBoundary) {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    const operator = operators.find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      tokens.push({ type: /^(?:;;&|;;|;&|&&|\|\||\|&|;|&|\||\(|\)|\{|\})$/.test(operator) ? "separator" : "operator", value: operator, line });
      index += operator.length;
      atWordBoundary = true;
      continue;
    }

    const startLine = line;
    let value = "";
    while (index < source.length) {
      const current = source[index];
      if (current === "\n" || /[\t\r ]/.test(current) || operators.some((candidate) => source.startsWith(candidate, index))) break;
      if (current === "\\") {
        if (index + 1 >= source.length) refuse("launcher has an unterminated shell escape", [`line ${line}`]);
        if (source[index + 1] === "\n") {
          index += 2;
          line += 1;
        } else {
          value += source[index + 1];
          index += 2;
        }
        continue;
      }
      if (current === "'" || current === '"') {
        const quote = current;
        index += 1;
        let closed = false;
        while (index < source.length) {
          const quoted = source[index];
          if (quoted === quote) {
            index += 1;
            closed = true;
            break;
          }
          if (quoted === "\n") line += 1;
          if (quote === '"' && quoted === "\\" && index + 1 < source.length) {
            const escaped = source[index + 1];
            if ('"\\$`\n'.includes(escaped)) {
              if (escaped === "\n") line += 1;
              else value += escaped;
              index += 2;
              continue;
            }
          }
          value += quoted;
          index += 1;
        }
        if (!closed) refuse("launcher has an unterminated shell quote", [`line ${startLine}`]);
        continue;
      }
      value += current;
      index += 1;
    }
    tokens.push({ type: "word", value, line: startLine });
    atWordBoundary = false;
  }

  const commands = [];
  let words = [];
  function finishCommand() {
    if (words.length === 0) return;
    const controlWords = new Set(["!", "if", "then", "elif", "else", "while", "until", "do"]);
    let cursor = 0;
    while (controlWords.has(words[cursor]?.value)) cursor += 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[cursor]?.value ?? "")) cursor += 1;
    if (words[cursor]) commands.push({ command: words[cursor].value, words: words.slice(cursor), line: words[cursor].line });
    words = [];
  }
  for (const token of tokens) {
    if (token.type === "separator") finishCommand();
    else if (token.type === "word") words.push(token);
  }
  finishCommand();
  return commands;
}

for (const command of scanShellCommands(launcherSource)) {
  const hasVinciExecutable = command.words.some(({ value }) => (
    /^(?:\$VINCI|\$\{VINCI\})\/.+\.(?:cjs|js|mjs|sh|ts)$/.test(value)
  ));
  const directlyRunsVinciExecutable = hasVinciExecutable && (
    /(?:^|\/)node$/.test(command.command)
    || command.command === "env"
    || command.command === "command"
    || (command.command.startsWith("$") && command.command !== "${PI[@]}")
  );
  const directlyRunsVac = command.command === "${_vinci_vac_cli}";
  if ((command.command === "exec" || directlyRunsVinciExecutable || directlyRunsVac) && !reviewedDispatchLines.has(command.line)) {
    refuse("launcher contains an unmanifested executable dispatch", [
      `line ${command.line}: ${command.words.map(({ value }) => value).join(" ")}`,
    ]);
  }
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
    const extension = file.slice(file.lastIndexOf("."));
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      extension === ".ts" ? ts.ScriptKind.TS : extension === ".cjs" ? ts.ScriptKind.JS : ts.ScriptKind.JS,
    );
    if ((sourceFile.parseDiagnostics ?? []).length > 0) {
      failures.push(`${relativeToRoot(file)} has malformed executable module syntax`);
      continue;
    }
    const specifiers = [];
    function addModuleSpecifier(node, moduleSpecifier) {
      if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) {
        failures.push(`${relativeToRoot(file)} uses a non-literal module specifier`);
        return;
      }
      if (moduleSpecifier.text.startsWith(".")) specifiers.push(moduleSpecifier.text);
    }
    function visit(node) {
      if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
        addModuleSpecifier(node, node.moduleSpecifier);
      } else if (ts.isImportEqualsDeclaration(node)) {
        failures.push(`${relativeToRoot(file)} uses runtime import-equals loading; the static artifact proof refuses it`);
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          failures.push(`${relativeToRoot(file)} uses dynamic/runtime module loading; the static artifact proof refuses it`);
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
            failures.push(`${relativeToRoot(file)} uses dynamic/runtime module loading; the static artifact proof refuses it`);
          } else if (node.arguments[0].text.startsWith(".")) {
            specifiers.push(node.arguments[0].text);
          }
        } else if (ts.isIdentifier(node.expression) && (node.expression.text === "eval" || node.expression.text === "Function")) {
          failures.push(`${relativeToRoot(file)} uses dynamic/runtime module loading; the static artifact proof refuses it`);
        }
      } else if (
        ts.isIdentifier(node)
        && (node.text === "require" || node.text === "createRequire")
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node && node.text === "require")
      ) {
        failures.push(`${relativeToRoot(file)} aliases a runtime module loader; the static artifact proof refuses it`);
      } else if (
        (ts.isPropertyAccessExpression(node) && ["require", "_load", "createRequire"].includes(node.name.text))
        || (
          ts.isElementAccessExpression(node)
          && ts.isStringLiteralLike(node.argumentExpression)
          && ["require", "_load", "createRequire"].includes(node.argumentExpression.text)
        )
      ) {
        failures.push(`${relativeToRoot(file)} aliases a runtime module loader; the static artifact proof refuses it`);
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
