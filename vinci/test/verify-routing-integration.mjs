import assert from "node:assert/strict";
import { accessSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = join(root, "vinci/bin/vinci");
const launcherSource = readFileSync(launcher, "utf8");
const identity = JSON.parse(readFileSync(join(root, "vinci/identity.json"), "utf8"));

assert.match(
  launcherSource,
  /--extension "\$\{VINCI\}\/extensions\/vinci-accept\.ts"/,
  "launcher must register vinci-accept",
);
assert(identity.extensions.includes("vinci-accept.ts"), "identity must register vinci-accept");

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

function run(path, home, marker, args, overrides = {}) {
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
    cwd: root,
    env,
    encoding: "utf8",
    input: "stdin reaches vac\n",
  });
}

const temp = mkdtempSync(join(tmpdir(), "vinci-verify-routing-"));
try {
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
    `#!/bin/sh\nIFS= read -r input\nprintf '%s' "$input" > "\${VAC_STDIN_CAPTURE}"\n"${process.execPath}" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@"\nprintf 'vac stderr\\n' >&2\nexit 3\n`,
  );

  const routed = run(pathWithVac, home, piMarker, ["--json", "extra-arg"], {
    VAC_STDIN_CAPTURE: stdinCapture,
  });
  assert.equal(routed.status, 3, routed.stderr);
  assert.equal(routed.stdout, '["--json","extra-arg"]');
  assert.equal(routed.stderr, "vac stderr\n");
  assert.equal(readFileSync(stdinCapture, "utf8"), "stdin reaches vac");
  assert.equal(existsSync(piMarker), false, "verify route started the Pi agent");

  const unavailable = run(pathWithoutVac, home, piMarker, ["some-arg"]);
  assert.equal(unavailable.status, 127, unavailable.stderr);
  assert.equal(unavailable.stdout, "");
  assert.match(unavailable.stderr, /Verification isn't set up yet/);
  assert.equal(existsSync(piMarker), false, "missing-vac route started the Pi agent");

  rmSync(stdinCapture, { force: true });
  const overridden = run(pathWithoutVac, home, piMarker, ["two words", ""], {
    VAC_CLI_PATH: vac,
    VAC_STDIN_CAPTURE: stdinCapture,
  });
  assert.equal(overridden.status, 3, overridden.stderr);
  assert.equal(overridden.stdout, '["two words",""]');
  assert.equal(overridden.stderr, "vac stderr\n");
  assert.equal(readFileSync(stdinCapture, "utf8"), "stdin reaches vac");
  assert.equal(existsSync(piMarker), false, "VAC_CLI_PATH route started the Pi agent");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("  verify routing integration: vac receives unchanged I/O, arguments, and exit status without starting Pi\n");
