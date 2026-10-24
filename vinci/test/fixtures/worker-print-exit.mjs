#!/usr/bin/env node
// Offline launcher: use the real print-mode and session writer at the worker process boundary.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

if (process.argv[2] === "--version") {
  process.stdout.write("0.0.0-fake\n");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const loader = createJiti(import.meta.url, {
  moduleCache: false, fsCache: false, tryNative: false,
  alias: {
    "@earendil-works/pi-ai/compat": join(root, "packages/ai/src/compat.ts"),
    "@earendil-works/pi-ai": join(root, "packages/ai/src/index.ts"),
    "@earendil-works/pi-agent-core": join(root, "packages/agent/src/index.ts"),
    "@earendil-works/pi-tui": join(root, "packages/tui/src/index.ts"),
  },
});
const { runPrintMode } = await loader.import(join(root, "packages/coding-agent/src/modes/print-mode.ts"), { default: false });
const { SessionManager } = await loader.import(join(root, "packages/coding-agent/src/core/session-manager.ts"), { default: false });
const sessionDir = process.argv[process.argv.indexOf("--session-dir") + 1];
const sessionId = process.argv[process.argv.indexOf("--session-id") + 1];
appendFileSync(process.env.FAKE_VINCI_RECORD, `${JSON.stringify({ argv: process.argv.slice(2), pid: process.pid })}\n`);

writeFileSync("VINCI_WORK_DONE", "offline print-mode work\n");
for (const args of [
  ["config", "user.email", "test@example.com"],
  ["config", "user.name", "Test User"],
  ["add", "VINCI_WORK_DONE"],
  ["commit", "-qm", "fixture: complete offline work"],
]) execFileSync("git", args, { stdio: "pipe" });

const manager = SessionManager.create(process.cwd(), sessionDir, { id: sessionId });
const message = {
  role: "assistant",
  api: "openai-completions",
  provider: "fixture",
  model: "offline-print",
  content: [],
  stopReason: process.env.FAKE_PRINT_STOP_REASON ?? "stop",
  errorMessage: "offline provider failure",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  timestamp: Date.now(),
};
const messages = [];
let activeMessage = message;
const runtime = {
  session: {
    sessionManager: manager,
    state: { messages },
    agent: { waitForIdle: async () => {} },
    extensionRunner: { getHeadlessExitHint: () => Number(process.env.FAKE_PRINT_EXIT_HINT ?? 1) || undefined },
    bindExtensions: async () => {},
    subscribe: () => () => {},
    prompt: async () => {
      if (messages.length === 0 && process.env.FAKE_PRINT_NO_STOP !== "1") {
        const captured = readFileSync(join(root, "vinci/test/fixtures/worker-session-harness-stop.jsonl"), "utf8")
          .split("\n").filter(Boolean).map((line) => JSON.parse(line));
        for (const entry of captured) {
          if (entry.type === "message" && entry.message.role === "toolResult") manager.appendMessage(entry.message);
        }
      }
      manager.appendMessage(activeMessage);
      messages.push(activeMessage);
      manager.appendCustomEntry("vinci-task-outcome", {
        schemaVersion: 1,
        taskId: sessionId,
        state: "DONE",
        reason: "offline print-mode fixture",
        usage: { estimatedCostUsd: Number(process.env.FAKE_PRINT_COST_USD ?? 0) },
      });
      if (process.env.FAKE_PRINT_THROW === "1") throw new Error("offline runtime crash; inspect the fixture failure path");
    },
  },
  setRebindSession() {},
  dispose: async () => {
    if (process.env.FAKE_PRINT_DISPOSE_ERROR === "1") throw new Error("offline disposal crash; inspect the fixture failure path");
  },
};
process.env.VINCI_CODE = "1";
let exitCode = await runPrintMode(runtime, { mode: "json", initialMessage: "offline task" });
if (process.env.FAKE_PRINT_LATER_ERROR === "1" || process.env.FAKE_PRINT_LATER_HINT === "1") {
  activeMessage = { ...message, stopReason: process.env.FAKE_PRINT_LATER_ERROR === "1" ? "error" : "stop", timestamp: message.timestamp + 1 };
  exitCode = await runPrintMode(runtime, { mode: "json", initialMessage: "continue offline task" });
}
process.exitCode = exitCode;
