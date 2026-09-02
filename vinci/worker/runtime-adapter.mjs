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

// idempotencyKey is derived from the EVENT'S IDENTITY, never from its payload: two distinct
// logical events with identical payloads (e.g. two manual pauses in one run) must be two lines,
// while a true re-append of the same event (same runId + type + identity) dedupes in the sink.
// The identity is the native id where the SDK provides one (tool call id), otherwise a per-attach
// monotonic counter scoped by the attach's traceId so a resumed process can never collide with
// the counters of the process it replaced.
function eventKey(runId, type, identity) {
  return sha256Hex(`${runId}\u0000${type}\u0000${identity}`);
}

// In-process mirror of run.mjs's envDelta provider isolation: the session's credential store
// answers ONLY for the Run's own provider and never falls back to ambient environment variables
// (AuthStorage.hasAuth / getApiKey / getAuthStatus consult process.env by default, which would let
// an OPENAI_API_KEY in the worker's environment make an "openai" model look configured to the
// session's ModelRegistry). Stored/runtime credentials for the Run's provider still resolve.
export function isolateAuthStorage(authStorage, provider) {
  const baseGetApiKey = authStorage.getApiKey.bind(authStorage);
  const baseGetAuthStatus = authStorage.getAuthStatus.bind(authStorage);
  const isolated = {
    hasAuth(candidate) {
      if (candidate !== provider) return false;
      const status = baseGetAuthStatus(candidate);
      return status.source === "stored" || status.source === "runtime";
    },
    getAuthStatus(candidate) {
      if (candidate !== provider) return { configured: false };
      const status = baseGetAuthStatus(candidate);
      return status.source === "stored" || status.source === "runtime" ? status : { configured: false };
    },
    async getApiKey(candidate, options = {}) {
      if (candidate !== provider) return undefined;
      return baseGetApiKey(candidate, { ...options, includeFallback: false });
    },
  };
  for (const [name, method] of Object.entries(isolated)) {
    Object.defineProperty(authStorage, name, { value: method, writable: true, configurable: true });
  }
  return authStorage;
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
  const auth = isolateAuthStorage(authStorage ?? AuthStorage.inMemory(), run.provider);
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
  }).then((result) => ({ session: result.session, authStorage: auth }));
}

// Shared translator: subscribes to the session and returns the adapter handle (prompt/steer/
// interrupt/dispose/sessionPath/complete). `onStart` is invoked to emit the run.started /
// run.resumed opening event.
function attachTranslator({ run, session, authStorage, sink, clock, grantedTools, onStart }) {
  const grantedSet = new Set(grantedTools ?? []);
  const traceId = randomUUID();
  // Per-attach monotonic counter for events the SDK gives no native id to (turns, pauses,
  // compaction, retries, completion). Scoped by traceId, see eventKey().
  let identityCounter = 0;
  function nextIdentity() {
    identityCounter += 1;
    return `${traceId}:${identityCounter}`;
  }

  function now() {
    return clock && typeof clock.now === "function" ? clock.now() : Date.now();
  }

  function emit(type, payload, identity = nextIdentity()) {
    return sink.append({
      eventId: randomUUID(),
      runId: run.runId,
      organizationId: null,
      workspaceId: run.workspaceId,
      type,
      actor: "worker",
      occurredAt: new Date(now()).toISOString(),
      idempotencyKey: eventKey(run.runId, type, identity),
      traceId,
      payload,
    });
  }

  let turnCounter = 0;
  let lastTurnId = "1";
  let turnIdentity = nextIdentity();
  // Set by interrupt(): the turn it stops is reported by run.paused, not by agent.turn_finished.
  let interrupted = false;
  const toolStartedAt = new Map();
  const refusedToolCalls = new Set();

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "agent_start": {
        turnCounter += 1;
        lastTurnId = String(turnCounter);
        turnIdentity = nextIdentity();
        interrupted = false;
        emit("agent.turn_started", { turnId: kinded("id", lastTurnId) }, `turn:${turnIdentity}:started`);
        break;
      }
      case "agent_end": {
        if (interrupted) {
          // The turn was stopped by interrupt(): run.paused already closed it; no agent.turn_*
          // event may follow the pause.
          interrupted = false;
          break;
        }
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
        emit("agent.turn_finished", payload, `turn:${turnIdentity}:finished`);
        break;
      }
      case "tool_execution_start": {
        if (!grantedSet.has(event.toolName)) {
          refusedToolCalls.add(event.toolCallId);
          emit(
            "capability.refused",
            {
              capabilityId: kinded("id", event.toolName),
              reason: kinded("enum", "not_attested"),
            },
            `tool:${event.toolCallId}:refused`,
          );
          break;
        }
        toolStartedAt.set(event.toolCallId, now());
        emit(
          "tool.started",
          {
            toolCallId: kinded("id", event.toolCallId),
            toolId: kinded("id", event.toolName),
          },
          `tool:${event.toolCallId}:started`,
        );
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
          emit(
            "tool.failed",
            {
              toolCallId: kinded("id", event.toolCallId),
              toolId: kinded("id", event.toolName),
              reason: kinded("enum", "error"),
            },
            `tool:${event.toolCallId}:failed`,
          );
        } else {
          emit(
            "tool.completed",
            {
              toolCallId: kinded("id", event.toolCallId),
              toolId: kinded("id", event.toolName),
              durationMs: kinded("count", durationMs),
              outputDigest: kinded("digest", sha256Hex(stableStringify(event.result))),
            },
            `tool:${event.toolCallId}:completed`,
          );
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

  // Records the steer (digest only) and queues it as a user message the model sees before its
  // next response (AgentSession.steer -> Agent steering queue, drained after the current tool
  // batch). The event is appended BEFORE the queue so a sink reader never sees an effect without
  // its cause.
  async function steer(text) {
    const steerId = randomUUID();
    emit(
      "steer.received",
      {
        steerId: kinded("id", steerId),
        instructionDigest: kinded("digest", sha256Hex(String(text))),
        issuedByPrincipalId: kinded("id", "control"),
      },
      `steer:${steerId}`,
    );
    await session.steer(String(text));
  }

  // Appends run.paused and stops the current turn. A reason outside the enum throws BEFORE
  // anything is appended. The turn's agent_end is swallowed (see agent_end above) so no
  // agent.turn_* event follows the pause; session.abort() resolves once the agent is idle.
  async function interrupt(reason = "manual") {
    if (!VALID_PAUSE_REASONS.includes(reason)) {
      const error = new Error(
        `invalid pause reason ${JSON.stringify(reason)}; expected one of ${VALID_PAUSE_REASONS.join(", ")}`,
      );
      error.code = "invalid_pause_reason";
      throw error;
    }
    emit("run.paused", { reasonCode: kinded("enum", reason) });
    interrupted = session.isStreaming === true;
    await session.abort();
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
    authStorage,
    _emit: emit,
  };
}

/**
 * Start an embedded run session.
 *
 * @param {object} options
 * @param {object} options.run - {runId, workOrderId, workOrderDigest, attemptId, workspaceId,
 *   contextManifestDigest|null, contextManifestEntryCount?, provider, model}
 * @param {string[]} options.grantedTools - exact tool allowlist passed to the session
 * @param {object[]} [options.customTools=[]] - custom tools, gated by ALLOWLISTED_CUSTOM_TOOLS
 * @param {string} options.cwd - working directory
 * @param {string} options.sessionDir - persistent session directory
 * @param {boolean} [options.persistent=true] - persist via SessionManager.create, else inMemory
 * @param {object} options.sink - run-events sink (createJsonlSink)
 * @param {object} [options.clock] - {now(): number} for deterministic timing
 * @param {object} [options.authStorage] - SDK AuthStorage (test seam; default in-memory). It is
 *   provider-isolated in place (isolateAuthStorage) before the session sees it.
 * @param {object} [options.model] - SDK Model (test seam; default getModel(run.provider, run.model))
 * @returns {Promise<{prompt, steer, interrupt, dispose, complete, sessionPath, session, authStorage}>}
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
  const opened = await openSession({
    run,
    grantedTools,
    customTools,
    cwd,
    sessionDir,
    persistent,
    authStorage,
    model,
  });
  const { session } = opened;
  // Record the run identity as a custom entry so resume can verify it.
  session.sessionManager.appendCustomEntry("vinci_run", { runId: run.runId, attemptId: run.attemptId });

  const entryCount = Number.isInteger(run.contextManifestEntryCount) && run.contextManifestEntryCount >= 0
    ? run.contextManifestEntryCount
    : 0;

  return attachTranslator({
    run,
    session,
    authStorage: opened.authStorage,
    sink,
    clock,
    grantedTools,
    onStart: (emit) => {
      // Payload is exactly {attemptId}: the runId is the envelope's runId, and the registry's
      // allowlist for run.started refuses unknown keys.
      emit("run.started", { attemptId: kinded("id", run.attemptId) }, `run:${run.attemptId}:started`);
      if (run.contextManifestDigest) {
        emit(
          "context.loaded",
          {
            contextManifestDigest: kinded("digest", run.contextManifestDigest),
            entryCount: kinded("count", entryCount),
          },
          `context:${run.attemptId}:loaded`,
        );
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
 * @returns {Promise<{prompt, steer, interrupt, dispose, complete, sessionPath, session, authStorage}>}
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
  const opened = await openSession({
    run,
    grantedTools,
    customTools,
    cwd,
    sessionDir,
    persistent: true,
    authStorage,
    model,
  });
  const { session } = opened;

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
    authStorage: opened.authStorage,
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
