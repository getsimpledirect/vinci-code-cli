// Offline retry/outcome reproduction through the real session and receipt extension.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AgentSessionRuntime, AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } from "../../packages/coding-agent/dist/index.js";
import { printModeExitCode } from "../../packages/coding-agent/dist/modes/print-mode.js";
import receipt from "../dist/extensions/vinci-receipt.js";
import verification from "../dist/extensions/vinci-verification.js";

process.env.VINCI_CODE = "1";
const owned = mkdtempSync(join(tmpdir(), "connection-retry-"));
const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
process.env.GIT_CEILING_DIRECTORIES = owned;
const connectionError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." });
const selected = process.argv.slice(2);

async function assertWithin(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new assert.AssertionError({ message })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(mode, { maxRetries = 2, baseDelayMs = 1, enabled = true, tools = false, verificationEnabled = false, captureExtensionErrors = false, terminalDelivery, configureExtension, firstAgentEnd, compaction } = {}) {
  const cwd = mkdtempSync(join(owned, `${mode}-`));
  const agentDir = join(cwd, "profile");
  mkdirSync(agentDir);
  // A digit-free api id: the default id embeds Date.now(), and an error text that names it could
  // contain 429/5xx digits, which the retryable-error pattern matches as substrings (#177).
  const fauxApi = `faux:retry-outcome-${mode}-${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 8)}`;
  const faux = registerFauxProvider({ tokensPerSecond: 100_000, api: fauxApi });
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(faux.getModel().provider, "offline-faux-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled, maxRetries, baseDelayMs },
    compaction: { enabled: false, ...compaction },
  });
  const extensionEvents = [];
  const extensionErrors = [];
  const extensionFactories = [(pi) => {
    // Runs before every other agent_end handler (none of which has awaited yet).
    if (firstAgentEnd) pi.on("agent_end", firstAgentEnd);
    pi.on("before_agent_start", (event) => { extensionEvents.push(event); });
    pi.on("agent_start", (event) => { extensionEvents.push(event); });
    pi.on("agent_end", async (event, ctx) => {
      extensionEvents.push(event);
      if (!event.willRetry) {
        await delay(0);
        await terminalDelivery?.(event, ctx);
      }
    });
    configureExtension?.(pi);
  }, ...(verificationEnabled ? [verification] : []), receipt];
  const createRuntime = async ({ cwd: sessionCwd = cwd, agentDir: sessionAgentDir = agentDir, sessionManager, sessionStartEvent }) => {
    const resourceLoader = new DefaultResourceLoader({
      cwd: sessionCwd, agentDir: sessionAgentDir, settingsManager, extensionFactories,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const result = await createAgentSession({
      cwd: sessionCwd, agentDir: sessionAgentDir, authStorage, modelRegistry, settingsManager, resourceLoader,
      model: faux.getModel(), sessionManager, sessionStartEvent, ...(tools ? {} : { noTools: "all" }),
    });
    return {
      ...result,
      services: { cwd: sessionCwd, agentDir: sessionAgentDir, authStorage, modelRegistry, settingsManager, resourceLoader, diagnostics: [] },
      diagnostics: [],
    };
  };
  const initial = await createRuntime({ sessionManager: SessionManager.inMemory(cwd) });
  const { session } = initial;
  const runtime = new AgentSessionRuntime(session, initial.services, createRuntime);
  const events = [];
  const badges = [];
  session.subscribe((event) => events.push(event));
  const bindings = {
    mode,
    uiContext: mode === "tui" || mode === "rpc" ? {
      setWidget(_key, widget) {
        if (typeof widget === "function") {
          const theme = { fg: (_color, text) => text, bold: (text) => text };
          badges.push(widget({}, theme).render(160).join("\n"));
        }
      },
    } : undefined,
    onError(error) {
      extensionErrors.push(error);
      if (!captureExtensionErrors) throw new Error(`Extension error: ${error.error}`);
    },
  };
  await session.bindExtensions(bindings);
  runtime.setRebindSession((next) => next.bindExtensions(bindings));
  const outcomes = () => session.sessionManager.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "vinci-task-outcome")
    .map((entry) => entry.data);
  return {
    session, runtime, faux, authStorage, events, extensionEvents, extensionErrors, badges, outcomes,
    retryEvents: () => events.filter((event) => event.type.startsWith("auto_retry_")),
    exitCode: () => printModeExitCode({ mode: mode === "json" ? "json" : "text", lastMessage: session.messages.at(-1), submitted: ["Complete the read-only task."], headlessExitHint: session.extensionRunner.getHeadlessExitHint() }).exitCode,
    close() { runtime.session.dispose(); faux.unregister(); },
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
      assert.deepEqual(f.extensionEvents.filter((event) => event.type === "agent_start").map(({ continuesRetry }) => continuesRetry), [false, true], "B1: the retry starts as a continuation of the same request");
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
        const outcome = f.outcomes().at(-1);
        console.log(`B3 ${mode}: ${JSON.stringify({ errorMessage, retryEvents: f.retryEvents(), outcome: outcome?.state, reason: outcome?.reason })}`);
        assert.equal(f.faux.state.callCount, 1);
        assert.deepEqual(f.retryEvents(), []);
        assert.equal(outcome?.state, "BLOCKED");
        assert.equal(outcome.reason, errorMessage, "B3: the receipt preserves the authentication error");
        assert.doesNotMatch(outcome.reason, /could not reach the model/);
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
      const context = f.session.extensionRunner.createCommandContext();
      f.session.dispose();
      assert.throws(() => context.getSystemPrompt(), /stale/, "B4: disposal after completed delivery invalidates immediately");
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
    for (const phase of ["before preparation", "during backoff"]) {
      // A backoff far longer than the bound: only the setter's own abortRetry() can end it in time.
      const f = await fixture(mode, { baseDelayMs: phase === "during backoff" ? 60_000 : 100 });
      try {
        const started = new Promise((resolve) => f.session.subscribe((event) => {
          if (event.type === "auto_retry_start") resolve();
          if (phase === "before preparation" && event.type === "agent_end" && event.willRetry) f.session.setAutoRetryEnabled(false);
        }));
        f.faux.setResponses([connectionError(), fauxAssistantMessage("Must not be reached.")]);
        const completion = f.session.prompt("Complete the read-only task.");
        if (phase === "during backoff") {
          await started;
          await delay(0);
          assert.equal(f.session.isRetrying, true, "B9: retries are disabled during backoff");
          f.session.setAutoRetryEnabled(false);
          await assertWithin(completion, 2_000, "B9: disabling retries during backoff cancels the wait at once");
          assert.deepEqual(f.retryEvents().map(({ type, finalError }) => [type, finalError]), [
            ["auto_retry_start", undefined], ["auto_retry_end", "Retry cancelled"],
          ], "B9: the backoff ends as a cancelled retry");
        }
        await completion;
        console.log(`B9 ${mode} ${phase}: ${JSON.stringify({ outcomes: f.outcomes().map(({ state, reason }) => ({ state, reason })), calls: f.faux.state.callCount })}`);
        assert.equal(f.faux.state.callCount, 1);
        assert.deepEqual(f.outcomes().map(({ state }) => state), ["BLOCKED"], "B9 OUTCOME: a declined retry still records one terminal outcome");
      } finally { f.close(); }
    }
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
  async B11(mode) {
    const name = "B11 dispose during retry backoff still records the request outcome";
    for (const path of ["dispose", "new session", "switch session"]) {
      let outcomesAtShutdown;
      const f = await fixture(mode, {
        baseDelayMs: 60_000,
        captureExtensionErrors: true,
        configureExtension(pi) {
          pi.on("session_shutdown", () => { outcomesAtShutdown = f.outcomes(); });
        },
      });
      let completion;
      try {
        const taskId = f.session.sessionId;
        let outcomesAtInvalidation;
        const runner = f.session.extensionRunner;
        const invalidate = runner.invalidate.bind(runner);
        const invalidated = new Promise((resolve) => {
          runner.invalidate = (...args) => {
            outcomesAtInvalidation = f.outcomes();
            invalidate(...args);
            resolve();
          };
        });
        const started = new Promise((resolve) => f.session.subscribe((event) => {
          if (event.type === "auto_retry_start") resolve();
        }));
        f.faux.setResponses([connectionError(), fauxAssistantMessage("Must not be reached.")]);
        completion = f.session.prompt("Complete the read-only task.");
        await started;
        await delay(0);
        assert.equal(f.session.isRetrying, true);
        assert.deepEqual(f.outcomes(), []);
        if (path === "dispose") {
          assert.equal(f.session.dispose(), undefined, `${name}: dispose stays synchronous`);
        } else if (path === "new session") {
          assert.equal((await f.runtime.newSession()).cancelled, false);
        } else {
          const cwd = f.session.sessionManager.getCwd();
          const target = SessionManager.create(cwd, join(cwd, "sessions"));
          target.appendMessage({ role: "user", content: "Saved request.", timestamp: Date.now() });
          target.appendMessage(fauxAssistantMessage("Saved response."));
          assert.equal((await f.runtime.switchSession(target.getSessionFile())).cancelled, false);
        }
        await completion;
        await invalidated;
        const outcome = f.outcomes().at(-1);
        console.log(`${name} ${mode} ${path}: ${JSON.stringify({ outcomes: f.outcomes().map(({ state, reason }) => ({ state, reason })), calls: f.faux.state.callCount })}`);
        assert.equal(outcome?.state, "BLOCKED", `${name}: the held request has a terminal receipt`);
        assert.equal(outcome.taskId, taskId);
        assert.match(outcome.reason, /connect|reach/i);
        assert.doesNotMatch(outcome.reason, /after \d+ tries/);
        assert.deepEqual(outcomesAtInvalidation, [outcome], `${name}: persistence precedes invalidation`);
        if (path !== "dispose") assert.deepEqual(outcomesAtShutdown, [outcome], `${name}: persistence precedes runtime shutdown handlers`);
        assert.deepEqual(f.extensionErrors, []);
        assert.equal(f.faux.state.callCount, 1);
        assert.equal(f.outcomes().length, 1);
      } finally {
        f.session.abortRetry();
        await completion;
        f.close();
      }
    }
  },
  async B12(mode) {
    const name = "B12 a prompt typed during backoff does not inherit the held failure";
    for (const [tools, streamingBehavior, submission] of [
      [false, undefined, "prompt"], [false, "steer", "prompt"], [true, "followUp", "prompt"],
      [false, undefined, "steer"], [true, undefined, "steer"],
      [false, undefined, "followUp"], [true, undefined, "followUp"],
    ]) {
      const f = await fixture(mode, { tools, baseDelayMs: 60_000 });
      let completion;
      try {
        let outcomesBeforeB;
        const started = new Promise((resolve) => f.session.subscribe((event) => {
          if (event.type === "auto_retry_start") resolve();
        }));
        f.faux.setResponses([
          ...(tools ? [fauxAssistantMessage(fauxToolCall("read", { path: "request-a-only.txt" }, { id: "request-a-read" }), { stopReason: "toolUse" })] : []),
          connectionError(),
          () => {
            outcomesBeforeB = f.outcomes();
            return fauxAssistantMessage("The requested read-only task is complete.");
          },
        ]);
        completion = f.session.prompt(tools ? "Read request-a-only.txt and summarize it." : "Complete request A.");
        await started;
        await delay(0);
        assert.equal(f.session.isRetrying, true);
        assert.equal(f.session.isStreaming, false);
        const held = f.extensionEvents.find((event) => event.type === "agent_end" && event.willRetry).messages;
        if (submission === "prompt") {
          await f.session.prompt("Complete a separate read-only request B.", { source: "interactive", streamingBehavior });
        } else {
          await f.session[submission]("Complete a separate read-only request B.");
        }
        assert.equal(outcomesBeforeB?.at(-1)?.state, "BLOCKED", `${name}: A is recorded before B runs via ${submission}`);
        assert.equal(f.session.isRetrying, false, `${name}: A's retry is cancelled before cleanup`);
        await completion;
        const outcomes = f.outcomes();
        const starts = f.extensionEvents.filter((event) => event.type === "agent_start");
        const endB = f.extensionEvents.filter((event) => event.type === "agent_end" && !event.willRetry).at(-1);
        console.log(`${name} ${mode} tools=${tools} submission=${submission} behavior=${streamingBehavior ?? "prompt"}: ${JSON.stringify({ outcomes: outcomes.map(({ state, reason }) => ({ state, reason })), continuesRetry: starts.map(({ continuesRetry }) => continuesRetry) })}`);
        assert.deepEqual(outcomes.map(({ state }) => state), ["BLOCKED", "DONE"]);
        assert.equal(starts.length, 2);
        assert.equal(starts[1].continuesRetry, false, `${name}: B starts a new request`);
        assert.equal(endB.heldRunMessages, undefined, `${name}: B has no held messages from A`);
        assert.equal(endB.messages.some((message) => held.includes(message)), false);
        assert.deepEqual(outcomes[1].requiredOperations ?? [], []);
        assert.doesNotMatch(outcomes[1].reason, /request-a-only|connect|reach/i);
        const endAIndex = f.extensionEvents.findIndex((event) => event.type === "agent_end" && !event.willRetry);
        const beforeBIndex = f.extensionEvents.findIndex((event) => event.type === "before_agent_start" && event.prompt.includes("request B"));
        assert.ok(endAIndex < beforeBIndex, `${name}: A settles before B's extension preflight`);
        assert.equal(f.faux.state.callCount, tools ? 3 : 2);
        await delay(0);
        assert.equal(f.faux.state.callCount, tools ? 3 : 2, `${name}: A makes no further retry call before cleanup`);
      } finally {
        f.session.abortRetry();
        await completion;
        f.close();
      }
    }
  },
  async B13(mode) {
    const name = "B13 tree navigation during backoff records the outcome and does not resume the retry";
    const f = await fixture(mode, { baseDelayMs: 60_000 });
    let completion;
    try {
      f.faux.setResponses([
        fauxAssistantMessage("The saved read-only task is complete."),
        connectionError(),
        fauxAssistantMessage("Must not be reached."),
      ]);
      await f.session.prompt("Complete a saved read-only request.");
      const targetId = f.session.sessionManager.getLeafId();
      const priorOutcomes = f.outcomes();
      const started = new Promise((resolve) => f.session.subscribe((event) => {
        if (event.type === "auto_retry_start") resolve();
      }));
      completion = f.session.prompt("Complete request A.");
      await started;
      await delay(0);
      assert.equal(f.session.isRetrying, true);
      assert.equal(f.session.isStreaming, false);
      const oldLeafId = f.session.sessionManager.getLeafId();
      assert.equal((await f.session.navigateTree(targetId)).cancelled, false);
      const recorded = f.session.sessionManager.getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "vinci-task-outcome")
        .at(-1);
      assert.equal(recorded?.data?.state, "BLOCKED", `${name}: A has its own terminal receipt before navigation returns`);
      assert.equal(recorded.parentId, oldLeafId, `${name}: A's outcome remains on its original branch`);
      assert.equal(recorded.data.taskId, f.session.sessionId);
      assert.match(recorded.data.reason, /connect|reach/i);
      assert.deepEqual(f.outcomes(), priorOutcomes, `${name}: the destination branch excludes A's outcome`);
      await completion;
      await delay(0);
      assert.equal(f.session.isRetrying, false);
      assert.equal(f.session.sessionManager.getLeafId(), targetId);
      assert.equal(f.faux.state.callCount, 2, `${name}: navigation prevents another model call`);
      assert.deepEqual(f.retryEvents().map(({ type, success, finalError }) => [type, success, finalError]), [
        ["auto_retry_start", undefined, undefined], ["auto_retry_end", false, "Retry cancelled"],
      ]);
      console.log(`${name} ${mode}: ${JSON.stringify({ outcome: recorded.data.state, calls: f.faux.state.callCount })}`);
    } finally {
      f.session.abortRetry();
      await completion;
      f.close();
    }
  },
  async B14(mode) {
    const name = "B14 dispose bounds invalidation when a terminal handler stalls";
    let releaseDelivery;
    const delivery = new Promise((resolve) => { releaseDelivery = resolve; });
    const f = await fixture(mode, { baseDelayMs: 60_000, captureExtensionErrors: true, terminalDelivery: () => delivery });
    let completion;
    try {
      const context = f.session.extensionRunner.createCommandContext();
      const started = new Promise((resolve) => f.session.subscribe((event) => {
        if (event.type === "auto_retry_start") resolve();
      }));
      f.faux.setResponses([connectionError(), fauxAssistantMessage("Must not be reached.")]);
      completion = f.session.prompt("Complete the read-only task.");
      await started;
      await delay(0);
      assert.equal(f.session.isRetrying, true);
      assert.equal(f.session.dispose(), undefined, `${name}: dispose stays synchronous`);
      assert.doesNotThrow(() => context.getSystemPrompt(), `${name}: terminal delivery gets a chance to finish`);
      await delay(5_100);
      assert.throws(() => context.getSystemPrompt(), /stale/, `${name}: captured APIs expire while delivery is still stalled`);
      assert.equal(f.faux.state.callCount, 1);
      releaseDelivery();
      await assertWithin(completion, 1_500, `${name}: released terminal delivery did not finish within 1.5 s`);
      // The 5 s invalidation expires the receipt's context; late delivery loses A's receipt.
      assert.deepEqual(f.outcomes(), [], `${name}: the late receipt is not persisted`);
      assert.equal(f.extensionErrors.length, 1);
      assert.equal(f.extensionErrors[0].event, "agent_end");
      assert.match(f.extensionErrors[0].error, /stale/);
    } finally {
      releaseDelivery();
      f.session.abortRetry();
      try {
        await assertWithin(completion, 1_500, `${name}: cleanup did not finish after releasing the handler`);
      } finally { f.close(); }
    }
  },
  async B15(mode) {
    const name = "B15 a custom message that triggers a turn during backoff settles the held run first";
    for (const deliverAs of [undefined, "steer", "followUp"]) {
      const f = await fixture(mode, { baseDelayMs: 60_000 });
      let completion;
      try {
        let outcomesBeforeB;
        const started = new Promise((resolve) => f.session.subscribe((event) => {
          if (event.type === "auto_retry_start") resolve();
        }));
        f.faux.setResponses([
          connectionError(),
          () => {
            outcomesBeforeB = f.outcomes();
            return fauxAssistantMessage("The requested read-only task is complete.");
          },
        ]);
        completion = f.session.prompt("Complete request A.");
        await started;
        await delay(0);
        assert.equal(f.session.isRetrying, true);
        assert.equal(f.session.isStreaming, false);
        assert.deepEqual(f.outcomes(), []);
        const held = f.extensionEvents.find((event) => event.type === "agent_end" && event.willRetry).messages;
        await f.session.sendCustomMessage({
          customType: "retry-outcome-request",
          content: "Complete a separate read-only request B.",
          display: true,
        }, { triggerTurn: true, deliverAs });
        assert.equal(outcomesBeforeB?.at(-1)?.state, "BLOCKED", `${name}: A is recorded before B runs`);
        assert.equal(f.session.isRetrying, false, `${name}: A's retry is cancelled`);
        await completion;
        const outcomes = f.outcomes();
        const starts = f.extensionEvents.filter((event) => event.type === "agent_start");
        const ends = f.extensionEvents.filter((event) => event.type === "agent_end" && !event.willRetry);
        assert.deepEqual(outcomes.map(({ state }) => state), ["BLOCKED", "DONE"]);
        assert.equal(starts.length, 2);
        assert.equal(starts[1].continuesRetry, false, `${name}: B starts a new request`);
        assert.equal(ends.length, 2);
        assert.deepEqual(ends[0].messages, held, `${name}: A has its own terminal event`);
        assert.equal(ends[1].heldRunMessages, undefined, `${name}: B has no held messages from A`);
        assert.equal(ends[1].messages.some((message) => held.includes(message)), false);
        assert.deepEqual(outcomes[1].requiredOperations ?? [], []);
        assert.doesNotMatch(outcomes[1].reason, /connect|reach/i);
        const endAIndex = f.extensionEvents.indexOf(ends[0]);
        assert.ok(endAIndex < f.extensionEvents.indexOf(starts[1]), `${name}: A settles before B starts`);
        assert.deepEqual(f.retryEvents().map(({ type, success, finalError }) => [type, success, finalError]), [
          ["auto_retry_start", undefined, undefined], ["auto_retry_end", false, "Retry cancelled"],
        ]);
        assert.equal(f.faux.state.callCount, 2, `${name}: A makes no further retry call`);
        console.log(`${name} ${mode} delivery=${deliverAs ?? "default"}: ${JSON.stringify({ outcomes: outcomes.map(({ state }) => state), calls: f.faux.state.callCount })}`);
      } finally {
        f.session.abortRetry();
        await completion;
        f.close();
      }
    }
  },
  async B15b(mode) {
    const name = "B15b a custom message appended during backoff settles the held run first";
    const f = await fixture(mode, { baseDelayMs: 60_000 });
    let completion;
    try {
      let outcomesAtAppend;
      f.session.subscribe((event) => {
        if (event.type === "message_start" && event.message.role === "custom") outcomesAtAppend = f.outcomes();
      });
      const started = new Promise((resolve) => f.session.subscribe((event) => {
        if (event.type === "auto_retry_start") resolve();
      }));
      f.faux.setResponses([connectionError(), fauxAssistantMessage("Must not be reached.")]);
      completion = f.session.prompt("Complete request A.");
      await started;
      await delay(0);
      assert.equal(f.session.isRetrying, true);
      assert.equal(f.session.isStreaming, false);
      assert.deepEqual(f.outcomes(), []);
      await f.session.sendCustomMessage({
        customType: "retry-outcome-note",
        content: "A history note after request A.",
        display: true,
      });
      assert.equal(outcomesAtAppend?.at(-1)?.state, "BLOCKED", `${name}: A is recorded before the message is appended`);
      const branch = f.session.sessionManager.getBranch();
      const note = branch.at(-1);
      const outcome = branch.filter((entry) => entry.type === "custom" && entry.customType === "vinci-task-outcome").at(-1);
      assert.equal(note.type, "custom_message");
      assert.equal(note.customType, "retry-outcome-note");
      assert.equal(note.parentId, outcome.id, `${name}: the note follows A's terminal receipt`);
      assert.equal(f.session.messages.at(-1)?.customType, "retry-outcome-note");
      assert.equal(f.session.isRetrying, false);
      await completion;
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["BLOCKED"]);
      assert.equal(f.faux.state.callCount, 1, `${name}: A makes no further retry call`);
      assert.deepEqual(f.retryEvents().map(({ type, success, finalError }) => [type, success, finalError]), [
        ["auto_retry_start", undefined, undefined], ["auto_retry_end", false, "Retry cancelled"],
      ]);
      console.log(`${name} ${mode}: ${JSON.stringify({ outcome: outcome.data.state, calls: f.faux.state.callCount })}`);
    } finally {
      f.session.abortRetry();
      await completion;
      f.close();
    }
  },
  async B15c(mode) {
    const name = "B15c custom turns carry failed required operations even without retries";
    const f = await fixture(mode, { tools: true, enabled: false });
    try {
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read", { path: "missing-input.txt" }, { id: "read-missing" }), { stopReason: "toolUse" }),
        connectionError(),
        fauxAssistantMessage("The unrelated read-only task is complete."),
      ]);
      await f.session.prompt("Read missing-input.txt and summarize it.");
      const outcomeA = f.outcomes().at(-1);
      assert.equal(outcomeA?.state, "BLOCKED");
      assert.ok(outcomeA.requiredOperations?.length > 0);
      assert.deepEqual(f.retryEvents(), [], `${name}: the baseline never schedules or settles a retry`);
      await f.session.sendCustomMessage({
        customType: "retry-outcome-request",
        content: "Complete a separate read-only request B.",
        display: true,
      }, { triggerTurn: true });
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["BLOCKED", "BLOCKED"]);
      assert.deepEqual(f.outcomes()[1].requiredOperations, outcomeA.requiredOperations);
      assert.equal(f.extensionEvents.filter((event) => event.type === "before_agent_start").length, 1);
      assert.deepEqual(f.extensionEvents.filter((event) => event.type === "agent_start").map(({ continuesRetry }) => continuesRetry), [false, false]);
      assert.equal(f.faux.state.callCount, 3);
    } finally { f.close(); }
  },
  async B16(mode) {
    const name = "B16 an extension command during backoff settles before creating its context";
    let commandCalls = 0;
    const f = await fixture(mode, {
      baseDelayMs: 60_000,
      configureExtension(pi) {
        pi.registerCommand("retry-outcome-check", {
          handler: async () => {
            commandCalls++;
            pi.appendEntry("retry-command-history", { checked: true });
          },
        });
      },
    });
    let completion;
    try {
      let outcomesAtContext;
      const runner = f.session.extensionRunner;
      const createContext = runner.createCommandContext.bind(runner);
      runner.createCommandContext = (...args) => {
        outcomesAtContext = f.outcomes();
        return createContext(...args);
      };
      const started = new Promise((resolve) => f.session.subscribe((event) => {
        if (event.type === "auto_retry_start") resolve();
      }));
      f.faux.setResponses([connectionError(), fauxAssistantMessage("Must not be reached.")]);
      completion = f.session.prompt("Complete request A.");
      await started;
      await delay(0);
      assert.equal(f.session.isRetrying, true);
      assert.equal(f.session.isStreaming, false);
      await f.session.prompt("/retry-outcome-check");
      assert.equal(outcomesAtContext?.at(-1)?.state, "BLOCKED", `${name}: A is recorded before command context creation`);
      assert.equal(commandCalls, 1);
      const branch = f.session.sessionManager.getBranch();
      const outcome = branch.filter((entry) => entry.type === "custom" && entry.customType === "vinci-task-outcome").at(-1);
      assert.equal(branch.at(-1)?.customType, "retry-command-history");
      assert.equal(branch.at(-1)?.parentId, outcome.id);
      assert.equal(f.session.isRetrying, false);
      await completion;
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["BLOCKED"]);
      assert.deepEqual(f.extensionErrors, []);
      assert.equal(f.faux.state.callCount, 1, `${name}: the command does not resume A's retry`);
      console.log(`${name} ${mode}: ${JSON.stringify({ outcome: outcome.data.state, calls: f.faux.state.callCount })}`);
    } finally {
      f.session.abortRetry();
      await completion;
      f.close();
    }
  },
  async B17(mode) {
    const name = "B17 manual compaction during backoff settles before rewriting history";
    let compactionHooks = 0;
    const summary = "The saved request is complete; request A stopped after a connection error.";
    const f = await fixture(mode, {
      baseDelayMs: 60_000,
      compaction: { keepRecentTokens: 1 },
      configureExtension(pi) {
        pi.on("session_before_compact", ({ preparation }) => {
          compactionHooks++;
          return { compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore } };
        });
      },
    });
    let completion;
    try {
      let outcomesAtCompaction;
      f.session.subscribe((event) => {
        if (event.type === "compaction_start") outcomesAtCompaction = f.outcomes();
      });
      f.faux.setResponses([
        fauxAssistantMessage("The saved read-only task is complete."),
        connectionError(),
        fauxAssistantMessage("Must not be reached."),
      ]);
      await f.session.prompt("Complete a saved read-only request.");
      const started = new Promise((resolve) => f.session.subscribe((event) => {
        if (event.type === "auto_retry_start") resolve();
      }));
      completion = f.session.prompt("Complete request A.");
      await started;
      await delay(0);
      assert.equal(f.session.isRetrying, true);
      assert.equal(f.session.isStreaming, false);
      const result = await f.session.compact();
      assert.deepEqual(outcomesAtCompaction?.map(({ state }) => state), ["DONE", "BLOCKED"], `${name}: A is recorded before compaction starts`);
      assert.equal(compactionHooks, 1);
      assert.equal(result.summary, summary);
      const branch = f.session.sessionManager.getBranch();
      const outcome = branch.filter((entry) => entry.type === "custom" && entry.customType === "vinci-task-outcome").at(-1);
      const compacted = branch.filter((entry) => entry.type === "compaction").at(-1);
      assert.equal(compacted?.parentId, outcome.id, `${name}: compaction follows A's terminal receipt`);
      assert.ok(f.session.messages.some((message) => message.role === "compactionSummary" && message.summary === summary));
      assert.equal(f.session.isRetrying, false);
      await completion;
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["DONE", "BLOCKED"]);
      assert.equal(f.faux.state.callCount, 2, `${name}: neither A's retry nor model compaction runs`);
      console.log(`${name} ${mode}: ${JSON.stringify({ outcome: outcome.data.state, calls: f.faux.state.callCount })}`);
    } finally {
      f.session.abortRetry();
      await completion;
      f.close();
    }
  },
  async B18(mode) {
    const name = "B18 a terminal handler that compacts during settlement does not deadlock";
    let compactions = 0;
    const summary = "The saved request is complete; request A stopped after a connection error.";
    const f = await fixture(mode, {
      baseDelayMs: 60_000,
      compaction: { keepRecentTokens: 1 },
      async terminalDelivery(event, ctx) {
        if (!event.messages.some((message) => message.role === "assistant" && message.stopReason === "error")) return;
        const result = await new Promise((resolve, reject) => {
          ctx.compact({ onComplete: resolve, onError: reject });
        });
        assert.equal(result.summary, summary);
        compactions++;
      },
      configureExtension(pi) {
        pi.on("session_before_compact", ({ preparation }) => ({
          compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore },
        }));
      },
    });
    try {
      await assertWithin((async () => {
        let outcomesBeforeB;
        f.faux.setResponses([
          fauxAssistantMessage("The saved read-only task is complete."),
          connectionError(),
          () => {
            outcomesBeforeB = f.outcomes();
            return fauxAssistantMessage("The unrelated read-only task is complete.");
          },
        ]);
        await f.session.prompt("Complete a saved read-only request.");
        const started = new Promise((resolve) => f.session.subscribe((event) => {
          if (event.type === "auto_retry_start") resolve();
        }));
        const completion = f.session.prompt("Complete request A.");
        await started;
        await delay(0);
        assert.equal(f.session.isRetrying, true);
        assert.equal(f.session.isStreaming, false);
        const held = f.extensionEvents.find((event) => event.type === "agent_end" && event.willRetry).messages;
        await f.session.prompt("Complete a separate read-only request B.");
        await completion;
        assert.equal(compactions, 1);
        assert.deepEqual(outcomesBeforeB?.map(({ state }) => state), ["DONE", "BLOCKED"]);
        assert.deepEqual(f.outcomes().map(({ state }) => state), ["DONE", "BLOCKED", "DONE"], `${name}: A is recorded once and B completes`);
        const ends = f.extensionEvents.filter((event) => event.type === "agent_end" && !event.willRetry);
        assert.equal(ends.length, 3);
        assert.deepEqual(ends[1].messages, held);
        assert.equal(ends[2].heldRunMessages, undefined);
        assert.equal(ends[2].messages.some((message) => held.includes(message)), false);
        assert.equal(f.extensionEvents.filter((event) => event.type === "agent_start").at(-1).continuesRetry, false);
        assert.equal(f.session.isRetrying, false);
        assert.equal(f.faux.state.callCount, 3);
        assert.deepEqual(f.extensionErrors, []);
      })(), 1_500, `${name}: nested compaction and request B did not finish within 1.5 s`);
    } finally {
      // Do not await a deadlocked submission if the bound assertion failed.
      f.session.abortRetry();
      f.close();
    }
  },
  async B19(mode) {
    const name = "B19 runtime disposal with a stalled terminal handler completes within the bound";
    let releaseDelivery;
    let markDeliveryStarted;
    const delivery = new Promise((resolve) => { releaseDelivery = resolve; });
    const deliveryStarted = new Promise((resolve) => { markDeliveryStarted = resolve; });
    const f = await fixture(mode, {
      baseDelayMs: 60_000,
      captureExtensionErrors: true,
      terminalDelivery() {
        markDeliveryStarted();
        return delivery;
      },
    });
    let completion;
    let disposing;
    let teardownReached = false;
    f.runtime.setBeforeSessionInvalidate(() => { teardownReached = true; });
    try {
      await assertWithin((async () => {
        const started = new Promise((resolve) => f.session.subscribe((event) => {
          if (event.type === "auto_retry_start") resolve();
        }));
        f.faux.setResponses([connectionError(), fauxAssistantMessage("Must not be reached.")]);
        completion = f.session.prompt("Complete request A.");
        await started;
        await delay(0);
        assert.equal(f.session.isRetrying, true);
        disposing = f.runtime.dispose();
        await deliveryStarted;
        await disposing;
        assert.equal(teardownReached, true, `${name}: teardown continues while the handler is stalled`);
        assert.deepEqual(f.outcomes(), []);
        assert.equal(f.faux.state.callCount, 1);
        assert.deepEqual(f.retryEvents().map(({ type, finalError }) => [type, finalError]), [
          ["auto_retry_start", undefined], ["auto_retry_end", "Retry cancelled"],
        ]);
        releaseDelivery();
        await completion;
      })(), 7_500, `${name}: runtime disposal did not finish within 7.5 s while terminal delivery was stalled`);
    } finally {
      releaseDelivery();
      f.session.abortRetry();
      try {
        await assertWithin(Promise.all([completion, disposing]), 1_500, `${name}: cleanup did not finish after releasing the handler`);
      } finally { f.close(); }
    }
  },
  async B20(mode) {
    const name = "B20 tree navigation and retry settlement during the live retry run leave that run alone";
    const f = await fixture(mode);
    try {
      let probed = false;
      f.faux.setResponses([
        connectionError(),
        async () => {
          assert.equal(f.session.isStreaming, true, `${name}: the probe runs inside the live retry run`);
          await f.session.navigateTree(f.session.sessionManager.getLeafId());
          await f.session.settleRetry();
          probed = true;
          return fauxAssistantMessage("Request A is complete.");
        },
      ]);
      await f.session.prompt("Complete request A.");
      await delay(0);
      const ends = f.extensionEvents.filter((event) => event.type === "agent_end");
      console.log(`${name} ${mode}: ${JSON.stringify({ ends: ends.map(({ willRetry }) => willRetry), retryEvents: f.retryEvents().map(({ type, success, attempt }) => [type, success, attempt]), outcomes: f.outcomes().map(({ state }) => state), calls: f.faux.state.callCount })}`);
      assert.equal(probed, true);
      assert.equal(ends.filter((event) => !event.willRetry).length, 1, `${name}: one terminal agent_end for request A`);
      assert.deepEqual(f.retryEvents().map(({ type, success, attempt }) => [type, success, attempt]), [
        ["auto_retry_start", undefined, 1], ["auto_retry_end", true, 1],
      ], `${name}: the retry budget is not reset during the live retry run`);
      assert.equal(f.faux.state.callCount, 2);
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["DONE"]);
    } finally { f.close(); }
  },
  async B21(mode) {
    const name = "B21 runtime disposal while a cancelled retry's terminal delivery runs keeps the receipt";
    let markDeliveryStarted;
    const deliveryStarted = new Promise((resolve) => { markDeliveryStarted = resolve; });
    const f = await fixture(mode, {
      baseDelayMs: 60_000,
      captureExtensionErrors: true,
      async terminalDelivery() {
        markDeliveryStarted();
        await delay(200);
      },
    });
    let completion;
    try {
      await assertWithin((async () => {
        const started = new Promise((resolve) => f.session.subscribe((event) => {
          if (event.type === "auto_retry_start") resolve();
        }));
        f.faux.setResponses([connectionError(), fauxAssistantMessage("Must not be reached.")]);
        completion = f.session.prompt("Complete request A.");
        await started;
        await delay(0);
        f.session.abortRetry();
        await deliveryStarted;
        // An outside caller, not a handler of that delivery: it waits for the delivery (bounded).
        await f.runtime.dispose();
        await completion;
      })(), 7_500, `${name}: did not finish within 7.5 s`);
      console.log(`${name} ${mode}: ${JSON.stringify({ outcomes: f.outcomes().map(({ state }) => state), errors: f.extensionErrors.length, calls: f.faux.state.callCount })}`);
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["BLOCKED"], `${name}: A's terminal receipt is recorded before the context is invalidated`);
      assert.deepEqual(f.extensionErrors, [], `${name}: no handler ran on an invalidated context`);
      assert.equal(f.faux.state.callCount, 1);
    } finally {
      f.session.abortRetry();
      await completion;
      f.close();
    }
  },
  async B22(mode) {
    const name = "B22 a prompt after a reload that timed out on a stalled terminal handler does not wait on it";
    let releaseDelivery;
    const delivery = new Promise((resolve) => { releaseDelivery = resolve; });
    let stalls = 1;
    const f = await fixture(mode, {
      baseDelayMs: 60_000,
      captureExtensionErrors: true,
      terminalDelivery() {
        // Only A's terminal delivery stalls; later requests deliver normally.
        if (stalls-- > 0) return delivery;
      },
    });
    let completion;
    try {
      await assertWithin((async () => {
        const started = new Promise((resolve) => f.session.subscribe((event) => {
          if (event.type === "auto_retry_start") resolve();
        }));
        f.faux.setResponses([connectionError(), fauxAssistantMessage("Request B is complete.")]);
        completion = f.session.prompt("Complete request A.");
        await started;
        await delay(0);
        await f.session.reload();
        await assertWithin(f.session.prompt("Complete request B."), 2_000, `${name}: request B waited on A's stalled terminal delivery`);
      })(), 9_000, `${name}: did not finish within 9 s`);
      console.log(`${name} ${mode}: ${JSON.stringify({ calls: f.faux.state.callCount, last: f.session.messages.at(-1)?.role, stop: f.session.messages.at(-1)?.stopReason, err: f.session.messages.at(-1)?.errorMessage })}`);
      // Reload resets API providers, so B ends with its own provider error instead of a model call;
      // what matters is that B finished its turn instead of waiting on A's stalled delivery.
      const userB = f.session.messages.findIndex((message) => message.role === "user" && JSON.stringify(message.content).includes("Complete request B."));
      assert.ok(userB >= 0, `${name}: request B was submitted`);
      assert.equal(f.session.messages.at(-1)?.role, "assistant", `${name}: request B finished its own turn`);
      assert.ok(f.session.messages.length - 1 > userB);
      assert.equal(f.faux.state.callCount, 1, `${name}: A's retry did not run`);
    } finally {
      releaseDelivery();
      f.session.abortRetry();
      try { await assertWithin(Promise.resolve(completion), 1_500, `${name}: cleanup did not finish`); } finally { f.close(); }
    }
  },
  async B23(mode) {
    for (const via of ["prompt", "custom message"]) {
      const name = `B23 a terminal handler that submits a new request by ${via} does not deadlock`;
      let session;
      let nested;
      const f = await fixture(mode, {
        baseDelayMs: 60_000,
        captureExtensionErrors: true,
        async terminalDelivery() {
          if (nested) return;
          nested = via === "prompt"
            ? session.prompt("Complete request C.")
            : session.sendCustomMessage({ customType: "follow-up", content: "Complete request C.", display: false }, { triggerTurn: true });
          await nested;
        },
      });
      session = f.session;
      let completion;
      let failed = false;
      try {
        await assertWithin((async () => {
          const started = new Promise((resolve) => f.session.subscribe((event) => {
            if (event.type === "auto_retry_start") resolve();
          }));
          f.faux.setResponses([connectionError(), fauxAssistantMessage("Request C is complete.")]);
          completion = f.session.prompt("Complete request A.");
          await started;
          await delay(0);
          f.session.abortRetry();
          await completion;
          await nested;
        })(), 3_000, `${name}: the nested request and A did not finish within 3 s`);
        console.log(`${name} ${mode}: ${JSON.stringify({ calls: f.faux.state.callCount, outcomes: f.outcomes().map(({ state }) => state) })}`);
        assert.equal(f.faux.state.callCount, 2, `${name}: C ran once and A's retry did not`);
        // This handler runs before the receipt's own handler, so C's outcome is written first.
        assert.deepEqual(f.outcomes().map(({ state }) => state), ["DONE", "BLOCKED"], `${name}: C and A each keep their own terminal outcome`);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        f.session.abortRetry();
        // After a deadlock the cleanup cannot finish either; report the first failure, not this one.
        try { await assertWithin(Promise.all([completion, nested]), 1_500, `${name}: cleanup did not finish`); } catch (error) { if (!failed) throw error; } finally { f.close(); }
      }
    }
  },
  async B24(mode) {
    const name = "B24 settlement from an idle waiter before post-run handling cancels the retry";
    const f = await fixture(mode, { baseDelayMs: 1 });
    try {
      let settled;
      f.session.subscribe((event) => {
        if (event.type === "agent_end" && event.willRetry && !settled) {
          settled = f.session.agent.waitForIdle().then(() => f.session.settleRetry());
        }
      });
      f.faux.setResponses([connectionError(), fauxAssistantMessage("Must not be reached.")]);
      await assertWithin(f.session.prompt("Complete request A."), 3_000, `${name}: A did not finish`);
      await settled;
      await delay(0);
      const ends = f.extensionEvents.filter((event) => event.type === "agent_end" && !event.willRetry);
      console.log(`${name} ${mode}: ${JSON.stringify({ ends: ends.length, calls: f.faux.state.callCount, outcomes: f.outcomes().map(({ state }) => state) })}`);
      assert.equal(ends.length, 1, `${name}: one terminal agent_end for A`);
      assert.equal(f.faux.state.callCount, 1, `${name}: the settled retry does not run`);
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["BLOCKED"]);
    } finally { f.close(); }
  },
  async B25(mode) {
    const name = "B25 a settle that times out on a terminal handler keeps the held retry of the request that handler started";
    let markDeliveryStarted;
    const deliveryStarted = new Promise((resolve) => { markDeliveryStarted = resolve; });
    let openGate;
    const gate = new Promise((resolve) => { openGate = resolve; });
    let session;
    let nested;
    const f = await fixture(mode, {
      baseDelayMs: 60_000,
      captureExtensionErrors: true,
      async terminalDelivery() {
        if (nested) return;
        markDeliveryStarted();
        await gate;
        // A's handler starts request B and waits for it; B enters its own long backoff.
        nested = session.prompt("Complete request B.");
        await nested;
      },
    });
    session = f.session;
    let completion;
    let failed = false;
    try {
      await assertWithin((async () => {
        let backoffs = 0;
        let markSecondBackoff;
        const secondBackoff = new Promise((resolve) => { markSecondBackoff = resolve; });
        let markFirstBackoff;
        const firstBackoff = new Promise((resolve) => { markFirstBackoff = resolve; });
        f.session.subscribe((event) => {
          if (event.type !== "auto_retry_start") return;
          backoffs++;
          if (backoffs === 1) markFirstBackoff();
          if (backoffs === 2) markSecondBackoff();
        });
        f.faux.setResponses([connectionError(), connectionError(), fauxAssistantMessage("Must not be reached.")]);
        completion = f.session.prompt("Complete request A.");
        await firstBackoff;
        await delay(0);
        f.session.abortRetry();
        await deliveryStarted;
        // An outside settle starts while A's delivery runs, then times out because A's handler waits on B.
        const timedOut = f.session.settleRetry();
        openGate();
        await secondBackoff;
        await timedOut;
        // A later settle cancels B's backoff: B must still get its own terminal agent_end.
        await f.session.settleRetry();
        await nested;
        await completion;
      })(), 9_000, `${name}: did not finish within 9 s`);
      const ends = f.extensionEvents.filter((event) => event.type === "agent_end" && !event.willRetry);
      const endsFor = (text) => ends.filter((event) => JSON.stringify(event.messages).includes(text)).length;
      console.log(`${name} ${mode}: ${JSON.stringify({ ends: ends.length, a: endsFor("Complete request A."), b: endsFor("Complete request B."), calls: f.faux.state.callCount, outcomes: f.outcomes().map(({ state }) => state) })}`);
      assert.equal(endsFor("Complete request B."), 1, `${name}: B's cancelled retry delivers one terminal agent_end`);
      assert.equal(endsFor("Complete request A."), 1, `${name}: A delivers one terminal agent_end`);
      assert.equal(f.faux.state.callCount, 2, `${name}: neither retry ran`);
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["BLOCKED", "BLOCKED"], `${name}: A and B each keep a terminal outcome`);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      openGate();
      f.session.abortRetry();
      try { await assertWithin(Promise.all([completion, nested]), 1_500, `${name}: cleanup did not finish`); } catch (error) { if (!failed) throw error; } finally { f.close(); }
    }
  },
  async B26(mode) {
    for (const via of ["direct call", "extension command"]) {
      const name = `B26 runtime disposal from a terminal handler by ${via} keeps the receipt`;
      let runtime;
      let session;
      let disposed;
      const f = await fixture(mode, {
        baseDelayMs: 60_000,
        captureExtensionErrors: true,
        configureExtension(pi) {
          pi.registerCommand("retry-outcome-quit", { handler: async () => { await runtime.dispose(); } });
        },
        async terminalDelivery() {
          if (disposed) return;
          // This handler runs before the receipt's own handler, which must still record A.
          disposed = via === "direct call" ? runtime.dispose() : session.prompt("/retry-outcome-quit");
          await disposed;
        },
      });
      runtime = f.runtime;
      session = f.session;
      let completion;
      try {
        await assertWithin((async () => {
          const started = new Promise((resolve) => f.session.subscribe((event) => {
            if (event.type === "auto_retry_start") resolve();
          }));
          f.faux.setResponses([connectionError(), fauxAssistantMessage("Must not be reached.")]);
          completion = f.session.prompt("Complete request A.");
          await started;
          await delay(0);
          f.session.abortRetry();
          await completion;
          await disposed;
        })(), 3_000, `${name}: did not finish within 3 s`);
        await delay(0);
        console.log(`${name} ${mode}: ${JSON.stringify({ outcomes: f.outcomes().map(({ state }) => state), errors: f.extensionErrors.map(({ error }) => String(error).slice(0, 80)), calls: f.faux.state.callCount })}`);
        assert.deepEqual(f.outcomes().map(({ state }) => state), ["BLOCKED"], `${name}: A's terminal receipt is recorded before the context is invalidated`);
        assert.deepEqual(f.extensionErrors, [], `${name}: no handler ran on an invalidated context`);
        assert.equal(f.faux.state.callCount, 1);
      } finally {
        f.session.abortRetry();
        await completion;
        f.close();
      }
    }
  },
  async B27(mode) {
    const name = "B27 a session disposed synchronously by the first terminal handler keeps the receipt";
    let session;
    let disposed = false;
    const f = await fixture(mode, {
      baseDelayMs: 60_000,
      captureExtensionErrors: true,
      firstAgentEnd(event) {
        if (event.willRetry || disposed) return;
        disposed = true;
        session.dispose();
      },
    });
    session = f.session;
    let completion;
    try {
      await assertWithin((async () => {
        const started = new Promise((resolve) => f.session.subscribe((event) => {
          if (event.type === "auto_retry_start") resolve();
        }));
        f.faux.setResponses([connectionError(), fauxAssistantMessage("Must not be reached.")]);
        completion = f.session.prompt("Complete request A.");
        await started;
        await delay(0);
        f.session.abortRetry();
        await completion;
      })(), 3_000, `${name}: did not finish within 3 s`);
      await delay(0);
      console.log(`${name} ${mode}: ${JSON.stringify({ disposed, outcomes: f.outcomes().map(({ state }) => state), errors: f.extensionErrors.map(({ error }) => String(error).slice(0, 80)) })}`);
      assert.equal(disposed, true);
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["BLOCKED"], `${name}: A's terminal receipt is recorded before the context is invalidated`);
      assert.deepEqual(f.extensionErrors, [], `${name}: no handler ran on an invalidated context`);
    } finally {
      f.session.abortRetry();
      await completion;
      f.faux.unregister();
    }
  },
  async B28(mode) {
    const name = "B28 disposal from the terminal handler of a request started by another terminal handler keeps both receipts";
    let session;
    let runtime;
    let nested;
    let disposing;
    const f = await fixture(mode, {
      baseDelayMs: 60_000,
      captureExtensionErrors: true,
      async terminalDelivery() {
        if (!nested) {
          // A's handler starts request B and waits for it.
          nested = session.prompt("Complete request B.");
          await nested;
          return;
        }
        if (!disposing) {
          // B's handler disposes the runtime while A's delivery still waits on B.
          disposing = runtime.dispose();
          await disposing;
        }
      },
    });
    session = f.session;
    runtime = f.runtime;
    let completion;
    try {
      await assertWithin((async () => {
        let backoffs = 0;
        let markFirst;
        let markSecond;
        const first = new Promise((resolve) => { markFirst = resolve; });
        const second = new Promise((resolve) => { markSecond = resolve; });
        f.session.subscribe((event) => {
          if (event.type !== "auto_retry_start") return;
          backoffs++;
          if (backoffs === 1) markFirst();
          if (backoffs === 2) markSecond();
        });
        f.faux.setResponses([connectionError(), connectionError(), fauxAssistantMessage("Must not be reached.")]);
        completion = f.session.prompt("Complete request A.");
        await first;
        await delay(0);
        f.session.abortRetry();
        await second;
        await delay(0);
        f.session.abortRetry();
        await nested;
        await completion;
        await disposing;
      })(), 4_000, `${name}: did not finish within 4 s`);
      await delay(0);
      console.log(`${name} ${mode}: ${JSON.stringify({ outcomes: f.outcomes().map(({ state }) => state), errors: f.extensionErrors.map(({ error }) => String(error).slice(0, 80)), calls: f.faux.state.callCount })}`);
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["BLOCKED", "BLOCKED"], `${name}: A and B each keep a terminal receipt`);
      assert.deepEqual(f.extensionErrors, [], `${name}: no handler ran on an invalidated context`);
      assert.equal(f.faux.state.callCount, 2, `${name}: neither retry ran`);
    } finally {
      f.session.abortRetry();
      try { await assertWithin(Promise.all([completion, nested, disposing]), 1_500, `${name}: cleanup did not finish`); } finally { f.faux.unregister(); }
    }
  },
  // A retried connection error followed by a non-retryable error keeps that error's own guidance:
  // the "could not reach the model" wording is only for retries exhausted on a retryable error.
  async B30(mode) {
    const name = "B30 disposal after a nested request's delivery cleared the delivery pointers keeps the outer receipt";
    let session;
    let nested;
    let openGate;
    const gate = new Promise((resolve) => { openGate = resolve; });
    let markNestedDone;
    const nestedDone = new Promise((resolve) => { markNestedDone = resolve; });
    const f = await fixture(mode, {
      baseDelayMs: 60_000,
      captureExtensionErrors: true,
      async terminalDelivery() {
        if (nested) return;
        // A's handler starts request B and waits until B's own terminal delivery has finished, then stalls.
        nested = session.prompt("Complete request B.");
        await nested;
        markNestedDone();
        await gate;
      },
    });
    session = f.session;
    let completion;
    try {
      await assertWithin((async () => {
        let backoffs = 0;
        let markFirst;
        let markSecond;
        const first = new Promise((resolve) => { markFirst = resolve; });
        const second = new Promise((resolve) => { markSecond = resolve; });
        f.session.subscribe((event) => {
          if (event.type !== "auto_retry_start") return;
          backoffs++;
          if (backoffs === 1) markFirst();
          if (backoffs === 2) markSecond();
        });
        f.faux.setResponses([connectionError(), connectionError(), fauxAssistantMessage("Must not be reached.")]);
        completion = f.session.prompt("Complete request A.");
        await first;
        await delay(0);
        f.session.abortRetry();
        await second;
        await delay(0);
        f.session.abortRetry();
        await nestedDone;
        // B's delivery is done and cleared the delivery pointers; A's delivery is still running.
        f.runtime.dispose();
        await delay(50);
        openGate();
        await completion;
      })(), 4_000, `${name}: did not finish within 4 s`);
      await delay(50);
      console.log(`${name} ${mode}: ${JSON.stringify({ outcomes: f.outcomes().map(({ state }) => state), errors: f.extensionErrors.map(({ error }) => String(error).slice(0, 80)), calls: f.faux.state.callCount })}`);
      assert.deepEqual(f.extensionErrors, [], `${name}: A's later handlers did not run on an invalidated context`);
      assert.deepEqual(f.outcomes().map(({ state }) => state), ["BLOCKED", "BLOCKED"], `${name}: A and B each keep a terminal receipt`);
      assert.equal(f.faux.state.callCount, 2, `${name}: neither retry ran`);
    } finally {
      openGate();
      f.session.abortRetry();
      try { await assertWithin(Promise.all([completion, nested]), 1_500, `${name}: cleanup did not finish`); } finally { f.faux.unregister(); }
    }
  },
  async B29(mode) {
    const name = "B29 disposal after a timed-out settle does not wait the bound again on the detached delivery";
    let releaseDelivery;
    const delivery = new Promise((resolve) => { releaseDelivery = resolve; });
    const f = await fixture(mode, { baseDelayMs: 60_000, captureExtensionErrors: true, terminalDelivery: () => delivery });
    let completion;
    try {
      const context = f.session.extensionRunner.createCommandContext();
      const started = new Promise((resolve) => f.session.subscribe((event) => {
        if (event.type === "auto_retry_start") resolve();
      }));
      f.faux.setResponses([connectionError(), fauxAssistantMessage("Must not be reached.")]);
      completion = f.session.prompt("Complete the read-only task.");
      await started;
      await delay(0);
      // The terminal handler stalls: this settle times out after its bound and detaches the delivery.
      await assertWithin(f.session.settleRetry(), 6_000, `${name}: the settle did not return within its bound`);
      assert.doesNotThrow(() => context.getSystemPrompt(), `${name}: the context is still live before disposal`);
      assert.equal(f.session.dispose(), undefined, `${name}: dispose stays synchronous`);
      await delay(500);
      assert.throws(() => context.getSystemPrompt(), /stale/, `${name}: disposal invalidates at once instead of waiting the bound again`);
      assert.equal(f.faux.state.callCount, 1, `${name}: the settled retry does not run`);
    } finally {
      releaseDelivery();
      f.session.abortRetry();
      try {
        await assertWithin(completion, 1_500, `${name}: cleanup did not finish after releasing the handler`);
      } finally { f.close(); }
    }
  },
  async B31(mode) {
    const name = "B31 a new prompt preserves the held request's verification evidence";
    let reference;
    for (const submission of ["settle", "prompt"]) {
      const f = await fixture(mode, { tools: true, verificationEnabled: true, baseDelayMs: 60_000 });
      let completion;
      try {
        const started = new Promise((resolve) => f.session.subscribe((event) => {
          if (event.type === "auto_retry_start") resolve();
        }));
        f.faux.setResponses([
          fauxAssistantMessage(fauxToolCall("write", {
            path: "verified.test.mjs",
            content: 'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("verified work", () => assert.equal(2 + 2, 4));\n',
          }, { id: "write-verified" }), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxToolCall("bash", { command: "node --test verified.test.mjs" }, { id: "check-verified" }), { stopReason: "toolUse" }),
          connectionError(),
          fauxAssistantMessage("Request B is complete."),
        ]);
        completion = f.session.prompt("Write verified.test.mjs and run its test for request A.");
        await assertWithin(started, 3_000, `${name}: A did not enter backoff`);
        await delay(0);
        assert.equal(f.session.isRetrying, true);
        assert.equal(f.session.isStreaming, false);
        assert.deepEqual(f.outcomes(), []);
        const evidence = f.session.sessionManager.getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "vinci-verification-state")
          .at(-1)?.data;
        assert.equal(evidence?.status, "passed", `${name}: A ran a passing check before backoff`);
        if (submission === "settle") await f.session.settleRetry();
        else await f.session.prompt("B is a separate read-only request.", { source: "interactive" });
        await completion;
        const outcome = f.outcomes()[0];
        const classification = outcome && {
          state: outcome.state,
          verificationStatus: outcome.verificationStatus,
          verificationCommand: outcome.verificationCommand,
          // The reason quotes the check's output, including its run time.
          reason: outcome.reason.replace(/\(\d+(?:\.\d+)?ms\)/g, "(<ms>)"),
          changedFiles: outcome.changedFiles,
        };
        console.log(`${name} ${mode} ${submission}: ${JSON.stringify(classification)}`);
        if (submission === "settle") {
          assert.equal(outcome?.state, "DONE", `${name}: verified work survives an interrupted wrap-up`);
          assert.equal(outcome.verificationStatus, "passed");
          assert.deepEqual(outcome.changedFiles, ["verified.test.mjs"]);
          reference = classification;
        } else {
          assert.deepEqual(classification, reference, `${name}: A's receipt matches settlement without a new prompt`);
          assert.equal(f.outcomes().length, 2, `${name}: A and B each have one receipt`);
          assert.equal(f.outcomes()[1].verificationStatus, "none", `${name}: B still resets its own verification state`);
        }
        assert.deepEqual(f.extensionErrors, []);
        assert.equal(f.faux.state.callCount, submission === "settle" ? 3 : 4);
      } finally {
        f.session.abortRetry();
        await completion;
        f.close();
      }
    }
  },
  async B32(mode) {
    const name = "B32 disposal during the retry's final delivery keeps the receipt";
    for (const path of ["runtime", "session", "handler runtime", "handler session"]) {
      let openGate;
      const gate = new Promise((resolve) => { openGate = resolve; });
      let markDeliveryStarted;
      const deliveryStarted = new Promise((resolve) => { markDeliveryStarted = resolve; });
      let outcomesAtShutdown;
      const f = await fixture(mode, {
        captureExtensionErrors: true,
        configureExtension(pi) {
          pi.on("session_shutdown", () => { outcomesAtShutdown ??= f.outcomes(); });
        },
        async firstAgentEnd(event) {
          if (event.willRetry) return;
          markDeliveryStarted();
          await gate;
          if (path === "handler runtime") await f.runtime.dispose();
          if (path === "handler session") f.session.dispose();
        },
      });
      let completion;
      let disposing;
      try {
        f.faux.setResponses([connectionError(), fauxAssistantMessage("Request A is complete.")]);
        completion = f.session.prompt("Complete request A.");
        await assertWithin(deliveryStarted, 2_000, `${name}: the retry did not reach its final handler`);
        assert.equal(f.faux.state.callCount, 2);
        assert.deepEqual(f.outcomes(), []);
        let disposed = false;
        if (path === "runtime") disposing = f.runtime.dispose().then(() => { disposed = true; });
        if (path === "session") assert.equal(f.session.dispose(), undefined);
        await delay(20);
        // Runtime teardown (quit) waits for the delivery: the process must not exit before its receipt.
        if (path === "runtime") assert.equal(disposed, false, `${name}: runtime teardown waits for the retried run's final delivery`);
        openGate();
        await assertWithin(Promise.all([completion, disposing]), 2_000, `${name}: ${path} deadlocked`);
        await delay(0);
        console.log(`${name} ${mode} ${path}: ${JSON.stringify({ outcomes: f.outcomes().map(({ state }) => state), errors: f.extensionErrors.map(({ error }) => error) })}`);
        assert.deepEqual(f.extensionErrors, [], `${name}: ${path} must not invalidate a later handler's context`);
        assert.deepEqual(f.outcomes().map(({ state }) => state), ["DONE"], `${name}: ${path} records exactly one outcome for A`);
        if (path === "runtime") assert.deepEqual(outcomesAtShutdown?.map(({ state }) => state), ["DONE"], `${name}: the receipt persists before runtime shutdown handlers`);
        assert.ok(f.extensionEvents.find((event) => event.type === "agent_end" && !event.willRetry)?.heldRunMessages?.length > 0);
      } finally {
        openGate();
        f.session.abortRetry();
        try { await assertWithin(Promise.all([completion, disposing]), 1_500, `${name}: cleanup did not finish`); } finally { f.close(); }
      }
    }
  },
  async B33(mode) {
    const name = "B33 new input during backoff names the cancelled retry in the held request's receipt";
    const expected = "Connection error. The retry was cancelled because new input arrived during the retry wait.";
    for (const row of ["handled input", "failed validation", "prompt", "steer", "followUp"]) {
      const f = await fixture(mode, {
        baseDelayMs: 60_000,
        configureExtension(pi) {
          pi.on("input", (event) => (event.text.startsWith("handled:") ? { action: "handled" } : undefined));
        },
      });
      let completion;
      try {
        const started = new Promise((resolve) => f.session.subscribe((event) => {
          if (event.type === "auto_retry_start") resolve();
        }));
        f.faux.setResponses([connectionError(), fauxAssistantMessage("Request B is complete.")]);
        completion = f.session.prompt("Complete request A.");
        await assertWithin(started, 3_000, `${name}: A did not enter backoff`);
        await delay(0);
        assert.equal(f.session.isRetrying, true);
        assert.equal(f.session.isStreaming, false);
        if (row === "handled input") {
          await f.session.prompt("handled: an extension consumes this input.", { source: "interactive" });
        } else if (row === "failed validation") {
          f.authStorage.removeRuntimeApiKey(f.faux.getModel().provider);
          await assert.rejects(f.session.prompt("Complete request B.", { source: "interactive" }), /API key|auth/i, `${name}: B fails model/auth validation`);
        } else if (row === "prompt") {
          await f.session.prompt("Complete request B.", { source: "interactive" });
        } else {
          await f.session[row]("Complete request B.");
        }
        await assertWithin(completion, 2_000, `${name}: A did not finish after ${row}`);
        const terminal = f.extensionEvents.filter((event) => event.type === "agent_end" && !event.willRetry);
        const a = f.outcomes()[0];
        console.log(`${name} ${mode} ${row}: ${JSON.stringify({ outcomes: f.outcomes().map(({ state, reason }) => ({ state, reason })), retryCancelled: terminal.map((event) => event.retryCancelled ?? null), calls: f.faux.state.callCount })}`);
        assert.equal(terminal[0]?.retryCancelled, "new-input", `${name}: ${row}: A's terminal agent_end says new input cancelled its retry`);
        assert.equal(a?.state, "BLOCKED", `${name}: ${row}: A stays BLOCKED`);
        assert.equal(a.reason, expected, `${name}: ${row}: A's receipt names why its retry ended`);
        const sentB = row === "prompt" || row === "steer" || row === "followUp";
        assert.equal(f.outcomes().length, sentB ? 2 : 1, `${name}: ${row}: one receipt per request`);
        assert.equal(f.faux.state.callCount, sentB ? 2 : 1, `${name}: ${row}: A is never retried`);
        if (sentB) {
          assert.equal(f.outcomes()[1].state, "DONE", `${name}: ${row}: B's own receipt`);
          assert.equal(terminal[1]?.retryCancelled, undefined, `${name}: ${row}: B's agent_end carries no cancellation`);
        }
        assert.deepEqual(f.extensionErrors, []);
      } finally {
        f.session.abortRetry();
        await completion?.catch(() => {});
        f.close();
      }
    }
  },
  async B34(mode) {
    const name = "B34 a retry ended without new input leaves the receipt unchanged";
    for (const row of ["abortRetry", "settleRetry", "exhausted", "recovered"]) {
      const f = await fixture(mode, { baseDelayMs: row === "abortRetry" || row === "settleRetry" ? 60_000 : 1 });
      let completion;
      try {
        const started = new Promise((resolve) => f.session.subscribe((event) => {
          if (event.type === "auto_retry_start") resolve();
        }));
        f.faux.setResponses(row === "exhausted"
          ? [connectionError(), connectionError(), connectionError()]
          : [connectionError(), fauxAssistantMessage("Request A is complete.")]);
        completion = f.session.prompt("Complete request A.");
        if (row === "abortRetry" || row === "settleRetry") {
          await assertWithin(started, 3_000, `${name}: A did not enter backoff`);
          await delay(0);
          if (row === "abortRetry") f.session.abortRetry();
          else await f.session.settleRetry();
        }
        await assertWithin(completion, 3_000, `${name}: A did not finish (${row})`);
        const terminal = f.extensionEvents.filter((event) => event.type === "agent_end" && !event.willRetry);
        const a = f.outcomes()[0];
        console.log(`${name} ${mode} ${row}: ${JSON.stringify({ outcome: a && { state: a.state, reason: a.reason }, keys: terminal.map((event) => Object.keys(event).sort()) })}`);
        assert.equal(terminal.length, 1);
        assert.equal(Object.hasOwn(terminal[0], "retryCancelled"), false, `${name}: ${row}: the field is absent`);
        assert.equal(f.outcomes().length, 1);
        if (row === "abortRetry" || row === "settleRetry") assert.deepEqual({ state: a.state, reason: a.reason }, { state: "BLOCKED", reason: "Connection error." }, `${name}: ${row}: the raw error, as before`);
        if (row === "exhausted") assert.match(a.reason, /^Vinci could not reach the model after 3 tries \(Connection error\.\)\. Type continue to resume\.$/, `${name}: exhausted wording unchanged`);
        if (row === "recovered") assert.equal(a.state, "DONE");
      } finally {
        f.session.abortRetry();
        await completion?.catch(() => {});
        f.close();
      }
    }
  },
  async B35(mode) {
    const name = "B35 input queued while the retry streams does not settle the held request";
    for (const row of ["prompt steer", "prompt followUp", "steer", "followUp"]) {
      const f = await fixture(mode);
      let completion;
      let queued;
      let streamingAtQueue;
      let outcomesAtQueue;
      try {
        f.faux.setResponses([
          connectionError(),
          () => {
            streamingAtQueue = f.session.isStreaming;
            outcomesAtQueue = f.outcomes();
            const text = "Also mention request A's follow-up.";
            queued = row.startsWith("prompt ")
              ? f.session.prompt(text, { source: "interactive", streamingBehavior: row.slice("prompt ".length) })
              : f.session[row](text);
            return fauxAssistantMessage("Request A is complete.");
          },
          fauxAssistantMessage("The follow-up is noted."),
        ]);
        completion = f.session.prompt("Complete request A.");
        await assertWithin(completion, 3_000, `${name}: A did not finish (${row})`);
        await queued;
        const terminal = f.extensionEvents.filter((event) => event.type === "agent_end" && !event.willRetry);
        console.log(`${name} ${mode} ${row}: ${JSON.stringify({ streamingAtQueue, outcomes: f.outcomes().map(({ state, reason }) => ({ state, reason })), terminal: terminal.map((event) => ({ held: event.heldRunMessages?.length ?? 0, retryCancelled: event.retryCancelled ?? null })), calls: f.faux.state.callCount })}`);
        assert.equal(streamingAtQueue, true, `${name}: ${row}: queued while the retry run streams`);
        assert.deepEqual(outcomesAtQueue, []);
        assert.equal(terminal.length, 1, `${name}: ${row}: the retried request has exactly one terminal agent_end`);
        assert.ok(terminal[0].heldRunMessages?.length > 0, `${name}: ${row}: the terminal agent_end is the retried run's, carrying the held run`);
        assert.equal(terminal[0].retryCancelled, undefined, `${name}: ${row}: queued input does not cancel a running retry`);
        assert.deepEqual(f.outcomes().map(({ state }) => state), ["DONE"], `${name}: ${row}: one DONE receipt`);
        assert.equal(f.faux.state.callCount, 3);
        assert.deepEqual(f.extensionErrors, []);
      } finally {
        f.session.abortRetry();
        await completion?.catch(() => {});
        f.close();
      }
    }
  },
  async B36(mode) {
    const name = "B36 teardown called from the retried run's final delivery does not wait on that delivery";
    for (const call of ["settleRetry", "runtime dispose"]) {
      let elapsedMs;
      const f = await fixture(mode, {
        captureExtensionErrors: true,
        async firstAgentEnd(event) {
          if (event.willRetry) return;
          const started = Date.now();
          if (call === "settleRetry") await f.session.settleRetry();
          else await f.runtime.dispose();
          elapsedMs = Date.now() - started;
        },
      });
      let completion;
      try {
        f.faux.setResponses([connectionError(), fauxAssistantMessage("Request A is complete.")]);
        completion = f.session.prompt("Complete request A.");
        // The teardown bound is 5 s; allow it to elapse so a self-wait is measured, not cut short.
        await assertWithin(completion, 8_000, `${name}: ${call}: A did not finish`);
        console.log(`${name} ${mode} ${call}: ${JSON.stringify({ elapsedMs, outcomes: f.outcomes().map(({ state }) => state), errors: f.extensionErrors.map(({ error }) => error) })}`);
        assert.equal(typeof elapsedMs, "number", `${name}: ${call}: the handler ran`);
        assert.ok(elapsedMs < 1_000, `${name}: ${call}: returned in ${elapsedMs} ms; a call from inside the delivery must not wait on it`);
        assert.ok(f.extensionEvents.find((event) => event.type === "agent_end" && !event.willRetry)?.heldRunMessages?.length > 0, `${name}: the delivery is the retried run's`);
      } finally {
        f.session.abortRetry();
        await completion?.catch(() => {});
        f.close();
      }
    }
  },
  async B37(mode) {
    const name = "B37 a long provider error keeps the cancellation sentence";
    const suffix = "The retry was cancelled because new input arrived during the retry wait.";
    const longError = `Connection error. ${"upstream detail ".repeat(20).trim()}`;
    const f = await fixture(mode, { baseDelayMs: 60_000 });
    let completion;
    try {
      const started = new Promise((resolve) => f.session.subscribe((event) => {
        if (event.type === "auto_retry_start") resolve();
      }));
      f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: longError }), fauxAssistantMessage("Request B is complete.")]);
      completion = f.session.prompt("Complete request A.");
      await assertWithin(started, 3_000, `${name}: A did not enter backoff`);
      await delay(0);
      await f.session.prompt("Complete request B.", { source: "interactive" });
      await assertWithin(completion, 2_000, `${name}: A did not finish`);
      const a = f.outcomes()[0];
      console.log(`${name} ${mode}: ${JSON.stringify({ state: a?.state, length: a?.reason.length, reason: a?.reason })}`);
      assert.equal(a?.state, "BLOCKED");
      assert.ok(a.reason.endsWith(` ${suffix}`), `${name}: the reason still says why the retry ended`);
      assert.ok(a.reason.length <= 240, `${name}: the reason stays within 240 characters`);
      assert.ok(a.reason.startsWith("Connection error. upstream detail"), `${name}: the provider text leads`);
    } finally {
      f.session.abortRetry();
      await completion?.catch(() => {});
      f.close();
    }
  },
  async B38(mode) {
    const name = "B38 a teardown that timed out on a retried run's final delivery does not wait the bound on it again";
    let openGate;
    const gate = new Promise((resolve) => { openGate = resolve; });
    let markDeliveryStarted;
    const deliveryStarted = new Promise((resolve) => { markDeliveryStarted = resolve; });
    const f = await fixture(mode, {
      captureExtensionErrors: true,
      async firstAgentEnd(event) {
        if (event.willRetry) return;
        markDeliveryStarted();
        await gate;
      },
    });
    let completion;
    try {
      f.faux.setResponses([connectionError(), fauxAssistantMessage("Request A is complete.")]);
      completion = f.session.prompt("Complete request A.");
      await assertWithin(deliveryStarted, 2_000, `${name}: the retry did not reach its final handler`);
      const firstStarted = Date.now();
      await assertWithin(f.session.settleRetry(), 8_000, `${name}: the first teardown wait is unbounded`);
      const firstMs = Date.now() - firstStarted;
      const secondStarted = Date.now();
      await assertWithin(f.session.settleRetry(), 8_000, `${name}: the second teardown wait is unbounded`);
      const secondMs = Date.now() - secondStarted;
      console.log(`${name} ${mode}: ${JSON.stringify({ firstMs, secondMs })}`);
      assert.ok(firstMs >= 4_500, `${name}: the first teardown waits the bound (${firstMs} ms)`);
      assert.ok(secondMs < 1_000, `${name}: the second teardown returned in ${secondMs} ms; the stalled delivery is already detached`);
    } finally {
      openGate();
      f.session.abortRetry();
      try { await assertWithin(completion, 2_000, `${name}: cleanup did not finish`); } finally { f.close(); }
    }
  },
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
