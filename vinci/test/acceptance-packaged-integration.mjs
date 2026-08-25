import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Minimal runtime dependencies needed for the packaged artifact to load
const minimalRuntimePackages = ["typebox", "get-east-asian-width", "marked"];

function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`required test executable not found: ${name}`);
}

function linkExecutable(directory, name) {
  symlinkSync(findExecutable(name), join(directory, name));
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function shippedTypeScriptModule(packagedRoot, relativePath) {
  const candidate = join(packagedRoot, `${relativePath}.ts`);
  assert.equal(existsSync(candidate), true, `packaged module is missing: ${relativePath}.ts`);
  return candidate;
}

function runLauncher(launcher, path, home, marker, args, overrides = {}) {
  const env = {
    ...process.env,
    HOME: home,
    PATH: path,
    PI_MARKER: marker,
    VINCI_NO_BOOTSTRAP_HEAL: "1",
    ...overrides,
  };
  if (overrides.VAC_CLI_PATH === undefined) delete env.VAC_CLI_PATH;
  return spawnSync(findExecutable("bash"), [launcher, "verify", ...args], {
    env,
    encoding: "utf8",
    input: "stdin reaches packaged vac\n",
  });
}

const temp = mkdtempSync(join(tmpdir(), "vinci-acceptance-packaged-"));
try {
  const packagedRoot = join(temp, "packaged");
  mkdirSync(packagedRoot);

  // Assemble minimal packaged layout (avoids npm ls errors on symlinked node_modules)
  // This layout matches what vinci/package.sh would produce:
  // - vinci/{bin,extensions,themes,assets,updater}
  // - packages/*/dist and package.json
  // - minimal runtime node_modules
  
  // Copy vinci layer (no tests, no docs)
  cpSync(join(root, "vinci/bin"), join(packagedRoot, "vinci/bin"), { recursive: true });
  cpSync(join(root, "vinci/extensions"), join(packagedRoot, "vinci/extensions"), { recursive: true });
  cpSync(join(root, "vinci/themes"), join(packagedRoot, "vinci/themes"), { recursive: true });
  cpSync(join(root, "vinci/assets"), join(packagedRoot, "vinci/assets"), { recursive: true });
  cpSync(join(root, "vinci/updater"), join(packagedRoot, "vinci/updater"), { recursive: true });
  writeFileSync(join(packagedRoot, "vinci/identity.json"), readFileSync(join(root, "vinci/identity.json")));
  writeFileSync(join(packagedRoot, "vinci/NOTICE"), readFileSync(join(root, "vinci/NOTICE")));
  mkdirSync(join(packagedRoot, "vinci/scripts"), { recursive: true });
  writeFileSync(join(packagedRoot, "vinci/scripts/report-wrong.mjs"), readFileSync(join(root, "vinci/scripts/report-wrong.mjs")));

  // Copy root package.json (for workspace resolution)
  writeFileSync(join(packagedRoot, "package.json"), readFileSync(join(root, "package.json")));

  // Copy built packages (dist only, not src)
  for (const pkg of ["tui", "ai", "agent", "coding-agent", "orchestrator"]) {
    const pkgDir = join(packagedRoot, "packages", pkg);
    mkdirSync(pkgDir, { recursive: true });
    if (existsSync(join(root, `packages/${pkg}/dist`))) {
      cpSync(join(root, `packages/${pkg}/dist`), join(pkgDir, "dist"), { recursive: true });
    }
    writeFileSync(join(pkgDir, "package.json"), readFileSync(join(root, `packages/${pkg}/package.json`)));
  }

  // Create workspace symlinks (mimics the layout from node_modules)
  mkdirSync(join(packagedRoot, "node_modules/@earendil-works"), { recursive: true });
  for (const pkg of ["tui", "ai", "agent", "coding-agent", "orchestrator"]) {
    symlinkSync(join("../../packages", pkg), join(packagedRoot, "node_modules/@earendil-works", `pi-${pkg}`));
  }

  // Copy minimal runtime dependencies
  for (const dep of minimalRuntimePackages) {
    cpSync(join(root, "node_modules", dep), join(packagedRoot, "node_modules", dep), { recursive: true });
  }

  const launcher = join(packagedRoot, "vinci/bin/vinci");
  assert.equal(existsSync(launcher), true, "packaged launcher is missing");

  const home = join(temp, "home");
  const pathWithVac = join(temp, "path-with-vac");
  const pathWithoutVac = join(temp, "path-without-vac");
  const piMarker = join(temp, "pi-started");
  const stdinCapture = join(temp, "vac-stdin");
  mkdirSync(home);
  mkdirSync(pathWithVac);
  mkdirSync(pathWithoutVac);

  for (const directory of [pathWithVac, pathWithoutVac]) {
    linkExecutable(directory, "dirname");
    linkExecutable(directory, "readlink");
    writeExecutable(
      join(directory, "pi"),
      `#!/bin/sh\n: > "\${PI_MARKER}"\nexit 99\n`,
    );
  }

  const vac = join(pathWithVac, "vac");
  writeExecutable(
    vac,
    `#!/bin/sh\nIFS= read -r input\nprintf '%s' "$input" > "\${VAC_STDIN_CAPTURE}"\n"${process.execPath}" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@"\nprintf 'packaged vac stderr\\n' >&2\nexit 3\n`,
  );

  const routed = runLauncher(launcher, pathWithVac, home, piMarker, ["--json", "test-arg"], {
    VAC_STDIN_CAPTURE: stdinCapture,
  });
  assert.equal(routed.status, 3, routed.stderr);
  assert.equal(routed.stdout, '["--json","test-arg"]');
  assert.equal(routed.stderr, "packaged vac stderr\n");
  assert.equal(readFileSync(stdinCapture, "utf8"), "stdin reaches packaged vac");
  assert.equal(existsSync(piMarker), false, "packaged verify route started the Pi agent");
  console.log("ok (a) packaged launcher passes arguments, stdio, and exit status through to vac");

  const unavailable = runLauncher(launcher, pathWithoutVac, home, piMarker, ["some-arg"]);
  assert.equal(unavailable.status, 127, unavailable.stderr);
  assert.equal(unavailable.stdout, "");
  assert.match(unavailable.stderr, /Verification isn't set up yet/);
  assert.equal(existsSync(piMarker), false, "missing-vac route started the Pi agent");
  console.log("ok (b) packaged launcher gives guidance without vac and does not start Pi");

  const acceptPath = shippedTypeScriptModule(packagedRoot, "vinci/extensions/vinci-accept");
  const verificationStatePath = shippedTypeScriptModule(packagedRoot, "vinci/extensions/lib/verification-state");
  const receiptPath = shippedTypeScriptModule(packagedRoot, "vinci/extensions/vinci-receipt");
  assert.match(
    readFileSync(verificationStatePath, "utf8"),
    /export\s+type\s*\{\s*RemoteAcceptanceVerdict\s*\}/,
    "packaged verification state does not export the RemoteAcceptanceVerdict type",
  );

  const loader = createJiti(join(packagedRoot, "package.json"), {
    moduleCache: false,
    tryNative: false,
  });
  const acceptModule = await loader.import(acceptPath, { default: false });
  const stateModule = await loader.import(verificationStatePath, { default: false });
  const receiptModule = await loader.import(receiptPath, { default: false });
  assert.equal(typeof acceptModule.default, "function", "packaged vinci-accept has no default extension export");
  assert.equal(typeof stateModule.applyRemoteVerdict, "function", "packaged verification-state has no applyRemoteVerdict export");
  assert.equal(typeof receiptModule.remoteVerdictDisplay, "function", "packaged receipt has no remoteVerdictDisplay export");
  console.log("ok (c) packaged extension set includes acceptance, verification state, and receipt exports");

  const localOutcome = { state: "DONE", reason: "All local checks passed" };
  assert.deepEqual(
    receiptModule.remoteVerdictDisplay(localOutcome, {
      status: "VERIFIED_PASS",
      staled: false,
      summary: "All criteria verified",
    }),
    { state: "DONE", reason: "All criteria verified" },
  );
  assert.deepEqual(
    receiptModule.remoteVerdictDisplay(localOutcome, {
      status: "CONDITIONAL",
      staled: false,
      summary: "Could not fully verify",
    }),
    { state: "DONE_UNVERIFIED", reason: "Could not fully verify" },
  );
  assert.deepEqual(
    receiptModule.remoteVerdictDisplay(localOutcome, {
      status: "CONDITIONAL",
      staled: true,
      summary: "Earlier verification was conditional",
    }),
    {
      state: "DONE",
      reason: "All local checks passed\nA verification from before your latest changes found: Earlier verification was conditional",
    },
  );
  console.log("ok (d) packaged receipt maps current verdicts and shows staled verdict context");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("✓ acceptance-packaged-integration.mjs: all tests passed");
