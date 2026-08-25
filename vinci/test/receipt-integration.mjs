import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-agent-core": resolve(here, "../../packages/agent/src/index.ts"),
  },
  moduleCache: false,
  tryNative: false,
});
const receipt = await loader.import(resolve(here, "../extensions/vinci-receipt.ts"), { default: false });
const advisor = await loader.import(resolve(here, "../extensions/vinci-advisor.ts"), { default: false });
const verification = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), { default: false });
const taskOutcome = await loader.import(resolve(here, "../extensions/lib/task-outcome.ts"), { default: false });
const usageAccumulator = await loader.import(resolve(here, "../extensions/lib/usage-accumulator.ts"), { default: false });
const compaction = await loader.import(
  resolve(here, "../../packages/coding-agent/src/core/compaction/compaction.ts"),
  { default: false },
);

// Hosts may omit both event handlers and durable persistence. Installation and in-memory
// accounting must remain available in that reduced environment.
const reducedHostTaskId = "task-receipt-reduced-host";
usageAccumulator.resetVinciTaskUsage(reducedHostTaskId);
assert.doesNotThrow(() => usageAccumulator.installVinciUsageAccumulator({}));
assert.doesNotThrow(() => {
  usageAccumulator.recordVinciTaskCall(
    reducedHostTaskId,
    {
      provider: "vinci",
      model: "vinci-fort",
      responseId: "reduced-host-response",
      usage: {
        input: 10,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
        reasoning: 0,
        cost: { total: 0.01 },
      },
    },
    "test:reduced-host",
  );
  usageAccumulator.recordVinciTaskUsage(
    reducedHostTaskId,
    {
      modelCalls: 1,
      inputTokens: 5,
      outputTokens: 1,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0.02,
      providers: ["vinci"],
      models: ["vinci-fort"],
    },
    { id: "reduced-host-aggregate", source: "test:reduced-host" },
  );
});
assert.equal(
  usageAccumulator.getVinciTaskUsageSnapshot(reducedHostTaskId).calls.length,
  2,
  "usage accumulates in memory without host event or persistence methods",
);

const handlers = {};
const commands = {};
const tools = {};
const branch = [];
const receiptCwd = mkdtempSync(resolve(tmpdir(), "vinci-receipt-fallback-"));
mkdirSync(resolve(receiptCwd, "src"), { recursive: true });
writeFileSync(resolve(receiptCwd, "src/auth.ts"), "export const auth = true;\n");
const pi = {
  on(name, handler) {
    (handlers[name] ??= []).push(handler);
  },
  appendEntry(customType, data) {
    branch.push({ type: "custom", customType, data });
  },
  registerCommand(name, definition) {
    commands[name] = definition;
  },
  registerTool(definition) {
    tools[definition.name] = definition;
  },
};
receipt.default(pi);
advisor.default(pi);

let widget;
let currentTaskId = "task-receipt-test";
const notifications = [];
const context = {
  hasUI: true,
  cwd: receiptCwd,
  sessionManager: {
    getBranch() {
      return [...branch];
    },
    getSessionId() {
      return currentTaskId;
    },
  },
  ui: {
    async select() {
      return undefined;
    },
    async confirm() {
      return false;
    },
    async input() {
      return undefined;
    },
    setWidget(_key, content) {
      widget = content;
    },
    notify(message, level) {
      notifications.push({ message, level });
    },
  },
};
const usage = (input, output, cacheRead, cost) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: input + output + cacheRead,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const messages = [
  {
    role: "assistant",
    provider: "vinci",
    model: "vinci-fort",
    responseModel: "zai-org/GLM-5.2",
    responseId: "response-1",
    stopReason: "toolUse",
    timestamp: 1,
    usage: usage(100, 10, 100, 0.01),
    content: [
      {
        type: "toolCall",
        id: "edit-1",
        name: "edit",
        arguments: { path: "src/auth.ts" },
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "edit-1",
    toolName: "edit",
    content: [{ type: "text", text: "Applied changes" }],
    isError: false,
    timestamp: 2,
  },
  {
    role: "assistant",
    provider: "vinci",
    model: "vinci-fort",
    responseModel: "zai-org/GLM-5.2",
    responseId: "response-2",
    stopReason: "stop",
    timestamp: 3,
    usage: usage(50, 5, 50, 0.02),
    content: [{ type: "text", text: "The requested change is in place." }],
  },
];

const emptyVerification = {
  status: "none",
  command: "",
  summary: "",
  mutationRevision: 0,
  verifiedRevision: -1,
  recoveryAttempts: 0,
};

// Exercise real authenticated extension/core call paths through faux providers. These assertions
// fail if the advisor's explicit accounting or compaction's global instrumentation is removed.
const wiringTaskId = "task-receipt-wiring";
currentTaskId = wiringTaskId;
usageAccumulator.resetVinciTaskUsage(wiringTaskId);
for (const handler of handlers.session_start ?? []) {
  await handler({ type: "session_start", reason: "startup" }, context);
}
const advisorFaux = registerFauxProvider({
  api: "faux:receipt-advisor",
  provider: "faux-receipt-advisor",
});
const compactionFaux = registerFauxProvider({
  api: "faux:receipt-compaction",
  provider: "faux-receipt-compaction",
});
try {
  let advisorOptions;
  advisorFaux.setResponses([
    (_context, options) => {
      advisorOptions = options;
      return fauxAssistantMessage("The approach is sound.", { responseId: "advisor-wiring-response" });
    },
  ]);
  await tools.advisor.execute(
    "advisor-wiring",
    { question: "Is this accounting approach sound?" },
    new AbortController().signal,
    () => {},
    {
      ...context,
      model: advisorFaux.getModel(),
      signal: undefined,
      modelRegistry: {
        async getApiKeyAndHeaders() {
          return { ok: true, apiKey: "faux-advisor-key", headers: {}, env: {} };
        },
      },
    },
  );
  assert.equal(advisorOptions.apiKey, "faux-advisor-key");

  let compactionOptions;
  compactionFaux.setResponses([
    (_context, options) => {
      compactionOptions = options;
      return fauxAssistantMessage("Compaction summary.", { responseId: "compaction-wiring-response" });
    },
  ]);
  await compaction.generateSummary(
    [{
      role: "user",
      content: [{ type: "text", text: "Summarize this authenticated compaction call." }],
      timestamp: 1,
    }],
    compactionFaux.getModel(),
    1024,
    "faux-compaction-key",
  );
  assert.equal(compactionOptions.apiKey, "faux-compaction-key");

  const wiringSources = usageAccumulator
    .getVinciTaskUsageSnapshot(wiringTaskId)
    .calls
    .map((call) => call.source);
  assert.equal(wiringSources.includes("advisor:fallback"), true, "advisor completion is instrumented");
  assert.equal(wiringSources.includes("compaction"), true, "compaction completion is instrumented");
} finally {
  advisorFaux.unregister();
  compactionFaux.unregister();
}
currentTaskId = "task-receipt-test";
usageAccumulator.resetVinciTaskUsage(currentTaskId);
for (const handler of handlers.session_start ?? []) {
  await handler({ type: "session_start", reason: "startup" }, context);
}

// Durable usage entries are session-bound. A completion from an earlier task may still update its
// in-memory accumulator, but it must never be appended into the active task's entry stream.
const mismatchedTaskId = "task-stale-completion";
usageAccumulator.resetVinciTaskUsage(mismatchedTaskId);
const mismatchEntryCount = branch.filter(
  (entry) => entry.type === "custom" && entry.customType === usageAccumulator.VINCI_TASK_USAGE_ENTRY,
).length;
const usageWarnings = [];
const originalConsoleWarn = console.warn;
console.warn = (message) => usageWarnings.push(String(message));
usageAccumulator.recordVinciTaskCall(
  mismatchedTaskId,
  {
    provider: "vinci",
    model: "vinci-forte",
    responseId: "late-stale-response",
    usage: usage(5, 1, 0, 0.01),
  },
  "test:stale-completion",
);
assert.equal(
  branch.filter(
    (entry) => entry.type === "custom" && entry.customType === usageAccumulator.VINCI_TASK_USAGE_ENTRY,
  ).length,
  mismatchEntryCount,
  "a stale completion cannot append usage into the active task's entry stream",
);
assert.match(usageWarnings.at(-1) ?? "", /dropped.*task.*mismatch/i);

// Task-scoped supplemental calls are separate from the durable assistant-message stream. Main-loop
// usage therefore stays byte-for-byte equivalent when no extension call was reported.
usageAccumulator.resetVinciTaskUsage("task-main-only");
const mainOnly = taskOutcome.buildVinciTaskOutcome({
  taskId: "task-main-only",
  messages,
  changedFiles: [],
  verification: emptyVerification,
});
assert.deepEqual(mainOnly.usage, taskOutcome.summarizeVinciTaskUsage(messages));

// Grader/council/advisor-style complete() responses add their full usage and cost.
const supplementalTaskId = "task-supplemental-calls";
usageAccumulator.resetVinciTaskUsage(supplementalTaskId);
for (const [source, responseId, cost] of [
  ["grader", "grader-1", 0.03],
  ["council", "council-1", 0.04],
  ["advisor", "advisor-1", 0.05],
]) {
  usageAccumulator.recordVinciTaskCall(
    supplementalTaskId,
    {
      role: "assistant",
      provider: "vinci",
      model: "vinci-forte",
      responseModel: "zai-org/GLM-5.2",
      responseId,
      usage: usage(20, 4, 6, cost),
    },
    source,
  );
}
const withSupplementalCalls = taskOutcome.buildVinciTaskOutcome({
  taskId: supplementalTaskId,
  messages,
  changedFiles: [],
  verification: emptyVerification,
});
assert.equal(withSupplementalCalls.usage.modelCalls, 5);
assert.equal(withSupplementalCalls.usage.estimatedCostUsd, 0.15);

// Assistant-stream costs use the same micro-USD representation as supplemental calls.
const assistantDriftMessages = Array.from({ length: 10 }, (_, index) => ({
  role: "assistant",
  provider: "vinci",
  model: "vinci-fort",
  responseId: `assistant-drift-${index}`,
  stopReason: "stop",
  timestamp: index,
  usage: usage(5, 1, 1, 0.03),
  content: [{ type: "text", text: "Done." }],
}));
assert.equal(
  taskOutcome.summarizeVinciTaskUsage(assistantDriftMessages).estimatedCostUsd,
  0.30,
  "assistant-stream cost accumulation is exact in micro-USD",
);

// Mixed assistant + supplemental calls share one cost representation end to end.
const driftTaskId = "task-floating-point-drift";
usageAccumulator.resetVinciTaskUsage(driftTaskId);
for (let i = 0; i < 5; i++) {
  usageAccumulator.recordVinciTaskCall(
    driftTaskId,
    {
      role: "assistant",
      provider: "vinci",
      model: "vinci-forte",
      responseModel: "zai-org/GLM-5.2",
      responseId: `drift-${i}`,
      usage: usage(5, 1, 1, 0.03),
    },
    "test:drift",
  );
}
const withDrift = taskOutcome.buildVinciTaskOutcome({
  taskId: driftTaskId,
  messages: assistantDriftMessages.slice(0, 5),
  changedFiles: [],
  verification: emptyVerification,
});
assert.equal(withDrift.usage.modelCalls, 10);
assert.equal(withDrift.usage.estimatedCostUsd, 0.30);
// Defensive de-duplication: even if an assistant-stream response is accidentally reported through
// the supplemental API, its response id causes summarizeVinciTaskUsage() to count it only once.
const dedupeTaskId = "task-no-double-count";
usageAccumulator.resetVinciTaskUsage(dedupeTaskId);
usageAccumulator.recordVinciTaskCall(dedupeTaskId, messages[0], "accidental-main-stream");
const deduped = taskOutcome.buildVinciTaskOutcome({
  taskId: dedupeTaskId,
  messages,
  changedFiles: [],
  verification: emptyVerification,
});
assert.equal(deduped.usage.modelCalls, 2);
assert.equal(deduped.usage.estimatedCostUsd, 0.03);

// A persisted outcome hydrates the same task UUID on resume, then later calls continue from it.
const resumeTaskId = "task-resume-usage";
usageAccumulator.resetVinciTaskUsage(resumeTaskId);
usageAccumulator.recordVinciTaskCall(
  resumeTaskId,
  {
    role: "assistant",
    provider: "vinci",
    model: "vinci-forte",
    responseId: "before-resume",
    usage: usage(10, 2, 3, 0.01),
  },
  "grader",
);
const beforeResume = taskOutcome.buildVinciTaskOutcome({
  taskId: resumeTaskId,
  messages,
  changedFiles: [],
  verification: emptyVerification,
});
usageAccumulator.resetVinciTaskUsage(resumeTaskId);
taskOutcome.setVinciTaskOutcome(beforeResume);
usageAccumulator.recordVinciTaskCall(
  resumeTaskId,
  {
    role: "assistant",
    provider: "vinci",
    model: "vinci-forte",
    responseId: "after-resume",
    usage: usage(12, 3, 4, 0.02),
  },
  "advisor",
);
const afterResume = taskOutcome.buildVinciTaskOutcome({
  taskId: resumeTaskId,
  messages,
  changedFiles: [],
  verification: emptyVerification,
});
assert.equal(afterResume.usage.modelCalls, 4);
assert.equal(afterResume.usage.estimatedCostUsd, 0.06);

// Crew contributes the complete child-session aggregate, including cost, as supplemental usage.
const crewTaskId = "task-crew-usage";
usageAccumulator.resetVinciTaskUsage(crewTaskId);
usageAccumulator.recordVinciTaskUsage(
  crewTaskId,
  {
    modelCalls: 3,
    inputTokens: 90,
    outputTokens: 30,
    cachedTokens: 15,
    cacheWriteTokens: 2,
    reasoningTokens: 8,
    estimatedCostUsd: 0.07,
    providers: ["vinci"],
    models: ["zai-org/GLM-5.2"],
  },
  { id: "crew:helper-1", source: "crew" },
);
const withCrew = taskOutcome.buildVinciTaskOutcome({
  taskId: crewTaskId,
  messages,
  changedFiles: [],
  verification: emptyVerification,
});
assert.equal(withCrew.usage.modelCalls, 5);
assert.equal(withCrew.usage.estimatedCostUsd, 0.1);

// A transient child getEntries() failure must retry before accepting assistant-only usage, otherwise
// supplemental child calls in the durable outcome are permanently omitted.
const retryChildTaskId = "task-crew-transient-child";
usageAccumulator.resetVinciTaskUsage(retryChildTaskId);
const childMessages = [{
  role: "assistant",
  provider: "vinci",
  model: "vinci-fort",
  responseId: "crew-child-main",
  stopReason: "stop",
  timestamp: 1,
  usage: usage(30, 5, 2, 0.01),
  content: [{ type: "text", text: "Child complete." }],
}];
usageAccumulator.recordVinciTaskCall(
  retryChildTaskId,
  {
    role: "assistant",
    provider: "vinci",
    model: "vinci-forte",
    responseId: "crew-child-grader",
    usage: usage(10, 2, 1, 0.02),
  },
  "grader",
);
const retryChildOutcome = taskOutcome.buildVinciTaskOutcome({
  taskId: retryChildTaskId,
  messages: childMessages,
  changedFiles: [],
  verification: emptyVerification,
});
let childEntryAttempts = 0;
const retryLookup = await taskOutcome.readLatestVinciTaskOutcomeUsage(async () => {
  childEntryAttempts++;
  if (childEntryAttempts < 4) throw new Error("transient getEntries failure");
  return {
    entries: [{
      type: "custom",
      customType: taskOutcome.VINCI_TASK_OUTCOME_ENTRY,
      data: retryChildOutcome,
    }],
  };
});
assert.equal(childEntryAttempts, 4, "child receipt lookup makes one attempt plus up to three retries");
assert.equal(retryLookup.entriesRead, true);
assert.equal(retryLookup.usage.modelCalls, 2, "the child supplemental call survives reconciliation");
console.warn = originalConsoleWarn;

for (const message of messages) branch.push({ type: "message", message });
const theme = {
  fg(_name, text) {
    return text;
  },
  bold(text) {
    return text;
  },
};

async function renderReceipt() {
  for (const handler of handlers.agent_end ?? []) {
    await handler({ type: "agent_end", messages }, context);
  }
  assert.equal(typeof widget, "function");
  return widget({}, theme).render(140).join("\n");
}

verification.resetVinciVerificationState();
verification.recordVinciMutation();
const unverified = await renderReceipt();
assert.match(unverified, /Done — please check it/);
assert.match(unverified, /2 model calls/);
assert.match(unverified, /50% cached/);
assert.match(unverified, /~\$0\.0300 estimated/);
assert.match(unverified, /~\$0\.0300 estimated · 0s active\n  Billed total in Platform\./);
assert.match(unverified, /0s active/);

verification.recordVinciVerification("npm run check", false, "1 test failed");
const failed = await renderReceipt();
assert.match(failed, /Stopped — needs you/);
assert.match(failed, /1 test failed/);

// #146: a latch-free failed verification whose attempted command found no tests is durable
// DONE_UNVERIFIED. The widget must use the warning label, never the blocker label.
verification.resetVinciVerificationState();
verification.recordVinciMutation();
verification.recordVinciVerification(
  "pytest -q",
  false,
  "The attempted check (pytest -q) ran without executing tests, so nothing was verified.",
  false,
  "behavioral",
  "pytest -q",
  true,
  undefined,
  true,
);
const zeroCollection = await renderReceipt();
assert.match(zeroCollection, /Done — please check it/);
assert.doesNotMatch(zeroCollection, /Stopped — needs you/);
assert.match(zeroCollection, /pytest -q/);
assert.match(zeroCollection, /ran without executing tests/i);
const zeroCollectionOutcomes = branch.filter(
  (entry) => entry.type === "custom" && entry.customType === taskOutcome.VINCI_TASK_OUTCOME_ENTRY,
);
assert.equal(zeroCollectionOutcomes.at(-1).data.state, "DONE_UNVERIFIED");
assert.equal(zeroCollectionOutcomes.at(-1).data.verificationStatus, "failed");
assert.equal(zeroCollectionOutcomes.at(-1).data.schemaVersion, 1);

// A STATIC pass while the zero-collection behavioral attempt is still open must not flip the
// receipt to verified Done — that was the pre-#146-review dishonesty (a lower-class pass
// "completing" a behavioral attempt that never ran any tests). The hedge stands until a
// behavioral pass actually lands (asserted just below).
verification.recordVinciVerification("npm run check", true, "12 tests passed");
const passed = await renderReceipt();
assert.match(passed, /Done — please check it/);
assert.doesNotMatch(passed, /✓ Done/);

verification.recordVinciVerificationAttempt("npm test", "behavioral");
const strongerIncomplete = await renderReceipt();
assert.match(strongerIncomplete, /Done — please check it/);
assert.match(strongerIncomplete, /test suite couldn't be run/i);
assert.doesNotMatch(strongerIncomplete, /✓ Done|check: npm run check/);
verification.recordVinciVerification("npm test", true, "18 tests passed", false, "behavioral", "npm test");
assert.match(await renderReceipt(), /✓ Done/);

const outcomes = branch.filter(
  (entry) => entry.type === "custom" && entry.customType === taskOutcome.VINCI_TASK_OUTCOME_ENTRY,
);
assert.equal(outcomes.at(-1).data.state, "DONE");
assert.equal(outcomes.at(-1).data.activeDurationMs, 0);
assert.equal(outcomes.at(-1).data.usage.estimatedCostUsd, 0.03);
assert.equal(taskOutcome.isVinciTaskOutcome(outcomes.at(-1).data), true);
const {
  supplementalUsage: _supplementalUsage,
  assistantUsage: _assistantUsage,
  assistantResponseKeys: _assistantResponseKeys,
  ...historicalSchemaV1Outcome
} = outcomes.at(-1).data;
assert.equal(
  taskOutcome.isVinciTaskOutcome(historicalSchemaV1Outcome),
  true,
  "historical schema-v1 receipts without accumulator data still validate",
);
assert.equal(
  taskOutcome.isVinciTaskOutcome({ ...outcomes.at(-1).data, usage: { ...outcomes.at(-1).data.usage, modelCalls: Number.NaN } }),
  false,
);

assert.equal(commands.usage.description.includes("local cost estimate"), true);
await commands.usage.handler("", context);
assert.match(notifications.at(-1).message, /State: Done/);
assert.match(notifications.at(-1).message, /Active time: 0s active/);
assert.match(notifications.at(-1).message, /Report wrong: vinci report-wrong task-receipt-test/);
assert.match(
  notifications.at(-1).message,
  /Account credits: https:\/\/platform\.getsimpledirect\.com\/billing\?source=code \(authoritative\)/,
);

// Supplemental usage can arrive after agent_end (autoname, crew shutdown). The refreshed full
// outcome must be appended durably, not only updated in the process-local store.
const outcomesBeforeLateUsage = branch.filter(
  (entry) => entry.type === "custom" && entry.customType === taskOutcome.VINCI_TASK_OUTCOME_ENTRY,
).length;
usageAccumulator.recordVinciTaskCall(
  "task-receipt-test",
  {
    role: "assistant",
    provider: "vinci",
    model: "vinci-forte",
    responseId: "late-after-agent-end",
    usage: usage(15, 3, 2, 0.004),
  },
  "autoname",
);
const outcomesAfterLateUsage = branch.filter(
  (entry) => entry.type === "custom" && entry.customType === taskOutcome.VINCI_TASK_OUTCOME_ENTRY,
);
assert.equal(outcomesAfterLateUsage.length, outcomesBeforeLateUsage + 1);
assert.equal(outcomesAfterLateUsage.at(-1).data.usage.modelCalls, 3);
assert.equal(taskOutcome.isVinciTaskOutcome(outcomesAfterLateUsage.at(-1).data), true);

const reportedOutcome = outcomesAfterLateUsage.at(-1).data;
branch.push({
  type: "custom",
  customType: taskOutcome.VINCI_FALSE_COMPLETION_ENTRY,
  data: {
    schemaVersion: 1,
    reportId: "report-1",
    taskId: reportedOutcome.taskId,
    outcomeRecordedAt: reportedOutcome.recordedAt,
    claimedState: "DONE",
    verificationStatus: reportedOutcome.verificationStatus,
    verificationCommand: reportedOutcome.verificationCommand,
    changedFiles: reportedOutcome.changedFiles,
    modelCalls: reportedOutcome.usage.modelCalls,
    providers: reportedOutcome.usage.providers,
    models: reportedOutcome.usage.models,
    estimatedCostUsd: reportedOutcome.usage.estimatedCostUsd,
    note: "The feature still fails in production.",
    reportedAt: "2026-07-12T00:01:00.000Z",
  },
});
await commands.usage.handler("", context);
assert.match(notifications.at(-1).message, /Reported wrong: yes/);

taskOutcome.setVinciTaskOutcome(undefined);
widget = undefined;
for (const handler of handlers.session_start ?? []) {
  await handler({ type: "session_start", reason: "resume" }, context);
}
assert.equal(taskOutcome.getVinciTaskOutcome()?.state, "DONE");
assert.equal(typeof widget, "function", "resume should restore the durable terminal receipt");
assert.match(widget({}, theme).render(140).join("\n"), /✓ Done/, "clean resume re-pins the DONE receipt as today");

// ── P2-9: resume beside an interrupted turn must not re-pin the PREVIOUS turn's "✓ Done" ──────
// A kill -9 mid-turn persists the assistant toolCall but never its durable result — the same
// dangling tail the checkpoint layer reports as "1 interrupted action needs inspection". The
// restored receipt is newer-outcome-stale and must not contradict that recovery note.
branch.push({
  type: "message",
  message: {
    role: "assistant",
    provider: "vinci",
    model: "vinci-fort",
    responseModel: "zai-org/GLM-5.2",
    responseId: "response-interrupted",
    stopReason: "toolUse",
    timestamp: 4,
    usage: usage(10, 2, 0, 0.001),
    content: [{ type: "toolCall", id: "edit-dangling", name: "edit", arguments: { path: "src/auth.ts" } }],
  },
});
taskOutcome.setVinciTaskOutcome(undefined);
widget = undefined;
for (const handler of handlers.session_start ?? []) {
  await handler({ type: "session_start", reason: "resume" }, context);
}
assert.equal(typeof widget, "function", "the receipt is still pinned, in downgraded form");
const downgraded = widget({}, theme).render(140).join("\n");
assert.doesNotMatch(downgraded, /✓ Done/, "an interrupted tail must not re-pin the previous turn's ✓ Done");
assert.match(downgraded, /Done — please check it/, "the downgrade uses the warning badge");
assert.match(downgraded, /interrupted — see recovery note/, "the downgrade points at the recovery note");
assert.equal(taskOutcome.getVinciTaskOutcome()?.state, "DONE", "the persisted outcome record itself is not rewritten");

// Once the dangling call has its durable result, there is no interrupted tail — resume restores
// the receipt exactly as before.
branch.push({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: "edit-dangling",
    toolName: "edit",
    content: [{ type: "text", text: "Applied changes" }],
    isError: false,
    timestamp: 5,
  },
});
taskOutcome.setVinciTaskOutcome(undefined);
widget = undefined;
for (const handler of handlers.session_start ?? []) {
  await handler({ type: "session_start", reason: "resume" }, context);
}
assert.match(widget({}, theme).render(140).join("\n"), /✓ Done/, "no dangling tail → the receipt restores as today");
console.log("  receipt: resume beside an interrupted turn downgrades the stale ✓ Done receipt");

const followUp = taskOutcome.buildVinciTaskOutcome({
  taskId: "task-receipt-test",
  messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Here is the answer." }] }],
  usageMessages: [
    ...messages,
    {
      role: "assistant",
      provider: "vinci",
      model: "vinci-fort",
      stopReason: "stop",
      content: [{ type: "text", text: "Here is the answer." }],
      usage: usage(25, 5, 25, 0.005),
    },
  ],
  changedFiles: [],
  verification: {
    ...emptyVerification,
  },
});
assert.equal(followUp.state, "DONE", "a read-only follow-up must not stale an earlier edit");
assert.equal(followUp.usage.modelCalls, 4, "task usage remains cumulative across follow-ups and late calls");

const blocked = taskOutcome.classifyVinciTaskState(
  [{ role: "assistant", stopReason: "error", errorMessage: "BLOCKED: budget", content: [] }],
  [],
  verification.getVinciVerificationState(),
);
assert.deepEqual(blocked, { state: "BLOCKED", reason: "BLOCKED: budget" });
const providerIdle = taskOutcome.classifyVinciTaskState(
  [{ role: "assistant", stopReason: "error", errorMessage: "Provider stream timed out after 120000ms without an event", content: [] }],
  [],
  verification.getVinciVerificationState(),
);
assert.deepEqual(providerIdle, {
  state: "BLOCKED",
  reason: "Vinci's provider stopped responding after repeated attempts. Continue to retry from where it paused.",
});
const waiting = taskOutcome.classifyVinciTaskState(
  [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "WAITING: choose the deployment region." }] }],
  [],
  { ...verification.getVinciVerificationState(), status: "none" },
);
assert.equal(waiting.state, "WAITING");

// A provider failure AFTER current verification passed on changed work is an interrupted wrap-up,
// not a blocked task (observed live: 21/21 tests green, then a stream stall produced bare BLOCKED).
const interruptedWrapUp = taskOutcome.classifyVinciTaskState(
  [{ role: "assistant", stopReason: "error", errorMessage: "Provider stream timed out after 120000ms without an event", content: [] }],
  ["csv2md.js", "test.js"],
  { ...verification.getVinciVerificationState(), status: "passed", summary: "node test.js: 21 passed." },
);
assert.equal(interruptedWrapUp.state, "DONE", "verified changed work interrupted at wrap-up stays DONE");
assert.ok(
  interruptedWrapUp.reason.includes("wrap-up was interrupted"),
  "the receipt says the wrap-up, not the work, was interrupted",
);
// Stale or missing verification keeps the honest BLOCKED on the same failure.
const interruptedUnverified = taskOutcome.classifyVinciTaskState(
  [{ role: "assistant", stopReason: "error", errorMessage: "Provider stream timed out after 120000ms without an event", content: [] }],
  ["csv2md.js"],
  { ...verification.getVinciVerificationState(), status: "stale", summary: "" },
);
assert.equal(interruptedUnverified.state, "BLOCKED", "unverified interrupted work still reports BLOCKED");

// A reduced session_start context must clear the previous binding. Otherwise a later model call
// can be silently persisted and accumulated against the task from the preceding session.
const sessionBindingHandlers = {};
const sessionBindingBranch = [];
const sessionBindingPi = {
  on(name, handler) {
    (sessionBindingHandlers[name] ??= []).push(handler);
  },
  appendEntry(customType, data) {
    sessionBindingBranch.push({ type: "custom", customType, data });
  },
};
usageAccumulator.installVinciUsageAccumulator(sessionBindingPi);
const validSessionTaskId = "task-with-valid-session";
usageAccumulator.resetVinciTaskUsage(validSessionTaskId);
for (const handler of sessionBindingHandlers.session_start ?? []) {
  await handler(
    { type: "session_start", reason: "startup" },
    {
      cwd: receiptCwd,
      hasUI: true,
      hasPendingMessages() {
        return false;
      },
      sessionManager: {
        getBranch() {
          return [...sessionBindingBranch];
        },
        getSessionId() {
          return validSessionTaskId;
        },
      },
      ui: context.ui,
    },
  );
}
assert.equal(
  usageAccumulator.recordVinciTaskCall(
    validSessionTaskId,
    {
      provider: "vinci",
      model: "vinci-forte",
      responseId: "valid-session-response",
      usage: usage(8, 2, 1, 0.01),
    },
    "test:valid-session",
  ),
  true,
);
const validSessionCallCount = usageAccumulator.getVinciTaskUsageSnapshot(validSessionTaskId).calls.length;
const validSessionEntryCount = sessionBindingBranch.length;
const missingSessionWarnings = [];
const warnBeforeMissingSession = console.warn;
console.warn = (message) => missingSessionWarnings.push(String(message));
try {
  await assert.doesNotReject(async () => {
    for (const handler of sessionBindingHandlers.session_start ?? []) {
      await handler(
        { type: "session_start", reason: "startup" },
        {
          cwd: receiptCwd,
          hasUI: true,
          hasPendingMessages() {
            return false;
          },
          ui: context.ui,
        },
      );
    }
  });
  assert.equal(globalThis.__vinciUsageAccumulatorStore?.activeTaskId, undefined);
  assert.equal(
    usageAccumulator.recordVinciTaskCall(
      "task-after-missing-session",
      {
        provider: "vinci",
        model: "vinci-forte",
        responseId: "missing-session-response",
        usage: usage(13, 3, 2, 0.02),
      },
      "test:missing-session",
    ),
    false,
    "usage recorded after an unbound session is dropped",
  );
  assert.equal(
    sessionBindingBranch.length,
    validSessionEntryCount,
    "unbound usage is not appended to the previous session stream",
  );
  assert.equal(
    usageAccumulator.getVinciTaskUsageSnapshot(validSessionTaskId).calls.length,
    validSessionCallCount,
    "unbound usage is not attributed to the previous task in memory",
  );
  assert.equal(
    missingSessionWarnings.some((warning) => /dropped.*active task is undefined/i.test(warning)),
    true,
    "dropping usage from an unbound session emits a warning",
  );
} finally {
  console.warn = warnBeforeMissingSession;
}
console.log("  receipt: a session without a manager clears the previous usage binding");

process.stdout.write("  receipt integration: terminal state and task usage stay grounded in runtime evidence\n");

// ── 2026-07-16 live: an honest mid-text "Blocked:" line becomes the receipt reason ────────────
// (the raw verification summary quoted the crashed runner — "Command exited with code 1" — instead
// of the actual environmental cause the model honestly reported.)
const envBlocked = taskOutcome.classifyVinciTaskState(
  [{
    role: "assistant",
    stopReason: "stop",
    content: [{
      type: "text",
      text: "The failure is the pytest runner crashing, not a test.\n\nBlocked: pytest is not installed on this machine, so the recorded verifier cannot run. The fix is in place but unverified.",
    }],
  }],
  ["expenses/tracker.py"],
  { ...verification.getVinciVerificationState(), status: "failed", summary: "Command exited with code 1" },
);
assert.equal(envBlocked.state, "BLOCKED");
assert.match(envBlocked.reason, /pytest is not installed/, "the receipt quotes the honest Blocked: line, not the crash");
console.log("  receipt: honest mid-text Blocked: line becomes the receipt reason");

// ── Issue #6: the receipt reflects surviving tree changes, not stale edit history ─────────────
const treeCwd = mkdtempSync(resolve(tmpdir(), "vinci-receipt-tree-"));
try {
  execFileSync("git", ["init", "-q"], { cwd: treeCwd });
  mkdirSync(resolve(treeCwd, "source"), { recursive: true });
  writeFileSync(resolve(treeCwd, "source/utilities.js"), "export const value = 1;\n");
  writeFileSync(resolve(treeCwd, "source/legacy.js"), "export const legacy = true;\n");
  execFileSync("git", ["add", "source/utilities.js", "source/legacy.js"], { cwd: treeCwd });
  execFileSync(
    "git",
    ["-c", "user.name=Vinci Test", "-c", "user.email=vinci@example.test", "commit", "-qm", "fixture"],
    { cwd: treeCwd },
  );

  const treeHandlers = {};
  const treeBranch = [];
  receipt.default({
    on(name, handler) {
      (treeHandlers[name] ??= []).push(handler);
    },
    appendEntry(customType, data) {
      treeBranch.push({ type: "custom", customType, data });
    },
    registerCommand() {},
  });
  const treeContext = {
    ...context,
    cwd: treeCwd,
    sessionManager: {
      getBranch() {
        return [...treeBranch];
      },
      getSessionId() {
        return "task-receipt-tree";
      },
    },
  };
  for (const handler of treeHandlers.agent_start ?? []) {
    await handler({ type: "agent_start" }, treeContext);
  }

  mkdirSync(resolve(treeCwd, "test"), { recursive: true });
  writeFileSync(resolve(treeCwd, "test/line-breaks.js"), "temporary\n");
  writeFileSync(resolve(treeCwd, "source/utilities.js"), "export const value = 2;\n");
  rmSync(resolve(treeCwd, "test/line-breaks.js"));
  rmSync(resolve(treeCwd, "source/legacy.js")); // delete a pre-existing TRACKED file — a genuine change
  const treeMessages = [
    {
      role: "assistant",
      provider: "vinci",
      model: "vinci-fort",
      stopReason: "toolUse",
      timestamp: 10,
      usage: usage(1, 1, 0, 0),
      content: [{
        type: "toolCall",
        id: "write-deleted",
        name: "write",
        arguments: { path: "test/line-breaks.js" },
      }],
    },
    {
      role: "toolResult",
      toolCallId: "write-deleted",
      toolName: "write",
      content: [{ type: "text", text: "Wrote test/line-breaks.js" }],
      isError: false,
      timestamp: 11,
    },
    {
      role: "assistant",
      provider: "vinci",
      model: "vinci-fort",
      stopReason: "stop",
      timestamp: 12,
      usage: usage(1, 1, 0, 0),
      content: [{ type: "text", text: "Done." }],
    },
  ];
  for (const handler of treeHandlers.agent_end ?? []) {
    await handler({ type: "agent_end", messages: treeMessages }, treeContext);
  }
  const treeOutcome = treeBranch.find(
    (entry) => entry.type === "custom" && entry.customType === taskOutcome.VINCI_TASK_OUTCOME_ENTRY,
  ).data;
  assert.deepEqual(
    treeOutcome.changedFiles.slice().sort(),
    ["legacy.js", "utilities.js"],
    "the receipt excludes a created-then-deleted file, includes the surviving modification AND a genuine tracked-file deletion",
  );
  console.log("  receipt: changed files reconcile against the surviving git tree (incl. a genuine deletion)");
} finally {
  rmSync(treeCwd, { recursive: true, force: true });
}

// ── Issues #34/#39: reconcile the complete turn delta without reporting shell artifacts ─────
const selectedChangedFilesRegression = process.env.VINCI_CHANGED_FILES_REGRESSION;
const runChangedFilesRegression = (name) => !selectedChangedFilesRegression || selectedChangedFilesRegression === name;

function initializeChangedFilesRepository(cwd, files, ignored = []) {
  execFileSync("git", ["init", "-q"], { cwd });
  if (ignored.length > 0) writeFileSync(resolve(cwd, ".gitignore"), `${ignored.join("\n")}\n`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(resolve(cwd, path)), { recursive: true });
    writeFileSync(resolve(cwd, path), content);
  }
  execFileSync("git", ["add", "."], { cwd });
  execFileSync(
    "git",
    ["-c", "user.name=Vinci Test", "-c", "user.email=vinci@example.test", "commit", "-qm", "fixture"],
    { cwd },
  );
}

function changedFilesMessages(toolCalls = []) {
  const assistant = {
    role: "assistant",
    provider: "vinci",
    model: "vinci-fort",
    stopReason: "toolUse",
    timestamp: 30,
    usage: usage(1, 1, 0, 0),
    content: toolCalls.map(({ id, name, arguments: toolArguments }) => ({
      type: "toolCall",
      id,
      name,
      arguments: toolArguments,
    })),
  };
  return [
    assistant,
    ...toolCalls.map(({ id, name }) => ({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: "Command completed" }],
      isError: false,
      timestamp: 31,
    })),
    {
      role: "assistant",
      provider: "vinci",
      model: "vinci-fort",
      stopReason: "stop",
      timestamp: 32,
      usage: usage(1, 1, 0, 0),
      content: [{ type: "text", text: "Done." }],
    },
  ];
}

async function changedFilesForTurn(cwd, taskId, mutate, turnMessages) {
  const turnHandlers = {};
  const turnBranch = [];
  receipt.default({
    on(name, handler) {
      (turnHandlers[name] ??= []).push(handler);
    },
    appendEntry(customType, data) {
      turnBranch.push({ type: "custom", customType, data });
    },
    registerCommand() {},
  });
  const turnContext = {
    ...context,
    cwd,
    sessionManager: {
      getBranch() {
        return [...turnBranch];
      },
      getSessionId() {
        return taskId;
      },
    },
  };
  for (const handler of turnHandlers.agent_start ?? []) {
    await handler({ type: "agent_start" }, turnContext);
  }
  mutate();
  for (const handler of turnHandlers.agent_end ?? []) {
    await handler({ type: "agent_end", messages: turnMessages }, turnContext);
  }
  return turnBranch.find(
    (entry) => entry.type === "custom" && entry.customType === taskOutcome.VINCI_TASK_OUTCOME_ENTRY,
  ).data.changedFiles;
}

if (runChangedFilesRegression("commit")) {
  const committedCwd = mkdtempSync(resolve(tmpdir(), "vinci-receipt-committed-"));
  try {
    initializeChangedFilesRepository(committedCwd, { "src/committed.ts": "export const value = 1;\n" });
    const committedFiles = await changedFilesForTurn(
      committedCwd,
      "task-receipt-committed",
      () => {
        writeFileSync(resolve(committedCwd, "src/committed.ts"), "export const value = 2;\n");
        execFileSync("git", ["add", "src/committed.ts"], { cwd: committedCwd });
        execFileSync(
          "git",
          ["-c", "user.name=Vinci Test", "-c", "user.email=vinci@example.test", "commit", "-qm", "agent change"],
          { cwd: committedCwd },
        );
      },
      changedFilesMessages([{
        id: "edit-committed",
        name: "edit",
        arguments: { path: "src/committed.ts" },
      }, {
        id: "bash-commit",
        name: "bash",
        arguments: { command: "git add src/committed.ts && git commit -qm 'agent change'" },
      }]),
    );
    assert.deepEqual(committedFiles, ["committed.ts"], "a file edited and committed during the turn remains in the receipt");
    console.log("  receipt: committed turn changes survive a clean post-commit working tree (#34)");
  } finally {
    rmSync(committedCwd, { recursive: true, force: true });
  }
}

if (runChangedFilesRegression("artifact")) {
  const artifactCwd = mkdtempSync(resolve(tmpdir(), "vinci-receipt-artifact-"));
  try {
    initializeChangedFilesRepository(artifactCwd, { "src/program.c": "int main(void) { return 0; }\n" });
    const artifactFiles = await changedFilesForTurn(
      artifactCwd,
      "task-receipt-artifact",
      () => {
        writeFileSync(resolve(artifactCwd, "src/program.c"), "int main(void) { return 1; }\n");
        writeFileSync(resolve(artifactCwd, "a.out"), "verification artifact\n");
      },
      changedFilesMessages([{
        id: "edit-program",
        name: "edit",
        arguments: { path: "src/program.c" },
      }, {
        id: "build-program",
        name: "bash",
        arguments: { command: "cc src/program.c -o a.out" },
      }]),
    );
    assert.deepEqual(
      artifactFiles,
      ["program.c"],
      "an untracked verification artifact is excluded while the deliberate source edit remains",
    );
    console.log("  receipt: untracked verification artifacts are excluded (#39)");
  } finally {
    rmSync(artifactCwd, { recursive: true, force: true });
  }
}

if (runChangedFilesRegression("ignored-tool-edit")) {
  const ignoredCwd = mkdtempSync(resolve(tmpdir(), "vinci-receipt-ignored-"));
  try {
    initializeChangedFilesRepository(ignoredCwd, {}, ["settings.local"]);
    writeFileSync(resolve(ignoredCwd, "settings.local"), "mode=before\n");
    const ignoredFiles = await changedFilesForTurn(
      ignoredCwd,
      "task-receipt-ignored",
      () => writeFileSync(resolve(ignoredCwd, "settings.local"), "mode=after\n"),
      changedFilesMessages([{
        id: "edit-ignored-settings",
        name: "edit",
        arguments: { path: "settings.local" },
      }]),
    );
    assert.deepEqual(ignoredFiles, ["settings.local"], "an explicit tool edit to a gitignored file remains visible");
    console.log("  receipt: explicit edits to gitignored files remain visible");
  } finally {
    rmSync(ignoredCwd, { recursive: true, force: true });
  }
}

if (runChangedFilesRegression("deletion")) {
  const deletionCwd = mkdtempSync(resolve(tmpdir(), "vinci-receipt-deletion-"));
  try {
    initializeChangedFilesRepository(deletionCwd, { "src/obsolete.ts": "export const obsolete = true;\n" });
    const deletionFiles = await changedFilesForTurn(
      deletionCwd,
      "task-receipt-deletion",
      () => rmSync(resolve(deletionCwd, "src/obsolete.ts")),
      changedFilesMessages([{
        id: "remove-obsolete",
        name: "bash",
        arguments: { command: "rm src/obsolete.ts" },
      }]),
    );
    assert.deepEqual(deletionFiles, ["obsolete.ts"], "a tracked file deleted during the turn remains visible");
    console.log("  receipt: tracked deletions remain visible");
  } finally {
    rmSync(deletionCwd, { recursive: true, force: true });
  }
}


if (runChangedFilesRegression("bash-created")) {
  const bashCreatedCwd = mkdtempSync(resolve(tmpdir(), "vinci-receipt-bash-created-"));
  try {
    initializeChangedFilesRepository(bashCreatedCwd, { "README.md": "# Project\n" });
    const bashCreatedFiles = await changedFilesForTurn(
      bashCreatedCwd,
      "task-receipt-bash-created",
      () => writeFileSync(resolve(bashCreatedCwd, "generated.config.json"), '{"key": "value"}\n'),
      changedFilesMessages([]),
    );
    assert.deepEqual(
      bashCreatedFiles,
      ["generated.config.json"],
      "a new file created via bash that the user asked for is included (#105)",
    );
    console.log("  receipt: new files created via bash are included (#105)");
  } finally {
    rmSync(bashCreatedCwd, { recursive: true, force: true });
  }
}

if (runChangedFilesRegression("pytest-artifact")) {
  const pytestCwd = mkdtempSync(resolve(tmpdir(), "vinci-receipt-pytest-"));
  try {
    // Don't use .gitignore for *.pyc — we want to test the actual code path that artifact exclusion takes
    initializeChangedFilesRepository(pytestCwd, { "test_example.py": "def test_pass():\n    pass\n" }, []);
    const pytestFiles = await changedFilesForTurn(
      pytestCwd,
      "task-receipt-pytest",
      () => {
        writeFileSync(resolve(pytestCwd, "test_example.py"), "def test_pass():\n    assert True\n");
        // Create the .pyc file that pytest would create (untracked, since we didn't gitignore it)
        mkdirSync(resolve(pytestCwd, "__pycache__"), { recursive: true });
        writeFileSync(resolve(pytestCwd, "__pycache__/test_example.cpython-314.pyc"), "compiled\n");
      },
      changedFilesMessages([{
        id: "edit-test",
        name: "edit",
        arguments: { path: "test_example.py" },
      }, {
        id: "run-pytest",
        name: "bash",
        arguments: { command: "python -m pytest test_example.py" },
      }]),
    );
    assert.deepEqual(
      pytestFiles,
      ["test_example.py"],
      "an untracked .pyc artifact from pytest is excluded while the deliberate source edit remains (#39)",
    );
    console.log("  receipt: untracked python .pyc artifacts are excluded (#39)");
  } finally {
    rmSync(pytestCwd, { recursive: true, force: true });
  }
}

// ── Issue #7: user-input dialog time is not active work ───────────────────────────────────────
const dialogHandlers = {};
const dialogBranch = [];
let now = 1_000;
const originalDateNow = Date.now;
Date.now = () => now;
try {
  receipt.default({
    on(name, handler) {
      (dialogHandlers[name] ??= []).push(handler);
    },
    appendEntry(customType, data) {
      dialogBranch.push({ type: "custom", customType, data });
    },
    registerCommand() {},
  });
  const dialogContext = {
    ...context,
    ui: {
      ...context.ui,
      async select() {
        now += 10 * 60_000;
        return "Allow";
      },
    },
    sessionManager: {
      getBranch() {
        return [...dialogBranch];
      },
      getSessionId() {
        return "task-receipt-dialog";
      },
    },
  };
  for (const handler of dialogHandlers.agent_start ?? []) {
    await handler({ type: "agent_start" }, dialogContext);
  }
  now += 2_000;
  await dialogContext.ui.select("Permission", ["Deny", "Allow"]);
  now += 3_000;
  for (const handler of dialogHandlers.agent_end ?? []) {
    await handler(
      {
        type: "agent_end",
        messages: [{
          role: "assistant",
          provider: "vinci",
          model: "vinci-fort",
          stopReason: "stop",
          timestamp: 20,
          usage: usage(1, 1, 0, 0),
          content: [{ type: "text", text: "Done." }],
        }],
      },
      dialogContext,
    );
  }
  const dialogOutcome = dialogBranch.find(
    (entry) => entry.type === "custom" && entry.customType === taskOutcome.VINCI_TASK_OUTCOME_ENTRY,
  ).data;
  assert.equal(dialogOutcome.activeDurationMs, 5_000, "ten minutes waiting on the dialog are excluded");
  console.log("  receipt: active time pauses while a user-input dialog is open");

  // #6 review BLOCK 1: a changed-file name is rendered into the receipt widget. A filename can carry
  // ANSI/control characters; they must be stripped so the receipt can't be corrupted or move the cursor.
  assert.equal(receipt.sanitizeFilename("utilities.js"), "utilities.js", "an ordinary name is unchanged");
  assert.equal(receipt.sanitizeFilename("café-münü.rs"), "café-münü.rs", "unicode is preserved");
  assert.equal(
    receipt.sanitizeFilename("a[31mred[0m.js"),
    "ared.js",
    "ANSI color sequences and a BEL are stripped from a filename",
  );
  assert.equal(
    receipt.sanitizeFilename("evil[2J[H.txt"),
    "evil.txt",
    "a clear-screen + cursor-home sequence embedded in a filename is neutralized",
  );
  assert.equal(receipt.sanitizeFilename("tab\tnewline\nx.js"), "tabnewlinex.js", "raw control chars are stripped");
  assert.equal(receipt.sanitizeFilename("del\x7fx.js"), "delx.js", "DEL (0x7f) is stripped");
  assert.equal(receipt.sanitizeFilename("c1\x9bx\x9c.js"), "c1x.js", "8-bit C1 controls (CSI 0x9b, ST 0x9c) are stripped");
  assert.equal(receipt.sanitizeFilename("osc\x1b]0;pwn\x07x.js"), "oscx.js", "an OSC title sequence in a filename is stripped whole");
  assert.equal(receipt.sanitizeFilename("bare\x1bx.js"), "barex.js", "a bare ESC not starting a sequence is stripped");
  console.log("  receipt: changed-file names are sanitized of ANSI/OSC/C1/DEL control characters");

  // #194: unresolved crew work floors a HEADLESS outcome — a one-shot run whose background agents
  // are still working, parked awaiting approval, or were stopped unfinished must never be stamped
  // as a clean completion (observed live: DONE "read-only", exit 0, three agents stopped later).
  {
    const crewStatus = await loader.import(resolve(here, "../extensions/lib/crew-status.ts"), { default: false });
    const hints = [];
    const headless = { ...context, hasUI: false, declareHeadlessExitHint: (code) => hints.push(code) };
    const lastOutcome = () =>
      branch.filter((e) => e.type === "custom" && e.customType === taskOutcome.VINCI_TASK_OUTCOME_ENTRY).at(-1).data;
    const drive = async (ctxToUse) => {
      for (const handler of handlers.agent_end ?? []) await handler({ type: "agent_end", messages }, ctxToUse);
      return lastOutcome();
    };

    verification.resetVinciVerificationState();
    crewStatus.setVinciCrewStatus({ active: 0, parkedWaiting: ["retry-fix"], stoppedUnfinished: [] });
    const parked = await drive(headless);
    assert.equal(parked.state, "WAITING", "#194 parked agent work floors the outcome to WAITING");
    assert.match(parked.reason, /awaiting approval/, "#194 the reason says the work awaits approval");
    assert.match(parked.reason, /retry-fix/, "#194 the reason names the parked agent");
    assert.ok(hints.includes(3), "#194 a floored outcome pins headless exit 3");

    crewStatus.setVinciCrewStatus({ active: 0, parkedWaiting: [], stoppedUnfinished: ["parser-fix"] });
    const stopped = await drive(headless);
    assert.equal(stopped.state, "BLOCKED", "#194 stopped-unfinished agents floor the outcome to BLOCKED");
    assert.match(stopped.reason, /stopped before finishing/, "#194 the reason says agents were stopped");
    assert.match(stopped.reason, /parser-fix/, "#194 the reason names the stopped agent");

    crewStatus.setVinciCrewStatus({ active: 2, parkedWaiting: [], stoppedUnfinished: [] });
    const active = await drive(headless);
    assert.equal(active.state, "WAITING", "#194 agents still working floor the outcome to WAITING");
    assert.match(active.reason, /2 agents still working/, "#194 the reason counts the working agents");

    crewStatus.setVinciCrewStatus({ active: 0, parkedWaiting: [], stoppedUnfinished: [] });
    const resolved = await drive(headless);
    assert.doesNotMatch(
      resolved.reason ?? "",
      /Delegated background work/,
      "#194 a fully resolved crew never floors the outcome",
    );

    crewStatus.setVinciCrewStatus({ active: 1, parkedWaiting: [], stoppedUnfinished: [] });
    const interactive = await drive(context);
    assert.doesNotMatch(
      interactive.reason ?? "",
      /Delegated background work/,
      "#194 interactive sessions keep the receipt as-is — the crew widget shows this state",
    );
    crewStatus.resetVinciCrewStatus();
    console.log("  receipt: #194 unresolved crew work floors headless outcomes (parked/stopped/active), never interactive");
  }

  // #199: an outcome may never claim "no changes" while the SESSION's tree delta says otherwise.
  // The per-turn baseline resets every agent_start, so a multi-turn run whose LAST turn was
  // read-only persisted "without project changes" over a tree earlier turns had changed.
  {
    const repo = mkdtempSync(resolve(tmpdir(), "vinci-199-"));
    try {
      const crewStatus199 = await loader.import(resolve(here, "../extensions/lib/crew-status.ts"), { default: false });
      crewStatus199.resetVinciCrewStatus();
      const repoGit = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      repoGit(["init", "-q"]);
      writeFileSync(resolve(repo, "parser.js"), "module.exports = 1;\n");
      repoGit(["add", "."]);
      repoGit(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "init"]);

      const sessionBranch = [];
      const sessionCtx = {
        ...context,
        hasUI: false,
        cwd: repo,
        sessionManager: {
          // pi.appendEntry writes into `branch` — include it so persisted entries (the #204
          // session baseline) are visible to the restore path, like a real session file.
          getBranch: () => [...sessionBranch, ...branch],
          getSessionId: () => "task-199",
        },
      };
      const finalTurnMessages = [
        { role: "user", content: [{ type: "text", text: "did you finish?" }], usage: usage(10, 2, 0, 0.001) },
        // Deliberately NOT ask-grammar: this fixture pins the pure veto downgrade; the closing-ask
        // WAITING path has its own case below.
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "The earlier work is summarized above." }], usage: usage(10, 2, 0, 0.001) },
      ];
      const driveTurn = async () => {
        for (const handler of handlers.agent_start ?? []) await handler({ type: "agent_start" }, sessionCtx);
        for (const handler of handlers.agent_end ?? []) await handler({ type: "agent_end", messages: finalTurnMessages }, sessionCtx);
        return branch.filter((e) => e.type === "custom" && e.customType === taskOutcome.VINCI_TASK_OUTCOME_ENTRY).at(-1).data;
      };

      // Session starts on a clean tree; an "earlier turn" edits a file; the FINAL turn is read-only.
      for (const handler of handlers.session_start ?? []) await handler({ type: "session_start" }, sessionCtx);
      writeFileSync(resolve(repo, "parser.js"), "module.exports = 2; // fixed\n");
      verification.resetVinciVerificationState();
      const corrected = await driveTurn();
      assert.deepEqual(corrected.changedFiles, ["parser.js"], "#199 the session tree delta vetoes the empty claim");
      assert.equal(corrected.state, "DONE_UNVERIFIED", "#199 an unverified DONE over a dirty tree is downgraded");
      assert.match(corrected.reason, /changed after this session began/i, "#199 the reason says where the changes came from");

      // Clean tree control: nothing to veto, the read-only claim stands untouched.
      repoGit(["checkout", "--", "parser.js"]);
      for (const handler of handlers.session_start ?? []) await handler({ type: "session_start" }, sessionCtx);
      verification.resetVinciVerificationState();
      const clean = await driveTurn();
      assert.deepEqual(clean.changedFiles, [], "#199 a genuinely clean session keeps its empty changedFiles");
      assert.equal(clean.state, "DONE", "#199 a clean session's DONE is untouched");
      assert.notEqual(clean.reason, corrected.reason, "#199 no correction reason on a clean session");

      // Committed-mid-session work is git-clean by the final turn, but "without project changes"
      // is still false: the session branch's tool history carries the edit into the veto.
      for (const handler of handlers.session_start ?? []) await handler({ type: "session_start" }, sessionCtx);
      writeFileSync(resolve(repo, "parser.js"), "module.exports = 3; // committed fix\n");
      sessionBranch.push(
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            timestamp: 10,
            usage: usage(10, 2, 0, 0.001),
            content: [{ type: "toolCall", id: "edit-199", name: "edit", arguments: { path: resolve(repo, "parser.js") } }],
          },
        },
        {
          type: "message",
          message: { role: "toolResult", toolCallId: "edit-199", toolName: "edit", content: [{ type: "text", text: "Applied changes" }], isError: false, timestamp: 11 },
        },
      );
      repoGit(["add", "."]);
      repoGit(["-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "mid-session fix"]);
      verification.resetVinciVerificationState();
      const committed = await driveTurn();
      assert.deepEqual(committed.changedFiles, ["parser.js"], "#199 a committed mid-session edit still vetoes the empty claim");

      // [#204] The baseline survives a resume. Run 1 starts clean, bash-style dirt appears (no
      // tool history), and the final read-only turn corrects. A --continue over the SAME dirty
      // tree must keep correcting — re-capturing at resume baselined the dirt away and
      // re-persisted the exact "without project changes" claim (the live repro on #203's review).
      sessionBranch.length = 0;
      for (const handler of handlers.session_start ?? []) await handler({ type: "session_start", reason: "startup" }, sessionCtx);
      writeFileSync(resolve(repo, "parser.js"), "module.exports = 4; // bash-made\n");
      verification.resetVinciVerificationState();
      const run1 = await driveTurn();
      assert.deepEqual(run1.changedFiles, ["parser.js"], "#204 run 1 corrects over the dirty tree");
      // The REAL --continue shape: a process-level resume emits reason "startup", not "resume"
      // (found by review — the first fix keyed on the reason and never fired for the actual
      // repro). Restore is keyed on entry PRESENCE, so this must restore and keep correcting.
      for (const handler of handlers.session_start ?? []) await handler({ type: "session_start", reason: "startup" }, sessionCtx);
      verification.resetVinciVerificationState();
      const resumed = await driveTurn();
      assert.deepEqual(resumed.changedFiles, ["parser.js"], "#204 a --continue (reason startup) keeps correcting — the baseline survived the instance");
      assert.equal(resumed.state, "DONE_UNVERIFIED", "#204 the resumed claim still downgrades honestly");
      assert.equal(
        branch.filter((e) => e.type === "custom" && e.customType === "vinci-session-baseline").length,
        1,
        "#204 the baseline persists exactly once per session — later starts must never append newer, wronger entries",
      );

      // [#199 closing-ask] The live shape: work sits corrected-but-unverified and the final reply
      // holds for the user's go-ahead — that is WAITING (exit 3), not a clean exit over held work.
      const askMessages = [
        { role: "user", content: [{ type: "text", text: "finish it" }], usage: usage(10, 2, 0, 0.001) },
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "The fix is ready. Just confirm and I'll apply it to finish the cleanup." }],
          usage: usage(10, 2, 0, 0.001),
        },
      ];
      const askHints = [];
      const askCtx = { ...sessionCtx, declareHeadlessExitHint: (code) => askHints.push(code) };
      for (const handler of handlers.agent_start ?? []) await handler({ type: "agent_start" }, askCtx);
      for (const handler of handlers.agent_end ?? []) await handler({ type: "agent_end", messages: askMessages }, askCtx);
      const askOutcome = branch.filter((e) => e.type === "custom" && e.customType === taskOutcome.VINCI_TASK_OUTCOME_ENTRY).at(-1).data;
      assert.equal(askOutcome.state, "WAITING", "#199 a closing ask over held unverified work classifies WAITING");
      assert.match(askOutcome.reason, /asks for your go-ahead/, "#199 the reason says the run is holding for the user");
      // [#215 review] The receipt lists files the session changed earlier, so the reason must not
      // claim nothing changed — that contradiction is the exact class #203 exists to remove.
      assert.doesNotMatch(askOutcome.reason, /nothing was changed/i, "#215 a WAITING reason never contradicts its own file list");
      if (askOutcome.changedFiles.length > 0) {
        assert.match(
          askOutcome.reason,
          /Files changed after this session began/i,
          "#215 a vetoed WAITING record explains the files it lists",
        );
      }
      assert.ok(askHints.includes(3), "#199 the closing ask pins headless exit 3");
      console.log("  receipt: #199 session delta vetoes + #204 the baseline survives resume; committed work counts; clean sessions untouched");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
} finally {
  Date.now = originalDateNow;
  rmSync(receiptCwd, { recursive: true, force: true });
}
