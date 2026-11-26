// Launcher terminal writes (spec r4 section 2 and section 4 row 1): a rich interactive launch keeps the
// screen clear before Pi starts and the exit bookend after it closes; every escape-free launch emits
// neither. Runs the real vinci/bin/vinci with a fake `pi` so no model, network or build is involved.
// There is no PTY here: VINCI_INTERNAL_ASSUME_TTY replaces only the launcher's `-t 0`/`-t 1` probe
// result, and only under the existing offline switch VINCI_INTERNAL_PROVIDER_TEST=1.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceLauncher = join(root, "vinci/bin/vinci");
const temp = mkdtempSync(join(tmpdir(), "vinci-launcher-presentation-"));
const CLEAR = "\x1b[H\x1b[2J";
// The wordmark and tagline use the text and muted tokens. Both use the default foreground at 16 colours.
const bookend = (text, muted, separator = "·") => {
  const paint = (code, text) => (code ? `\x1b[${code}m${text}\x1b[39m` : text);
  return `\n  ${paint(text, "\x1b[1mVinci Code\x1b[22m")} ${separator} ${paint(muted, "Made, not generated.")}\n\n`;
};
const BOOKEND_COLOR = bookend("38;2;244;241;236", "38;2;163;163;156");
const BOOKEND_NO_COLOR = bookend("", "");
const PI_OUTPUT = "FAKE-PI\n";
const COLOR_SGR = /\x1b\[(?:[0-9;:]*;)?(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])(?:[;:][0-9;:]*)?m/;

let launcher = sourceLauncher;
let cases = 0;
try {
  // A built tree resolves Pi from packages/coding-agent/dist before PATH. Run a byte-identical copy of
  // the launcher in a root without dist so the fake `pi` answers.
  if (existsSync(join(root, "packages/coding-agent/dist/cli.js"))) {
    launcher = join(temp, "root/vinci/bin/vinci");
    mkdirSync(dirname(launcher), { recursive: true });
    copyFileSync(sourceLauncher, launcher);
    assert.ok(readFileSync(launcher).equals(readFileSync(sourceLauncher)), "launcher copy must be byte-identical");
  }
  const bin = join(temp, "bin");
  const home = join(temp, "home");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(bin, "pi"), '#!/bin/sh\nprintf "FAKE-PI\\n"\nexit 3\n');
  chmodSync(join(bin, "pi"), 0o755);

  const run = (args, env = {}) => {
    const result = spawnSync("bash", [launcher, ...args], {
      // An `undefined` override removes the variable from the launcher's environment.
      env: Object.fromEntries(Object.entries({
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home,
        TMPDIR: tmpdir(),
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        FORCE_COLOR: "3",
        VINCI_INTERNAL_PROVIDER_TEST: "1",
        VINCI_PROVIDER: "faux",
        VINCI_MODEL: "faux-1",
        VINCI_NO_BOOTSTRAP_HEAL: "1",
        ...env,
      }).filter(([, value]) => value !== undefined)),
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 3, `launcher must return Pi's exit status; stderr: ${result.stderr}`);
    cases++;
    return result.stdout;
  };

  // Rich interactive: clear first, Pi output, then the bookend.
  const rich = run(["hello"], { VINCI_INTERNAL_ASSUME_TTY: "1" });
  assert.equal(rich, CLEAR + PI_OUTPUT + BOOKEND_COLOR, "rich interactive launch keeps the clear and the bookend");

  // The bookend follows the look table on every colour path (truecolor, 256, 16), dark and light.
  for (const [label, env, expected] of [
    ["truecolor via COLORTERM", { FORCE_COLOR: undefined, TERM: "xterm", COLORTERM: "truecolor" }, BOOKEND_COLOR],
    ["truecolor light (COLORFGBG)", { COLORFGBG: "0;15" }, bookend("38;2;20;22;26", "38;2;108;106;98")],
    ["256 dark via TERM", { FORCE_COLOR: undefined }, bookend("38;5;255", "38;5;247")],
    ["256 light via TERM", { FORCE_COLOR: undefined, COLORFGBG: "0;15" }, bookend("38;5;233", "38;5;242")],
    ["256 via FORCE_COLOR=2", { FORCE_COLOR: "2", TERM: "xterm" }, bookend("38;5;255", "38;5;247")],
    ["16 colour", { FORCE_COLOR: undefined, TERM: "xterm" }, bookend("", "")],
    ["16 colour light", { FORCE_COLOR: undefined, TERM: "xterm", COLORFGBG: "0;15" }, bookend("", "")],
  ]) {
    const out = run(["hello"], { VINCI_INTERNAL_ASSUME_TTY: "1", ...env });
    assert.equal(out, CLEAR + PI_OUTPUT + expected, `${label}: bookend uses the look table colours`);
    assert.ok(!out.includes("\x1b[2m"), `${label}: no SGR 2`);
  }

  for (const [label, env] of [
    ["VINCI_ASCII=1", { VINCI_ASCII: "1" }],
    ["TERM=linux", { TERM: "linux" }],
    ["non-UTF-8 locale", { LC_ALL: "C" }],
  ]) {
    const out = run(["hello"], { VINCI_INTERNAL_ASSUME_TTY: "1", ...env });
    assert.equal(out, CLEAR + PI_OUTPUT + bookend("38;2;244;241;236", "38;2;163;163;156", "-"),
      `${label}: rich exit uses the Vinci Code wordmark and ASCII separator`);
  }

  // NO_COLOR and --no-color (anywhere before `--`) remove colour only: clear and bookend stay, with no
  // colour SGR.
  for (const [label, args, env] of [
    ["NO_COLOR empty", ["hello"], { NO_COLOR: "" }],
    ["NO_COLOR=1", ["hello"], { NO_COLOR: "1" }],
    ["--no-color", ["--no-color", "hello"], {}],
    ["trailing --no-color", ["hello", "--no-color"], {}],
    ["--no-color after options", ["--thinking", "low", "--no-color", "hello"], {}],
  ]) {
    const out = run(args, { VINCI_INTERNAL_ASSUME_TTY: "1", ...env });
    assert.equal(out, CLEAR + PI_OUTPUT + BOOKEND_NO_COLOR, `${label}: rich layout kept, colour removed`);
    assert.doesNotMatch(out, COLOR_SGR, `${label}: no colour SGR`);
  }

  // After `--` the word is a message, not an option: colour stays.
  const literal = run(["--", "--no-color"], { VINCI_INTERNAL_ASSUME_TTY: "1" });
  assert.equal(literal, CLEAR + PI_OUTPUT + BOOKEND_COLOR, "--no-color after -- is not an option");

  // Escape-free launches: no clear, no bookend, zero ESC bytes from the launcher.
  for (const [label, args, env] of [
    ["TERM=dumb", ["hello"], { VINCI_INTERNAL_ASSUME_TTY: "1", TERM: "dumb" }],
    ["VINCI_PLAIN=1", ["hello"], { VINCI_INTERNAL_ASSUME_TTY: "1", VINCI_PLAIN: "1" }],
    ["VINCI_SCREEN_READER=1", ["hello"], { VINCI_INTERNAL_ASSUME_TTY: "1", VINCI_SCREEN_READER: "1" }],
    ["-p", ["-p", "hello"], { VINCI_INTERNAL_ASSUME_TTY: "1" }],
    ["--print", ["--print", "hello"], { VINCI_INTERNAL_ASSUME_TTY: "1" }],
    ["--mode json", ["--mode", "json", "hello"], { VINCI_INTERNAL_ASSUME_TTY: "1" }],
    ["--mode=rpc", ["--mode=rpc"], { VINCI_INTERNAL_ASSUME_TTY: "1" }],
    ["non-TTY streams (real -t probe)", ["hello"], {}],
  ]) {
    const out = run(args, env);
    assert.equal(out, PI_OUTPUT, `${label}: escape-free launch emits no clear or bookend`);
    assert.ok(!out.includes("\x1b"), `${label}: zero ESC bytes`);
  }
  console.log(`  ✓ launcher presentation: ${cases} launches (rich clear + bookend kept; escape-free suppressed)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
