import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const checkpoint = await loader.import(resolve(here, "../extensions/vinci-checkpoint.ts"), { default: false });
const taskOutcome = await loader.import(resolve(here, "../extensions/lib/task-outcome.ts"), { default: false });

function assistantToolCall(toolCallId, toolName, input) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: input }],
    },
  };
}

function toolResult(toolCallId, toolName, isError = false) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: isError ? "failed" : "completed" }],
      isError,
    },
  };
}

function runtime(branch, cwd) {
  const handlers = {};
  const commands = {};
  const notifications = [];
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
  };
  checkpoint.default(pi);
  const context = {
    cwd,
    hasUI: true,
    sessionManager: {
      getBranch() {
        return [...branch];
      },
      getSessionId() {
        return "task-checkpoint-test";
      },
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };
  return { handlers, commands, notifications, context };
}

async function emit(state, name, event) {
  let result;
  for (const handler of state.handlers[name] ?? []) {
    const next = await handler(event, state.context);
    if (next !== undefined) result = next;
  }
  return result;
}

async function start(state, reason = "startup") {
  await emit(state, "session_start", { type: "session_start", reason });
}

function checkpointEntries(branch, event) {
  return branch.filter(
    (entry) => entry.type === "custom" && entry.customType === "vinci-tool-checkpoint" && entry.data.event === event,
  );
}

const cwd = mkdtempSync(join(tmpdir(), "vinci-checkpoint-"));
try {
  assert.equal(
    checkpoint.mutationFingerprint("write", { content: "ok", path: "a.txt" }),
    checkpoint.mutationFingerprint("write", { path: "a.txt", content: "ok" }),
    "fingerprints must not depend on object key order",
  );

  const writeInput = { path: "applied.txt", content: "landed exactly\n" };
  const writeBranch = [assistantToolCall("write-1", "write", writeInput)];
  const beforeCrash = runtime(writeBranch, cwd);
  await start(beforeCrash);
  assert.equal(
    await emit(beforeCrash, "tool_call", {
      type: "tool_call",
      toolCallId: "write-1",
      toolName: "write",
      input: writeInput,
    }),
    undefined,
  );
  writeFileSync(join(cwd, "applied.txt"), writeInput.content);
  assert.equal(checkpointEntries(writeBranch, "started").length, 1);

  const resumedWrite = runtime(writeBranch, cwd);
  await start(resumedWrite, "resume");
  assert.equal(checkpointEntries(writeBranch, "recovered").length, 1);
  assert.match(resumedWrite.notifications[0].message, /1 completed change recovered/);
  const resumePrompt = await emit(resumedWrite, "before_agent_start", {
    type: "before_agent_start",
    systemPrompt: "base",
  });
  assert.match(resumePrompt.systemPrompt, /Task ID: task-checkpoint-test/);
  assert.match(resumePrompt.systemPrompt, /Do not repeat these exact actions/);
  const duplicateWrite = await emit(resumedWrite, "tool_call", {
    type: "tool_call",
    toolCallId: "write-2",
    toolName: "write",
    input: writeInput,
  });
  assert.equal(duplicateWrite.block, true);
  assert.match(duplicateWrite.reason, /already completed/);
  assert.equal(readFileSync(join(cwd, "applied.txt"), "utf8"), writeInput.content);

  await resumedWrite.commands["task-info"].handler("", resumedWrite.context);
  assert.match(resumedWrite.notifications.at(-1).message, /Task: task-checkpoint-test/);
  assert.match(resumedWrite.notifications.at(-1).message, /Resume: vinci resume task-checkpoint-test/);
  taskOutcome.setVinciTaskOutcome(
    taskOutcome.buildVinciTaskOutcome({
      taskId: "task-checkpoint-test",
      messages: [
        {
          role: "assistant",
          provider: "vinci",
          model: "vinci-fort",
          stopReason: "stop",
          content: [{ type: "text", text: "Done." }],
          usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, cost: { total: 0.01 } },
        },
      ],
      changedFiles: ["src/app.ts"],
      verification: {
        status: "passed",
        command: "npm run check",
        summary: "12 tests passed",
        mutationRevision: 1,
        verifiedRevision: 1,
        recoveryAttempts: 0,
      },
      activeDurationMs: 72_000,
      now: new Date("2026-07-12T00:00:00.000Z"),
    }),
  );
  await resumedWrite.commands["task-info"].handler("", resumedWrite.context);
  assert.match(resumedWrite.notifications.at(-1).message, /State: Done/);
  assert.match(resumedWrite.notifications.at(-1).message, /Usage: 1 model call/);
  assert.match(resumedWrite.notifications.at(-1).message, /Active time: 1m 12s active/);
  assert.match(resumedWrite.notifications.at(-1).message, /Report wrong: vinci report-wrong task-checkpoint-test/);
  taskOutcome.setVinciTaskOutcome(undefined);

  const recoveredCount = checkpointEntries(writeBranch, "recovered").length;
  const resumedAgain = runtime(writeBranch, cwd);
  await start(resumedAgain, "resume");
  assert.equal(checkpointEntries(writeBranch, "recovered").length, recoveredCount, "recovery records are idempotent");

  const pendingInput = { path: "not-yet-written.txt", content: "eventual content\n" };
  const pendingBranch = [assistantToolCall("write-pending", "write", pendingInput)];
  const pendingBeforeCrash = runtime(pendingBranch, cwd);
  await start(pendingBeforeCrash);
  await emit(pendingBeforeCrash, "tool_call", {
    type: "tool_call",
    toolCallId: "write-pending",
    toolName: "write",
    input: pendingInput,
  });
  const resumedPending = runtime(pendingBranch, cwd);
  await start(resumedPending, "resume");
  assert.equal(checkpointEntries(pendingBranch, "uncertain").length, 1);
  const blindRetry = await emit(resumedPending, "tool_call", {
    type: "tool_call",
    toolCallId: "write-pending-retry",
    toolName: "write",
    input: pendingInput,
  });
  assert.equal(blindRetry.block, true);
  assert.match(blindRetry.reason, /Read the current target file/);
  await emit(resumedPending, "tool_result", {
    type: "tool_result",
    toolCallId: "read-pending",
    toolName: "read",
    input: { path: pendingInput.path },
    content: [{ type: "text", text: "File does not exist" }],
    details: {},
    isError: false,
  });
  assert.equal(
    await emit(resumedPending, "tool_call", {
      type: "tool_call",
      toolCallId: "write-pending-retry-2",
      toolName: "write",
      input: pendingInput,
    }),
    undefined,
    "a structured mutation may retry only after inspecting its target",
  );

  writeFileSync(join(cwd, "edited.txt"), 'const releaseChannel = "beta-rollout-2026";\n');
  const editInput = {
    path: "edited.txt",
    edits: [
      { oldText: 'const releaseChannel = "alpha-rollout-2026";', newText: 'const releaseChannel = "beta-rollout-2026";' },
    ],
  };
  assert.equal(checkpoint.mutationPostcondition(cwd, "edit", editInput), true);
  const editBranch = [assistantToolCall("edit-1", "edit", editInput)];
  const editBeforeCrash = runtime(editBranch, cwd);
  await start(editBeforeCrash);
  await emit(editBeforeCrash, "tool_call", {
    type: "tool_call",
    toolCallId: "edit-1",
    toolName: "edit",
    input: editInput,
  });
  const resumedEdit = runtime(editBranch, cwd);
  await start(resumedEdit, "resume");
  assert.equal(checkpointEntries(editBranch, "recovered").length, 1, "a distinctive applied edit is still recovered");
  assert.match(resumedEdit.notifications[0].message, /1 completed change recovered/);
  const duplicateEdit = await emit(resumedEdit, "tool_call", {
    type: "tool_call",
    toolCallId: "edit-2",
    toolName: "edit",
    input: editInput,
  });
  assert.equal(duplicateEdit.block, true);
  assert.match(duplicateEdit.reason, /already completed/);

  // A never-applied edit must not be classified as recovered: its oldText never existed in the
  // file (the interrupted call would have errored) and its short generic newText matches
  // unrelated content that was already there.
  writeFileSync(
    join(cwd, "config.json"),
    '{\n  "featureFlags": {\n    "beta": false\n  },\n  "enabled": false\n}\n',
  );
  const staleEditInput = {
    path: "config.json",
    edits: [{ oldText: '"telemetry": true', newText: '"enabled": false' }],
  };
  assert.equal(checkpoint.mutationPostcondition(cwd, "edit", staleEditInput), false);
  const staleBranch = [assistantToolCall("edit-stale", "edit", staleEditInput)];
  const staleBeforeCrash = runtime(staleBranch, cwd);
  await start(staleBeforeCrash);
  await emit(staleBeforeCrash, "tool_call", {
    type: "tool_call",
    toolCallId: "edit-stale",
    toolName: "edit",
    input: staleEditInput,
  });
  const resumedStale = runtime(staleBranch, cwd);
  await start(resumedStale, "resume");
  assert.equal(checkpointEntries(staleBranch, "recovered").length, 0, "a never-applied edit is not recovered");
  assert.equal(checkpointEntries(staleBranch, "uncertain").length, 1, "a never-applied edit needs inspection");
  assert.doesNotMatch(resumedStale.notifications[0].message, /completed change/);
  assert.match(resumedStale.notifications[0].message, /1 interrupted action needs inspection/);
  const staleRetry = await emit(resumedStale, "tool_call", {
    type: "tool_call",
    toolCallId: "edit-stale-retry",
    toolName: "edit",
    input: staleEditInput,
  });
  assert.equal(staleRetry.block, true);
  assert.match(staleRetry.reason, /Read the current target file/);
  await emit(resumedStale, "tool_result", {
    type: "tool_result",
    toolCallId: "read-stale",
    toolName: "read",
    input: { path: staleEditInput.path },
    content: [{ type: "text", text: "current config" }],
    details: {},
    isError: false,
  });
  assert.equal(
    await emit(resumedStale, "tool_call", {
      type: "tool_call",
      toolCallId: "edit-stale-retry-2",
      toolName: "edit",
      input: staleEditInput,
    }),
    undefined,
    "the repair of a never-applied edit is unblocked after inspecting the target",
  );

  // With one genuine recovery and one stale edit interrupted in the same session, the banner
  // counts only the genuine recovery as completed.
  writeFileSync(join(cwd, "mixed.txt"), 'export const mixedFeatureGate = "enabled-after-crash";\n');
  const mixedAppliedInput = {
    path: "mixed.txt",
    edits: [
      { oldText: 'export const mixedFeatureGate = "disabled-before-crash";', newText: 'export const mixedFeatureGate = "enabled-after-crash";' },
    ],
  };
  const mixedBranch = [
    assistantToolCall("edit-mixed-applied", "edit", mixedAppliedInput),
    assistantToolCall("edit-mixed-stale", "edit", staleEditInput),
  ];
  const mixedBeforeCrash = runtime(mixedBranch, cwd);
  await start(mixedBeforeCrash);
  await emit(mixedBeforeCrash, "tool_call", {
    type: "tool_call",
    toolCallId: "edit-mixed-applied",
    toolName: "edit",
    input: mixedAppliedInput,
  });
  await emit(mixedBeforeCrash, "tool_call", {
    type: "tool_call",
    toolCallId: "edit-mixed-stale",
    toolName: "edit",
    input: staleEditInput,
  });
  const resumedMixed = runtime(mixedBranch, cwd);
  await start(resumedMixed, "resume");
  assert.match(
    resumedMixed.notifications[0].message,
    /1 completed change recovered; 1 interrupted action needs inspection/,
    "the recovered count reflects only genuine recoveries",
  );

  const bashInput = { command: "git commit -m checkpoint" };
  const bashBranch = [assistantToolCall("bash-1", "bash", bashInput)];
  const bashBeforeCrash = runtime(bashBranch, cwd);
  await start(bashBeforeCrash);
  await emit(bashBeforeCrash, "tool_call", {
    type: "tool_call",
    toolCallId: "bash-1",
    toolName: "bash",
    input: bashInput,
  });
  const resumedBash = runtime(bashBranch, cwd);
  await start(resumedBash, "resume");
  const replayedBash = await emit(resumedBash, "tool_call", {
    type: "tool_call",
    toolCallId: "bash-2",
    toolName: "bash",
    input: bashInput,
  });
  assert.equal(replayedBash.block, true);
  assert.match(replayedBash.reason, /may already have external side effects/);

  const completedBashBranch = [assistantToolCall("bash-complete", "bash", { command: "npm run check" })];
  const completedBash = runtime(completedBashBranch, cwd);
  await start(completedBash);
  await emit(completedBash, "tool_call", {
    type: "tool_call",
    toolCallId: "bash-complete",
    toolName: "bash",
    input: { command: "npm run check" },
  });
  const fakeAnthropicToken = "sk-ant-api03-" + "secret".repeat(4);
  await emit(completedBash, "tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "bash-complete",
    toolName: "bash",
    result: { content: [{ type: "text", text: `passed with token ${fakeAnthropicToken}` }] },
    isError: false,
  });
  const completedRecord = checkpointEntries(completedBashBranch, "completed")[0].data;
  assert.doesNotMatch(completedRecord.resultSummary, /sk-ant-api03-secret/);
  const resumedCompletedBash = runtime(completedBashBranch, cwd);
  await start(resumedCompletedBash, "resume");
  assert.equal(checkpointEntries(completedBashBranch, "recovered").length, 1);
  const repeatedCompletedBash = await emit(resumedCompletedBash, "tool_call", {
    type: "tool_call",
    toolCallId: "bash-complete-2",
    toolName: "bash",
    input: { command: "npm run check" },
  });
  assert.equal(repeatedCompletedBash.block, true);

  const normalInput = { path: "normal.txt", content: "normal\n" };
  const normalBranch = [assistantToolCall("write-normal", "write", normalInput)];
  const normal = runtime(normalBranch, cwd);
  await start(normal);
  await emit(normal, "tool_call", {
    type: "tool_call",
    toolCallId: "write-normal",
    toolName: "write",
    input: normalInput,
  });
  writeFileSync(join(cwd, normalInput.path), normalInput.content);
  await emit(normal, "tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "write-normal",
    toolName: "write",
    result: { content: [{ type: "text", text: "Successfully wrote file" }] },
    isError: false,
  });
  normalBranch.push(toolResult("write-normal", "write"));
  const resumedNormal = runtime(normalBranch, cwd);
  await start(resumedNormal, "resume");
  assert.equal(resumedNormal.notifications.length, 0, "a persisted tool result needs no recovery warning");

  const noStartInput = { path: "never-started.txt", content: "new\n" };
  const noStartBranch = [assistantToolCall("write-never-started", "write", noStartInput)];
  const resumedNoStart = runtime(noStartBranch, cwd);
  await start(resumedNoStart, "resume");
  assert.equal(
    await emit(resumedNoStart, "tool_call", {
      type: "tool_call",
      toolCallId: "write-never-started-retry",
      toolName: "write",
      input: noStartInput,
    }),
    undefined,
    "a call with no durable started checkpoint never reached execution and can safely run",
  );
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

process.stdout.write("  checkpoint integration: interrupted mutations resume without blind side-effect replay\n");
