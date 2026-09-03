// IR-02 embedded runtime adapter ("Lane B").
//
// Runs a Vinci/Pi agent session IN-PROCESS under an exact Run definition instead of spawning a
// `vinci -p` subprocess (the subprocess path in run.mjs stays untouched as the compatibility
// lane). The adapter:
//
//   * registers EXACTLY the granted tools, and runs them under an environment the Run defines.
//     Nothing on disk under the run's cwd or in ~/.pi — extensions, skills, prompt templates,
//     AGENTS.md/context files, project or global settings.json — and nothing in the daemon's own
//     process environment can widen a Run. Four mechanisms carry it, each load-bearing alone:
//       - a null ResourceLoader: no extensions, skills, prompt templates, AGENTS.md/context
//         files, themes or system-prompt appends, regardless of what exists on disk;
//       - an in-memory, project-UNTRUSTED SettingsManager: neither `<cwd>/.pi/settings.json` nor
//         `<agentDir>/settings.json` is read, so a settings file planted in the very working tree
//         the agent holds `write`/`edit` on cannot hand `shellCommandPrefix` or `shellPath` to the
//         bash tool. Settings are re-read at every session construction, resume included, so this
//         has to hold on both entry points;
//       - an adapter-owned `bash` tool definition whose subprocess environment is EXACTLY the
//         caller's `taskEnv` — never `process.env`. The SDK's own bash spawns with
//         `getShellEnv()` = `{...process.env}` and `createAgentSession` exposes no option for
//         that environment, so the adapter registers its own definition through `customTools`
//         (which override same-named built-ins in the session's tool registry) and refuses to
//         grant `bash` at all without a `taskEnv`;
//       - a MANDATORY, non-empty `grantedTools` (an omitted allowlist registers the SDK's DEFAULT
//         tool set, so an absent grant is the WIDEST Run this adapter can open), plus a
//         construction-time pin of the session's tool registry to exactly that set — in both
//         directions, so neither an ungranted tool that would be executable nor a granted tool the
//         runtime cannot register ever becomes a handle. The `tools` allowlist is what REFUSES an
//         ungranted call; the `capability.refused` event is the RECORD of that refusal, and it is
//         emitted only for a name the pin has already proven has no implementation to run.
//     What this does NOT claim: the granted tools still read and write the real filesystem at
//     `cwd`, so ambient FILES remain visible to a granted `read`/`ls`/`grep`/`bash`. The guarantee
//     is over CONFIGURATION — what the session is set up to do, and with what environment — not
//     over the contents of the workspace the Run was pointed at.
//   * translates native agent-session events into the Vinci run-event vocabulary, writing them to
//     a durable sink (run-events-sink.mjs);
//   * supports steer / interrupt / resume-after-process-replacement.
//
// Provider isolation mirrors run.mjs's envDelta idiom: the adapter builds an in-memory AuthStorage
// and never reads ambient provider keys, so only the Run's own provider can ever authenticate.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStorage,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createBashToolDefinition,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";

// Explicit allowlist for custom tools. The adapter only ever forwards a custom tool whose name
// appears here; empty means no custom tool can be registered through this adapter.
export const ALLOWLISTED_CUSTOM_TOOLS = Object.freeze([]);

const VALID_PAUSE_REASONS = Object.freeze(["manual", "steer", "budget", "worker_lost"]);

// The one granted tool whose EXECUTION ENVIRONMENT the adapter has to own. The SDK's bash spawns
// with getShellEnv() = {...process.env}; in-process that is the DAEMON's environment, including
// the debris-authority capabilities run.mjs deletes from a subprocess child. Granting it without
// a taskEnv is refused at construction rather than silently widened.
export const ENVIRONMENT_BEARING_TOOL = "bash";

// capability.refused names a tool the MODEL chose, so its name is unbounded free text on a stream
// documented as content-free. The name is emitted verbatim only when it is a conservative
// identifier within a length cap; anything else becomes a digest of the name. `capabilityIdForm`
// says which, so a reader never has to guess whether it is looking at a name or a digest.
const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export const CAPABILITY_ID_MAX_LENGTH = 64;

// The custom session entry that binds a persisted session file to the Run it was opened for.
// resumeRunSession refuses to reopen a session whose recorded identity is not this Run's.
export const VINCI_RUN_ENTRY = "vinci_run";

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

// A settings manager that answers from NOTHING on disk. Without it createAgentSession falls
// through to SettingsManager.create(cwd, agentDir) with project trust defaulting to TRUE, and a
// `.pi/settings.json` in the run's cwd — a file inside the repository working tree the agent
// itself holds `write` and `edit` on — hands `shellCommandPrefix`/`shellPath` straight to the bash
// tool factory. `projectTrusted: false` makes the project scope unreadable; the in-memory storage
// means the global scope has no file behind it either.
function nullSettingsManager() {
  return SettingsManager.inMemory({}, { projectTrusted: false });
}

// The SDK's OWN session-id rule, applied by the SDK itself: SessionManager.inMemory(cwd, {id})
// runs assertValidSessionId. That function is not exported from the package, so asking the SDK is
// the only way to test the rule that will actually be applied — a regex copied into this repo
// would be a second spelling of the rule, free to drift from it. In-memory: no file is created.
export function isValidSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  try {
    SessionManager.inMemory(process.cwd(), { id: sessionId });
    return true;
  } catch {
    return false;
  }
}

// A payload VALUE is always kinded and content-free: { kind, value }.
function kinded(kind, value) {
  return { kind, value };
}

// The bounded {capabilityId, capabilityIdForm} pair for a model-chosen capability name.
export function capabilityIdFields(name) {
  const text = typeof name === "string" ? name : String(name ?? "");
  if (text.length > 0 && text.length <= CAPABILITY_ID_MAX_LENGTH && CAPABILITY_ID_PATTERN.test(text)) {
    return { capabilityId: kinded("id", text), capabilityIdForm: kinded("enum", "name") };
  }
  return { capabilityId: kinded("digest", sha256Hex(text)), capabilityIdForm: kinded("enum", "digest") };
}

// An omitted or empty grant is not "no tools": createAgentSession registers its DEFAULT built-in
// set (read, bash, edit, write) when `tools` is undefined, so an absent grant is the widest Run
// this adapter can open. It is refused at construction, on both entry points.
function assertGrantedTools(grantedTools, where) {
  const valid =
    Array.isArray(grantedTools) &&
    grantedTools.length > 0 &&
    grantedTools.every((name) => typeof name === "string" && name.length > 0);
  if (valid) return;
  const error = new Error(
    `${where}: grantedTools must be a non-empty array of tool names (got ${JSON.stringify(grantedTools ?? null)}); ` +
      "an omitted allowlist registers the SDK's DEFAULT tool set, which silently WIDENS the Run",
  );
  error.code = "granted_tools_required";
  throw error;
}

// Granting the environment-bearing tool without saying what environment it runs under is the
// silent-widening shape this adapter exists to prevent, so it is an error, not a default.
function assertTaskEnv(grantedTools, taskEnv, where) {
  if (!grantedTools.includes(ENVIRONMENT_BEARING_TOOL)) return;
  if (taskEnv && typeof taskEnv === "object" && !Array.isArray(taskEnv)) return;
  const error = new Error(
    `${where}: granting ${JSON.stringify(ENVIRONMENT_BEARING_TOOL)} requires taskEnv — the environment its ` +
      "subprocesses run with. Without it the SDK spawns with {...process.env}, which in-process is the " +
      "DAEMON'S environment (debris-authority capabilities, provider keys, the unattended-policy stamp).",
  );
  error.code = "task_env_required";
  throw error;
}

// Freeze the Run's environment as own, string-valued entries only: a prototype-chain or
// non-string value would reach child_process.spawn and is not something a Run's env may carry.
function freezeTaskEnv(taskEnv) {
  const frozen = {};
  for (const key of Object.keys(taskEnv)) {
    const value = taskEnv[key];
    if (typeof value === "string") frozen[key] = value;
  }
  return Object.freeze(frozen);
}

// The adapter's own `bash`, registered through `customTools` so it REPLACES the SDK's built-in
// definition in the session's tool registry (AgentSession builds the registry from the built-ins
// and then sets custom tools over it by name). Two differences from the built-in, both deliberate:
//   * `spawnHook` replaces the process environment the command spawns with. The SDK's default is
//     getShellEnv() = {...process.env}; here it is exactly the environment run.mjs computed for
//     this task, which is the same map the subprocess lane hands its child.
//   * no `commandPrefix`/`shellPath` is passed. With nullSettingsManager() those are undefined
//     anyway; not passing them states that no settings file may reach this tool even if the
//     settings manager were ever changed.
function embeddedBashTool(cwd, taskEnv) {
  const frozen = freezeTaskEnv(taskEnv);
  return createBashToolDefinition(cwd, {
    spawnHook: (context) => ({ ...context, env: { ...frozen } }),
  });
}

// The `tools` allowlist handed to createAgentSession is the ENFORCEMENT; the capability.refused
// event is only a RECORD of it. Pin the enforcement here, in BOTH directions, so the constructed
// session and the Run's grant are the same set:
//
//   * a registered tool the Run does NOT grant would be executable, and the translator's
//     capability.refused would then be a label on a tool that ran;
//   * a granted tool the session did NOT register is a Run silently running NARROWER than its own
//     definition — a misspelled or retired name in `envelope.tools` would produce a
//     capability.refused for every call to it, attributed to "not attested" when the truth is that
//     the grant named a tool this runtime has no implementation for.
//
// Either way no handle is returned, so by the time a tool_execution_start names an ungranted tool,
// that tool provably has no implementation to run.
export function assertRegistryPinnedToGrant(session, grantedTools, where) {
  const granted = new Set(grantedTools);
  const registered = new Set(session.getAllTools().map((tool) => tool.name));
  const ungranted = [...registered].filter((name) => !granted.has(name)).sort();
  const unregistered = [...granted].filter((name) => !registered.has(name)).sort();
  if (ungranted.length === 0 && unregistered.length === 0) return;
  const error = new Error(
    `${where}: the constructed session's tool registry is not the Run's grant — registered but not granted: ` +
      `${JSON.stringify(ungranted)}; granted but not registered: ${JSON.stringify(unregistered)} ` +
      `(granted: ${JSON.stringify([...granted].sort())})`,
  );
  error.code = "tool_registry_mismatch";
  throw error;
}

function lastAssistantUsage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "assistant" && message.usage) return message.usage;
  }
  return null;
}

function openSession({
  run,
  grantedTools,
  customTools,
  taskEnv,
  cwd,
  sessionDir,
  persistent,
  authStorage,
  model,
  sessionId,
  sessionManager,
  where,
}) {
  const newSessionOptions = sessionId ? { id: sessionId } : undefined;
  const manager =
    sessionManager ??
    (persistent
      ? SessionManager.create(cwd, sessionDir, newSessionOptions)
      : SessionManager.inMemory(cwd, newSessionOptions));
  const modelInstance = model ?? getModel(run.provider, run.model);
  const auth = isolateAuthStorage(authStorage ?? AuthStorage.inMemory(), run.provider);
  const allowlistedCustom = (Array.isArray(customTools) ? customTools : []).filter((tool) =>
    ALLOWLISTED_CUSTOM_TOOLS.includes(tool && tool.name),
  );
  // `bash` is only ever registered as the adapter's own definition, whose environment is the Run's.
  const registeredCustom = grantedTools.includes(ENVIRONMENT_BEARING_TOOL)
    ? [...allowlistedCustom, embeddedBashTool(cwd, taskEnv)]
    : allowlistedCustom;
  return createAgentSession({
    cwd,
    agentDir: join(sessionDir, "agent"),
    model: modelInstance,
    authStorage: auth,
    tools: grantedTools,
    customTools: registeredCustom,
    resourceLoader: nullResourceLoader(),
    settingsManager: nullSettingsManager(),
    sessionManager: manager,
  }).then((result) => {
    assertRegistryPinnedToGrant(result.session, grantedTools, where);
    return { session: result.session, authStorage: auth };
  });
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
          // This branch RECORDS a refusal; it does not perform one. The refusal is performed by
          // the `tools` allowlist handed to createAgentSession and pinned at construction
          // (assertRegistryPinnedToGrant), which is why a name reaching here has no implementation
          // in the session's registry and the SDK answers the call with "Tool <name> not found".
          // The name is model-chosen, so it is bounded before it reaches the sink.
          refusedToolCalls.add(event.toolCallId);
          emit(
            "capability.refused",
            {
              ...capabilityIdFields(event.toolName),
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
 * @param {string[]} options.grantedTools - exact tool allowlist passed to the session. REQUIRED
 *   and non-empty: an omitted allowlist registers the SDK's default tool set.
 * @param {object[]} [options.customTools=[]] - custom tools, gated by ALLOWLISTED_CUSTOM_TOOLS
 * @param {object} [options.taskEnv] - the environment the Run's own subprocesses run with (the
 *   map run.mjs computes with applyEnvDelta, minus the daemon-only variables). REQUIRED when
 *   `bash` is granted; unused otherwise.
 * @param {string} options.cwd - working directory
 * @param {string} options.sessionDir - persistent session directory
 * @param {boolean} [options.persistent=true] - persist via SessionManager.create, else inMemory
 * @param {object} options.sink - run-events sink (createJsonlSink)
 * @param {object} [options.clock] - {now(): number} for deterministic timing
 * @param {object} [options.authStorage] - SDK AuthStorage (test seam; default in-memory). It is
 *   provider-isolated in place (isolateAuthStorage) before the session sees it.
 * @param {object} [options.model] - SDK Model (test seam; default getModel(run.provider, run.model))
 * @param {string} [options.sessionId] - explicit session id, so the worker's session accounting
 *   (session-read.mjs readSessionState(sessionDir, sessionId)) finds this session's transcript the
 *   same way it finds a `vinci -p --session-id` subprocess's.
 * @returns {Promise<{prompt, steer, interrupt, dispose, complete, sessionPath, session, authStorage}>}
 */
export async function createRunSession({
  run,
  grantedTools,
  customTools = [],
  taskEnv,
  cwd,
  sessionDir,
  persistent = true,
  sink,
  clock,
  authStorage,
  model,
  sessionId,
}) {
  assertGrantedTools(grantedTools, "createRunSession");
  assertTaskEnv(grantedTools, taskEnv, "createRunSession");
  const opened = await openSession({
    run,
    grantedTools,
    customTools,
    taskEnv,
    cwd,
    sessionDir,
    persistent,
    authStorage,
    model,
    sessionId,
    where: "createRunSession",
  });
  const { session } = opened;
  // Record the run identity as a custom entry so resume can verify it.
  session.sessionManager.appendCustomEntry(VINCI_RUN_ENTRY, { runId: run.runId, attemptId: run.attemptId });

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

// Every run identity the persisted session file recorded, oldest first. createRunSession writes
// one on create; a resume that adopts a new attempt of the same run writes another.
function recordedRunIdentities(sessionManager) {
  const entries = sessionManager.getEntries();
  return entries
    .filter((entry) => entry && entry.type === "custom" && entry.customType === VINCI_RUN_ENTRY)
    .map((entry) => (entry.data && typeof entry.data === "object" ? entry.data : {}));
}

function identityMismatch(message) {
  const error = new Error(`run identity mismatch: ${message}`);
  error.code = "run_identity_mismatch";
  return error;
}

/**
 * Reopen a persisted run session after the previous process was replaced (e.g. SIGKILLed).
 *
 * Ordering is load-bearing. The session file is opened and its recorded run identity is verified
 * BEFORE the agent session is constructed and before a single line reaches the sink, so a resume
 * pointed at the wrong run, at a missing file, or at a file that is not a pi session leaves the
 * event log byte-identical.
 *
 * `sink.replay()` re-reads the events file from disk and RESETS the sink's in-memory sequence
 * counter and idempotency index to what the killed process actually durably wrote. Without it a
 * sink object whose in-memory state is behind the file (constructed before the previous process's
 * last writes landed) would re-issue sequence numbers that are already on disk, and the run-event
 * contract's "contiguous, never reused" guarantee would be broken by the resume itself.
 *
 * @param {object} options - same as createRunSession, plus:
 * @param {string} options.sessionPath - the persisted session file to reopen (handle.sessionPath)
 * @returns {Promise<{prompt, steer, interrupt, dispose, complete, sessionPath, session, authStorage,
 *   resumedFromSequence, resumedAtSequence}>}
 * @throws {Error} code "granted_tools_required" when grantedTools is absent/empty (nothing appended)
 * @throws {Error} code "task_env_required" when `bash` is granted without taskEnv (nothing appended)
 * @throws {Error} code "tool_registry_mismatch" when the session registers an ungranted tool
 * @throws {Error} code "session_not_found" when sessionPath is absent/missing (nothing appended)
 * @throws {Error} code "session_unreadable" when the file is not a pi session (nothing appended)
 * @throws {Error} code "run_identity_mismatch" when the persisted runId differs (nothing appended)
 */
export async function resumeRunSession({
  run,
  grantedTools,
  customTools = [],
  taskEnv,
  cwd,
  sessionDir,
  sessionPath,
  sink,
  clock,
  authStorage,
  model,
}) {
  // (0) The grant and the Run's environment are checked FIRST, before the session file is even
  // opened: a resume that would widen the Run must leave the event log byte-identical too.
  assertGrantedTools(grantedTools, "resumeRunSession");
  assertTaskEnv(grantedTools, taskEnv, "resumeRunSession");
  // (1) The file must exist. SessionManager.open() on a missing path silently starts a BRAND NEW
  // session at that path, which would read as a successful resume of an empty run.
  if (typeof sessionPath !== "string" || sessionPath.length === 0) {
    const error = new Error("resumeRunSession: sessionPath is required");
    error.code = "session_not_found";
    throw error;
  }
  if (!existsSync(sessionPath)) {
    const error = new Error(`resumeRunSession: session file does not exist: ${sessionPath}`);
    error.code = "session_not_found";
    throw error;
  }

  // (2) Parse the file. A non-empty file that is not a pi session throws here; an EMPTY file is
  // accepted by the SDK (it initializes a header in place), so it is caught by (3) instead.
  let sessionManager;
  try {
    sessionManager = SessionManager.open(sessionPath, sessionDir, cwd);
  } catch (cause) {
    const error = new Error(
      `resumeRunSession: cannot read session file ${sessionPath}: ${cause && cause.message ? cause.message : cause}`,
    );
    error.code = "session_unreadable";
    error.cause = cause;
    throw error;
  }

  // (3) Verify the recorded run identity BEFORE constructing the agent session (createAgentSession
  // appends thinking-level/model-change entries to the file) and before touching the sink.
  const identities = recordedRunIdentities(sessionManager);
  if (identities.length === 0) {
    throw identityMismatch(
      `session file ${sessionPath} records no ${VINCI_RUN_ENTRY} entry; it was not opened by this adapter for run ${JSON.stringify(run.runId)}`,
    );
  }
  // EVERY recorded identity must name this run. The attemptId may legitimately be a NEW attempt of
  // the same run, so it is not compared; a crossed attemptId (one the file binds to a different
  // run) is already a runId divergence and is refused by this same check — a second condition on
  // `identity.attemptId === run.attemptId && identity.runId !== run.runId` would be unreachable,
  // and an unreachable second guard is what makes a mutation of the first one look survivable.
  for (const identity of identities) {
    if (identity.runId !== run.runId) {
      throw identityMismatch(
        `persisted runId ${JSON.stringify(identity.runId ?? null)} != ${JSON.stringify(run.runId)}`,
      );
    }
  }

  // (4) Re-sync the sink to what is durably on disk, so the first post-resume append is
  // lastSequence+1 — no gap, no reuse.
  const replayed = sink.replay();

  const opened = await openSession({
    run,
    grantedTools,
    customTools,
    taskEnv,
    cwd,
    sessionDir,
    persistent: true,
    authStorage,
    model,
    sessionManager,
    where: "resumeRunSession",
  });
  const { session } = opened;
  // Bind this attempt to the run in the transcript too, so a later resume verifies against it.
  if (!identities.some((identity) => identity.attemptId === run.attemptId)) {
    session.sessionManager.appendCustomEntry(VINCI_RUN_ENTRY, {
      runId: run.runId,
      attemptId: run.attemptId,
    });
  }

  let resumedAtSequence = null;
  const handle = attachTranslator({
    run,
    session,
    authStorage: opened.authStorage,
    sink,
    clock,
    grantedTools,
    onStart: (emit) => {
      resumedAtSequence = emit(
        "run.resumed",
        { attemptId: kinded("id", run.attemptId) },
        `run:${run.attemptId}:resumed`,
      );
    },
  });
  handle.resumedFromSequence = replayed.lastSequence;
  handle.resumedAtSequence = resumedAtSequence;
  return handle;
}
