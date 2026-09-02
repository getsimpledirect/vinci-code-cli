// Vinci Code — supported dev-environment mode (VINCI_ENV).
//
//   1. LAUNCHER RESOLUTION — the bin/vinci resolver: default/prod is a no-op, VINCI_ENV=dev
//      exports the dev gateway/platform, an ISOLATED agent dir (~/.pi-dev/agent, so a dev /login
//      can never clobber the prod credential slot), and VINCI_UPDATE_DISABLED=1; an explicitly
//      set variable always wins; an unknown value is rejected at launch; and a profile file
//      (~/.vinci-code.env) may set VINCI_ENV=dev because resolution runs after sourcing.
//   2. UPDATER — before-launch is a hard no-op under VINCI_ENV=dev (no dev update channel;
//      a dev session must never touch prod update state), and `vinci doctor` reports the
//      effective environment, gateway/platform URLs, and agent config dir.
//   3. LINKS CONSOLIDATION — /support, web_search, and /feedback all derive from the ONE shared
//      gateway value in vinci-links.ts, for both the prod default and an override.
//   4. HEADER BADGE — a warning-colored environment badge renders under VINCI_ENV=dev (or any
//      non-prod base URL) and is absent on the prod default.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
let pass = 0;
const ok = (name, cond, detail = "") => {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✓ ${name}`);
  pass++;
};

const DEV_GATEWAY = "https://3.98.156.231.sslip.io/api/v1";
const DEV_PLATFORM = "https://platform.3.98.156.231.sslip.io";
const PROD_GATEWAY = "https://vinci.getsimpledirect.com/api/v1";
const PROD_PLATFORM = "https://platform.getsimpledirect.com";

// ── 1. Launcher resolution table ────────────────────────────────────────────────────────────────
// Run the REAL launcher (copied into a bare fake repo root so PI resolution falls through to a
// stub `pi` on PATH that reports the environment it received) with a scratch HOME so the user's
// real ~/.vinci-code.env and auth are never touched.
const stage = mkdtempSync(join(tmpdir(), "vinci-dev-env-"));
const fakeRoot = join(stage, "repo");
mkdirSync(join(fakeRoot, "vinci", "bin"), { recursive: true });
const launcher = join(fakeRoot, "vinci", "bin", "vinci");
copyFileSync(join(root, "vinci", "bin", "vinci"), launcher);
chmodSync(launcher, 0o755);
const stubDir = join(stage, "stub-bin");
mkdirSync(stubDir);
writeFileSync(
  join(stubDir, "pi"),
  '#!/usr/bin/env bash\nprintf "BASE=%s\\nPLATFORM=%s\\nAGENT_DIR=%s\\nPI_AGENT_DIR=%s\\nUPDATE=%s\\nENV=%s\\n" ' +
    '"${VINCI_BASE_URL:-}" "${VINCI_PLATFORM_URL:-}" "${VINCI_CODING_AGENT_DIR:-}" "${PI_CODING_AGENT_DIR:-}" "${VINCI_UPDATE_DISABLED:-}" "${VINCI_ENV:-}"\n',
  { mode: 0o755 },
);
// The report-wrong dispatch execs this script directly — it must ALSO see the resolved
// environment (it reads/appends the task/session store).
mkdirSync(join(fakeRoot, "vinci", "scripts"), { recursive: true });
copyFileSync(
  join(root, "vinci", "scripts", "resolve-dispatch.mjs"),
  join(fakeRoot, "vinci", "scripts", "resolve-dispatch.mjs"),
);
copyFileSync(
  join(root, "vinci", "scripts", "reap-heal-temp.mjs"),
  join(fakeRoot, "vinci", "scripts", "reap-heal-temp.mjs"),
);
copyFileSync(join(root, "vinci", "dispatch-manifest.json"), join(fakeRoot, "vinci", "dispatch-manifest.json"));
writeFileSync(
  join(fakeRoot, "vinci", "scripts", "report-wrong.mjs"),
  'console.log(`RW_AGENT_DIR=${process.env.VINCI_CODING_AGENT_DIR ?? ""}`);\n' +
    'console.log(`RW_BASE=${process.env.VINCI_BASE_URL ?? ""}`);\n',
);
const scratchHome = join(stage, "home");
mkdirSync(scratchHome);

function runLauncher(extraEnv = {}, args = []) {
  const result = spawnSync("bash", [launcher, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: `${stubDir}:${process.env.PATH}`,
      HOME: scratchHome,
      VINCI_NO_BOOTSTRAP_HEAL: "1",
      ...extraEnv,
    },
  });
  const report = {};
  for (const line of (result.stdout || "").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) report[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { ...result, report };
}

const byDefault = runLauncher();
ok(
  "default launch leaves the environment untouched (prod is a no-op)",
  byDefault.status === 0 &&
    byDefault.report.BASE === "" &&
    byDefault.report.PLATFORM === "" &&
    byDefault.report.AGENT_DIR === "" &&
    byDefault.report.UPDATE === "",
  JSON.stringify(byDefault.report),
);
const explicitProd = runLauncher({ VINCI_ENV: "prod" });
ok(
  "VINCI_ENV=prod behaves exactly like the default",
  explicitProd.status === 0 && explicitProd.report.BASE === "" && explicitProd.report.UPDATE === "",
);

const dev = runLauncher({ VINCI_ENV: "dev" });
ok("VINCI_ENV=dev points the gateway at the dev box", dev.report.BASE === DEV_GATEWAY, dev.stdout);
ok("VINCI_ENV=dev points the platform at the dev box", dev.report.PLATFORM === DEV_PLATFORM);
ok(
  "VINCI_ENV=dev isolates credentials/sessions under ~/.pi-dev/agent",
  dev.report.AGENT_DIR === join(scratchHome, ".pi-dev", "agent"),
);
ok("VINCI_ENV=dev disables auto-update", dev.report.UPDATE === "1" && dev.status === 0);
ok("VINCI_ENV itself is exported so extensions can badge the session", dev.report.ENV === "dev");
ok(
  "the upstream PI_CODING_AGENT_DIR spelling is mirrored (global-pi fallback lane is isolated too)",
  dev.report.PI_AGENT_DIR === join(scratchHome, ".pi-dev", "agent"),
  dev.stdout,
);

const explicitWins = runLauncher({
  VINCI_ENV: "dev",
  VINCI_BASE_URL: "https://custom.example/api/v1",
  VINCI_CODING_AGENT_DIR: join(scratchHome, "elsewhere"),
});
ok(
  "an explicitly set variable always beats the dev defaults",
  explicitWins.report.BASE === "https://custom.example/api/v1" &&
    explicitWins.report.AGENT_DIR === join(scratchHome, "elsewhere"),
  explicitWins.stdout,
);
ok(
  "unset variables still get dev values next to an explicit one",
  explicitWins.report.PLATFORM === DEV_PLATFORM && explicitWins.report.UPDATE === "1",
);
ok(
  "an explicit VINCI agent dir propagates to the PI_ spelling (same isolated dir on both lanes)",
  explicitWins.report.PI_AGENT_DIR === join(scratchHome, "elsewhere"),
  explicitWins.stdout,
);
const explicitPiDir = runLauncher({ VINCI_ENV: "dev", PI_CODING_AGENT_DIR: join(scratchHome, "pi-elsewhere") });
ok(
  "an explicitly set PI_CODING_AGENT_DIR is never overwritten",
  explicitPiDir.report.PI_AGENT_DIR === join(scratchHome, "pi-elsewhere") &&
    explicitPiDir.report.AGENT_DIR === join(scratchHome, ".pi-dev", "agent"),
  explicitPiDir.stdout,
);

// The report-wrong dispatch runs BEFORE Pi — resolution and validation must already apply there.
const reportWrongDev = runLauncher({ VINCI_ENV: "dev" }, ["report-wrong"]);
ok(
  "report-wrong sees the resolved dev environment (agent dir + gateway) before dispatch",
  reportWrongDev.status === 0 &&
    reportWrongDev.stdout.includes(`RW_AGENT_DIR=${join(scratchHome, ".pi-dev", "agent")}`) &&
    reportWrongDev.stdout.includes(`RW_BASE=${DEV_GATEWAY}`),
  reportWrongDev.stdout + reportWrongDev.stderr,
);
const reportWrongBogus = runLauncher({ VINCI_ENV: "bogus" }, ["report-wrong"]);
ok(
  "an unknown VINCI_ENV is rejected on the report-wrong path too",
  reportWrongBogus.status !== 0 &&
    /Unknown VINCI_ENV: bogus/.test(reportWrongBogus.stderr) &&
    !reportWrongBogus.stdout.includes("RW_AGENT_DIR"),
  `status=${reportWrongBogus.status} ${reportWrongBogus.stderr}`,
);

const bogus = runLauncher({ VINCI_ENV: "bogus" });
ok(
  "an unknown VINCI_ENV is rejected before anything launches",
  bogus.status !== 0 && !("BASE" in bogus.report),
  `status=${bogus.status}`,
);
ok(
  "the rejection names the bad value and the supported ones",
  /Unknown VINCI_ENV: bogus/.test(bogus.stderr) && /'dev'/.test(bogus.stderr),
  bogus.stderr,
);

// Resolution runs AFTER ~/.vinci-code.env sourcing, so the profile file can opt a machine in.
writeFileSync(join(scratchHome, ".vinci-code.env"), "VINCI_ENV=dev\n");
const viaProfile = runLauncher();
ok(
  "a profile-file VINCI_ENV=dev resolves the same as the environment variable",
  viaProfile.report.BASE === DEV_GATEWAY && viaProfile.report.UPDATE === "1" && viaProfile.report.ENV === "dev",
  viaProfile.stdout,
);
rmSync(join(scratchHome, ".vinci-code.env"));

// ── 2. Updater: dev never auto-updates; doctor reports the environment ──────────────────────────
const updater = join(root, "vinci", "updater", "update.mjs");
const emptyHome = join(stage, "updater-home");
mkdirSync(emptyHome);
function runUpdater(args, extraEnv = {}) {
  return spawnSync(process.execPath, [updater, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: scratchHome, VINCI_HOME: emptyHome, ...extraEnv },
  });
}
const devLaunch = runUpdater(["before-launch"], { VINCI_ENV: "dev" });
ok(
  "before-launch is a silent no-op under VINCI_ENV=dev (never touches update state)",
  devLaunch.status === 0 && devLaunch.stdout === "" && devLaunch.stderr === "",
  devLaunch.stderr,
);
const prodLaunch = runUpdater(["before-launch"]);
ok(
  "the same broken install FAILS before-launch outside dev (the dev gate is what returned 0)",
  prodLaunch.status !== 0,
);

// Minimal healthy install layout for doctor.
const docHome = join(stage, "doctor-home");
mkdirSync(join(docHome, "versions", "0.0.1", "vinci", "bin"), { recursive: true });
mkdirSync(join(docHome, "bin"), { recursive: true });
mkdirSync(join(docHome, "updater"), { recursive: true });
writeFileSync(join(docHome, "versions", "0.0.1", "vinci", "identity.json"), JSON.stringify({ version: "0.0.1" }));
writeFileSync(join(docHome, "versions", "0.0.1", "vinci", "bin", "vinci"), "#!/bin/sh\n");
writeFileSync(join(docHome, "bin", "vinci"), "#!/bin/sh\n");
// The REAL updater, so the installed shim's `node "$UPDATER" …` dispatches run the code under test.
copyFileSync(updater, join(docHome, "updater", "update.mjs"));
writeFileSync(join(docHome, "updater", "public-key.pem"), "stub\n");
symlinkSync(join(docHome, "versions", "0.0.1"), join(docHome, "current"));

const doctorProd = runUpdater(["doctor"], { VINCI_HOME: docHome });
ok(
  "doctor reports the prod environment + endpoints by default",
  doctorProd.status === 0 &&
    doctorProd.stdout.includes("Environment: prod") &&
    doctorProd.stdout.includes(`Gateway: ${PROD_GATEWAY}`) &&
    doctorProd.stdout.includes(`Platform: ${PROD_PLATFORM}`) &&
    doctorProd.stdout.includes(`Agent config: ${join(scratchHome, ".pi", "agent")}`),
  doctorProd.stdout + doctorProd.stderr,
);
const doctorDev = runUpdater(["doctor"], { VINCI_HOME: docHome, VINCI_ENV: "dev" });
ok(
  "doctor reports the dev environment, dev endpoints, and the isolated agent dir",
  doctorDev.status === 0 &&
    doctorDev.stdout.includes("Environment: dev") &&
    doctorDev.stdout.includes(`Gateway: ${DEV_GATEWAY}`) &&
    doctorDev.stdout.includes(`Platform: ${DEV_PLATFORM}`) &&
    doctorDev.stdout.includes(`Agent config: ${join(scratchHome, ".pi-dev", "agent")}`),
  doctorDev.stdout + doctorDev.stderr,
);
const doctorExplicit = runUpdater(["doctor"], { VINCI_HOME: docHome, VINCI_ENV: "dev", VINCI_BASE_URL: "https://custom.example/api/v1" });
ok(
  "doctor shows an explicit override winning over the dev default",
  doctorExplicit.stdout.includes("Gateway: https://custom.example/api/v1") &&
    doctorExplicit.stdout.includes(`Platform: ${DEV_PLATFORM}`),
  doctorExplicit.stdout,
);
const doctorBogus = runUpdater(["doctor"], { VINCI_HOME: docHome, VINCI_ENV: "bogus" });
ok(
  "doctor flags an unknown VINCI_ENV loudly instead of printing it as a real environment",
  doctorBogus.stdout.includes("Environment: bogus (INVALID") &&
    doctorBogus.stdout.includes(`Gateway: ${PROD_GATEWAY}`),
  doctorBogus.stdout,
);

// The INSTALLED SHIM (vinci/updater/vinci) dispatches the updater BEFORE the launcher ever
// sources ~/.vinci-code.env — so the shim must source the profile itself, or a profile-only
// VINCI_ENV=dev machine gets prod auto-update on every launch and a lying doctor.
const shim = join(root, "vinci", "updater", "vinci");
const profileHome = join(stage, "profile-home");
mkdirSync(profileHome);
writeFileSync(join(profileHome, ".vinci-code.env"), "VINCI_ENV=dev\n");
function runShim(args, extraEnv = {}) {
  return spawnSync("sh", [shim, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: profileHome, VINCI_UPDATER_TIMEOUT_MS: "30000", ...extraEnv },
  });
}
const shimDoctor = runShim(["doctor"], { VINCI_HOME: docHome });
ok(
  "the installed shim sources the profile: doctor via the shim reports dev",
  shimDoctor.status === 0 && shimDoctor.stdout.includes("Environment: dev"),
  shimDoctor.stdout + shimDoctor.stderr,
);
// A home with an updater but NO active version: under the dev gate before-launch returns 0
// silently and the shim proceeds; without it (or without the profile sourcing) the updater
// errors and the shim prints its continue-anyway warning — a clean, offline discriminator.
const gateHome = join(stage, "shim-gate-home");
mkdirSync(join(gateHome, "updater"), { recursive: true });
copyFileSync(updater, join(gateHome, "updater", "update.mjs"));
const shimLaunch = runShim([], { VINCI_HOME: gateHome });
ok(
  "the shim's before-launch dispatch honors the profile's VINCI_ENV=dev (no update attempt)",
  !shimLaunch.stderr.includes("update check failed") && shimLaunch.stderr.includes("no runnable version"),
  `status=${shimLaunch.status} ${shimLaunch.stderr}`,
);

// A PROFILE-SET VINCI_HOME MUST REACH THE UPDATER PATH, not just the payload path.
//
// Every test above passes VINCI_HOME as an ENVIRONMENT VARIABLE, which resolves before the shim
// runs at all — so none of them could see the ordering bug this covers. The shim used to derive
// UPDATER above the profile sourcing. Sourcing reassigns VINCI_HOME but nothing recomputed
// UPDATER, so a profile-set home ran the DEFAULT home's updater against the PROFILE home's
// payload: two installs in one launch, the updater writing current/ and previous/ into the tree
// the launcher does not execute from.
//
// The discriminator is offline and needs no active version: point the profile at a home holding
// ONLY an updater. If the shim reads the profile's home, the updater runs and reports no runnable
// version. If it reads the default home, the updater is absent there and the shim says so.
const profileHomeHome = join(stage, "profile-sets-home");
mkdirSync(profileHomeHome);
const profileTargetHome = join(stage, "profile-target-home");
mkdirSync(join(profileTargetHome, "updater"), { recursive: true });
copyFileSync(updater, join(profileTargetHome, "updater", "update.mjs"));
writeFileSync(
  join(profileHomeHome, ".vinci-code.env"),
  `VINCI_ENV=dev\nVINCI_HOME=${profileTargetHome}\n`,
);
const shimProfileHome = spawnSync("sh", [shim], {
  encoding: "utf8",
  timeout: 60_000,
  // Deliberately NO VINCI_HOME in the environment: the profile is the only place it is set.
  env: { PATH: process.env.PATH, HOME: profileHomeHome, VINCI_UPDATER_TIMEOUT_MS: "30000" },
});
ok(
  "a profile-set VINCI_HOME reaches the updater path, not only the payload path",
  !shimProfileHome.stderr.includes("updater is missing")
    && shimProfileHome.stderr.includes("no runnable version"),
  `status=${shimProfileHome.status} ${shimProfileHome.stderr}`,
);

// A MALFORMED PROFILE MUST NOT TAKE THE LAUNCHER DOWN.
//
// The shim exists so an update can replace a broken release before it starts. Sourcing a
// user-editable file directly under `set -eu` put that promise behind the contents of that file.
// Measured on the pre-fix shim: a failing command exited 1 with NO output, an unset reference
// exited 1, a syntax error exited 2, and a bare `exit` ended the launcher outright — each leaving
// `vinci update`, `vinci rollback` and `vinci doctor` unreachable, which is when they are needed.
//
// `set +eu` around the source is not a fix and was tried: `.` runs in the shim's own shell, so
// `exit` still terminates it. Hence the subshell. Each case below fails the pre-fix shim.
const brokenProfiles = [
  ["a failing command", "false"],
  ["an unset variable reference", 'BROKEN="${DEFINITELY_NOT_SET}"'],
  ["a syntax error", "if [ 1 -eq 1 ]"],
  ["a bare exit", "exit 3"],
];
for (const [index, [label, line]] of brokenProfiles.entries()) {
  const brokenHome = join(stage, `broken-profile-${index}`);
  mkdirSync(brokenHome, { recursive: true });
  writeFileSync(join(brokenHome, ".vinci-code.env"), `VINCI_ENV=dev\n${line}\n`);
  const broken = spawnSync("sh", [shim, "doctor"], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: brokenHome,
      VINCI_HOME: docHome,
      VINCI_UPDATER_TIMEOUT_MS: "30000",
    },
  });
  // The bar is that the launcher still REACHES its dispatch. doctor is the cheapest proof: it
  // runs, exits 0 and prints an environment line. A shim killed by the profile prints nothing.
  ok(
    `a profile containing ${label} does not stop the launcher reaching doctor`,
    broken.status === 0 && broken.stdout.includes("Environment:"),
    `status=${broken.status} stdout=${broken.stdout} stderr=${broken.stderr}`,
  );
}

// THE SECOND-STAGE LAUNCHER NEEDS ITS OWN COVERAGE, and the loop above does not provide it.
//
// Those four run `sh <shim> doctor`, and the shim's doctor branch is `exec node "$UPDATER" doctor`
// — it never reaches vinci/bin/vinci. Reverting ONLY bin/vinci to direct sourcing therefore left
// the suite fully green at 47/47, which is a guard with no test that fails when it is removed:
// exactly the shape this file exists to catch. A review caught it; the mutation confirmed it.
//
// bin/vinci sources the same user-editable profile under `set -euo pipefail`, so it has the same
// exposure independently of the shim. `--version` is the cheap probe: pure shell, needs no build,
// and dispatches AFTER the profile sourcing. Measured against the pre-fix bin/vinci, these four
// cases exit 1, 1, 2 and 3; against the fixed one they all exit 0 and print the version.
const binVinci = join(root, "vinci", "bin", "vinci");

// A PARTLY-APPLIED PROFILE SAYS SO, AND KEEPS WHAT APPLIED.
//
// A review found that a mid-file SYNTAX ERROR is genuinely partial: the shell stops reading at
// that point, so lines above take effect and lines below do not. (A mid-file `false` is not
// partial — `set +e` continues and everything applies. Measured both.) The shell prints its own
// parse error, but nothing said the profile was half-applied.
//
// What applied is KEPT rather than discarded, deliberately. Discarding is the more dangerous
// choice here: a profile whose VINCI_ENV=dev line succeeded and whose later line failed would,
// if thrown away, run the session against PROD — the exact leak the dev switch exists to
// prevent. So the assertion is BOTH halves: the warning is present, and dev still applied.
const partialHome = join(stage, "partial-profile-home");
mkdirSync(partialHome, { recursive: true });
writeFileSync(
  join(partialHome, ".vinci-code.env"),
  "VINCI_ENV=dev\nif [ 1 -eq 1 ]\nBRAVE_SEARCH_API_KEY=never-applied\n",
);
const partial = spawnSync("sh", [shim, "doctor"], {
  encoding: "utf8",
  timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: partialHome, VINCI_HOME: docHome, VINCI_UPDATER_TIMEOUT_MS: "30000" },
});
// SHELL-DEPENDENT, AND CI FOUND IT. This assertion used to require the exact
// "only partly" wording and that dev still applied. Both are true under macOS
// /bin/sh (bash in sh mode) and neither is true under dash, which is /bin/sh on
// the Linux runners: a syntax error there kills the sourcing subshell outright,
// so the capture comes back EMPTY and NOTHING is applied. Measured on both:
//
//   profile fault        bash-as-sh              dash
//   false                applies everything      applies everything
//   unset reference      applies everything      applies everything
//   exit 3               applies nothing         applies nothing
//   syntax error         applies the lines above applies nothing
//
// THAT TABLE IS THE OLD BEHAVIOUR, kept because it is why the fix looks the way
// it does. The syntax-error row no longer diverges: `sh -n` runs BEFORE the
// sourcing, so on both shells an unparseable profile now applies exactly
// nothing. Making the two shells agree is the point of the fix, not a side
// effect of it — an earlier version of this comment still described the
// divergence as live, which review caught.
//
// The assertion therefore accepts either warning wording only because the two
// shells word it differently, not because they behave differently.
ok(
  "a profile that does not finish cleanly warns and does not stop the launcher",
  partial.status === 0
    && partial.stdout.includes("Environment:")
    && /only partly|no usable settings/.test(partial.stderr),
  `status=${partial.status} stdout=${partial.stdout} stderr=${partial.stderr}`,
);

// The no-silent-fall-back-to-prod property, on a fault that behaves the same
// under bash and dash. A failing command does not stop `.` under `set +e` in
// either shell, so every line applies and dev must survive: discarding here
// would run the session against PROD, which is the leak the switch prevents.
const keptHome = join(stage, "profile-fails-but-applies-home");
mkdirSync(keptHome, { recursive: true });
writeFileSync(join(keptHome, ".vinci-code.env"), "VINCI_ENV=dev\nfalse\n");
const kept = spawnSync("sh", [shim, "doctor"], {
  encoding: "utf8",
  timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: keptHome, VINCI_HOME: docHome, VINCI_UPDATER_TIMEOUT_MS: "30000" },
});
ok(
  "a failing command in the profile does not discard the settings that applied",
  kept.status === 0 && kept.stdout.includes("Environment: dev"),
  `status=${kept.status} stdout=${kept.stdout} stderr=${kept.stderr}`,
);

// A NORMAL LAUNCH FAILS CLOSED when the profile could not be read at all.
//
// The recovery commands above stay reachable by design — they are what a user
// needs when the profile is the broken thing. A real session is different: this
// file is where VINCI_ENV=dev is set, so if it did not apply, the session runs
// against PROD with the user's dev intent silently dropped. That is the leak the
// dev switch exists to prevent, and the shim cannot know whether the lines it
// failed to read were the ones that mattered.
//
// `sh -n` runs before the sourcing, so this is identical under bash and dash —
// which the previous, wording-based version of this test was not.
const refusedLaunch = spawnSync("sh", [shim], {
  encoding: "utf8",
  timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: partialHome, VINCI_HOME: docHome, VINCI_UPDATER_TIMEOUT_MS: "30000" },
});
ok(
  "a normal launch refuses a profile it could not read, rather than falling back to prod",
  refusedLaunch.status === 78 && /will not start/.test(refusedLaunch.stderr),
  `status=${refusedLaunch.status} stderr=${refusedLaunch.stderr}`,
);

// AND IT MUST NOT OVER-REFUSE. A profile ending in a command that returns
// nonzero is ordinary — `[ -f ~/.keys ] && . ~/.keys` returns 1 whenever that
// file is absent — and it applied perfectly. A draft of this gate keyed on the
// sourcing exit status and refused to start on exactly that shape, which would
// have bricked launches for a common profile idiom.
const ordinaryHome = join(stage, "profile-nonzero-tail-home");
mkdirSync(ordinaryHome, { recursive: true });
writeFileSync(join(ordinaryHome, ".vinci-code.env"), "VINCI_ENV=dev\n[ -f /nonexistent ] && export UNUSED=1\n");
const ordinary = spawnSync("sh", [shim, "doctor"], {
  encoding: "utf8",
  timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: ordinaryHome, VINCI_HOME: docHome, VINCI_UPDATER_TIMEOUT_MS: "30000" },
});
ok(
  "a profile ending in a nonzero command still applies and does not block the launch",
  ordinary.status === 0 && ordinary.stdout.includes("Environment: dev"),
  `status=${ordinary.status} stdout=${ordinary.stdout} stderr=${ordinary.stderr}`,
);

// THE DIRECT PATH NEEDS ITS OWN GATE, and a review found it did not have one.
//
// vinci/README.md documents running vinci/bin/vinci directly and symlinking it
// onto PATH as `vinci` (lines 24, 163, 179). On that path the shim never
// executes, so the shim's refusal is irrelevant — and bin/vinci used to parse
// the profile, warn, and carry on. VINCI_ENV=dev was dropped and the session
// started against PROD, which is the leak both gates exist to close. A comment
// in bin/vinci asserted the shim had already handled it; that was false for the
// one path a contributor is told to use.
//
// --version is the probe because it dispatches BEFORE the gate and must stay
// reachable; a real launch dispatches after it and must not.
const directHome = join(stage, "direct-bin-malformed-home");
mkdirSync(directHome, { recursive: true });
writeFileSync(join(directHome, ".vinci-code.env"), "VINCI_ENV=dev\nif [ 1 -eq 1 ]\n");
const directEnv = { PATH: process.env.PATH, HOME: directHome };
const directLaunch = spawnSync("bash", [binVinci], {
  encoding: "utf8",
  timeout: 60_000,
  input: "",
  env: directEnv,
});
ok(
  "running bin/vinci directly refuses a malformed profile instead of starting against prod",
  directLaunch.status === 78 && /will not start/.test(directLaunch.stderr),
  `status=${directLaunch.status} stderr=${directLaunch.stderr}`,
);
const directVersion = spawnSync("bash", [binVinci, "--version"], {
  encoding: "utf8",
  timeout: 60_000,
  input: "",
  env: directEnv,
});
// A PROFILE THAT RETURNS PART-WAY IS TRUNCATED, NOT CLEAN.
//
// `return N` at the top level of a sourced file stops the sourcing and hands N
// back to `.`. The shell lives, `export -p` still runs, the capture is
// non-empty — so the parse check cannot see it (it parses) and the
// empty-capture check cannot either (the shell survived). The profile applies
// its first lines, drops the rest, and reports nothing wrong. Review found this
// after the parse check had already landed.
//
// The shim appends an assignment after the profile and requires it to arrive:
// reached means the profile ran to the end. Identical under both shells.
const returnHome = join(stage, "profile-early-return-home");
mkdirSync(returnHome, { recursive: true });
writeFileSync(
  join(returnHome, ".vinci-code.env"),
  "VINCI_ENV=dev\nreturn 1\nVINCI_BASE_URL=https://never-applied\n",
);
const returned = spawnSync("sh", [shim], {
  encoding: "utf8",
  timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: returnHome, VINCI_HOME: docHome, VINCI_UPDATER_TIMEOUT_MS: "30000" },
});
ok(
  "a profile that returns before its end refuses the launch instead of applying half of itself",
  returned.status === 78 && /part-way/.test(returned.stderr),
  `status=${returned.status} stderr=${returned.stderr}`,
);

// AND THE SENTINEL MUST NOT REACH THE SESSION. It is bookkeeping; exporting it
// would put a Vinci-internal variable into every launched agent's environment.
const cleanSentinelHome = join(stage, "profile-sentinel-clean-home");
mkdirSync(cleanSentinelHome, { recursive: true });
writeFileSync(join(cleanSentinelHome, ".vinci-code.env"), "VINCI_ENV=dev\n");
const sentinelCheck = spawnSync("sh", [shim, "doctor"], {
  encoding: "utf8",
  timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: cleanSentinelHome, VINCI_HOME: docHome, VINCI_UPDATER_TIMEOUT_MS: "30000" },
});
// A PROFILE CANNOT FORGE COMPLETENESS.
//
// The first version of this check globbed the capture for the sentinel's NAME,
// which any profile could put there. Confirmed two ways before fixing: a
// profile containing the innocuous line `export DECOY="VINCI_PROFILE_COMPLETE=1"`
// and then returning early passed as complete, because the glob matched the
// decoy's VALUE — and so did one that simply set the sentinel itself. Detection
// failed silently in exactly the case it exists for.
//
// The sentinel now carries an mktemp-derived token the profile cannot predict.
for (const [label, line] of [
  ["a decoy value containing the sentinel name", 'export DECOY="VINCI_PROFILE_COMPLETE=1"'],
  ["the sentinel variable set by the profile itself", "export VINCI_PROFILE_COMPLETE=1"],
]) {
  const forgeHome = join(stage, `forge-${line.length}`);
  mkdirSync(forgeHome, { recursive: true });
  writeFileSync(join(forgeHome, ".vinci-code.env"), `VINCI_ENV=dev\n${line}\nreturn 1\nLATE=1\n`);
  const forged = spawnSync("sh", [shim], {
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: forgeHome, VINCI_HOME: docHome, VINCI_UPDATER_TIMEOUT_MS: "30000" },
  });
  ok(
    `${label} cannot forge completeness`,
    forged.status === 78 && /part-way/.test(forged.stderr),
    `status=${forged.status} stderr=${forged.stderr}`,
  );
}

ok(
  "a complete profile is not mistaken for a truncated one",
  sentinelCheck.status === 0 && !/part-way/.test(sentinelCheck.stderr),
  `status=${sentinelCheck.status} stderr=${sentinelCheck.stderr}`,
);

// A PROFILE WITH NO TRAILING NEWLINE MUST NOT FUSE WITH THE SENTINEL.
//
// `cat` of such a file leaves the last line open, so the appended sentinel
// joined it: `VINCI_ENV=dev` became `VINCI_ENV=devVINCI_PROFILE_COMPLETE=<token>`,
// which SET VINCI_ENV to that whole string and passed as complete, because the
// token was present — inside the corrupted value. Silent corruption that also
// defeated detection. Review found it; an earlier check of mine looked only at
// the exit code and called this case clean.
// WHEN THE CHECK CANNOT RUN, IT SAYS SO.
//
// Completeness detection needs a temp file. If mktemp fails there is no
// sentinel, so a profile that returns part-way is applied without being
// noticed. Continuing is right — refusing every launch because /tmp is full
// would be worse than the defect — but doing it SILENTLY made the guard weaker
// than its description, which is the failure this block has repeated at every
// stage of its life.
//
// mktemp is made to fail by putting a stub earlier on PATH, which is exactly
// how the shim resolves it.
const mktempStubDir = join(stage, "mktemp-stub-bin");
mkdirSync(mktempStubDir, { recursive: true });
writeFileSync(join(mktempStubDir, "mktemp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

const noTmpHome = join(stage, "profile-no-mktemp-home");
mkdirSync(noTmpHome, { recursive: true });
writeFileSync(join(noTmpHome, ".vinci-code.env"), "VINCI_ENV=dev\n");
const noTmpEnv = {
  PATH: `${mktempStubDir}:${process.env.PATH}`,
  HOME: noTmpHome,
  VINCI_HOME: docHome,
  VINCI_UPDATER_TIMEOUT_MS: "30000",
};
const noTmp = spawnSync("sh", [shim, "doctor"], { encoding: "utf8", timeout: 60_000, env: noTmpEnv });
ok(
  "when it cannot verify completeness, the shim says so instead of degrading silently",
  /cannot check whether/.test(noTmp.stderr) && noTmp.stderr.includes(join(noTmpHome, ".vinci-code.env")),
  `status=${noTmp.status} stderr=${noTmp.stderr}`,
);
ok(
  // Anchored, and the sentinel name required absent. `includes("Environment: dev")`
  // is the idiom this file bans further down for exactly this reason: it matches
  // a CORRUPTED `devVINCI_PROFILE_COMPLETE=<token>` that doctor itself labels
  // INVALID. Review caught this reverting to the banned form.
  "a failed mktemp does not lose a good profile",
  noTmp.status === 0
    && /Environment: dev(\s|$)/m.test(noTmp.stdout)
    && !/VINCI_PROFILE_COMPLETE/.test(noTmp.stdout),
  `status=${noTmp.status} stdout=${noTmp.stdout} stderr=${noTmp.stderr}`,
);

// A REAL LAUNCH, not `doctor`. The doctor arm `exec`s the updater twenty lines
// ABOVE the fail-closed launch gate, so an assertion named "does not refuse the
// launch" that runs doctor never reaches the gate at all. Review proved it: a
// shim mutated to refuse every real session on mktemp failure still passed
// 73/73. This runs the shim with no arguments, which is the path that gate sits on.
const noTmpLaunchHome = join(stage, "no-mktemp-launch-home");
mkdirSync(join(noTmpLaunchHome, "updater"), { recursive: true });
mkdirSync(join(noTmpLaunchHome, "current", "vinci", "bin"), { recursive: true });
copyFileSync(updater, join(noTmpLaunchHome, "updater", "update.mjs"));
writeFileSync(
  join(noTmpLaunchHome, "current", "vinci", "bin", "vinci"),
  '#!/usr/bin/env bash\necho "PROFILE_GATE_PASSED"\n',
  { mode: 0o755 },
);
const noTmpLaunch = spawnSync("sh", [shim], {
  encoding: "utf8",
  timeout: 60_000,
  input: "",
  env: { ...noTmpEnv, VINCI_HOME: noTmpLaunchHome },
});
ok(
  "a failed mktemp does not refuse a real launch",
  noTmpLaunch.status === 0
    && /PROFILE_GATE_PASSED/.test(noTmpLaunch.stdout)
    && /cannot check whether/.test(noTmpLaunch.stderr)
    && !/will not start/.test(noTmpLaunch.stderr),
  `status=${noTmpLaunch.status} stdout=${noTmpLaunch.stdout} stderr=${noTmpLaunch.stderr}`,
);

// bin/vinci CARRIES THE SAME WARNING AND NEEDS ITS OWN ASSERTIONS.
//
// This is the THIRD time on this branch that a fix landed in both launchers and
// only the shim got tested — the fail-closed gate, then the early-return
// sentinel, now this. Review proved it again: deleting bin/vinci's warning gave
// 73/73, and making it unconditional gave 73/73. Both directions are pinned here.
const noTmpBin = spawnSync("bash", [binVinci, "--version"], {
  encoding: "utf8",
  timeout: 60_000,
  input: "",
  env: { PATH: `${mktempStubDir}:${process.env.PATH}`, HOME: noTmpHome },
});
ok(
  "bin/vinci also says so when it cannot verify completeness",
  noTmpBin.status === 0 && /cannot check whether/.test(noTmpBin.stderr),
  `status=${noTmpBin.status} stderr=${noTmpBin.stderr}`,
);
const tmpOkayBin = spawnSync("bash", [binVinci, "--version"], {
  encoding: "utf8",
  timeout: 60_000,
  input: "",
  env: { PATH: process.env.PATH, HOME: noTmpHome },
});
ok(
  "bin/vinci stays quiet when completeness can be verified",
  tmpOkayBin.status === 0 && !/cannot check whether/.test(tmpOkayBin.stderr),
  `status=${tmpOkayBin.status} stderr=${tmpOkayBin.stderr}`,
);

// WHERE mktemp ACTUALLY WRITES, which is not always $TMPDIR.
//
// The wrapper-cleanup assertions below set TMPDIR and then check that directory
// is empty. That binds on Linux, where GNU mktemp honours TMPDIR — and it is
// VACUOUS on macOS, where mktemp ignores TMPDIR entirely (verified: even
// `mktemp -t` writes to the per-user /var/folders directory). On a macOS dev
// machine the assertion inspects a directory nothing was ever written to and
// always passes. Proven by mutation: reverting the cleanup fix leaves a real
// wrapper on disk and the suite still reports every check passing.
//
// So the check also asserts the property that actually matters — no file in the
// REAL temp directory still holds the profile's contents. Matching on a
// distinctive string from the fixture, rather than counting files, keeps it from
// racing with unrelated processes.
function realTempDir(env) {
  const probe = spawnSync("sh", ["-c", 'F=$(mktemp) || exit 1; printf %s "$F"; rm -f "$F"'], {
    encoding: "utf8",
    env,
  });
  return probe.status === 0 && probe.stdout ? dirname(probe.stdout.trim()) : tmpdir();
}
function profileLeftovers(dir, needle) {
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith("tmp."));
  } catch {
    return [];
  }
  return names.filter((name) => {
    try {
      return readFileSync(join(dir, name), "utf8").includes(needle);
    } catch {
      return false;
    }
  });
}

// THE COPY CAN FAIL EVEN WHEN mktemp SUCCEEDS, and that used to be the worst
// case of the three.
//
// `{ cat; printf; } > file || fail` tests only the LAST command. On a full
// filesystem `cat` fails with ENOSPC while the 29-byte `printf` still fits, so
// the group returned 0, the wrap file held ONLY the sentinel, the token came
// back, and a profile discarded ENTIRELY reported as COMPLETE — silently, with
// the session running against PROD. Review measured that on a real filesystem
// with 4 KB free. Worse than the truncation this block detects, and in the very
// scenario the warning cites to justify continuing.
//
// A `cat` that writes part of the file and then fails models ENOSPC exactly and
// needs no privileged filesystem.
const catStubDir = join(stage, "cat-stub-bin");
mkdirSync(catStubDir, { recursive: true });
writeFileSync(
  join(catStubDir, "cat"),
  '#!/bin/sh\n# models ENOSPC: partial write, then failure\nhead -c 40 "$1" 2>/dev/null\nexit 1\n',
  { mode: 0o755 },
);
const badCopyHome = join(stage, "profile-copy-fails-home");
mkdirSync(badCopyHome, { recursive: true });
writeFileSync(join(badCopyHome, ".vinci-code.env"), "VINCI_ENV=dev\nVINCI_BASE_URL=https://dev\n");
const badCopyShimTmp = join(stage, "profile-copy-fails-shim-tmp");
mkdirSync(badCopyShimTmp, { recursive: true });
const badCopy = spawnSync("sh", [shim, "doctor"], {
  encoding: "utf8",
  timeout: 60_000,
  env: {
    PATH: `${catStubDir}:${process.env.PATH}`,
    HOME: badCopyHome,
    TMPDIR: badCopyShimTmp,
    VINCI_HOME: docHome,
    VINCI_UPDATER_TIMEOUT_MS: "30000",
  },
});
ok(
  "a failed copy is reported, not passed off as a verified-complete profile",
  badCopy.status === 0
    && /Environment: dev(\s|$)/m.test(badCopy.stdout)
    && /could not prepare a temporary profile/.test(badCopy.stderr)
    && !/produced no usable settings/.test(badCopy.stderr),
  `status=${badCopy.status} stdout=${badCopy.stdout} stderr=${badCopy.stderr}`,
);
ok(
  // The second half of the same defect: clearing WRAP but leaving TOKEN set made
  // the completeness check run against a source with no sentinel, so a healthy
  // profile drew "cannot check" AND a flatly contradictory "stopped reading
  // part-way", then had its launch refused. Two messages about one file, one false.
  "a failed copy does not also claim the profile stopped part-way",
  !/part-way/.test(badCopy.stderr),
  `stderr=${badCopy.stderr}`,
);
ok(
  "the shim removes a partial wrapper that may contain profile secrets",
  readdirSync(badCopyShimTmp).length === 0
    && profileLeftovers(realTempDir({ PATH: process.env.PATH, HOME: badCopyHome }), "VINCI_BASE_URL=https://dev").length === 0,
  `${readdirSync(badCopyShimTmp).join(", ")} | real=${profileLeftovers(realTempDir({ PATH: process.env.PATH, HOME: badCopyHome }), "VINCI_BASE_URL=https://dev").join(", ")}`,
);
const badCopyLaunch = spawnSync("sh", [shim], {
  encoding: "utf8",
  timeout: 60_000,
  input: "",
  env: {
    PATH: `${catStubDir}:${process.env.PATH}`,
    HOME: badCopyHome,
    TMPDIR: badCopyShimTmp,
    VINCI_HOME: noTmpLaunchHome,
    VINCI_UPDATER_TIMEOUT_MS: "30000",
  },
});
ok(
  "a failed wrapper copy does not refuse a real launch",
  badCopyLaunch.status === 0
    && /PROFILE_GATE_PASSED/.test(badCopyLaunch.stdout)
    && /could not prepare a temporary profile/.test(badCopyLaunch.stderr)
    && !/part-way|will not start/.test(badCopyLaunch.stderr),
  `status=${badCopyLaunch.status} stdout=${badCopyLaunch.stdout} stderr=${badCopyLaunch.stderr}`,
);
ok(
  "the shim also cleans a partial wrapper on the real-launch path",
  readdirSync(badCopyShimTmp).length === 0,
  readdirSync(badCopyShimTmp).join(", "),
);
const badCopyBinTmp = join(stage, "profile-copy-fails-bin-tmp");
mkdirSync(badCopyBinTmp, { recursive: true });
const badCopyBin = spawnSync("bash", [launcher], {
  encoding: "utf8",
  timeout: 60_000,
  env: {
    PATH: `${catStubDir}:${stubDir}:${process.env.PATH}`,
    HOME: badCopyHome,
    TMPDIR: badCopyBinTmp,
    VINCI_NO_BOOTSTRAP_HEAL: "1",
  },
});
ok(
  "bin/vinci also keeps a good profile when its wrapper copy fails",
  badCopyBin.status === 0
    && /ENV=dev(\s|$)/m.test(badCopyBin.stdout)
    && /could not prepare a temporary profile/.test(badCopyBin.stderr)
    && !/part-way|will not start/.test(badCopyBin.stderr),
  `status=${badCopyBin.status} stdout=${badCopyBin.stdout} stderr=${badCopyBin.stderr}`,
);
ok(
  "bin/vinci removes a partial wrapper that may contain profile secrets",
  readdirSync(badCopyBinTmp).length === 0
    && profileLeftovers(realTempDir({ PATH: process.env.PATH, HOME: badCopyHome }), "VINCI_BASE_URL=https://dev").length === 0,
  `${readdirSync(badCopyBinTmp).join(", ")} | real=${profileLeftovers(realTempDir({ PATH: process.env.PATH, HOME: badCopyHome }), "VINCI_BASE_URL=https://dev").join(", ")}`,
);

// THE SCENARIO THE WARNING EXISTS FOR, which nothing asserted: a failing mktemp
// AND a profile that stops early. That pairing is the whole point — the warning
// says "a profile that stops early will be applied in part without further
// warning", and this is the case where that sentence is doing work. With mktemp
// working the same profile is refused; with it failing the profile applies in
// part and only the warning marks it.
const noTmpTruncHome = join(stage, "no-mktemp-truncated-home");
mkdirSync(noTmpTruncHome, { recursive: true });
writeFileSync(join(noTmpTruncHome, ".vinci-code.env"), "VINCI_ENV=dev\nreturn 0\nVINCI_BASE_URL=https://never\n");
const truncNoTmp = spawnSync("sh", [shim, "doctor"], {
  encoding: "utf8",
  timeout: 60_000,
  env: { ...noTmpEnv, HOME: noTmpTruncHome },
});
const truncWithTmp = spawnSync("sh", [shim, "doctor"], {
  encoding: "utf8",
  timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: noTmpTruncHome, VINCI_HOME: docHome, VINCI_UPDATER_TIMEOUT_MS: "30000" },
});
ok(
  "a truncated profile is caught when mktemp works and only warned about when it does not",
  /part-way/.test(truncWithTmp.stderr)
    && !/part-way/.test(truncNoTmp.stderr)
    && /cannot check whether/.test(truncNoTmp.stderr),
  `withTmp=${truncWithTmp.stderr} noTmp=${truncNoTmp.stderr}`,
);
// And it must stay quiet when the check CAN run, or the warning is noise that
// trains people to ignore it.
const tmpOkay = spawnSync("sh", [shim, "doctor"], {
  encoding: "utf8",
  timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: noTmpHome, VINCI_HOME: docHome, VINCI_UPDATER_TIMEOUT_MS: "30000" },
});
ok(
  "no such warning when completeness can be verified",
  tmpOkay.status === 0 && !/cannot check whether/.test(tmpOkay.stderr),
  `status=${tmpOkay.status} stderr=${tmpOkay.stderr}`,
);

// A TRAILING BACKSLASH MUST NOT SWALLOW THE SEPARATOR.
//
// One injected newline was not enough. If the profile's last byte is a
// backslash with no trailing newline, that newline becomes a POSIX line
// CONTINUATION and the sentinel joins the last assignment anyway —
// `BASE=https://intendedVINCI_PROFILE_COMPLETE=<token>`, corrupted AND passing
// as complete, because the token sits inside the value it corrupted. Review
// found this after the one-newline fix had landed. Two newlines: an odd number
// of trailing backslashes consumes the first, the second always terminates.
for (const [label, tail] of [["one", "\\"], ["two", "\\\\"], ["three", "\\\\\\"]]) {
  const bsHome = join(stage, `profile-trailing-backslash-${label}`);
  mkdirSync(bsHome, { recursive: true });
  // VINCI_ENV is the LAST assignment on purpose: doctor prints it, so corruption
  // is observable. An earlier version put the backslash on a BASE= line that
  // nothing surfaces, so reverting the fix left this green — the fourth
  // assertion on this branch that named a property it could not see.
  writeFileSync(join(bsHome, ".vinci-code.env"), `BASE=https://intended\nVINCI_ENV=dev${tail}`);
  for (const entry of ["shim", "bin"]) {
    const run = spawnSync(entry === "shim" ? "sh" : "bash",
      entry === "shim" ? [shim, "doctor"] : [binVinci, "--version"], {
        encoding: "utf8",
        timeout: 60_000,
        input: "",
        env: { PATH: process.env.PATH, HOME: bsHome, VINCI_HOME: docHome, VINCI_UPDATER_TIMEOUT_MS: "30000" },
      });
    ok(
      `${label} trailing backslash via ${entry} does not fuse the sentinel into a value`,
      // ONLY the sentinel check. An even number of trailing backslashes legally
      // yields the value `dev\` — correct shell behaviour, not corruption — so
      // asserting `Environment: dev` exactly was wrong and failed the two- and
      // three-backslash cases. This binds because VINCI_ENV is the last
      // assignment and doctor prints it, so a fused sentinel is visible.
      !/VINCI_PROFILE_COMPLETE/.test(run.stdout + run.stderr),
      `stdout=${run.stdout} stderr=${run.stderr}`,
    );
  }
}

const noNewlineHome = join(stage, "profile-no-trailing-newline-home");
mkdirSync(noNewlineHome, { recursive: true });
writeFileSync(join(noNewlineHome, ".vinci-code.env"), "VINCI_ENV=dev");
const noNewline = spawnSync("sh", [shim, "doctor"], {
  encoding: "utf8",
  timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: noNewlineHome, VINCI_HOME: docHome, VINCI_UPDATER_TIMEOUT_MS: "30000" },
});
ok(
  // NOT `includes("Environment: dev")`. The corrupted value is
  // `devVINCI_PROFILE_COMPLETE=<token>`, which CONTAINS "dev" — the loose
  // assertion passed with the fix reverted, so it proved nothing. Match the
  // value to end of token, and require the sentinel name to be absent entirely.
  "a profile with no trailing newline keeps its last value intact",
  noNewline.status === 0
    && /Environment: dev(\s|$)/m.test(noNewline.stdout)
    && !/VINCI_PROFILE_COMPLETE/.test(noNewline.stdout),
  `status=${noNewline.status} stdout=${noNewline.stdout}`,
);

// A REJECTED PROFILE'S SETTINGS MUST NOT SURVIVE. A truncated profile setting
// VINCI_HOME used to override the environment's, send the updater to the wrong
// path, and then be described as "ignored" — false, in the message a user reads
// while recovering.
const poisonHome = join(stage, "profile-poison-home");
mkdirSync(poisonHome, { recursive: true });
writeFileSync(join(poisonHome, ".vinci-code.env"), "VINCI_HOME=/definitely/missing\nreturn 1\n");
const poisoned = spawnSync("sh", [shim, "doctor"], {
  encoding: "utf8",
  timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: poisonHome, VINCI_HOME: docHome, VINCI_UPDATER_TIMEOUT_MS: "30000" },
});
ok(
  "a rejected profile's VINCI_HOME really is ignored, so recovery still reaches the updater",
  !/\/definitely\/missing/.test(poisoned.stderr + poisoned.stdout),
  `stdout=${poisoned.stdout} stderr=${poisoned.stderr}`,
);

// THE DIRECT PATH NEEDS THE EARLY-RETURN CHECK TOO.
//
// Pinned separately from the shim's because a both-files revert lets one
// failure mask the other — which is exactly how the missing bin/vinci gate
// survived earlier on this branch, and how the missing sentinel survived the
// first version of this commit.
const directReturnHome = join(stage, "direct-bin-early-return-home");
mkdirSync(directReturnHome, { recursive: true });
writeFileSync(
  join(directReturnHome, ".vinci-code.env"),
  "VINCI_ENV=dev\nreturn 1\nVINCI_BASE_URL=https://never-applied\n",
);
const directReturned = spawnSync("bash", [binVinci], {
  encoding: "utf8",
  timeout: 60_000,
  input: "",
  env: { PATH: process.env.PATH, HOME: directReturnHome },
});
ok(
  "running bin/vinci directly refuses a profile that returns part-way",
  directReturned.status === 78 && /part-way/.test(directReturned.stderr),
  `status=${directReturned.status} stderr=${directReturned.stderr}`,
);

ok(
  "running bin/vinci directly still answers --version with a malformed profile",
  directVersion.status === 0 && /^\d+\.\d+\.\d+/.test(directVersion.stdout.trim()),
  `status=${directVersion.status} stdout=${JSON.stringify(directVersion.stdout)}`,
);

for (const [index, [label, line]] of brokenProfiles.entries()) {
  const launcherHome = join(stage, `broken-profile-launcher-${index}`);
  mkdirSync(launcherHome, { recursive: true });
  writeFileSync(join(launcherHome, ".vinci-code.env"), `VINCI_ENV=dev\n${line}\n`);
  const launched = spawnSync("bash", [binVinci, "--version"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: launcherHome },
  });
  ok(
    `a profile containing ${label} does not stop bin/vinci reaching its --version dispatch`,
    // The concrete version, not merely non-empty output. A review was right that /\S/ would
    // accept anything at all on stdout; identity.json is what --version must actually print.
    launched.status === 0 && /^\d+\.\d+\.\d+/.test(launched.stdout.trim()),
    `status=${launched.status} stdout=${JSON.stringify(launched.stdout)} stderr=${launched.stderr}`,
  );
}

// ── 3. Links consolidation: one shared gateway value feeds /support, web_search, /feedback ──────
// Fresh jiti loaders (moduleCache off) re-evaluate the module graph per scenario, so the env can
// change between imports the way separate processes would see it.
const ENV_KEYS = ["VINCI_ENV", "VINCI_BASE_URL", "VINCI_PLATFORM_URL", "BRAVE_SEARCH_API_KEY"];
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
function setEnv(overrides) {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
}
function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
const freshLoader = () => createJiti(import.meta.url, { moduleCache: false, tryNative: false });

async function capturedSupportUrl() {
  const supportExtension = await freshLoader().import(resolve(root, "vinci/extensions/vinci-support.ts"), { default: true });
  let command;
  supportExtension(
    { registerCommand: (_name, options) => (command = options) },
    () => ({ on: () => ({ unref: () => {} }), unref: () => {} }),
  );
  const originalWrite = process.stdout.write;
  let stdout = "";
  process.stdout.write = (chunk) => ((stdout += chunk.toString()), true);
  try {
    await command.handler("", {});
  } finally {
    process.stdout.write = originalWrite;
  }
  return stdout.split("\n").filter(Boolean).pop();
}

async function capturedSearchUrl() {
  const searchExtension = await freshLoader().import(resolve(root, "vinci/extensions/vinci-search.ts"), { default: true });
  const tools = new Map();
  searchExtension({ registerTool: (tool) => tools.set(tool.name, tool) });
  const originalFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async (url) => {
    requested = String(url);
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };
  try {
    await tools.get("web_search").execute(
      "t1",
      { query: "vinci" },
      undefined,
      undefined,
      { model: { id: "auto" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) } },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  return requested;
}

try {
  // Overridden: everything follows ONE repointed origin.
  setEnv({ VINCI_BASE_URL: "https://dev.example/api/v1" });
  const links = await freshLoader().import(resolve(root, "vinci/extensions/vinci-links.ts"), { default: false });
  ok(
    "vinci-links exposes the shared overridden gateway value",
    links.VINCI_GATEWAY_BASE_URL === "https://dev.example/api/v1" && links.VINCI_PROD_GATEWAY_URL === PROD_GATEWAY,
  );
  ok(
    "the support URL follows the shared origin and keeps ?source=code",
    links.VINCI_SUPPORT_URL === "https://dev.example/support?source=code",
    links.VINCI_SUPPORT_URL,
  );
  ok(
    "/support prints the repointed URL (consumes vinci-links, not its own literal)",
    (await capturedSupportUrl()) === "https://dev.example/support?source=code",
  );
  ok(
    "web_search posts to the shared origin's gateway /search",
    (await capturedSearchUrl()) === "https://dev.example/api/v1/search",
  );
  const feedback = await freshLoader().import(resolve(root, "vinci/extensions/vinci-feedback.ts"), { default: false });
  ok(
    "/feedback derives its endpoint from the same shared origin",
    feedback.feedbackEndpoint() === "https://dev.example/api/feedback",
    feedback.feedbackEndpoint(),
  );

  // The provider — the biggest gateway consumer — must ride the same shared values.
  setEnv({ VINCI_BASE_URL: "https://dev.example/api/v1", VINCI_PLATFORM_URL: "https://platform.dev.example" });
  const platformLinks = await freshLoader().import(resolve(root, "vinci/extensions/vinci-links.ts"), { default: false });
  ok(
    "vinci-links exposes the shared effective platform base URL",
    platformLinks.VINCI_PLATFORM_BASE_URL === "https://platform.dev.example" &&
      platformLinks.VINCI_PROD_PLATFORM_URL === PROD_PLATFORM,
  );
  const providerExtension = await freshLoader().import(resolve(root, "vinci/extensions/vinci-provider.ts"), { default: true });
  const providers = new Map();
  providerExtension({ registerProvider: (name, config) => providers.set(name, config), on() {} });
  ok(
    "the provider registers the shared overridden gateway as its baseUrl",
    providers.get("vinci")?.baseUrl === "https://dev.example/api/v1",
    providers.get("vinci")?.baseUrl,
  );
  const originalFetch = globalThis.fetch;
  let pairingUrl;
  globalThis.fetch = async (url) => {
    pairingUrl = String(url);
    return { ok: false, status: 503 };
  };
  try {
    await providers.get("vinci").oauth.login({});
    assert.fail("pairing against a 503 stub must throw");
  } catch (error) {
    ok(
      "device pairing starts against the shared overridden platform URL",
      pairingUrl === "https://platform.dev.example/api/device/code" && /Couldn't start pairing/.test(error.message),
      `${pairingUrl} — ${error.message}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Default: identical prod behavior everywhere.
  setEnv({});
  const prodLinks = await freshLoader().import(resolve(root, "vinci/extensions/vinci-links.ts"), { default: false });
  ok(
    "with no override the shared value is the prod gateway",
    prodLinks.VINCI_GATEWAY_BASE_URL === PROD_GATEWAY &&
      prodLinks.VINCI_SUPPORT_URL === "https://vinci.getsimpledirect.com/support?source=code",
  );
  ok(
    "default /support and web_search stay on prod",
    (await capturedSupportUrl()) === "https://vinci.getsimpledirect.com/support?source=code" &&
      (await capturedSearchUrl()) === `${PROD_GATEWAY}/search`,
  );
  const prodFeedback = await freshLoader().import(resolve(root, "vinci/extensions/vinci-feedback.ts"), { default: false });
  ok(
    "default /feedback endpoint stays on prod (whitespace override still falls back)",
    prodFeedback.feedbackEndpoint() === "https://vinci.getsimpledirect.com/api/feedback",
  );

  // ── 4. Header badge ───────────────────────────────────────────────────────────────────────────
  const { ENV_AGENT_DIR } = await freshLoader().import(resolve(root, "packages/coding-agent/src/config.ts"), { default: false });
  const savedAgentDir = process.env[ENV_AGENT_DIR];
  const savedWordmark = process.env.VINCI_ASCII_WORDMARK;
  process.env[ENV_AGENT_DIR] = mkdtempSync(join(tmpdir(), "vinci-badge-agent-"));
  process.env.VINCI_ASCII_WORDMARK = "1"; // force the no-image header path

  // Theme stub: mark warning-styled spans so the badge is identifiable (and its style pinned)
  // without depending on ANSI codes; everything else passes through.
  const theme = { fg: (style, text) => (style === "warning" ? `«W:${text}»` : text), bold: (text) => text };
  async function renderedHeader() {
    const headerExtension = await freshLoader().import(resolve(root, "vinci/extensions/vinci-header.ts"), { default: true });
    let sessionStart;
    let factory;
    headerExtension({ on: (name, handler) => name === "session_start" && (sessionStart = handler) });
    await sessionStart({}, {
      mode: "tui",
      cwd: "/workspace",
      model: { id: "auto", name: "Vinci" },
      ui: { notify() {}, setHeader: (f) => (factory = f) },
    });
    return factory(undefined, theme).render(500).join("\n");
  }

  setEnv({ VINCI_ENV: "dev" });
  const devHeader = await renderedHeader();
  ok("the header shows a warning-colored dev badge under VINCI_ENV=dev", devHeader.includes("«W:▲ dev»"), devHeader);

  setEnv({});
  const prodHeader = await renderedHeader();
  ok(
    "the prod header carries no environment badge (and no other warning span)",
    !prodHeader.includes("▲") && !prodHeader.includes("«W:"),
    prodHeader,
  );

  setEnv({ VINCI_BASE_URL: "https://custom.example/api/v1" });
  const overriddenHeader = await renderedHeader();
  ok(
    "a bare base-URL override badges the session with the gateway host",
    overriddenHeader.includes("«W:▲ custom.example»"),
    overriddenHeader,
  );

  // Cosmetic variants of the PROD URL must NOT read as a different backend, and an
  // exported-but-empty override means "unset", not a mystery backend labeled "▲ ".
  setEnv({ VINCI_BASE_URL: `${PROD_GATEWAY}/` });
  const trailingSlashHeader = await renderedHeader();
  ok("a trailing slash on the prod URL renders no badge", !trailingSlashHeader.includes("«W:"), trailingSlashHeader);
  setEnv({ VINCI_BASE_URL: "https://VINCI.getsimpledirect.com/api/v1" });
  const upperHostHeader = await renderedHeader();
  ok("an uppercase prod host renders no badge", !upperHostHeader.includes("«W:"), upperHostHeader);
  setEnv({ VINCI_BASE_URL: "" });
  const emptyOverrideHeader = await renderedHeader();
  ok("an exported-but-empty override renders no badge", !emptyOverrideHeader.includes("«W:"), emptyOverrideHeader);

  if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
  else process.env[ENV_AGENT_DIR] = savedAgentDir;
  if (savedWordmark === undefined) delete process.env.VINCI_ASCII_WORDMARK;
  else process.env.VINCI_ASCII_WORDMARK = savedWordmark;
} finally {
  restoreEnv();
}

rmSync(stage, { recursive: true, force: true });
console.log(`\ndev-env-integration: ${pass}/${pass} checks passed`);
