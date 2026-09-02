// IR-02 embedded runtime adapter ("Lane B").
//
// Runs a Vinci/Pi agent session IN-PROCESS under an exact Run definition instead of spawning a
// `vinci -p` subprocess (the subprocess path in run.mjs stays untouched as the compatibility
// lane). The adapter:
//
//   * registers ONLY the granted tools — nothing from cwd, extensions, skills, prompt templates,
//     AGENTS.md/context files or ambient config can widen a Run (a null ResourceLoader guarantees
//     this regardless of what exists on disk);
//   * translates native agent-session events into the Vinci run-event vocabulary, writing them to
//     a durable sink (run-events-sink.mjs);
//   * supports steer / interrupt / resume-after-process-replacement.
//
// Provider isolation mirrors run.mjs's envDelta idiom: the adapter builds an in-memory AuthStorage
// and never reads ambient provider keys, so only the Run's own provider can ever authenticate.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AuthStorage,
  SessionManager,
  createAgentSession,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";

// Explicit allowlist for custom tools. The adapter only ever forwards a custom tool whose name
// appears here; empty means no custom tool can be registered through this adapter.
export const ALLOWLISTED_CUSTOM_TOOLS = Object.freeze([]);

const VALID_PAUSE_REASONS = Object.freeze(["manual", "steer", "budget", "worker_lost"]);

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Stable canonical encoding so the same logical payload always produces the same digest/key.
function stableStringify(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "number" || type === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (type === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function eventKey(type, payload) {
  return sha256Hex(`${type}\u0000${stableStringify(payload ?? {})}`);
}

// A resource loader that returns NOTHING regardless of what exists in cwd or ~/.pi/agent: no
// extensions, skills, prompt templates, AGENTS.md/context files, themes, or system-prompt
// appends. This is the load-bearing isolation guarantee of the embedded lane.
function nullResourceLoader() {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

// A payload VALUE is always kinded and content-free: { kind, value }.
function kinded(kind, value) {
  return { kind, value };
}

function lastAssistantUsage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "assistant" && message.usage) return message.usage;
  }
  return null;
}

function openSession({ run, grantedTools, customTools, cwd, sessionDir, persistent, authStorage, model }) {
  const manager = persistent ? SessionManager.create(cwd, sessionDir) : SessionManager.inMemory(cwd);
  const modelInstance = model ?? getModel(run.provider, run.model);
  const auth = authStorage ?? AuthStorage.inMemory();
  const allowlistedCustom = (Array.isArray(customTools) ? customTools : []).filter((tool) =>
    ALLOWLISTED_CUSTOM_TOOLS.includes(tool && tool.name),
  );
  return createAgentSession({
    cwd,
    agentDir: join(sessionDir, "agent"),
    model: modelInstance,
    authStorage: auth,
    tools: grantedTools,
    customTools: allowlistedCustom,
    resourceLoader: nullResourceLoader(),
    sessionManager: manager,
  }).then((result) => result.session);
}

// Shared translator: subscribes to the session and returns the adapter handle (prompt/steer/
// interrupt/dispose/sessionPath/complete). `onStart` is invoked to emit the run.started /
// run.resumed opening event.
function attachTranslator({ run, session, sink, clock, grantedTools, onStart }) {
  const grantedSet = new Set(grantedTools ?? []);
  const traceId = randomUUID();

  function now() {
    return clock && typeof clock.now === "function" ? clock.now() : Date.now();
  }

  function emit(type, payload) {
    return sink.append({
      eventId: randomUUID(),
      runId: run.runId,
      organizationId: null,
      workspaceId: run.workspaceId,
      type,
      actor: "worker",
      occurredAt: new Date(now()).toISOString(),
      idempotencyKey: eventKey(type, payload),
      traceId,
      payload,
    });
  }

  let turnCounter = 0;
  let lastTurnId = "1";
  const toolStartedAt = new Map();
  const refusedToolCalls = new Set();

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "agent_start": {
        turnCounter += 1;
        lastTurnId = String(turnCounter);
        emit("agent.turn_started", { turnId: kinded("id", lastTurnId) });
        break;
      }
      case "agent_end": {
        const usage = lastAssistantUsage(event.messages) ?? {};
        const payload = {
          turnId: kinded("id", lastTurnId),
          modelId: kinded("id", session.model ? session.model.id : run.model),
        };
        if (typeof usage.input === "number") {
          payload.inputTokens = kinded("count", usage.input);
        }
        if (typeof usage.output === "number") {
          payload.outputTokens = kinded("count", usage.output);
        }
        // Integer microdollars from usage accounting; omitted when unavailable (never 0).
        if (usage.cost && typeof usage.cost.total === "number" && usage.cost.total > 0) {
          payload.costMicrousd = kinded("count", Math.round(usage.cost.total * 1000000));
        }
        emit("agent.turn_finished", payload);
        break;
      }
      case "tool_execution_start": {
        if (!grantedSet.has(event.toolName)) {
          refusedToolCalls.add(event.toolCallId);
          emit("capability.refused", {
            capabilityId: kinded("id", event.toolName),
            reason: kinded("enum", "not_attested"),
          });
          break;
        }
        toolStartedAt.set(event.toolCallId, now());
        emit("tool.started", {
          toolCallId: kinded("id", event.toolCallId),
          toolId: kinded("id", event.toolName),
        });
        break;
      }
      case "tool_execution_end": {
        if (refusedToolCalls.has(event.toolCallId)) {
          refusedToolCalls.delete(event.toolCallId);
          break;
        }
        const started = toolStartedAt.get(event.toolCallId);
        toolStartedAt.delete(event.toolCallId);
        const durationMs = typeof started === "number" ? Math.max(0, now() - started) : 0;
        if (event.isError) {
          emit("tool.failed", {
            toolCallId: kinded("id", event.toolCallId),
            toolId: kinded("id", event.toolName),
            reason: kinded("enum", "error"),
          });
        } else {
          emit("tool.completed", {
            toolCallId: kinded("id", event.toolCallId),
            toolId: kinded("id", event.toolName),
            durationMs: kinded("count", durationMs),
            outputDigest: kinded("digest", sha256Hex(stableStringify(event.result))),
          });
        }
        break;
      }
      case "compaction_start": {
        emit("agent.compaction_started", {
          reason: kinded("enum", event.reason ? event.reason : "manual"),
          tokens: kinded("count", typeof event.tokens === "number" ? event.tokens : 0),
        });
        break;
      }
      case "compaction_end": {
        emit("agent.compaction_finished", {
          reason: kinded("enum", event.reason ? event.reason : "manual"),
        });
        break;
      }
      case "auto_retry_start": {
        emit("agent.retry_started", {
          attempt: kinded("count", event.attempt),
          maxAttempts: kinded("count", event.maxAttempts),
        });
        break;
      }
      case "auto_retry_end": {
        emit("agent.retry_finished", {
          attempt: kinded("count", event.attempt),
          success: kinded("flag", event.success === true),
        });
        break;
      }
      default:
        break;
    }
  });

  async function prompt(text, options) {
    await session.prompt(text, options);
  }

  async function steer(text) {
    emit("steer.received", {
      steerId: kinded("id", randomUUID()),
      instructionDigest: kinded("digest", sha256Hex(String(text))),
      issuedByPrincipalId: kinded("id", "control"),
    });
    await session.steer(text);
  }

  async function interrupt(reason = "manual") {
    const reasonCode = VALID_PAUSE_REASONS.includes(reason) ? reason : "manual";
    emit("run.paused", { reasonCode: kinded("enum", reasonCode) });
    await session.agent.abort();
  }

  function complete({ outcome = "SUCCEEDED", tierReached = "NONE" } = {}) {
    emit("run.completed", {
      outcome: kinded("enum", outcome),
      tierReached: kinded("enum", tierReached),
    });
  }

  async function dispose() {
    unsubscribe();
    session.dispose();
  }

  onStart(emit);

  return {
    prompt,
    steer,
    interrupt,
    dispose,
    complete,
    // AgentSession exposes the persisted file as a getter (delegating to sessionManager.getSessionFile()).
    sessionPath: session.sessionFile,
    session,
    _emit: emit,
  };
}

/**
 * Start an embedded run session.
 *
 * @param {object} options
 * @param {object} options.run - {runId, workOrderId, workOrderDigest, attemptId, workspaceId,
 *   contextManifestDigest|null, provider, model}
 * @param {string[]} options.grantedTools - exact tool allowlist passed to the session
 * @param {object[]} [options.customTools=[]] - custom tools, gated by ALLOWLISTED_CUSTOM_TOOLS
 * @param {string} options.cwd - working directory
 * @param {string} options.sessionDir - persistent session directory
 * @param {boolean} [options.persistent=true] - persist via SessionManager.create, else inMemory
 * @param {object} options.sink - run-events sink (createJsonlSink)
 * @param {object} [options.clock] - {now(): number} for deterministic timing
 * @param {object} [options.authStorage] - SDK AuthStorage (test seam; default in-memory, isolated)
 * @param {object} [options.model] - SDK Model (test seam; default getModel(run.provider, run.model))
 * @returns {Promise<{prompt, steer, interrupt, dispose, complete, sessionPath, session}>}
 */
export async function createRunSession({
  run,
  grantedTools,
  customTools = [],
  cwd,
  sessionDir,
  persistent = true,
  sink,
  clock,
  authStorage,
  model,
}) {
  const session = await openSession({
    run,
    grantedTools,
    customTools,
    cwd,
    sessionDir,
    persistent,
    authStorage,
    model,
  });
  // Record the run identity as a custom entry so resume can verify it.
  session.sessionManager.appendCustomEntry("vinci_run", { runId: run.runId, attemptId: run.attemptId });

  return attachTranslator({
    run,
    session,
    sink,
    clock,
    grantedTools,
    onStart: (emit) => {
      emit("run.started", {
        runId: kinded("id", run.runId),
        attemptId: kinded("id", run.attemptId),
      });
      if (run.contextManifestDigest) {
        emit("context.loaded", {
          contextManifestDigest: kinded("digest", run.contextManifestDigest),
          entryCount: kinded("count", 0),
        });
      }
    },
  });
}

/**
 * Reopen a persisted run session after the previous process was replaced (e.g. SIGKILLed).
 * Reopens the sink passed in (which reloads sequence state from disk), verifies the recorded run
 * identity, emits run.resumed, and returns the same handle shape as createRunSession.
 *
 * @param {object} options - same as createRunSession, plus `sessionPath` (returned for clarity)
 * @returns {Promise<{prompt, steer, interrupt, dispose, complete, sessionPath, session}>}
 * @throws {Error} code "run_identity_mismatch" when the persisted runId differs (nothing appended)
 */
export async function resumeRunSession({
  run,
  grantedTools,
  customTools = [],
  cwd,
  sessionDir,
  sessionPath,
  sink,
  clock,
  authStorage,
  model,
}) {
  const session = await openSession({
    run,
    grantedTools,
    customTools,
    cwd,
    sessionDir,
    persistent: true,
    authStorage,
    model,
  });

  const recordedRunId = sessionRunId(session);
  if (recordedRunId !== run.runId) {
    const error = new Error(
      `run identity mismatch: persisted runId ${JSON.stringify(recordedRunId)} != ${JSON.stringify(run.runId)}`,
    );
    error.code = "run_identity_mismatch";
    session.dispose();
    throw error;
  }

  return attachTranslator({
    run,
    session,
    sink,
    clock,
    grantedTools,
    onStart: (emit) => {
      emit("run.resumed", { attemptId: kinded("id", run.attemptId) });
    },
  });
}

function sessionRunId(session) {
  try {
    const entries = session.sessionManager.getEntries();
    const runEntry = entries.find(
      (entry) => entry && entry.type === "custom" && entry.customType === "vinci_run",
    );
    return runEntry && runEntry.data && typeof runEntry.data.runId === "string"
      ? runEntry.data.runId
      : null;
  } catch {
    return null;
  }
}
