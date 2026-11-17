// Regression checks for #198: always-allow trust is saved only after the guard allows a command.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, {
  moduleCache: false,
  tryNative: false,
  alias: {
    "@earendil-works/pi-coding-agent": resolve(here, "../../packages/coding-agent/dist/index.js"),
  },
});
const guard = await loader.import(resolve(here, "../extensions/vinci-guard.ts"), { default: false });

const runRoot = mkdtempSync(join(tmpdir(), "vinci-guard-trust-order-"));
const workspace = join(runRoot, "project");
const trustPath = join(runRoot, "vinci-trust.json");
const originalTrustFile = process.env.VINCI_TRUST_FILE;
const originalSecurityNonce = process.env.VINCI_SECURITY_NONCE;
const NO = "No, don't";
const YES = "Yes, run it";
const ALWAYS = "Always allow this exact command in this project";
const ALLOW = "Yes, allow it";
const REMEMBER_NOTICE = "Got it — I'll remember that exact command in this project if it passes the remaining checks (/allowed to undo).";

function createHarness({ riskyChoice = ALWAYS, deniedTitle, rememberError } = {}) {
  const handlers = {};
  const dialogs = [];
  const notifications = [];
  const pi = {
    on(name, handler) {
      (handlers[name] ??= []).push(handler);
    },
    registerCommand() {},
    sendMessage() {},
  };
  guard.default(pi);
  const ctx = {
    cwd: workspace,
    hasUI: true,
    ui: {
      async select(title, options) {
        dialogs.push({ title, options: [...options] });
        if (options.includes(ALWAYS)) return riskyChoice;
        if (deniedTitle && title.startsWith(`${deniedTitle}\n\n`)) return NO;
        assert.ok(options.includes(ALLOW), `unexpected dialog: ${title}`);
        return ALLOW;
      },
      notify(message, level) {
        notifications.push({ message, level });
        if (rememberError && message.startsWith("Got it —")) throw rememberError;
      },
    },
  };
  return {
    dialogs,
    notifications,
    async toolCall(command) {
      for (const handler of handlers.tool_call ?? []) {
        const result = await handler({ toolName: "bash", input: { command } }, ctx);
        if (result !== undefined) return result;
      }
      return undefined;
    },
  };
}

function trustSnapshot() {
  return existsSync(trustPath) ? readFileSync(trustPath) : undefined;
}

function assertOnlyTrust(command) {
  assert.ok(existsSync(trustPath), "an allowed ALWAYS choice must create the trust file");
  assert.deepEqual(JSON.parse(readFileSync(trustPath, "utf8")), { [workspace]: [command] }, "save exactly this command under this cwd");
}

const refusedFixtures = [
  {
    name: "R1",
    command: "git push --force origin main",
    titles: ["Vinci — confirm a risky command", "Vinci — allow this network command once?"],
    refusal: /force-push to a protected branch/,
    message: "protected-branch refusal leaves trust unchanged after ALWAYS",
    noPermanencePromise: true,
  },
  {
    name: "R2",
    command: "npx prisma migrate dev; rm -rf /",
    titles: ["Vinci — confirm a database change", "Vinci — allow this network command once?"],
    refusal: /rm -rf on \/ or your home directory/,
    message: "root-delete refusal leaves trust unchanged after ALWAYS",
  },
  {
    name: "R3a",
    // Only the database class matches; bare npx is dev tooling. BUILD-NETWORK denial fires.
    command: "npx prisma migrate dev",
    titles: ["Vinci — confirm a database change", "Vinci — let builds reach the internet?"],
    deniedTitle: "Vinci — let builds reach the internet?",
    refusal: /declined internet access for BUILD TOOLS/,
    message: "BUILD-NETWORK denial leaves trust unchanged after ALWAYS",
  },
  {
    name: "R3b",
    // Dangerous + outward classes force the per-command gate. EXACT-NETWORK denial fires.
    command: "git push --force origin feature",
    titles: ["Vinci — confirm a risky command", "Vinci — allow this network command once?"],
    deniedTitle: "Vinci — allow this network command once?",
    refusal: /declined THIS network command/,
    message: "EXACT-NETWORK denial leaves trust unchanged after ALWAYS",
  },
  {
    name: "R4",
    // E1: notify throws immediately after ALWAYS is recorded, before confirmRisky returns.
    // Catch that exact exception so unfixed code fails on the trust assertion, not a crash.
    command: "git push --force origin feature",
    titles: ["Vinci — confirm a risky command"],
    throwsAfterAlways: true,
    message: "exception after ALWAYS leaves trust unchanged",
  },
];

async function assertRefusalPreservesTrust(fixture) {
  const rememberError = fixture.throwsAfterAlways ? new Error("notification failed after ALWAYS") : undefined;
  const harness = createHarness({ deniedTitle: fixture.deniedTitle, rememberError });
  const before = trustSnapshot();
  let result;
  if (rememberError) {
    await assert.rejects(() => harness.toolCall(fixture.command), (error) => error === rememberError);
  } else {
    result = await harness.toolCall(fixture.command);
  }
  // Prove each fixture reaches the priority ALWAYS ask before checking trust bytes.
  assert.ok(harness.dialogs.length >= 1, `${fixture.name}: must reach a priority dialog`);
  assert.deepEqual(harness.dialogs[0].options, [NO, YES, ALWAYS], `${fixture.name}: must offer ALWAYS first`);
  assert.deepEqual(harness.dialogs.map(({ title }) => title.split("\n\n")[0]), fixture.titles, `${fixture.name}: expected guard sequence`);
  if (!rememberError) {
    assert.equal(result?.block, true, `${fixture.name}: must block after ALWAYS`);
    assert.match(result.reason, fixture.refusal, `${fixture.name}: expected refusal`);
  }
  assert.deepEqual(trustSnapshot(), before, `${fixture.name}: refusal or exception must not change trust bytes`);
  if (fixture.noPermanencePromise) {
    // The ALWAYS notice must have fired (so this check is not vacuous) and must not promise a saved grant.
    assert.ok(harness.notifications.some(({ message }) => message.startsWith("Got it —")), `${fixture.name}: the ALWAYS notice must be shown`);
    assert.ok(!harness.notifications.some(({ message }) => /won.t ask/.test(message)), `${fixture.name}: a refused ALWAYS must not promise never to ask again`);
  }
}

const rows = [
  ...refusedFixtures.map((fixture) => ({
    name: fixture.name,
    message: fixture.message,
    run: () => assertRefusalPreservesTrust(fixture),
  })),
  {
    name: "R5",
    message: "refused ALWAYS cannot leak into a later allowed invocation on the same harness",
    async run() {
      const harness = createHarness({ riskyChoice: ALWAYS });
      const before = trustSnapshot();
      const result = await harness.toolCall("git push --force origin main");
      assert.equal(result?.block, true, "R5: protected-branch force-push must be refused");
      assert.match(result.reason, /force-push to a protected branch/, "R5: expected R1 refusal");
      assert.ok(harness.dialogs.length >= 1, "R5: first invocation must reach a priority dialog");
      assert.deepEqual(harness.dialogs[0].options, [NO, YES, ALWAYS], "R5: first invocation must offer ALWAYS");
      const afterRefusal = trustSnapshot();
      const dialogsAfterRefusal = harness.dialogs.length;
      assert.notEqual((await harness.toolCall("ls"))?.block, true, "R5: benign second invocation must be allowed");
      assert.equal(harness.dialogs.length, dialogsAfterRefusal, "R5: ls must not show a dialog");
      // On base R5 is RED because the first refusal already persisted the grant, not
      // because of the ls call. The coordinator's expectation of green on base is wrong.
      assert.deepEqual(afterRefusal, before, "R5: first refusal must not change trust bytes");
      assert.deepEqual(trustSnapshot(), before, "R5: later allow must not commit the refused invocation's grant");
    },
  },
  {
    name: "R6",
    message: "secret-staging refusal leaves trust unchanged after an earlier ALWAYS choice",
    async run() {
      // Use the C6 path: approve the checkpoint, choose ALWAYS, then decline secret staging.
      // The command first raises the credential-exposure dialog (No / Yes, allow it); the harness
      // answers ALLOW, which grants this one invocation only and writes nothing to the trust file.
      const command = "git reset --hard HEAD~1; prisma migrate dev; git add .env";
      const harness = createHarness({ riskyChoice: ALWAYS, deniedTitle: "Vinci — put secrets into git?" });
      const before = trustSnapshot();
      const result = await harness.toolCall(command);
      assert.equal(result?.block, true, "R6: declined secret staging must be blocked");
      assert.ok(harness.dialogs.length >= 1, "R6: must reach a dialog before checking trust");
      assert.ok(harness.dialogs.some(({ title }) => title.startsWith("Vinci — put secrets into git?\n\n")),
        "R6: must show the secret-staging prompt");
      assert.deepEqual(harness.dialogs.map(({ title }) => title.split("\n\n")[0]), [
        "Vinci — expose credentials to this session?",
        "Vinci — save a git checkpoint?",
        "Vinci — confirm a risky command",
        "Vinci — put secrets into git?",
      ], "R6: checkpoint approval and ALWAYS must precede the secret-staging decline");
      assert.deepEqual(harness.dialogs[2].options, [NO, YES, ALWAYS], "R6: earlier ask must offer ALWAYS");
      assert.deepEqual(harness.dialogs[3].options, [NO, ALLOW], "R6: secret-staging decline must be offered");
      // Base persists ALWAYS before this late refusal; the fix must leave trust unchanged.
      assert.deepEqual(trustSnapshot(), before, "R6: secret-staging refusal must not change trust bytes");
    },
  },
  {
    name: "C1",
    message: "allowed reset saves exactly one grant and a second invocation asks nothing",
    async run() {
      const command = "git reset --hard HEAD~1";
      const first = createHarness();
      assert.notEqual((await first.toolCall(command))?.block, true, "first reset must be allowed");
      assert.equal(first.dialogs.length, 1, "first reset asks exactly once");
      assert.ok(first.notifications.some(({ message }) => message === REMEMBER_NOTICE), "C1: the ALWAYS notice must say the grant is kept only if the remaining checks pass");
      assertOnlyTrust(command);
      const second = createHarness();
      assert.notEqual((await second.toolCall(command))?.block, true, "trusted reset must be allowed");
      assert.equal(second.dialogs.length, 0, "second invocation reads persistent trust without a dialog");
      assertOnlyTrust(command);
    },
  },
  {
    name: "C2",
    message: "unrelated project trust survives R1, R2, R3a, R3b and R4 byte for byte",
    async run() {
      const unrelatedCwd = join(runRoot, "unrelated-project");
      const seededBytes = Buffer.from(`${JSON.stringify({ [unrelatedCwd]: ["git clean -fdx"] }, null, 2)}\n`);
      // Every fixture gets a fresh extension instance and the same pre-existing store bytes.
      for (const fixture of refusedFixtures) {
        writeFileSync(trustPath, seededBytes);
        await assertRefusalPreservesTrust(fixture);
        assert.deepEqual(trustSnapshot(), seededBytes, `${fixture.name}: preserve unrelated project and formatting byte for byte`);
      }
    },
  },
  {
    name: "C3",
    message: "multi-class approval preserves the unfixed dialog sequence and saves one command",
    async run() {
      const command = "git reset --hard HEAD~1; prisma migrate dev";
      const harness = createHarness();
      assert.notEqual((await harness.toolCall(command))?.block, true, "multi-class command must be allowed");
      // Before #198 the first ALWAYS write silences the later database confirm for this command.
      // Pending trust must retain this exact single dialog, including text and option order.
      assert.deepEqual(harness.dialogs, [{
        title: `Vinci — confirm a risky command\n\nThis looks destructive (git reset --hard — discards uncommitted work):\n\n  ${command}\n\nRun it?`,
        options: [NO, YES, ALWAYS],
      }], "preserve the unfixed dialog text, order, and count");
      assertOnlyTrust(command);
    },
  },
  {
    name: "C4",
    message: "Yes, run it allows once without writing trust",
    async run() {
      const harness = createHarness({ riskyChoice: YES });
      assert.notEqual((await harness.toolCall("git reset --hard HEAD~1"))?.block, true, "one-time reset must be allowed");
      assert.equal(harness.dialogs.length, 1, "one-time reset asks exactly once");
      assert.deepEqual(harness.dialogs[0].options, [NO, YES, ALWAYS], "Yes, run it must be offered");
      assert.equal(existsSync(trustPath), false, "Yes, run it must not create trust");
    },
  },
  {
    name: "C5",
    message: "single-consequential allow exit commits its pending grant",
    async run() {
      // SYSTEM only: no dangerous class or network detector matches git config --global.
      const command = "git config --global user.name Example";
      const harness = createHarness();
      assert.notEqual((await harness.toolCall(command))?.block, true, "system-only command must be allowed");
      assert.deepEqual(harness.dialogs, [{
        title: `Vinci — this changes your computer\n\nVinci wants to change your git setup (where your code gets sent):\n\n  ${command}\n\nGo ahead?`,
        options: [NO, YES, ALWAYS],
      }], "reach exactly the system-only confirmation");
      assertOnlyTrust(command);
    },
  },
  {
    name: "C6",
    message: "secret-staging approval commits an earlier pending ALWAYS grant",
    async run() {
      // The credential-exposure dialog comes first and is answered ALLOW (once only, never saved);
      // the trust assertions below show that answer adds nothing to the trust file.
      // Dangerous + database avoids both single-class early exits; git add .env reaches the
      // secret-staging return after ALWAYS. No shell command is executed by this harness.
      const command = "git reset --hard HEAD~1; prisma migrate dev; git add .env";
      const harness = createHarness();
      assert.notEqual((await harness.toolCall(command))?.block, true, "approved secret staging must be allowed");
      assert.deepEqual(harness.dialogs, [
        {
          title: `Vinci — expose credentials to this session?\n\nThis command may print credentials into Vinci's model context:\n\n  ${command}\n\nRun this exact command once? Detected values will be redacted.`,
          options: [NO, ALLOW],
        },
        {
          title: `Vinci — save a git checkpoint?\n\nYou didn't ask Vinci to stage or commit changes in this request:\n\n  ${command}\n\nCreate a git checkpoint now?`,
          options: [NO, ALLOW],
        },
        {
          title: `Vinci — confirm a risky command\n\nThis looks destructive (git reset --hard — discards uncommitted work):\n\n  ${command}\n\nRun it?`,
          options: [NO, YES, ALWAYS],
        },
        {
          title: `Vinci — put secrets into git?\n\nThis would add secret files to git, which leaks them once the repo is pushed:\n\n  ${command}\n\nAre you sure?`,
          options: [NO, ALLOW],
        },
      ], "checkpoint approval, ALWAYS, then secret-staging approval in order");
      // Removing commitPendingGrants() from the secret-staging success return fails this assertion.
      assertOnlyTrust(command);
    },
  },
];

let failed = false;
try {
  for (const row of rows) {
    try {
      // Reset persistent and in-memory fixture state INSIDE each independently caught row.
      rmSync(trustPath, { force: true });
      rmSync(workspace, { recursive: true, force: true });
      mkdirSync(workspace);
      process.env.VINCI_TRUST_FILE = trustPath;
      if (originalSecurityNonce === undefined) delete process.env.VINCI_SECURITY_NONCE;
      else process.env.VINCI_SECURITY_NONCE = originalSecurityNonce;
      await row.run();
      console.log(`ROW ${row.name} PASS ${row.message}`);
    } catch (error) {
      failed = true;
      const message = String(error instanceof Error ? error.message : error).replace(/\s+/g, " ");
      console.log(`ROW ${row.name} FAIL ${message}`);
    }
  }
} finally {
  if (originalTrustFile === undefined) delete process.env.VINCI_TRUST_FILE;
  else process.env.VINCI_TRUST_FILE = originalTrustFile;
  if (originalSecurityNonce === undefined) delete process.env.VINCI_SECURITY_NONCE;
  else process.env.VINCI_SECURITY_NONCE = originalSecurityNonce;
  rmSync(runRoot, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
