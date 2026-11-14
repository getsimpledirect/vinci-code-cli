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

async function fixture(mode, { maxRetries = 2, baseDelayMs = 1, enabled = true, tools = false, captureExtensionErrors = false, terminalDelivery, configureExtension, compaction } = {}) {
  const cwd = mkdtempSync(join(owned, `${mode}-`));
  const agentDir = join(cwd, "profile");
  mkdirSync(agentDir);
  const faux = registerFauxProvider({ tokensPerSecond: 100_000 });
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
  }, receipt];
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
    session, runtime, faux, events, extensionEvents, extensionErrors, badges, outcomes,
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
      const f = await fixture(mode, { baseDelayMs: 100 });
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
      const f = await fixture(mode, { baseDelayMs: 60_000, captureExtensionErrors: true });
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
