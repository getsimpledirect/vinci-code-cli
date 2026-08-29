// W2 — the opt-in `governed` unattended policy profile.
//
// What these checks pin, in the order the profile's claims have to be true:
//   1. the profile is UNREACHABLE without an explicit opt-in AND a Governor lease behind it;
//   2. the daemon is the only producer, and it DELETES the profile on every ungoverned path;
//   3. each of the eleven headless gates lands in the bucket it was classified into — including
//      the ones that must keep blocking;
//   4. the three outcomes stay separately identifiable all the way into the terminal post.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

import { unattendedPolicyEnv, UNATTENDED_POLICY_ENV_KEYS } from "../worker/governor.mjs";
import { applyEnvDelta } from "../worker/run.mjs";
import { summarizeUnattendedPolicy } from "../worker/session-read.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, {
  moduleCache: false,
  tryNative: false,
  alias: {
    "@earendil-works/pi-coding-agent": resolve(here, "../../packages/coding-agent/dist/index.js"),
  },
});
const guard = await loader.import(resolve(here, "../extensions/vinci-guard.ts"), { default: false });
const policy = await loader.import(resolve(here, "../extensions/lib/unattended-policy.ts"), { default: false });
const control = await loader.import(resolve(here, "../extensions/lib/control.ts"), { default: false });

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

const handlers = {};
const appended = [];
const pi = {
  on(name, handler) {
    (handlers[name] ??= []).push(handler);
  },
  registerCommand() {},
  sendMessage() {},
  appendEntry(customType, data) {
    appended.push({ customType, data });
  },
};
guard.default(pi);

const workspace = mkdtempSync(join(tmpdir(), "vinci-unattended-policy-"));
writeFileSync(join(workspace, "app.js"), "console.log('x');\n");
writeFileSync(join(workspace, ".env"), "API_KEY=abc\n");

const headlessCtx = { cwd: workspace, hasUI: false, ui: { notify() {} } };
// The guard latches per-session approvals (git checkpoint, build network). Replay a neutral user
// request before every call so each check starts from the same session state and the checks cannot
// pass on a latch a previous check set.
async function resetSession() {
  for (const handler of handlers.input ?? []) {
    await handler({ type: "input", text: "do the task in the work order", source: "interactive" }, headlessCtx);
  }
}
async function headlessCall(toolName, input) {
  await resetSession();
  control.clearVinciConfirmationGate();
  policy.clearUnattendedDecisions();
  appended.length = 0;
  for (const handler of handlers.tool_call ?? []) {
    const result = await handler({ toolName, input }, headlessCtx);
    if (result !== undefined) return result;
  }
  return undefined;
}
const decisions = () => policy.getUnattendedDecisions();
const only = () => {
  assert.equal(decisions().length, 1, `expected exactly one policy decision, got ${JSON.stringify(decisions())}`);
  return decisions()[0];
};
const last = () => decisions()[decisions().length - 1];

const savedEnv = { ...process.env };
function setProfile({ profile, lease }) {
  if (profile === undefined) delete process.env.VINCI_UNATTENDED_POLICY;
  else process.env.VINCI_UNATTENDED_POLICY = profile;
  if (lease === undefined) delete process.env.VINCI_UNATTENDED_LEASE;
  else process.env.VINCI_UNATTENDED_LEASE = lease;
}

try {
  // ── 1. The opt-in predicate ───────────────────────────────────────────────────────────────────
  check("profile is off when nothing is set", policy.unattendedPolicyProfile({}) === null);
  check(
    "profile is off with the env var alone — a lease is REQUIRED",
    policy.unattendedPolicyProfile({ VINCI_UNATTENDED_POLICY: "governed" }) === null,
  );
  check(
    "profile is off with an EMPTY lease",
    policy.unattendedPolicyProfile({ VINCI_UNATTENDED_POLICY: "governed", VINCI_UNATTENDED_LEASE: "  " }) === null,
  );
  check(
    "profile is off with a lease but no opt-in",
    policy.unattendedPolicyProfile({ VINCI_UNATTENDED_LEASE: "t/1@now" }) === null,
  );
  check(
    "an unrecognised profile name is off",
    policy.unattendedPolicyProfile({ VINCI_UNATTENDED_POLICY: "unattended", VINCI_UNATTENDED_LEASE: "t/1@now" }) === null,
  );
  check(
    "profile is on only with BOTH the opt-in and a lease",
    policy.unattendedPolicyProfile({ VINCI_UNATTENDED_POLICY: "governed", VINCI_UNATTENDED_LEASE: "t/1@now" })?.lease ===
      "t/1@now",
  );

  // ── 2. The daemon is the only producer, and it strips the profile without a lease ─────────────
  const granted = { success: true, id: "task-1/1@2026-08-29T00:00:00.000Z", ttl: 900 };
  check(
    "a granted lease stamps the profile and the lease id",
    unattendedPolicyEnv(granted).VINCI_UNATTENDED_POLICY === "governed" &&
      unattendedPolicyEnv(granted).VINCI_UNATTENDED_LEASE === granted.id,
  );
  for (const [label, lease] of [
    ["no governor configured (null)", null],
    ["a refusal", { success: false, blocked: true, refused: true, reason: "no" }],
    ["an unavailability", { success: false, blocked: true, error: true, reason: "down" }],
    ["a success with no lease id", { success: true }],
  ]) {
    const delta = unattendedPolicyEnv(lease);
    check(
      `${label} DELETES both profile variables`,
      UNATTENDED_POLICY_ENV_KEYS.every((key) => key in delta && delta[key] === undefined),
    );
  }
  // The leak this closes: a daemon whose OWN environment carries the profile must not hand it to an
  // ungoverned child. The delta deletes, it does not merely omit.
  const leaky = { VINCI_UNATTENDED_POLICY: "governed", VINCI_UNATTENDED_LEASE: "stale", PATH: "/bin" };
  const stripped = applyEnvDelta(leaky, unattendedPolicyEnv(null));
  check(
    "an ungoverned run cannot inherit the profile from the daemon's env",
    !("VINCI_UNATTENDED_POLICY" in stripped) && !("VINCI_UNATTENDED_LEASE" in stripped) && stripped.PATH === "/bin",
  );
  check(
    "a governed run gets the profile applied on top of a clean-room env",
    applyEnvDelta({ PATH: "/bin" }, unattendedPolicyEnv(granted)).VINCI_UNATTENDED_LEASE === granted.id,
  );

  // ── 3. Default behaviour is unchanged (profile unset) ─────────────────────────────────────────
  setProfile({});
  const defaultNetwork = await headlessCall("bash", { command: "curl https://example.com/data.json" });
  check(
    "profile OFF: an ordinary network command blocks exactly as today",
    defaultNetwork?.block === true && /no UI to confirm this in a non-interactive run/.test(defaultNetwork.reason),
  );
  check("profile OFF: no policy decision is recorded at all", decisions().length === 0 && appended.length === 0);
  check("profile OFF: the confirmation gate is still recorded", control.getVinciConfirmationGates().length === 1);

  // Opt-in WITHOUT a lease must be indistinguishable from the default.
  setProfile({ profile: "governed" });
  const noLease = await headlessCall("bash", { command: "curl https://example.com/data.json" });
  check(
    "opt-in with NO lease keeps the conservative gate, byte for byte",
    noLease?.block === true && noLease.reason === defaultNetwork.reason,
  );
  check("opt-in with NO lease records no policy decision", decisions().length === 0);

  // ── 4. The buckets ───────────────────────────────────────────────────────────────────────────
  setProfile({ profile: "governed", lease: "task-1/1@2026-08-29T00:00:00.000Z" });

  // PROCEED — the measured killer: 2 of the 3 deaths were "run a command that needs the internet".
  const ordinaryNet = await headlessCall("bash", { command: "curl https://example.com/data.json" });
  check("PROCEED: an ordinary network command is allowed under a lease", ordinaryNet === undefined);
  check("PROCEED: the decision is recorded as PROCEEDED", only().outcome === "PROCEEDED" && only().site === "network-ordinary");
  check(
    "PROCEED: the decision is durable in the session transcript",
    appended.length === 1 &&
      appended[0].customType === "vinci-unattended-policy" &&
      appended[0].data.outcome === "PROCEEDED",
  );
  check("PROCEED: no confirmation gate is recorded — nothing was held", control.getVinciConfirmationGates().length === 0);

  const install = await headlessCall("bash", { command: "npm install" });
  check("PROCEED: a dependency install is allowed under a lease", install === undefined && only().outcome === "PROCEEDED");

  const commit = await headlessCall("bash", { command: 'git add app.js && git commit -m "work"' });
  check(
    "PROCEED: the unrequested-checkpoint gate resolves as PROCEEDED",
    commit === undefined && only().outcome === "PROCEEDED" && only().site === "git-checkpoint",
  );

  // ESCALATE — consequential, and the Governor could authorize it, but never self-granted.
  const push = await headlessCall("bash", { command: "git push origin feat/x" });
  check("ESCALATE: an OUTWARD network command still stops the run", push?.block === true);
  check("ESCALATE: it is recorded as ESCALATED, not PROCEEDED", only().outcome === "ESCALATED" && only().site === "network-outward");
  check(
    "ESCALATE: the reason names the Governor as the grantor, not an absent user",
    /grantor=governor/.test(push.reason) && /Governor authorization/.test(push.reason),
  );
  check(
    "ESCALATE: the reason drops today's 'waiting on their go-ahead' prose",
    !/waiting on their go-ahead/.test(push.reason),
  );
  check("ESCALATE: the held step is still named for the closing handoff", control.getVinciConfirmationGates().length === 1);

  const publishPkg = await headlessCall("bash", { command: "npm publish" });
  check("ESCALATE: npm publish is never a PROCEED", publishPkg?.block === true && only().outcome === "ESCALATED");

  const globalInstall = await headlessCall("bash", { command: "npm install -g typescript" });
  check(
    "ESCALATE: a SYSTEM-class network command escalates, it does not proceed",
    globalInstall?.block === true && only().outcome === "ESCALATED" && only().site === "network-system",
  );

  const credRead = await headlessCall("read", { path: join(workspace, ".env") });
  check(
    "ESCALATE: reading a credentials file escalates — a path claim is not a disclosure grant",
    credRead?.block === true && only().outcome === "ESCALATED" && only().site === "file-credential-read",
  );
  const shellCredRead = await headlessCall("bash", { command: "cat .env" });
  check(
    "ESCALATE: the shell twin of the credential read escalates too",
    shellCredRead?.block === true && only().outcome === "ESCALATED" && only().site === "shell-credential-read",
  );

  const migrate = await headlessCall("bash", { command: "npx prisma migrate dev --name add_phone" });
  check("KEEP-BLOCKING: a database migration is still refused", migrate?.block === true);
  check("KEEP-BLOCKING: it is recorded as BLOCKED", only().outcome === "BLOCKED");
  check(
    "KEEP-BLOCKING: the reason says a lease does not override it",
    /a Governor lease does not override/.test(migrate.reason),
  );

  const reset = await headlessCall("bash", { command: "git reset --hard HEAD~3" });
  check(
    "KEEP-BLOCKING: a destructive command is still refused",
    reset?.block === true && only().outcome === "BLOCKED" && only().site === "dangerous-command",
  );

  const rmrf = await headlessCall("bash", { command: "rm -rf build" });
  check("KEEP-BLOCKING: rm -rf is still refused", rmrf?.block === true && only().outcome === "BLOCKED");

  // Two gates in one command, and they must land in DIFFERENT buckets: the checkpoint itself is a
  // PROCEED, its contents are not. This is the pair that shows the profile is per-gate, not per-run.
  const secretCommit = await headlessCall("bash", { command: "git add .env && git commit -m secrets" });
  check(
    "KEEP-BLOCKING: committing secret files is still refused under a lease",
    secretCommit?.block === true && last().outcome === "BLOCKED" && last().site === "commit-secret-files",
  );
  check(
    "the allowed checkpoint and the refused contents are recorded as different outcomes",
    decisions().length === 2 &&
      decisions()[0].outcome === "PROCEEDED" &&
      decisions()[0].site === "git-checkpoint" &&
      decisions()[1].outcome === "BLOCKED",
  );

  const outside = await headlessCall("write", {
    path: join(homedir(), "Desktop", "vinci-w2-outside.txt"),
    content: "x",
  });
  check(
    "KEEP-BLOCKING: a write outside the project folder is still refused",
    outside?.block === true && only().outcome === "BLOCKED" && only().site === "outside-project-write",
  );

  const envWrite = await headlessCall("write", { path: ".env", content: "API_KEY=zzz\nOTHER_KEY=qqq\nTHIRD=1\n" });
  check(
    "KEEP-BLOCKING: writing a sensitive path is still refused",
    envWrite?.block === true && only().outcome === "BLOCKED" && only().site === "sensitive-path-write",
  );

  // The load-bearing refusal the spec singles out. It is NOT a blockHeadless site at all — it
  // blocks in interactive runs too — so the profile cannot reach it by construction. Pinned here
  // anyway, because "the profile does not touch it" is the claim that matters.
  const shellWrite = await headlessCall("bash", { command: "echo 'hello' > notes.txt" });
  check(
    "the shell-based file write STILL blocks under the profile",
    shellWrite?.block === true && /shell-based file write/i.test(shellWrite.reason),
  );
  check("the shell-write refusal is not a policy decision at all", decisions().length === 0);

  const catastrophic = await headlessCall("bash", { command: "mkfs.ext4 /dev/sda1" });
  check(
    "the CATASTROPHIC list is untouched by the profile",
    catastrophic?.block === true && /never safe/i.test(catastrophic.reason) && decisions().length === 0,
  );

  // ── 5. The record keeps the three apart ───────────────────────────────────────────────────────
  policy.clearUnattendedDecisions();
  policy.recordUnattendedDecision({ outcome: "PROCEEDED", site: "network-ordinary", gate: "net", lease: "l" });
  policy.recordUnattendedDecision({ outcome: "ESCALATED", site: "network-outward", gate: "push", lease: "l" });
  policy.recordUnattendedDecision({ outcome: "BLOCKED", site: "dangerous-command", gate: "reset", lease: "l" });
  const summary = policy.summarizeUnattendedDecisions();
  check(
    "the in-process summary counts all three separately",
    summary.blocked === 1 && summary.escalated === 1 && summary.proceeded === 1,
  );

  const workerSummary = summarizeUnattendedPolicy([
    { outcome: "PROCEEDED", site: "network-ordinary", gate: "net" },
    { outcome: "PROCEEDED", site: "git-checkpoint", gate: "commit" },
    { outcome: "ESCALATED", site: "network-outward", gate: "push" },
    { outcome: "BLOCKED", site: "dangerous-command", gate: "reset" },
  ]);
  check(
    "the worker-side summary counts all three separately",
    workerSummary.blocked === 1 && workerSummary.escalated === 1 && workerSummary.proceeded === 2,
  );
  check(
    "the worker-side summary names the sites per bucket",
    workerSummary.sites.escalated.join() === "network-outward" &&
      workerSummary.sites.proceeded.join() === "network-ordinary,git-checkpoint",
  );
  check("a run that met no gate reports no policy fields", summarizeUnattendedPolicy([]) === null);
  const unknown = summarizeUnattendedPolicy([{ outcome: "ALLOWED", site: "x", gate: "y" }]);
  check(
    "an unrecognised outcome is dropped, never counted as the most permissive bucket",
    unknown.blocked === 0 && unknown.escalated === 0 && unknown.proceeded === 0,
  );

  // The distinguishability claim, stated as the thing that must NOT be true: an escalation and a
  // proceed must never produce the same record. This is the check mutation (d) has to break.
  const escalatedOnly = summarizeUnattendedPolicy([{ outcome: "ESCALATED", site: "network-outward", gate: "push" }]);
  const proceededOnly = summarizeUnattendedPolicy([{ outcome: "PROCEEDED", site: "network-ordinary", gate: "net" }]);
  check(
    "an ESCALATED run and a PROCEEDED run are not the same record",
    JSON.stringify(escalatedOnly) !== JSON.stringify(proceededOnly) &&
      escalatedOnly.escalated === 1 &&
      escalatedOnly.proceeded === 0 &&
      proceededOnly.escalated === 0 &&
      proceededOnly.proceeded === 1,
  );
  check(
    "the tag a downstream reader routes on carries the outcome and the site",
    policy.unattendedDecisionTag({ outcome: "ESCALATED", site: "network-outward", gate: "push commits", lease: "l" }) ===
      '[vinci-unattended outcome=ESCALATED site=network-outward gate="push commits" grantor=governor lease=l]',
  );
} finally {
  setProfile({});
  for (const [key, value] of Object.entries(savedEnv)) if (process.env[key] === undefined) process.env[key] = value;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(join(homedir(), "Desktop", "vinci-w2-outside.txt"), { force: true });
}

console.log(`\nworker-unattended-policy: ${pass}/${pass} checks passed (governed profile: opt-in, buckets, record)`);
