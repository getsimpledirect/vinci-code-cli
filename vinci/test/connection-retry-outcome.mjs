// Offline retry/outcome reproduction through the real session and receipt extension.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } from "../../packages/coding-agent/dist/index.js";
import { printModeExitCode } from "../../packages/coding-agent/dist/modes/print-mode.js";
import { vinciFriendlyError } from "../../packages/coding-agent/dist/modes/interactive/components/assistant-message.js";
import receipt from "../dist/extensions/vinci-receipt.js";

process.env.VINCI_CODE = "1";
const owned = mkdtempSync(join(tmpdir(), "connection-retry-"));
const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
process.env.GIT_CEILING_DIRECTORIES = owned;
const connectionError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." });
const selected = process.argv.slice(2);

async function fixture(mode, { maxRetries = 2, baseDelayMs = 1, enabled = true, tools = false } = {}) {
  const cwd = mkdtempSync(join(owned, `${mode}-`));
  const agentDir = join(cwd, "profile");
  mkdirSync(agentDir);
  const faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(faux.getModel().provider, "offline-faux-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled, maxRetries, baseDelayMs },
    compaction: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, extensionFactories: [receipt],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd, agentDir, authStorage, modelRegistry, settingsManager, resourceLoader,
    model: faux.getModel(), sessionManager: SessionManager.inMemory(cwd), ...(tools ? {} : { noTools: "all" }),
  });
  const events = [];
  const badges = [];
  session.subscribe((event) => events.push(event));
  await session.bindExtensions({
    mode,
    uiContext: mode === "tui" || mode === "rpc" ? {
      setWidget(_key, widget) {
        if (typeof widget === "function") {
          const theme = { fg: (_color, text) => text, bold: (text) => text };
          badges.push(widget({}, theme).render(160).join("\n"));
        }
      },
    } : undefined,
    onError(error) { throw new Error(`Extension error: ${error.error}`); },
  });
  const outcomes = () => session.sessionManager.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "vinci-task-outcome")
    .map((entry) => entry.data);
  return {
    session, faux, events, badges, outcomes,
    retryEvents: () => events.filter((event) => event.type.startsWith("auto_retry_")),
    exitCode: () => printModeExitCode({ mode: mode === "json" ? "json" : "text", lastMessage: session.messages.at(-1), submitted: ["Complete the read-only task."], headlessExitHint: session.extensionRunner.getHeadlessExitHint() }).exitCode,
    close() { session.dispose(); faux.unregister(); },
  };
}

const cases = {
  async B1(mode) {
    const f = await fixture(mode);
    try {
      const duringRetry = [];
      f.faux.setResponses([connectionError(), () => {
        duringRetry.push(...f.outcomes());
        return fauxAssistantMessage("The requested read-only task is complete.");
      }]);
      await f.session.prompt("Complete the read-only task.");
      const outcome = f.outcomes().at(-1);
      const sameTurn = f.session.messages.filter((message) => message.role === "user").length === 1 && f.faux.state.callCount === 2;
      console.log(`B1 ${mode}: ${JSON.stringify({ retryEvents: f.retryEvents(), duringRetry: duringRetry.map(({ state, reason }) => ({ state, reason })), finalOutcome: outcome?.state, receiptBadges: f.badges.map((badge) => badge.split("\n")[0].trim()), sameTurn, exitCode: f.exitCode() })}`);
      assert.equal(duringRetry.length, 0, "B1 OUTCOME: retryable failure must not record a terminal outcome while retries remain");
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["DONE"], "B1 OUTCOME: normal evidence must decide the only final outcome");
      assert.equal(outcome.verificationStatus, "none");
      assert.equal(sameTurn, true);
      assert.deepEqual(f.retryEvents().map(({ type, success, attempt }) => ({ type, success, attempt })), [
        { type: "auto_retry_start", success: undefined, attempt: 1 },
        { type: "auto_retry_end", success: true, attempt: 1 },
      ]);
      assert.equal(f.badges.some((badge) => badge.includes("Stopped — needs you")), false);
      assert.equal(f.exitCode(), 0, "B1: recovered headless task must exit successfully");
    } finally { f.close(); }
  },
  async B2(mode) {
    const f = await fixture(mode);
    try {
      f.faux.setResponses([connectionError(), connectionError(), connectionError()]);
      await f.session.prompt("Complete the read-only task.");
      const outcome = f.outcomes().at(-1);
      console.log(`B2 ${mode}: ${JSON.stringify({ retryEvents: f.retryEvents(), outcomes: f.outcomes().map(({ state, reason }) => ({ state, reason })), receipt: f.badges.at(-1), calls: f.faux.state.callCount })}`);
      assert.equal(outcome?.state, "BLOCKED");
      assert.match(outcome.reason, /Vinci could not reach the model after 3 tries/);
      assert.match(outcome.reason, /continue/i);
      assert.equal(f.outcomes().length, 1);
      assert.equal(f.faux.state.callCount, 3);
      assert.deepEqual(f.retryEvents().map(({ type, success, attempt }) => [type, success, attempt]), [
        ["auto_retry_start", undefined, 1], ["auto_retry_start", undefined, 2], ["auto_retry_end", false, 2],
      ]);
      if (mode === "tui") assert.match(f.badges.at(-1), /Vinci could not reach the model after 3 tries/);
      f.faux.appendResponses([fauxAssistantMessage("The requested read-only task is complete.")]);
      const taskId = f.session.sessionId;
      await f.session.prompt("continue", { source: "interactive" });
      assert.equal(f.session.sessionId, taskId);
      assert.equal(f.faux.state.callCount, 4);
      assert.equal(f.outcomes().at(-1)?.state, "DONE", "B2: typed continue resumes the task");
    } finally { f.close(); }
  },
  async B3(mode) {
    for (const errorMessage of ["401 Connection error.", "403 Connection error.", "invalid_api_key: Connection error."]) {
      const f = await fixture(mode);
      try {
        f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);
        await f.session.prompt("Complete the read-only task.");
        console.log(`B3 ${mode}: ${JSON.stringify({ errorMessage, retryEvents: f.retryEvents(), outcome: f.outcomes().at(-1)?.state, guidance: vinciFriendlyError(errorMessage, true)?.text })}`);
        assert.equal(f.faux.state.callCount, 1);
        assert.deepEqual(f.retryEvents(), []);
        assert.equal(f.outcomes().at(-1)?.state, "BLOCKED");
        // Existing guidance is kept: credentials point to /login, a 403 to checking account access.
        assert.match(vinciFriendlyError(errorMessage, true)?.text ?? "", errorMessage.startsWith("403") ? /Check access/ : /\/login/);
        assert.notEqual(f.exitCode(), 0);
      } finally { f.close(); }
    }
  },
  async B4(mode) {
    const f = await fixture(mode, { baseDelayMs: 1000 });
    try {
      f.faux.setResponses([connectionError(), fauxAssistantMessage("Must not be reached.")]);
      const started = new Promise((resolve) => f.session.subscribe((event) => {
        if (event.type === "auto_retry_start") resolve();
      }));
      const completion = f.session.prompt("Complete the read-only task.");
      await started;
      await delay(0);
      f.session.abortRetry();
      await completion;
      console.log(`B4 ${mode}: ${JSON.stringify({ retryEvents: f.retryEvents(), outcomes: f.outcomes().map(({ state, reason }) => ({ state, reason })), calls: f.faux.state.callCount })}`);
      assert.equal(f.faux.state.callCount, 1, "B4: interrupt must prevent a second provider attempt");
      assert.equal(f.outcomes().at(-1)?.state, "BLOCKED");
      assert.deepEqual(f.retryEvents().map(({ type, success, finalError }) => [type, success, finalError]), [
        ["auto_retry_start", undefined, undefined], ["auto_retry_end", false, "Retry cancelled"],
      ]);
      assert.equal(f.outcomes().length, 1, "B4: a cancelled retry records exactly one terminal outcome");
      assert.notEqual(f.exitCode(), 0);
    } finally { f.close(); }
  },
  // A failed required read before the connection error must still decide the outcome after the
  // retry succeeds with closing prose: the retry continues the same request, it does not reset it.
  async B7(mode) {
    const f = await fixture(mode, { tools: true });
    try {
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read", { path: "missing-input.txt" }, { id: "read-missing" }), { stopReason: "toolUse" }),
        connectionError(),
        fauxAssistantMessage("Done."),
      ]);
      await f.session.prompt("Read missing-input.txt and summarize it.");
      console.log(`B7 ${mode}: ${JSON.stringify({ retryEvents: f.retryEvents().map(({ type, success }) => [type, success]), outcomes: f.outcomes().map(({ state, reason }) => ({ state, reason })), calls: f.faux.state.callCount })}`);
      assert.equal(f.faux.state.callCount, 3);
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["BLOCKED"], "B7 OUTCOME: the failed required read still blocks after a recovered retry");
      assert.match(f.outcomes().at(-1).reason, /missing-input\.txt|read/i);
      assert.notEqual(f.exitCode(), 0);
    } finally { f.close(); }
  },
  // Retries switched off after the run ended with a pending retry: the held run still gets exactly
  // one terminal outcome instead of disappearing.
  async B9(mode) {
    const f = await fixture(mode);
    try {
      f.session.subscribe((event) => {
        if (event.type === "agent_end" && event.willRetry) f.session.setAutoRetryEnabled(false);
      });
      f.faux.setResponses([connectionError(), fauxAssistantMessage("Must not be reached.")]);
      await f.session.prompt("Complete the read-only task.");
      console.log(`B9 ${mode}: ${JSON.stringify({ outcomes: f.outcomes().map(({ state, reason }) => ({ state, reason })), calls: f.faux.state.callCount })}`);
      assert.equal(f.faux.state.callCount, 1);
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["BLOCKED"], "B9 OUTCOME: a declined retry still records one terminal outcome");
    } finally { f.close(); }
  },
  // An extension reload during the backoff must not lose the earlier run's failed operation.
  async B10(mode) {
    const f = await fixture(mode, { tools: true, baseDelayMs: 300 });
    try {
      let reloaded;
      f.session.subscribe((event) => {
        if (event.type === "auto_retry_start" && !reloaded) reloaded = f.session.reload();
      });
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read", { path: "missing-input.txt" }, { id: "read-missing" }), { stopReason: "toolUse" }),
        connectionError(),
        async () => { await reloaded; return fauxAssistantMessage("Done."); },
      ]);
      await f.session.prompt("Read missing-input.txt and summarize it.");
      await reloaded;
      console.log(`B10 ${mode}: ${JSON.stringify({ outcomes: f.outcomes().map(({ state, reason }) => ({ state, reason })), calls: f.faux.state.callCount })}`);
      assert.ok(reloaded, "B10: the reload ran during the backoff");
      // A reload may end the pending retry (two calls) or let it run (three); either way no outcome
      // may claim success over the earlier failed read.
      assert.ok([2, 3].includes(f.faux.state.callCount));
      assert.equal(f.outcomes().some(({ state }) => state === "DONE"), false, "B10 OUTCOME: no DONE over the failed required read after a reload during backoff");
      assert.equal(f.outcomes().at(-1)?.state, "BLOCKED", "B10 OUTCOME: the failed required read still blocks after a reload during backoff");
      assert.match(f.outcomes().at(-1).reason, /missing-input\.txt/);
    } finally { f.close(); }
  },
  // A retried connection error followed by a non-retryable error keeps that error's own guidance:
  // the "could not reach the model" wording is only for retries exhausted on a retryable error.
  async B8(mode) {
    const f = await fixture(mode);
    try {
      f.faux.setResponses([connectionError(), fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized." })]);
      await f.session.prompt("Complete the read-only task.");
      const outcome = f.outcomes().at(-1);
      console.log(`B8 ${mode}: ${JSON.stringify({ retryEvents: f.retryEvents().map(({ type, success }) => [type, success]), outcomes: f.outcomes().map(({ state, reason }) => ({ state, reason })), calls: f.faux.state.callCount })}`);
      assert.equal(f.faux.state.callCount, 2);
      assert.equal(outcome?.state, "BLOCKED");
      assert.equal(f.outcomes().length, 1);
      assert.doesNotMatch(outcome.reason, /could not reach the model/, "B8 OUTCOME: a non-retryable final error is not reported as exhausted connection retries");
      assert.match(outcome.reason, /401/);
    } finally { f.close(); }
  },
};

let failures = 0;
try {
  for (const name of selected.length ? selected : Object.keys(cases)) {
    assert.ok(Object.hasOwn(cases, name), `Unknown case ${name}`);
    // All modes share AgentSession; tui additionally exercises the rendered receipt widget.
    for (const mode of ["tui", "print", "json", "rpc"]) {
      try {
        await cases[name](mode);
        console.log(`PASS ${name} ${mode}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${name} ${mode}: ${error.message.split("\n")[0]}`);
      }
    }
  }
} finally {
  if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  rmSync(owned, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
