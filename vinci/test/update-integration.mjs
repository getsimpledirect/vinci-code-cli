import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = mkdtempSync(join(tmpdir(), "vinci-update-test-"));
const releases = join(temporary, "releases");
const home = join(temporary, "home", ".vinci-code");
const binDir = join(temporary, "home", ".local", "bin");
const manifestPath = join(releases, "manifest-beta.json");
const privateKeyPath = join(temporary, "signing-private.pem");
const publicKeyPath = join(temporary, "signing-public.pem");
mkdirSync(releases, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });

const environment = {
  ...process.env,
  HOME: join(temporary, "home"),
  VINCI_BIN_DIR: binDir,
  VINCI_HOME: home,
  VINCI_TOOL_BOOTSTRAP: "0",
  VINCI_UPDATE_ALLOW_FILE_URLS: "1",
  VINCI_UPDATE_INTERVAL_SECONDS: "0",
  VINCI_UPDATE_MANIFEST_URL: pathToFileURL(manifestPath).href,
  VINCI_UPDATE_PUBLIC_KEY_PATH: publicKeyPath,
};

function run(command, args, expectedStatus = 0) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env: environment });
  assert.equal(
    result.status,
    expectedStatus,
    `${command} ${args.join(" ")} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function runAsync(command, args, expectedStatus = 0) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: root, env: environment });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (status) => {
      try {
        assert.equal(
          status,
          expectedStatus,
          `${command} ${args.join(" ")} exited ${status}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
        resolvePromise({ status, stdout, stderr });
      } catch (error) {
        rejectPromise(error);
      }
    });
  });
}

async function waitForPath(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function waitForChild(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (status, signal) => resolvePromise({ status, signal }));
  });
}

function runWithLimit(command, args, env, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: root, detached: true, env });
    let stdout = "";
    let stderr = "";
    let exceededLimit = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    const timer = setTimeout(() => {
      exceededLimit = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ exceededLimit, signal, status, stderr, stdout });
    });
  });
}

function updaterSourceAtVersion(version) {
  const source = readFileSync(join(root, "vinci", "updater", "update.mjs"), "utf8").replace(
    /\n?\/\/ payload-updater-version: \d+\.\d+\.\d+\s*$/,
    "",
  );
  return `${source}\n// payload-updater-version: ${version}\n`;
}

function createRelease(version, sequence, minimumVersion = version, updaterVersion = version) {
  const releaseDir = join(releases, `${version}-${sequence}`);
  const payload = join(releaseDir, "payload");
  const artifact = join(releaseDir, `vinci-code-${version}.tgz`);
  mkdirSync(join(payload, "vinci", "bin"), { recursive: true });
  mkdirSync(join(payload, "vinci", "updater"), { recursive: true });
  writeFileSync(
    join(payload, "vinci", "identity.json"),
    `${JSON.stringify({ productName: "Vinci Code", command: "vinci", version }, null, 2)}\n`,
  );
  const launcher = join(payload, "vinci", "bin", "vinci");
  const launcherSource = readFileSync(join(root, "vinci", "bin", "vinci"), "utf8");
  const fixtureLauncher = launcherSource.replace(
    "# Verification is a standalone product command",
    `if [ "\${1:-}" = "--payload-version" ]; then echo "${version}"; exit 0; fi

# Verification is a standalone product command`,
  );
  assert.notEqual(fixtureLauncher, launcherSource, "fixture payload-version insertion must apply to the real launcher");
  writeFileSync(launcher, fixtureLauncher);
  chmodSync(launcher, 0o755);
  // Stamp each release's updater with its own version. Without this every fixture payload carries a
  // byte-identical copy of the repo's update.mjs, so "is the bootstrap the same as the payload?"
  // is trivially true whether or not the refresh actually ran — the assertion below would pass with
  // the refresh deleted. The marker is a trailing comment, so the script's behaviour is unchanged.
  const payloadUpdater = join(payload, "vinci", "updater", "update.mjs");
  writeFileSync(payloadUpdater, updaterSourceAtVersion(updaterVersion));
  copyFileSync(join(root, "vinci", "updater", "vinci"), join(payload, "vinci", "updater", "vinci"));
  copyFileSync(publicKeyPath, join(payload, "vinci", "updater", "public-key.pem"));
  run("tar", ["-czf", artifact, "-C", payload, "."]);
  run("node", [
    join(root, "vinci", "scripts", "create-update-manifest.mjs"),
    "--artifact",
    artifact,
    "--artifact-url",
    pathToFileURL(artifact).href,
    "--version",
    version,
    "--minimum-version",
    minimumVersion,
    "--sequence",
    String(sequence),
    "--channel",
    "beta",
    "--mandatory",
    "true",
    "--published-at",
    `2026-07-13T00:00:0${Math.min(sequence, 9)}.000Z`,
    "--private-key",
    privateKeyPath,
    "--public-key",
    publicKeyPath,
    "--output",
    manifestPath,
  ]);
  return { artifact, manifest: readFileSync(manifestPath, "utf8") };
}

function linkedVersion(name) {
  const target = resolve(home, readlinkSync(join(home, name)));
  return JSON.parse(readFileSync(join(target, "vinci", "identity.json"), "utf8")).version;
}

try {
  const first = createRelease("0.0.09", 1);
  const tamperedBootstrap = JSON.parse(first.manifest);
  tamperedBootstrap.signed.version = "9.9.9";
  writeFileSync(manifestPath, `${JSON.stringify(tamperedBootstrap, null, 2)}\n`);
  const bootstrapRejected = run("sh", [join(root, "vinci", "install.sh")], 1);
  assert.match(bootstrapRejected.stderr, /manifest signature is invalid/);
  assert.equal(existsSync(join(home, "current")), false);
  writeFileSync(manifestPath, first.manifest);

  const installed = run("sh", [join(root, "vinci", "install.sh")]);
  assert.match(installed.stdout, /Automatic beta updates are enabled/);
  assert.equal(linkedVersion("current"), "0.0.09");
  assert.equal(existsSync(join(binDir, "vinci")), true);
  assert.equal(run(join(binDir, "vinci"), ["--version"]).stdout.trim(), "0.0.09");
  assert.equal(run(join(binDir, "vinci"), ["--payload-version"]).stdout.trim(), "0.0.09");

  // Linux needs bubblewrap or the bash tool refuses to run commands (see vinci-sandbox.ts). A
  // missing bwrap must NOT fail the install — the agent still reads, edits, and answers — it must
  // tell the user how to fix it. `uname` is stubbed so this runs identically on macOS and Linux.
  //
  // The installer must warn EXACTLY when the runtime would refuse, so its path list has to stay
  // identical to bwrapPath()'s. Pin that here: drift in either file is the bug this asserts.
  const sandboxSource = readFileSync(
    join(root, "packages", "coding-agent", "src", "core", "vinci-sandbox.ts"),
    "utf8",
  );
  const runtimePaths = (
    sandboxSource.match(/function bwrapPath[\s\S]*?\[([^\]]*)\][\s\S]*?\}/)?.[1] ?? ""
  )
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const installerPaths = (
    readFileSync(join(root, "vinci", "install.sh"), "utf8").match(/^BWRAP_PATHS="([^"]*)"$/m)?.[1] ??
    ""
  )
    .split(/\s+/)
    .filter(Boolean);
  assert.ok(runtimePaths.length > 0, "could not parse bwrapPath() — update this test with it");
  assert.deepEqual(
    installerPaths,
    runtimePaths,
    "install.sh's BWRAP_PATHS must match vinci-sandbox.ts's bwrapPath(); otherwise the installer " +
      "stays silent for users whose bwrap sits somewhere the runtime will not accept",
  );

  // Mirror every executable on PATH into one isolated directory, omitting the names we control, and
  // run with PATH set to only that directory. Only real executables are mirrored: a non-executable
  // file that merely shares a tool's name would otherwise shadow the working one further down PATH.
  const isolatedBin = join(temporary, "preflight-bin");
  mkdirSync(isolatedBin, { recursive: true });
  const controlled = new Set(["uname", "apt", "dnf", "pacman", "zypper"]);
  for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    let entries = [];
    try {
      entries = readdirSync(directory);
    } catch {
      continue; // a non-existent PATH entry is normal
    }
    for (const entry of entries) {
      if (controlled.has(entry)) continue;
      const link = join(isolatedBin, entry);
      if (existsSync(link)) continue; // first match wins, as PATH lookup would
      const source = join(directory, entry);
      try {
        if (!statSync(source).isFile()) continue; // follows symlinks; broken ones throw
        accessSync(source, constants.X_OK);
        symlinkSync(source, link);
      } catch {
        // not executable, unreadable, or racing — the tools we need are still mirrored
      }
    }
  }
  const writeStub = (name, body) => {
    const stubPath = join(isolatedBin, name);
    writeFileSync(stubPath, body);
    chmodSync(stubPath, 0o755);
  };
  // Presence is decided by absolute path, which PATH stubs cannot fake, and creating /usr/bin/bwrap
  // on the test machine is not an option. Rather than give the shipped installer a test-only
  // environment switch — which inherited env state could then use to suppress a real user's warning
  // — drive the branches through a COPY whose only difference is that one data line, repointed into
  // a temp filesystem. The loop, the warning and the hint are all the real code, and the parity
  // assertion above pins the real list to the runtime's.
  const installerSource = readFileSync(join(root, "vinci", "install.sh"), "utf8");
  const bwrapRoot = join(temporary, "bwrap-root");
  const fakePaths = runtimePaths.map((runtimePath) => join(bwrapRoot, runtimePath));
  for (const fakePath of fakePaths) mkdirSync(dirname(fakePath), { recursive: true });
  const derivedInstaller = join(temporary, "install-derived.sh");
  const derivedSource = installerSource.replace(
    /^BWRAP_PATHS="[^"]*"$/m,
    `BWRAP_PATHS="${fakePaths.join(" ")}"`,
  );
  assert.notEqual(derivedSource, installerSource, "BWRAP_PATHS substitution did not apply");
  writeFileSync(derivedInstaller, derivedSource);
  const setPresent = (present) => {
    for (const fakePath of fakePaths) {
      if (present.includes(fakePath)) writeFileSync(fakePath, "");
      else rmSync(fakePath, { force: true });
    }
  };
  const runInstaller = (script) =>
    spawnSync("sh", [script], { cwd: root, encoding: "utf8", env: { ...environment, PATH: isolatedBin } });

  const HINT = "Vinci needs bubblewrap to run shell commands safely";
  const preflightCases = [
    { label: "linux, apt", os: "Linux", present: [], manager: "apt", hint: "sudo apt install bubblewrap" },
    { label: "linux, dnf", os: "Linux", present: [], manager: "dnf", hint: "sudo dnf install bubblewrap" },
    { label: "linux, pacman", os: "Linux", present: [], manager: "pacman", hint: "sudo pacman -S bubblewrap" },
    { label: "linux, zypper", os: "Linux", present: [], manager: "zypper", hint: "sudo zypper install bubblewrap" },
    { label: "linux, unknown manager", os: "Linux", present: [], manager: null, hint: "'bubblewrap' package" },
    // A bwrap on PATH but at none of the accepted paths MUST still warn — that is the whole defect
    // this detection exists to avoid, so assert it behaviourally rather than trusting the code shape.
    { label: "linux, bwrap only on PATH", os: "Linux", present: [], manager: "apt", onPath: true, hint: "sudo apt install bubblewrap" },
    { label: "macos", os: "Darwin", present: [], manager: "apt", hint: null },
    // Every accepted path must satisfy the check on its own; testing only the first would let a
    // regression that ignores /bin/bwrap or /usr/local/bin/bwrap pass.
    ...fakePaths.map((fakePath, index) => ({
      label: `linux with ${runtimePaths[index]}`,
      os: "Linux",
      present: [fakePath],
      manager: "apt",
      hint: null,
    })),
  ];
  for (const preflight of preflightCases) {
    writeStub("uname", `#!/bin/sh\necho ${preflight.os}\n`);
    for (const manager of ["apt", "dnf", "pacman", "zypper"]) {
      rmSync(join(isolatedBin, manager), { force: true });
    }
    if (preflight.manager) writeStub(preflight.manager, "#!/bin/sh\nexit 0\n");
    if (preflight.onPath) writeStub("bwrap", "#!/bin/sh\nexit 0\n");
    else rmSync(join(isolatedBin, "bwrap"), { force: true });
    setPresent(preflight.present);

    const result = runInstaller(derivedInstaller);
    assert.equal(
      result.status,
      0,
      `${preflight.label}: preflight must warn, never fail\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    if (preflight.hint) {
      assert.match(result.stdout, new RegExp(HINT), `${preflight.label}: expected the warning`);
      assert.ok(
        result.stdout.includes(preflight.hint),
        `${preflight.label}: expected hint ${preflight.hint}\ngot:\n${result.stdout}`,
      );
    } else {
      assert.doesNotMatch(result.stdout, /bubblewrap/, `${preflight.label}: must stay silent`);
    }
    assert.equal(linkedVersion("current"), "0.0.09", `${preflight.label}: install must stay intact`);
  }
  // The SHIPPED script must also survive a real run here; the derived copy only repoints one line.
  rmSync(join(isolatedBin, "bwrap"), { force: true });
  writeStub("uname", "#!/bin/sh\necho Darwin\n");
  const shippedRun = runInstaller(join(root, "vinci", "install.sh"));
  assert.equal(shippedRun.status, 0, `shipped installer must still succeed\n${shippedRun.stderr}`);
  assert.doesNotMatch(shippedRun.stdout, /bubblewrap/, "macOS must never see the bubblewrap notice");
  rmSync(join(isolatedBin, "uname"), { force: true });

  const second = createRelease("0.0.10", 2, "0.0.09");
  const concurrentUpdates = await Promise.all([
    runAsync(join(binDir, "vinci"), ["--payload-version"]),
    runAsync(join(binDir, "vinci"), ["--payload-version"]),
  ]);
  assert.deepEqual(
    concurrentUpdates.map((result) => result.stdout.trim()),
    ["0.0.10", "0.0.10"],
  );
  assert.equal(
    concurrentUpdates.filter((result) => /Updated to Vinci Code 0\.0\.10/.test(result.stderr)).length,
    1,
  );
  assert.equal(linkedVersion("current"), "0.0.10");
  assert.equal(linkedVersion("previous"), "0.0.09");

  assert.match(run(join(binDir, "vinci"), ["update", "--check"]).stdout, /Update: current/);
  assert.match(run(join(binDir, "vinci"), ["rollback"]).stdout, /Rolled back to Vinci Code 0\.0\.09/);
  assert.equal(linkedVersion("current"), "0.0.09");
  assert.equal(run(join(binDir, "vinci"), ["--payload-version"]).stdout.trim(), "0.0.09");
  const rollbackBootstrap = readFileSync(join(home, "updater", "update.mjs"), "utf8");
  assert.equal(
    rollbackBootstrap.match(/\/\/ payload-updater-version: (\d+\.\d+\.\d+)\s*$/)?.[1],
    "0.0.10",
    "#91 rollback no-downgrade revert-proof: launching rolled-back vA must not replace bootstrap uB with older uA",
  );
  assert.equal(
    rollbackBootstrap,
    readFileSync(join(home, "versions", "0.0.10", "vinci", "updater", "update.mjs"), "utf8"),
    "#91 rollback no-downgrade: bootstrap bytes must remain the newer uB payload's bytes",
  );
  run(join(binDir, "vinci"), ["update"]);
  assert.equal(linkedVersion("current"), "0.0.10");

  // A DOWNLOADED update must refresh the bootstrap updater, not just the payload.
  //
  // The launcher runs $VINCI_HOME/updater/update.mjs — the bootstrap copy — so if only
  // install-extracted refreshes it, the updater can never fix itself: new payloads ship while the
  // executing updater stays frozen at whatever version last ran the installer. That shipped: on
  // 0.0.35 both installed payloads carried the version-pruning logic while the running bootstrap
  // was months older and had none of it, so versions/ grew exactly as if the fix did not exist.
  //
  // Assert on the per-version marker each fixture payload carries, not on file equality: every
  // payload otherwise holds an identical copy of the repo's updater, so equality would hold with
  // the refresh removed.
  {
    const bootstrap = readFileSync(join(home, "updater", "update.mjs"), "utf8");
    assert.match(
      bootstrap,
      /\/\/ payload-updater-version: 0\.0\.10\b/,
      "a downloaded update must copy the payload's updater over the bootstrap one, or updater fixes never reach users " +
        "(the bootstrap is what the launcher executes, so a stale one means the updater can never fix itself)",
    );
  }

  const broken = createRelease("0.0.11", 3);
  writeFileSync(broken.artifact, "corrupt", { flag: "a" });
  const blocked = run(join(binDir, "vinci"), ["--payload-version"], 75);
  assert.match(blocked.stderr, /BLOCKED: update/);
  assert.equal(linkedVersion("current"), "0.0.10");

  writeFileSync(manifestPath, second.manifest);
  const remoteRollback = createRelease("0.0.09", 4, "0.0.09");
  assert.ok(remoteRollback.artifact);
  assert.equal(run(join(binDir, "vinci"), ["--payload-version"]).stdout.trim(), "0.0.09");
  assert.equal(linkedVersion("current"), "0.0.09");
  assert.equal(linkedVersion("previous"), "0.0.10");

  const tampered = JSON.parse(readFileSync(manifestPath, "utf8"));
  tampered.signed.version = "9.9.9";
  writeFileSync(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
  const rejected = run(
    "node",
    [join(home, "updater", "update.mjs"), "verify-manifest", "--manifest", manifestPath],
    1,
  );
  assert.match(rejected.stderr, /signature verification failed/);

  const doctor = run(join(binDir, "vinci"), ["doctor"]);
  assert.match(doctor.stdout, /Updater: ready/);
  assert.match(doctor.stdout, /Installation: healthy/);
  assert.equal(readFileSync(first.artifact).length > 0, true);

  function listVersions() {
    const versionsDir = join(home, "versions");
    const entries = existsSync(versionsDir)
      ? readdirSync(versionsDir).filter((entry) => !entry.startsWith(".")).sort()
      : [];
    return entries;
  }

  // Pre-pruning state: versions/ contains 0.0.09 (current) and 0.0.10 (previous).
  createRelease("0.0.12", 5, "0.0.12");
  run("node", [join(root, "vinci", "updater", "update.mjs"),
    "install-extracted",
    "--home",
    home,
    "--bin-dir",
    binDir,
    "--source",
    join(releases, "0.0.12-5", "payload"),
    "--manifest",
    manifestPath,
  ]);
  // Installing 0.0.12 makes it current; the prior current (0.0.09) becomes
  // previous, so both are retained. With RETAINED_VERSIONS=3, 0.0.10 is also retained.
  assert.deepEqual(listVersions(), ["0.0.09", "0.0.10", "0.0.12"]);
  assert.equal(linkedVersion("current"), "0.0.12");
  assert.equal(linkedVersion("previous"), "0.0.09");

  createRelease("0.0.13", 6, "0.0.12");
  run("node", [join(root, "vinci", "updater", "update.mjs"),
    "install-extracted",
    "--home",
    home,
    "--bin-dir",
    binDir,
    "--source",
    join(releases, "0.0.13-6", "payload"),
    "--manifest",
    manifestPath,
  ]);
  assert.deepEqual(listVersions(), ["0.0.10", "0.0.12", "0.0.13"]);
  assert.equal(linkedVersion("current"), "0.0.13");
  assert.equal(linkedVersion("previous"), "0.0.12");

  createRelease("0.0.14", 7, "0.0.12");
  run("node", [join(root, "vinci", "updater", "update.mjs"),
    "install-extracted",
    "--home",
    home,
    "--bin-dir",
    binDir,
    "--source",
    join(releases, "0.0.14-7", "payload"),
    "--manifest",
    manifestPath,
  ]);
  assert.deepEqual(listVersions(), ["0.0.12", "0.0.13", "0.0.14"]);
  assert.equal(linkedVersion("current"), "0.0.14");
  assert.equal(linkedVersion("previous"), "0.0.13");

  run(join(binDir, "vinci"), ["rollback"]);
  assert.equal(linkedVersion("current"), "0.0.13");
  assert.equal(linkedVersion("previous"), "0.0.14");
  assert.deepEqual(listVersions(), ["0.0.12", "0.0.13", "0.0.14"]);
  run(join(binDir, "vinci"), ["update"]);
  assert.equal(linkedVersion("current"), "0.0.14");

  // pruning failures must not fail the update: make versions/ unreadable so
  // pruneVersions' readdir throws EACCES while install still succeeds.
  const pruneFailHome = mkdtempSync(join(tmpdir(), "vinci-update-prune-fail-"));
  mkdirSync(join(pruneFailHome, "versions", "0.0.99"), { recursive: true });
  mkdirSync(join(pruneFailHome, "bin"), { recursive: true });
  chmodSync(join(pruneFailHome, "versions"), 0o300);
  createRelease("0.0.15", 8, "0.0.12");
  const pruneResult = spawnSync(
    "node",
    [
      join(root, "vinci", "updater", "update.mjs"),
      "install-extracted",
      "--home",
      pruneFailHome,
      "--bin-dir",
      join(pruneFailHome, "bin"),
      "--source",
      join(releases, "0.0.15-8", "payload"),
      "--manifest",
      manifestPath,
    ],
    { cwd: root, encoding: "utf8", env: { ...environment, VINCI_HOME: pruneFailHome, VINCI_BIN_DIR: join(pruneFailHome, "bin") } },
  );
  chmodSync(join(pruneFailHome, "versions"), 0o700);
  assert.equal(pruneResult.status, 0, `prune-fail install exited ${pruneResult.status}\nstderr:\n${pruneResult.stderr}`);
  assert.match(pruneResult.stderr, /Pruning skipped/);
  // the leftover remains because prune could not run
  assert.equal(existsSync(join(pruneFailHome, "versions", "0.0.99")), true);
  rmSync(pruneFailHome, { recursive: true, force: true });

  
  // Test: downloadAndInstall pruning is covered by real update path
  // This test verifies that pruneVersions is called during downloadAndInstall
  // by updating through multiple versions and checking retention.
  const downloadPruneHome = mkdtempSync(join(tmpdir(), "vinci-update-download-prune-"));
  const downloadPruneBinDir = join(downloadPruneHome, "bin");
  mkdirSync(downloadPruneBinDir, { recursive: true });
  
  // Create and install initial version
  createRelease("0.0.20", 10, "0.0.20");
  run("node", [
    join(root, "vinci", "updater", "update.mjs"),
    "install-extracted",
    "--home", downloadPruneHome,
    "--bin-dir", downloadPruneBinDir,
    "--source", join(releases, "0.0.20-10", "payload"),
    "--manifest", manifestPath,
  ]);
  
  // Update through multiple versions to trigger downloadAndInstall pruning
  for (let v = 21; v <= 25; v++) {
    const prev = v - 1;
    createRelease(`0.0.${v}`, v, `0.0.${prev}`);
    writeFileSync(manifestPath, createRelease(`0.0.${v}`, v, `0.0.${prev}`).manifest);
    const downloadEnv = {
      ...environment,
      VINCI_HOME: downloadPruneHome,
      VINCI_BIN_DIR: downloadPruneBinDir,
    };
    spawnSync("node", [join(root, "vinci", "updater", "update.mjs"), "before-launch"], {
      cwd: root,
      encoding: "utf8",
      env: downloadEnv,
    });
  }
  
  // After updating to 0.0.25, should retain: 0.0.23, 0.0.24, 0.0.25 (RETAINED_VERSIONS=3)
  const versionsList = readdirSync(join(downloadPruneHome, "versions"))
    .filter((v) => !v.startsWith("."))
    .sort();
  assert.deepEqual(versionsList, ["0.0.23", "0.0.24", "0.0.25"]);
  rmSync(downloadPruneHome, { recursive: true, force: true });

  // Test: a dangling `current` makes the prune a no-op.
  //
  // This drives the internal `prune-versions` entry point rather than an install, and that is
  // deliberate: both production call sites run activateTarget() before pruning, which always
  // re-points `current` at a freshly installed version. Reached through an install, `current`
  // is never dangling by the time the prune runs, so the guard cannot fire and a test built
  // that way passes whether or not the guard exists.
  //
  // The fixture holds MORE than RETAINED_VERSIONS entries on purpose. With three or fewer, the
  // count rule alone would retain everything and the assertion would hold with the guard gone.
  const danglingHome = mkdtempSync(join(tmpdir(), "vinci-update-dangling-"));
  mkdirSync(join(danglingHome, "versions"), { recursive: true });
  const danglingVersions = ["0.0.91", "0.0.92", "0.0.93", "0.0.94", "0.0.95", "0.0.96"];
  for (const v of danglingVersions) {
    mkdirSync(join(danglingHome, "versions", v), { recursive: true });
  }
  // `current` points at a version directory that does not exist.
  symlinkSync(join(danglingHome, "versions", "0.0.99"), join(danglingHome, "current"));

  const danglingResult = spawnSync(
    "node",
    [join(root, "vinci", "updater", "update.mjs"), "prune-versions", "--home", danglingHome],
    { cwd: root, encoding: "utf8", env: { ...environment, VINCI_HOME: danglingHome } },
  );
  assert.equal(danglingResult.status, 0, `prune-versions exited ${danglingResult.status}\n${danglingResult.stderr}`);

  // EVERY version survives — including the three outside the retention window, which only the
  // dangling-current guard can save. Remove that guard and 0.0.91/92/93 are deleted.
  for (const v of danglingVersions) {
    assert.equal(
      existsSync(join(danglingHome, "versions", v)),
      true,
      `${v} must survive a prune when current is dangling`,
    );
  }
  rmSync(danglingHome, { recursive: true, force: true });

  // Test: a symlinked versions/ directory is refused outright.
  //
  // Driven through `prune-versions` for the same reason as the dangling case, and stocked with
  // MORE than RETAINED_VERSIONS entries on purpose: with only one or two, the count rule retains
  // everything and the assertion holds whether or not the containment guard exists. Here the three
  // oldest fall outside the window, so only the guard can save them — remove it and readdir()/rm()
  // follow the symlink and delete external data.
  const symVersionsHome = mkdtempSync(join(tmpdir(), "vinci-update-symlinked-versions-"));
  const externalVersionsDir = mkdtempSync(join(tmpdir(), "vinci-update-external-versions-"));
  const externalVersions = ["0.0.81", "0.0.82", "0.0.83", "0.0.84", "0.0.85", "0.0.86"];
  for (const v of externalVersions) {
    mkdirSync(join(externalVersionsDir, v), { recursive: true });
  }

  mkdirSync(symVersionsHome, { recursive: true });
  symlinkSync(externalVersionsDir, join(symVersionsHome, "versions"));
  symlinkSync(join(externalVersionsDir, "0.0.86"), join(symVersionsHome, "current"));

  const symVersionsResult = spawnSync(
    "node",
    [join(root, "vinci", "updater", "update.mjs"), "prune-versions", "--home", symVersionsHome],
    { cwd: root, encoding: "utf8", env: { ...environment, VINCI_HOME: symVersionsHome } },
  );
  assert.equal(
    symVersionsResult.status,
    0,
    `prune-versions exited ${symVersionsResult.status}\n${symVersionsResult.stderr}`,
  );
  // Nothing outside the Vinci home may be touched, including entries the count rule would drop.
  for (const v of externalVersions) {
    assert.equal(
      existsSync(join(externalVersionsDir, v)),
      true,
      `${v} must survive: a symlinked versions/ must be refused, not followed`,
    );
  }
  rmSync(symVersionsHome, { recursive: true, force: true });
  rmSync(externalVersionsDir, { recursive: true, force: true });

  // Test: Symlinked entry inside versions/ is removed, but its target survives
  const symEntryHome = mkdtempSync(join(tmpdir(), "vinci-update-symlinked-entry-"));
  const symEntryBinDir = join(symEntryHome, "bin");
  mkdirSync(join(symEntryHome, "versions"), { recursive: true });
  mkdirSync(symEntryBinDir, { recursive: true });
  
  // Create external directory to be linked from versions/
  const externalTarget = mkdtempSync(join(tmpdir(), "vinci-update-external-target-"));
  mkdirSync(join(externalTarget, "important"), { recursive: true });
  writeFileSync(join(externalTarget, "important", "data.txt"), "KEEP THIS DATA");
  
  // Create symlink in versions/ pointing to external target
  symlinkSync(externalTarget, join(symEntryHome, "versions", "external-link"));
  
  // Install version as current
  createRelease("0.0.86", 86, "0.0.86");
  run("node", [
    join(root, "vinci", "updater", "update.mjs"),
    "install-extracted",
    "--home", symEntryHome,
    "--bin-dir", symEntryBinDir,
    "--source", join(releases, "0.0.86-86", "payload"),
    "--manifest", manifestPath,
  ]);
  
  // Install another version - pruning should remove the symlink but not its target
  createRelease("0.0.87", 87, "0.0.86");
  run("node", [
    join(root, "vinci", "updater", "update.mjs"),
    "install-extracted",
    "--home", symEntryHome,
    "--bin-dir", symEntryBinDir,
    "--source", join(releases, "0.0.87-87", "payload"),
    "--manifest", manifestPath,
  ]);
  
  // Symlink should be gone
  assert.equal(existsSync(join(symEntryHome, "versions", "external-link")), false);
  // But external target should still exist
  assert.equal(existsSync(join(externalTarget, "important", "data.txt")), true);
  assert.equal(readFileSync(join(externalTarget, "important", "data.txt"), "utf8"), "KEEP THIS DATA");
  rmSync(symEntryHome, { recursive: true, force: true });
  rmSync(externalTarget, { recursive: true, force: true });

  // Test: a PRE-FIX bootstrap is healed by a current payload.
  //
  // This is the rollout case, and the one an earlier version of this work got wrong. The shim runs
  // $VINCI_HOME/updater/update.mjs for every command, so on an existing install the update is
  // performed BY the stale updater — which, being pre-fix, cannot contain the code that replaces
  // itself. Adding the refresh to downloadAndInstall alone therefore repairs nobody: it only helps
  // installs whose bootstrap is already current. The heal must run from the PAYLOAD, which the shim
  // execs and which is always current after an update.
  //
  // Drives the REAL vinci/bin/vinci launcher (not the fixture stub) with a deliberately stale
  // bootstrap, and asserts the bootstrap is replaced by the payload's copy.
  {
    const healHome = mkdtempSync(join(tmpdir(), "vinci-update-heal-"));
    const payloadRoot = join(healHome, "versions", "0.0.50");
    mkdirSync(join(payloadRoot, "vinci", "bin"), { recursive: true });
    mkdirSync(join(payloadRoot, "vinci", "scripts"), { recursive: true });
    mkdirSync(join(payloadRoot, "vinci", "updater"), { recursive: true });
    mkdirSync(join(healHome, "bin"), { recursive: true });
    mkdirSync(join(healHome, "updater"), { recursive: true });

    // The real launcher, and the real current updater as the payload's copy.
    copyFileSync(join(root, "vinci", "bin", "vinci"), join(payloadRoot, "vinci", "bin", "vinci"));
    copyFileSync(
      join(root, "vinci", "scripts", "reap-heal-temp.mjs"),
      join(payloadRoot, "vinci", "scripts", "reap-heal-temp.mjs"),
    );
    chmodSync(join(payloadRoot, "vinci", "bin", "vinci"), 0o755);
    writeFileSync(join(payloadRoot, "vinci", "updater", "update.mjs"), updaterSourceAtVersion("2.0.0"));
    writeFileSync(
      join(payloadRoot, "vinci", "identity.json"),
      `${JSON.stringify({ productName: "Vinci Code", command: "vinci", version: "0.0.50" }, null, 2)}\n`,
    );
    const shim = join(healHome, "bin", "vinci");
    writeFileSync(shim, '#!/usr/bin/env sh\nexec bash "$VINCI_HOME/current/vinci/bin/vinci" "$@"\n');
    chmodSync(shim, 0o755);
    symlinkSync(payloadRoot, join(healHome, "current"));

    // A stale bootstrap: valid script, but demonstrably not the payload's.
    const staleBootstrap = "#!/usr/bin/env node\n// stale pre-fix bootstrap\nprocess.exit(0);\n";
    writeFileSync(join(healHome, "updater", "update.mjs"), staleBootstrap);

    const healRun = spawnSync(join(healHome, "bin", "vinci"), ["--version"], {
      encoding: "utf8",
      env: { ...environment, VINCI_HOME: healHome },
    });
    assert.equal(healRun.status, 0, `launcher exited ${healRun.status}: ${healRun.stderr}`);
    assert.equal(healRun.stdout.trim(), "0.0.50", "the launcher must still answer --version normally");

    const healed = readFileSync(join(healHome, "updater", "update.mjs"), "utf8");
    assert.notEqual(healed, staleBootstrap, "a stale bootstrap must be replaced by the payload's updater");
    assert.equal(
      healed,
      readFileSync(join(payloadRoot, "vinci", "updater", "update.mjs"), "utf8"),
      "the healed bootstrap must be byte-identical to the payload's updater, or updater fixes never reach existing installs",
    );

    // An older embedded updater must never downgrade the newest trusted bootstrap.
    const newerBootstrap = updaterSourceAtVersion("3.0.0").replace(
      "// payload-updater-version: 3.0.0",
      "// bootstrap-only bytes\n// payload-updater-version: 3.0.0",
    );
    writeFileSync(join(healHome, "updater", "update.mjs"), newerBootstrap);
    const noDowngradeRun = spawnSync(join(healHome, "bin", "vinci"), ["--version"], {
      encoding: "utf8",
      env: { ...environment, VINCI_HOME: healHome },
    });
    assert.equal(noDowngradeRun.status, 0, `older-updater launcher exited ${noDowngradeRun.status}: ${noDowngradeRun.stderr}`);
    assert.equal(
      readFileSync(join(healHome, "updater", "update.mjs"), "utf8"),
      newerBootstrap,
      "heal no-downgrade: an older embedded updater must leave a newer bootstrap byte-for-byte unchanged",
    );

    // Reap only aged regular heal files. Fresh files, unrelated files, and symlinks survive.
    const staleOrphan = join(healHome, "updater", "update.mjs.heal-12345");
    const freshOrphan = join(healHome, "updater", "update.mjs.heal-23456");
    const unrelated = join(healHome, "updater", "update.mjs.not-a-heal");
    const symlinkTarget = join(healHome, "updater", "symlink-target");
    const staleSymlink = join(healHome, "updater", "update.mjs.heal-34567");
    writeFileSync(staleOrphan, "stale");
    writeFileSync(freshOrphan, "fresh");
    writeFileSync(unrelated, "unrelated");
    writeFileSync(symlinkTarget, "target");
    symlinkSync(symlinkTarget, staleSymlink);
    const aged = new Date(Date.now() - 61 * 60 * 1_000);
    utimesSync(staleOrphan, aged, aged);
    writeFileSync(join(healHome, "updater", "update.mjs"), updaterSourceAtVersion("1.0.0"));
    const reapRun = spawnSync(join(healHome, "bin", "vinci"), ["--version"], {
      encoding: "utf8",
      env: { ...environment, VINCI_HOME: healHome },
    });
    assert.equal(reapRun.status, 0, `orphan-reap launcher exited ${reapRun.status}: ${reapRun.stderr}`);
    assert.equal(existsSync(staleOrphan), false, "#92 orphan reaping: an aged heal temp must be reaped");
    assert.equal(existsSync(freshOrphan), true, "#92 orphan reaping: a fresh heal temp must be kept");
    assert.equal(readFileSync(unrelated, "utf8"), "unrelated", "#92 orphan reaping: unrelated files must be untouched");
    assert.equal(lstatSync(staleSymlink).isSymbolicLink(), true, "#92 orphan reaping: heal symlinks must never be followed or removed");

    // A same-PID temp is live, even if its mtime is old. Pause before exec so the test can seed the
    // exact $$ path, then let a cp stub record whether reaping incorrectly removed it.
    const samePidBin = join(healHome, "same-pid-bin");
    const samePidSeen = join(healHome, "same-pid-seen");
    mkdirSync(samePidBin);
    writeFileSync(
      join(samePidBin, "cp"),
      '#!/bin/sh\n[ -e "$2" ] && : > "$VINCI_SAME_PID_SEEN"\nexit 1\n',
    );
    chmodSync(join(samePidBin, "cp"), 0o755);
    writeFileSync(join(healHome, "updater", "update.mjs"), updaterSourceAtVersion("1.0.0"));
    const samePidChild = spawn(
      "bash",
      ["-c", 'kill -STOP $$; exec bash "$1" --version', "vinci-same-pid", join(payloadRoot, "vinci", "bin", "vinci")],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...environment,
          PATH: `${samePidBin}:${process.env.PATH ?? ""}`,
          VINCI_HOME: healHome,
          VINCI_SAME_PID_SEEN: samePidSeen,
        },
      },
    );
    const samePidDone = waitForChild(samePidChild);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const samePidTemp = join(healHome, "updater", `update.mjs.heal-${samePidChild.pid}`);
    writeFileSync(samePidTemp, "live temp");
    utimesSync(samePidTemp, aged, aged);
    samePidChild.kill("SIGCONT");
    const samePidResult = await samePidDone;
    assert.equal(samePidResult.status, 0, `same-PID launcher failed with ${samePidResult.signal}`);
    assert.equal(existsSync(samePidSeen), true, "#92 orphan reaping: the current process's own aged temp must not be reaped");

    // Kill a heal after cp has created its temp. The next launch reaps that aged orphan.
    const interruptedBin = join(healHome, "interrupted-bin");
    const interruptedDestination = join(healHome, "interrupted-destination");
    mkdirSync(interruptedBin);
    writeFileSync(
      join(interruptedBin, "cp"),
      '#!/bin/sh\n/bin/cp "$1" "$2"\nprintf "%s" "$2" > "$VINCI_INTERRUPTED_DESTINATION"\nwhile :; do sleep 1; done\n',
    );
    chmodSync(join(interruptedBin, "cp"), 0o755);
    writeFileSync(join(healHome, "updater", "update.mjs"), updaterSourceAtVersion("1.0.0"));
    const interruptedChild = spawn("bash", [join(payloadRoot, "vinci", "bin", "vinci"), "--version"], {
      detached: true,
      stdio: "ignore",
      env: {
        ...environment,
        PATH: `${interruptedBin}:${process.env.PATH ?? ""}`,
        VINCI_HOME: healHome,
        VINCI_INTERRUPTED_DESTINATION: interruptedDestination,
      },
    });
    const interruptedDone = waitForChild(interruptedChild);
    await waitForPath(interruptedDestination);
    process.kill(-interruptedChild.pid, "SIGKILL");
    await interruptedDone;
    const interruptedTemp = readFileSync(interruptedDestination, "utf8");
    assert.equal(existsSync(interruptedTemp), true, "#92 interrupted heal must leave a temp when killed after cp");
    utimesSync(interruptedTemp, aged, aged);
    const nextHealRun = spawnSync(join(healHome, "bin", "vinci"), ["--version"], {
      encoding: "utf8",
      env: { ...environment, VINCI_HOME: healHome },
    });
    assert.equal(nextHealRun.status, 0, `post-interruption launcher exited ${nextHealRun.status}: ${nextHealRun.stderr}`);
    assert.equal(existsSync(interruptedTemp), false, "#92 interrupted heal: the next launch must reap the age-forced orphan");

    // And the guard: a payload OUTSIDE $VINCI_HOME/versions (a repo checkout) must not overwrite it.
    writeFileSync(join(healHome, "updater", "update.mjs"), staleBootstrap);
    const outsideRun = spawnSync(join(root, "vinci", "bin", "vinci"), ["--version"], {
      encoding: "utf8",
      env: { ...environment, VINCI_HOME: healHome },
    });
    assert.equal(outsideRun.status, 0, "the repo launcher must still run");
    assert.equal(
      readFileSync(join(healHome, "updater", "update.mjs"), "utf8"),
      staleBootstrap,
      "a repo checkout must NOT push its working tree over an installed bootstrap",
    );

    // Two near-miss layouts the containment check must also refuse. Both look like an install to a
    // careless prefix comparison, and both would let a non-payload overwrite a user's bootstrap.
    const refuses = (label, payloadDir) => {
      mkdirSync(join(payloadDir, "vinci", "bin"), { recursive: true });
      mkdirSync(join(payloadDir, "vinci", "updater"), { recursive: true });
      copyFileSync(join(root, "vinci", "bin", "vinci"), join(payloadDir, "vinci", "bin", "vinci"));
      chmodSync(join(payloadDir, "vinci", "bin", "vinci"), 0o755);
      copyFileSync(join(root, "vinci", "updater", "update.mjs"), join(payloadDir, "vinci", "updater", "update.mjs"));
      writeFileSync(
        join(payloadDir, "vinci", "identity.json"),
        `${JSON.stringify({ productName: "Vinci Code", command: "vinci", version: "9.9.9" }, null, 2)}\n`,
      );
      writeFileSync(join(healHome, "updater", "update.mjs"), staleBootstrap);
      const run = spawnSync("bash", [join(payloadDir, "vinci", "bin", "vinci"), "--version"], {
        encoding: "utf8",
        env: { ...environment, VINCI_HOME: healHome },
      });
      assert.equal(run.status, 0, `${label}: the launcher must still run (${run.stderr})`);
      assert.equal(
        readFileSync(join(healHome, "updater", "update.mjs"), "utf8"),
        staleBootstrap,
        `${label} must NOT be treated as an installed payload and overwrite the bootstrap`,
      );
    };
    // Inside $VINCI_HOME, but not under versions/ — e.g. someone clones the repo into their install.
    refuses("a checkout inside $VINCI_HOME", join(healHome, "src"));
    // A sibling whose path merely shares a prefix with $VINCI_HOME: a plain string-prefix test
    // matches "<home>-evil/versions/..." against "<home>" and heals from a directory we do not own.
    const evilHome = `${healHome}-evil`;
    refuses("a sibling sharing $VINCI_HOME's path prefix", join(evilHome, "versions", "9.9.9"));
    rmSync(evilHome, { recursive: true, force: true });

    // A retained payload is inside versions/ but is not the current actor, so it cannot heal.
    const retainedRoot = join(healHome, "versions", "9.9.8");
    mkdirSync(join(retainedRoot, "vinci", "bin"), { recursive: true });
    mkdirSync(join(retainedRoot, "vinci", "updater"), { recursive: true });
    copyFileSync(join(root, "vinci", "bin", "vinci"), join(retainedRoot, "vinci", "bin", "vinci"));
    chmodSync(join(retainedRoot, "vinci", "bin", "vinci"), 0o755);
    writeFileSync(join(retainedRoot, "vinci", "updater", "update.mjs"), updaterSourceAtVersion("9.9.8"));
    writeFileSync(
      join(retainedRoot, "vinci", "identity.json"),
      `${JSON.stringify({ productName: "Vinci Code", command: "vinci", version: "9.9.8" }, null, 2)}\n`,
    );
    const actorRestrictedBootstrap = updaterSourceAtVersion("2.0.0");
    writeFileSync(join(healHome, "updater", "update.mjs"), actorRestrictedBootstrap);
    const retainedRun = spawnSync("bash", [join(retainedRoot, "vinci", "bin", "vinci"), "--version"], {
      encoding: "utf8",
      env: { ...environment, VINCI_HOME: healHome },
    });
    assert.equal(retainedRun.status, 0, `retained-payload launcher exited ${retainedRun.status}: ${retainedRun.stderr}`);
    assert.equal(
      readFileSync(join(healHome, "updater", "update.mjs"), "utf8"),
      actorRestrictedBootstrap,
      "heal actor restriction: direct execution of a non-current retained payload must not change bootstrap bytes",
    );

    rmSync(healHome, { recursive: true, force: true });
  }

  // The automatic check has one aggregate wall-clock bound. Mandatory failures still block, fast
  // checks behave normally, explicit commands remain unbounded, and the payload owns final status.
  {
    const timeoutHome = mkdtempSync(join(tmpdir(), "vinci-update-timeout-"));
    const timeoutUpdaterDir = join(timeoutHome, "updater");
    const timeoutPayloadBin = join(timeoutHome, "current", "vinci", "bin");
    mkdirSync(timeoutUpdaterDir, { recursive: true });
    mkdirSync(timeoutPayloadBin, { recursive: true });
    copyFileSync(join(root, "vinci", "updater", "vinci"), join(timeoutHome, "vinci"));
    chmodSync(join(timeoutHome, "vinci"), 0o755);
    writeFileSync(
      join(timeoutUpdaterDir, "update.mjs"),
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const command = process.argv[2];
const mode = process.env.VINCI_TIMEOUT_FIXTURE_MODE;
if (command === "before-launch" && mode === "hang") {
  const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 10; done"], { stdio: "ignore" });
  writeFileSync(process.env.VINCI_TIMEOUT_CHILD_PID, String(child.pid));
  setInterval(() => {}, 60_000);
} else if (command === "before-launch" && mode === "mandatory") {
  process.exit(75);
} else if (command === "before-launch") {
  process.exit(0);
} else {
  setTimeout(() => process.exit(17), 1_500);
}
`,
    );
    writeFileSync(
      join(timeoutPayloadBin, "vinci"),
      '#!/bin/sh\necho payload-launched\nexit "${VINCI_FIXTURE_PAYLOAD_STATUS:-23}"\n',
    );
    chmodSync(join(timeoutPayloadBin, "vinci"), 0o755);
    const timeoutChildPid = join(timeoutHome, "timeout-child.pid");
    const timeoutEnvironment = {
      ...environment,
      VINCI_HOME: timeoutHome,
      VINCI_UPDATER_TIMEOUT_MS: "1000",
      VINCI_TIMEOUT_CHILD_PID: timeoutChildPid,
    };

    const timeoutStarted = Date.now();
    const timeoutRun = await runWithLimit(
      join(timeoutHome, "vinci"),
      [],
      { ...timeoutEnvironment, VINCI_TIMEOUT_FIXTURE_MODE: "hang" },
      8_000,
    );
    const timeoutElapsed = Date.now() - timeoutStarted;
    assert.equal(
      timeoutRun.status,
      23,
      `#138 automatic before-launch liveness timeout revert-proof: launcher must fall through to payload status 23 ` +
        `(limit exceeded: ${timeoutRun.exceededLimit}, signal: ${timeoutRun.signal})\n${timeoutRun.stderr}`,
    );
    assert.ok(
      timeoutElapsed < 6_000,
      `#138 automatic before-launch liveness timeout revert-proof: launch took ${timeoutElapsed}ms instead of timing out`,
    );
    assert.equal(timeoutRun.stdout.trim(), "payload-launched", "timed-out update must fall through to current payload");
    assert.match(timeoutRun.stderr, /update check timed out.*continuing with the installed version/i, "timeout must emit one-line stderr notice");
    assert.equal(
      timeoutRun.stderr.trim().split("\n").filter((line) => /timed out/i.test(line)).length,
      1,
      "timeout must emit exactly one timeout notice",
    );
    const descendantPid = Number(readFileSync(timeoutChildPid, "utf8"));
    let descendantAlive = true;
    const descendantDeadline = Date.now() + 1_000;
    while (descendantAlive && Date.now() < descendantDeadline) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      } catch {
        descendantAlive = false;
      }
    }
    assert.equal(descendantAlive, false, "timeout must kill the updater's process group, including descendants");

    const mandatoryRun = spawnSync(join(timeoutHome, "vinci"), [], {
      encoding: "utf8",
      env: { ...timeoutEnvironment, VINCI_TIMEOUT_FIXTURE_MODE: "mandatory" },
    });
    assert.equal(mandatoryRun.status, 75, "a known mandatory before-launch failure must still block with status 75");
    assert.doesNotMatch(mandatoryRun.stdout, /payload-launched/, "mandatory failure must not launch the payload");

    const fastRun = spawnSync(join(timeoutHome, "vinci"), [], {
      encoding: "utf8",
      env: { ...timeoutEnvironment, VINCI_TIMEOUT_FIXTURE_MODE: "fast" },
    });
    assert.equal(fastRun.status, 23, "a fast before-launch check must preserve the launched payload's status");
    assert.doesNotMatch(fastRun.stderr, /timed out/i, "a fast before-launch check must not report a timeout");

    const explicitStarted = Date.now();
    const explicitRun = spawnSync(join(timeoutHome, "vinci"), ["doctor"], {
      encoding: "utf8",
      env: { ...timeoutEnvironment, VINCI_TIMEOUT_FIXTURE_MODE: "hang" },
      timeout: 5_000,
    });
    assert.equal(explicitRun.status, 17, "explicit updater commands must return their own status without the automatic bound");
    assert.ok(Date.now() - explicitStarted >= 1_300, "explicit updater commands must not use VINCI_UPDATER_TIMEOUT_MS");

    rmSync(timeoutHome, { recursive: true, force: true });
  }

console.log("update-integration: signed install, bubblewrap preflight, concurrent update, mandatory failure, rollback, recovery, pruning, downloadAndInstall coverage, dangling symlink, symlinked versions, symlinked entry, bootstrap-heal, orphan-reaping, and launcher-timeout tests passed");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
