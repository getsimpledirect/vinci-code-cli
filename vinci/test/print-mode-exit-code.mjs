// A provider failure must be reported to scripted callers as a NON-ZERO exit, in BOTH output modes.
//
// The exit-code decision used to live entirely inside `if (mode === "text")`, so `--mode json` — the
// mode scripted callers are most likely to use — returned 0 when the provider errored. That is the
// exact bug the text-mode comment was written against ("scripted callers must not read exit 0 as
// success", observed live 2026-07-16); the fix was applied to one mode only.
//
// Observed for real on 2026-07-28: a provider outage returned 500s, and corpus runs driving
// `vinci --mode json -p` recorded exit 0 on runs that did nothing.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const printMode = await loader.import(resolve(here, "../../packages/coding-agent/src/modes/print-mode.ts"), {
  default: false,
});
const corpus = await import("./ec2/run-repo-corpus.mjs");

const failures = [];
const check = (name, condition) => {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name}`);
    failures.push(name);
  }
};

// The decision under test, extracted so both modes can be driven without a live provider.
const decide = printMode.printModeExitCode;
check("print-mode exports its exit-code decision for testing", typeof decide === "function");

if (typeof decide === "function") {
  const errored = { role: "assistant", stopReason: "error", errorMessage: "500 Internal Server Error", content: [] };
  const aborted = { role: "assistant", stopReason: "aborted", errorMessage: "", content: [] };
  const ok = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };

  for (const mode of ["text", "json"]) {
    check(
      `${mode}: a provider error exits non-zero`,
      decide({ mode, lastMessage: errored, submitted: ["fix the bug"] }).exitCode === 1,
    );
    check(
      `${mode}: an aborted run exits non-zero`,
      decide({ mode, lastMessage: aborted, submitted: ["fix the bug"] }).exitCode === 1,
    );
    check(
      `${mode}: a run with no final assistant message exits non-zero`,
      decide({ mode, lastMessage: undefined, submitted: ["fix the bug"] }).exitCode === 1,
    );
    check(`${mode}: a successful run exits zero`, decide({ mode, lastMessage: ok, submitted: ["fix the bug"] }).exitCode === 0);
    check(
      `${mode}: a successful transport with headless exit hint 3 exits 3`,
      decide({ mode, lastMessage: ok, submitted: ["fix the bug"], headlessExitHint: 3 }).exitCode === 3,
    );
    check(
      `${mode}: a provider error wins over headless exit hint 3`,
      decide({ mode, lastMessage: errored, submitted: ["fix the bug"], headlessExitHint: 3 }).exitCode === 1,
    );
    check(
      `${mode}: an empty prompt exits 2, not 1`,
      decide({ mode, lastMessage: undefined, submitted: [""] }).exitCode === 2,
    );
    check(
      `${mode}: an empty prompt wins over headless exit hint 3`,
      decide({ mode, lastMessage: undefined, submitted: [""], headlessExitHint: 3 }).exitCode === 2,
    );
    check(
      `${mode}: a slash command that prints its own result is not a failure`,
      decide({ mode, lastMessage: undefined, submitted: ["/undo"] }).exitCode === 0,
    );
  }

  // Only the TEXT path writes the assistant answer to stdout; json already streamed it as events.
  check(
    "text mode emits the assistant answer, json mode does not",
    decide({ mode: "text", lastMessage: ok, submitted: ["x"] }).emitText === true &&
      decide({ mode: "json", lastMessage: ok, submitted: ["x"] }).emitText === false,
  );
}

if (typeof printMode.runPrintMode === "function") {
  const messages = [];
  const session = {
    state: { messages },
    agent: { waitForIdle: async () => {} },
    sessionManager: { getHeader: () => undefined },
    extensionRunner: { getHeadlessExitHint: () => 3 },
    bindExtensions: async () => {},
    subscribe: () => () => {},
    prompt: async () => {
      messages.push({ role: "assistant", stopReason: "stop", content: [] });
    },
  };
  const runtime = {
    session,
    setRebindSession() {},
    dispose: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
  };
  check(
    "runPrintMode consumes the runtime headless exit hint",
    await printMode.runPrintMode(runtime, { mode: "json", initialMessage: "fix the bug" }) === 3,
  );

  // #194: before deciding the exit code, one-shot runs emit session_before_exit so extensions can
  // settle background work (crew agents). The loop stops once a pass adds no new messages.
  const beforeExitEvents = [];
  const settleMessages = [];
  const settleSession = {
    state: { messages: settleMessages },
    agent: { waitForIdle: async () => {} },
    sessionManager: { getHeader: () => undefined },
    extensionRunner: {
      getHeadlessExitHint: () => undefined,
      hasHandlers: (name) => name === "session_before_exit",
      emit: async (event) => {
        beforeExitEvents.push(event);
        // First pass: background work "finishes" and delivers one follow-up message.
        if (beforeExitEvents.length === 1) {
          settleMessages.push({ role: "assistant", stopReason: "stop", content: [] });
        }
      },
    },
    bindExtensions: async () => {},
    subscribe: () => () => {},
    prompt: async () => {
      settleMessages.push({ role: "assistant", stopReason: "stop", content: [] });
    },
  };
  const settleRuntime = {
    session: settleSession,
    setRebindSession() {},
    dispose: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
  };
  const settleExit = await printMode.runPrintMode(settleRuntime, { mode: "json", initialMessage: "fix the bug" });
  check("#194 runPrintMode emits session_before_exit before deciding the exit code", beforeExitEvents.length >= 1);
  check(
    "#194 the before-exit loop re-checks after a pass that delivered messages, then stops",
    beforeExitEvents.length === 2 && beforeExitEvents.every((e) => e.type === "session_before_exit"),
  );
  check("#194 a settled run still exits cleanly", settleExit === 0);
}

check(
  "corpus exports its process exit classifier",
  typeof corpus.classifyCorpusProcessExit === "function",
);
if (typeof corpus.classifyCorpusProcessExit === "function") {
  check(
    "corpus classifies exit 3 as completed with a non-final outcome",
    corpus.classifyCorpusProcessExit(3, null).classification === "completed_non_final" &&
      corpus.classifyCorpusProcessExit(3, null).transportFailure === false,
  );
  check(
    "corpus preserves exit 1 as a transport failure",
    corpus.classifyCorpusProcessExit(1, null).classification === "transport_failure" &&
      corpus.classifyCorpusProcessExit(1, null).transportFailure === true,
  );
}

if (failures.length) {
  console.error(`print-mode exit code: ${failures.length} failed`);
  process.exit(1);
}
console.log("  print-mode exit code: provider failures are non-zero in both modes");
