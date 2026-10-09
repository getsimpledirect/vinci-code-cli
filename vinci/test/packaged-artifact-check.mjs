#!/usr/bin/env node
// Verify a PACKAGED Vinci artifact can actually load — the one thing the offline harness
// structurally cannot check, because the harness runs from the repo where every source path
// resolves.
//
// 0.0.31 shipped broken: #46 added an import from `vinci/extensions/lib/verification-state.ts`
// to `packages/coding-agent/src/core/vinci-grader.ts`. That file exists in the repo but the
// tarball ships only `packages/coding-agent/dist` — so the extension failed to load and the CLI
// died at startup. Full harness green, both CI legs green, 50 live campaign runs green: every
// gate ran from the repo, so none of them could see it.
//
// Usage:  node vinci/test/packaged-artifact-check.mjs <unpacked-artifact-root>
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.argv[2];
if (!root || !existsSync(root)) {
  console.error("usage: packaged-artifact-check.mjs <unpacked-artifact-root>");
  process.exit(2);
}

// Every relative specifier the shipped extension layer resolves at RUNTIME. Bare specifiers
// (node:, package names) are resolved by node/jiti and are out of scope here.
const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)[^'"]*?from\s+["'](\.[^"']+)["']/g;
const SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s+["'](\.[^"']+)["']/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(path, out);
    } else if (/\.(ts|mjs|js)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

const extensionsRoot = join(root, "vinci", "extensions");
if (!existsSync(extensionsRoot)) {
  console.error(`✗ packaged artifact has no vinci/extensions: ${extensionsRoot}`);
  process.exit(1);
}

const failures = [];
let checked = 0;

for (const file of walk(extensionsRoot)) {
  const source = readFileSync(file, "utf8");
  const specifiers = [
    ...[...source.matchAll(RELATIVE_IMPORT)].map((m) => m[1]),
    ...[...source.matchAll(SIDE_EFFECT_IMPORT)].map((m) => m[1]),
  ];
  for (const specifier of specifiers) {
    checked += 1;
    const base = resolve(dirname(file), specifier);
    // A TS specifier may point at .ts that ships as .ts, or at built .js next to a .d.ts.
    const candidates = [base, `${base}.ts`, `${base}.js`, `${base}.mjs`, join(base, "index.ts"), join(base, "index.js")];
    if (candidates.some((candidate) => existsSync(candidate))) continue;
    failures.push(`${file.slice(root.length + 1)} -> ${specifier} (resolved ${base.slice(root.length + 1)})`);
  }
}

if (failures.length > 0) {
  console.error(`✗ packaged artifact: ${failures.length} unresolvable import(s) in the shipped extension layer`);
  console.error("  These load at runtime, so the CLI will fail to start:");
  for (const failure of failures) console.error(`    ${failure}`);
  console.error("\n  Most likely cause: an extension imports from packages/*/src, which is NOT shipped.");
  console.error("  Import the built module under packages/*/dist instead.");
  process.exit(1);
}

console.log(`  ✓ packaged artifact: ${checked} relative imports in vinci/extensions all resolve inside the tarball`);

// Compile a real consumer of the unpacked .mjs, so omission of the adjacent declaration
// cannot pass merely because the development checkout still has its types.
const runtimePath = resolve(root, "vinci/scripts/runtime.mjs");
let runtime;
try { runtime = await import(pathToFileURL(runtimePath).href); }
catch { throw new Error("The unpacked runtime module did not load. Restore its reviewed artifact and dependencies before retrying."); }
for (const name of ["createRuntime", "runtimeClient", "runRuntime", "RuntimeError"]) {
  assert.equal(typeof runtime[name], "function", `The unpacked runtime export "${name}" must load. Restore its reviewed module before retrying.`);
}
const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
let compiler;
try { compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc"); }
catch { throw new Error("The source TypeScript compiler is unavailable. Install locked development dependencies before retrying."); }
const temporary = await mkdtemp(join(sourceRoot, ".runtime-package-types-"));
let retainEvidence = false;
try {
  const consumer = join(temporary, "consumer.mts");
  await writeFile(consumer, `import { createRuntime, RuntimeError } from ${JSON.stringify(runtimePath)};
declare const privateConfigPath: string;
const api = await createRuntime(privateConfigPath);
const created = await api.create({ saved: true, input: "Synthetic type fixture", commandId: "type-fixture" });
const task = await api.inspect(created.runId);
const revision: number = task.view.snapshot.revision;
const receipt = await api.receipt(created.runId);
if (receipt.receipt) { const verdict: "VERIFIED_PASS" | "BLOCKED" | "CONDITIONAL" = receipt.receipt.verdict; }
await api.correct(created.runId, { approvalId: "selected", actionDigest: "selected", text: "Synthetic feedback", target: "selected", commandId: "stable", expectedRevision: revision });
const error = new RuntimeError("unconfirmed", 69, true);
const unconfirmed: boolean = error.mutationUnconfirmed;
// @ts-expect-error Explicit saved admission cannot become false.
await api.create({ saved: false, input: "Synthetic type fixture", commandId: "type-fixture" });
// @ts-expect-error Caller owner authority is not a facade input.
await api.create({ saved: true, input: "Synthetic type fixture", commandId: "type-fixture", ownerId: "other" });
// @ts-expect-error Unprojected producer fields remain unknown.
const lease: string = task.view.lease;
// @ts-expect-error The facade adds no generic request escape hatch.
await api.request("POST", "/private");
`, { mode: 0o600 });
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [compiler, "--strict", "--noEmit", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--lib", "ES2023,DOM", "--types", "node", consumer], { cwd: sourceRoot, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = []; let size = 0, refusal = null, killTimer, closeTimer;
    const stop = message => {
      if (refusal) return; refusal = message; child.kill("SIGTERM");
      killTimer = setTimeout(() => { child.kill("SIGKILL"); closeTimer = setTimeout(() => {
        retainEvidence = true; child.unref(); child.stdout.destroy(); child.stderr.destroy();
        reject(new Error(`Packaged type compiler close is unconfirmed for PID ${child.pid}; retain ${temporary} and stop that exact child before cleanup.`));
      }, 3000); }, 3000);
    };
    const deadline = setTimeout(() => stop("Packaged type compiler deadline elapsed. Inspect the exact child before retrying."), 15000);
    child.once("error", () => stop("Packaged type compiler launch failed. Restore the source compiler before retrying."));
    for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { size += bytes.length; if (size > 262144) stop("Packaged type compiler output exceeded its bound. Inspect the consumer declaration before retrying."); else chunks.push(bytes); });
    child.once("close", (code, signal) => {
      clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(closeTimer);
      resolveResult({ status: refusal ? 124 : code ?? signal, output: Buffer.concat(chunks).toString("utf8") + (refusal ?? "") });
    });
  });
  if (result.status !== 0) process.stderr.write(result.output);
  assert.equal(result.status, 0, "The actual unpacked runtime module must resolve its declaration and reject invalid consumer types. Restore the adjacent declaration before retrying.");
  console.log("  ✓ unpacked runtime facade and legacy exports load; strict consumer type resolution preserves exact inputs and unknown fields");
} finally {
  if (!retainEvidence) await rm(temporary, { recursive: true, force: true });
  else process.stderr.write(`Packaged type cleanup is unconfirmed; retain ${temporary} and reconcile its exact compiler child before cleanup.\n`);
}
// --- Launcher dispatch targets -------------------------------------------------------------------
// vinci/bin/vinci hands whole subcommands to standalone programs (`exec node "${VINCI}/<path>"`).
// Each such target is a runtime dependency of the shipped launcher exactly like an extension
// import, and the tarball is assembled from an explicit path list, so a target the list forgets
// ships as a dead subcommand: the launcher execs a file that is not there and node prints
// ERR_MODULE_NOT_FOUND. That is how `vinci worker` shipped in every 0.0.x tarball up to 0.0.51 --
// package.sh listed vinci/bin, vinci/extensions, vinci/themes ... and never vinci/worker -- and
// nothing here could see it, because this check only followed imports under vinci/extensions.
//
// Read from the SHIPPED launcher, not from a hardcoded list, so a new `exec node` dispatch is
// covered the moment it is added; refuse outright if the grammar stops matching, because a check
// that finds zero targets has gone blind, not clean.
const launcherPath = join(root, "vinci", "bin", "vinci");
if (!existsSync(launcherPath)) {
  console.error(`✗ packaged artifact has no launcher: ${launcherPath}`);
  process.exit(1);
}
const DISPATCH = /exec node "\$\{VINCI\}\/([^"\s]+)"/g;
const dispatchTargets = [...readFileSync(launcherPath, "utf8").matchAll(DISPATCH)].map((m) => m[1]);
if (dispatchTargets.length === 0) {
  console.error("✗ packaged artifact: found no `exec node \"${VINCI}/...\"` dispatch in vinci/bin/vinci -- the launcher grammar changed and this check can no longer see its targets");
  process.exit(1);
}
const missingTargets = dispatchTargets.filter((target) => !existsSync(join(root, "vinci", target)));
if (missingTargets.length > 0) {
  console.error(`✗ packaged artifact: ${missingTargets.length} launcher dispatch target(s) are not in the tarball`);
  console.error("  vinci/bin/vinci execs these, so the subcommand dies with ERR_MODULE_NOT_FOUND on an installed copy:");
  for (const target of missingTargets) console.error(`    vinci/${target}`);
  console.error("\n  Most likely cause: the directory is missing from the path list at the end of vinci/package.sh.");
  process.exit(1);
}

// Follow the standalone programs' own relative imports too, with the same resolver the extension
// layer gets: the worker is a module graph (worker.mjs -> run.mjs -> contracts/...), and a
// present entry file with an absent sibling is the same dead subcommand one level down.
const targetFailures = [];
let targetImports = 0;
for (const target of dispatchTargets) {
  const dir = dirname(join(root, "vinci", target));
  for (const file of walk(dir)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of [...source.matchAll(RELATIVE_IMPORT)].map((m) => m[1])) {
      targetImports += 1;
      const base = resolve(dirname(file), specifier);
      if ([base, `${base}.js`, `${base}.mjs`, join(base, "index.js")].some((c) => existsSync(c))) continue;
      targetFailures.push(`${file.slice(root.length + 1)} -> ${specifier}`);
    }
  }
}
if (targetFailures.length > 0) {
  console.error(`✗ packaged artifact: ${targetFailures.length} unresolvable import(s) under launcher dispatch targets`);
  for (const failure of targetFailures) console.error(`    ${failure}`);
  process.exit(1);
}

// And DRIVE it: the worker with no arguments must reach its own usage refusal, which proves the
// whole module graph loads from the unpacked tree (not from the repo) with node alone. A file-
// existence check would pass an entry file whose import of identity.json or a sibling is broken.
// An installed user's profile is not part of this artifact check. Give the real launcher a fresh
// home so its profile loading and bootstrap healing cannot read or modify developer state.
const workerHome = await mkdtemp(join(sourceRoot, ".worker-package-home-"));
let drive;
try {
  drive = spawnSync(launcherPath, ["worker"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: workerHome, VINCI_NO_BOOTSTRAP_HEAL: "1", VINCI_UPDATE_DISABLED: "1" },
    timeout: 60_000,
  });
} finally {
  await rm(workerHome, { recursive: true, force: true });
}
if (drive.status !== 1 || !/^vinci worker: Usage: vinci worker start/m.test(drive.stderr ?? "")) {
  console.error("✗ packaged artifact: `vinci worker` did not reach its usage refusal from the unpacked tree");
  console.error(`  exit=${drive.status ?? drive.signal} stderr:\n${(drive.stderr ?? "").split("\n").slice(0, 6).map((l) => `    ${l}`).join("\n")}`);
  process.exit(1);
}
console.log(`  ✓ packaged artifact: ${dispatchTargets.length} launcher dispatch target(s) ship (${dispatchTargets.join(", ")}), ${targetImports} imports resolve, \`vinci worker\` loads from the unpacked tree`);
