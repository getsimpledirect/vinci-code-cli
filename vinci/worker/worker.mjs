#!/usr/bin/env node
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { BusClient, isLedgerRef } from "./bus.mjs";
import { command, finalState, prepareRepository, publish, readHead, runVinci } from "./run.mjs";
import { assertTaskId, contractTag, isDigestHandoff, loadModelClasses, materializeEnvelope, parseEnvelope, parseHandoffTriple, TaskLifecycle, vinciBinaryRecord } from "./task.mjs";
import { claimGovernorPaths, tightenEnvelopeLimits } from "./governor.mjs";
import { readSessionState } from "./session-read.mjs";
import { uploadEvidence } from "./evidence.mjs";
import { buildIdentity, fetchServerBuild, formatServerBuild, formatVinciBinary, formatWorkerBuild, vinciBinaryVersion } from "./build.mjs";

// W0.5: the exact build this daemon runs from, computed once at startup. `version` keeps the
// identity.json string that task records always carried as `vinci_version` — it is the DAEMON
// CHECKOUT's version, not the version of the `vinci` binary that runs tasks (see vinciBinary).
const workerBuild = buildIdentity();
const version = workerBuild.version;
// Filled at startup from GET <server>/v1/version (or `{ error }`); stamped on every task.
let serverBuild = { error: "not fetched" };
// #18: `<PATH vinci> --version`, i.e. the launcher payload that actually runs tasks. Probed at
// startup (the `online` post's value) AND immediately before every spawn (the value the task
// record carries, see processHandoff), because an operator can update the launcher between
// tasks. `{ version, path }` or `{ error }`. This is the LAST OBSERVED probe: it is what early
// terminal posts (which never spawn) report, and what terminalPostBody prints.
let vinciBinary = { error: "not checked" };
// F2: the operator model-class table (VINCI_WORKER_MODEL_CLASSES, inline JSON or `@<file>`),
// parsed and validated EXACTLY ONCE at daemon startup (see main): an invalid value refuses to
// start (exit 78, reason on stderr) and can never surface as a crash in the middle of a task.
// Unset ⇒ the daemon starts prose-only: `configured: false`, and every digest handoff BLOCKs
// with `unknown_model_class: MODEL_CLASSES not configured`.
let modelConfig = { configured: false, table: Object.freeze({}) };

// Drift signal (#18), persisted so it survives restarts: `<state-dir>/vinci-binary.json` holds
// the last ANNOUNCED `{ version, path }`. Rules:
//   - only a version -> version change is announced (`worker <id> vinci binary changed A -> B`,
//     once per change; A -> B -> A is two changes);
//   - a probe `{ error }` is recorded on the task but never announced and never resets the
//     last-announced value, so a flaky probe cannot fake a drift or hide the next real one;
//   - the first successful probe on a box is the baseline: persisted, not announced;
//   - the file is written only AFTER the post succeeded, so a failed post is retried before the
//     next task (or at the next start) instead of being lost.
const ANNOUNCED_BINARY_FILE = "vinci-binary.json";

function readAnnouncedBinary(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, ANNOUNCED_BINARY_FILE), "utf8"));
    return typeof parsed?.version === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeAnnouncedBinary(stateDir, binary) {
  const target = join(stateDir, ANNOUNCED_BINARY_FILE);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: binary.version, path: binary.path, announced_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

async function announceBinaryChange(bus, stateDir, workerId) {
  if (!vinciBinary || vinciBinary.error) return false;
  const last = readAnnouncedBinary(stateDir);
  if (!last) {
    writeAnnouncedBinary(stateDir, vinciBinary);
    return false;
  }
  if (last.version === vinciBinary.version) return false;
  try {
    await bus.post(
      "status",
      `worker ${workerId} vinci binary changed ${last.version} -> ${vinciBinary.version}`,
      `vinci_binary=${vinciBinary.version} previous=${last.version} path=${vinciBinary.path} worker_build=${formatWorkerBuild(workerBuild)}`,
    );
  } catch (error) {
    process.stderr.write(`vinci worker: vinci binary change post failed, will retry before the next task: ${error.message}\n`);
    return false;
  }
  writeAnnouncedBinary(stateDir, vinciBinary);
  return true;
}

function usage() {
  return "Usage: vinci worker start --id <id> --server <url> [--once] [--poll-seconds 60] [--state-dir <dir>] [--governor <url>] [--require-governor]";
}

// EX_CONFIG (sysexits.h): the daemon refused to start because its configuration is incomplete.
const EXIT_CONFIG = 78;

function parseArgs(args, env = process.env) {
  if (args.shift() !== "start") throw new Error(usage());
  const options = {
    once: false,
    pollSeconds: 60,
    stateDir: resolve(".vinci-worker-state"),
    governor: null,
    requireGovernor: env.VINCI_WORKER_REQUIRE_GOVERNOR === "1",
  };
  const seen = new Set();
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--once" || argument === "--require-governor") {
      if (seen.has(argument)) throw new Error(`duplicate option: ${argument}`);
      seen.add(argument);
      if (argument === "--once") options.once = true;
      else options.requireGovernor = true;
      continue;
    }
    if (!["--id", "--server", "--poll-seconds", "--state-dir", "--governor"].includes(argument)) {
      throw new Error(`unknown option: ${argument}\n${usage()}`);
    }
    if (seen.has(argument)) throw new Error(`duplicate option: ${argument}`);
    seen.add(argument);
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--id") options.id = value;
    else if (argument === "--server") options.server = value;
    else if (argument === "--state-dir") options.stateDir = resolve(value);
    else if (argument === "--governor") options.governor = value;
    else options.pollSeconds = Number(value);
  }
  if (options.requireGovernor && !options.governor) {
    // W0.1: a Governor was REQUIRED but none configured. Refuse to start rather than run a
    // single ungoverned poll. This is the FIRST check after option parsing — ahead of the bus
    // token, id/server validation, the daemon lock and any bus request — so the exit code is
    // 78 regardless of what else is missing.
    const configError = new Error(
      "a Governor is required (--require-governor / VINCI_WORKER_REQUIRE_GOVERNOR=1) but no --governor <url> was given; refusing to start",
    );
    configError.exitCode = EXIT_CONFIG;
    throw configError;
  }
  if (!options.id) throw new Error("--id is required");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(options.id)) throw new Error("invalid worker id");
  if (!options.server) throw new Error("--server is required");
  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds <= 0) {
    throw new Error("--poll-seconds must be a positive number");
  }
  const token = env.VINCI_BUS_TOKEN;
  if (!token) throw new Error("VINCI_BUS_TOKEN is required");
  return { ...options, token };
}

function cursorPath(stateDir) {
  return join(stateDir, "cursor.json");
}

function loadCursor(stateDir, workerId) {
  try {
    const cursors = JSON.parse(readFileSync(cursorPath(stateDir), "utf8"));
    const cursor = cursors?.[workerId];
    if (
      cursor &&
      typeof cursor.ts === "string" &&
      Array.isArray(cursor.message_ids) &&
      cursor.message_ids.every((id) => typeof id === "string")
    ) {
      return cursor;
    }
  } catch {
    // fall through: missing or unreadable cursor file
  }
  // A missing or corrupt cursor starts from NOW, never from the beginning: the bus holds
  // thousands of historical rows and a fresh worker must not replay them (the first live
  // start did exactly that, 2026-08-27 11:16Z). The initial cursor is persisted before the
  // first poll so a crash between init and poll cannot reopen history.
  const fresh = { ts: new Date().toISOString(), message_ids: [] };
  saveCursor(stateDir, workerId, fresh);
  return fresh;
}

function advanceCursor(cursor, message) {
  if (!cursor || message.ts > cursor.ts) return { ts: message.ts, message_ids: [message.message_id] };
  if (message.ts === cursor.ts) {
    return { ts: cursor.ts, message_ids: [...new Set([...cursor.message_ids, message.message_id])] };
  }
  return cursor;
}

function saveCursor(stateDir, workerId, cursor) {
  const path = cursorPath(stateDir);
  let cursors = {};
  try {
    cursors = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  cursors[workerId] = cursor;
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(cursors, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function pidIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireDaemonLock(stateDir, workerId) {
  const path = join(stateDir, "daemon.lock");
  const contents = `${JSON.stringify({ pid: process.pid, id: workerId, started_at: new Date().toISOString() })}\n`;
  while (true) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, contents);
      } finally {
        closeSync(descriptor);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(readFileSync(path, "utf8"));
          if (owner?.pid === process.pid) unlinkSync(path);
        } catch {}
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(readFileSync(path, "utf8"));
      } catch {}
      if (pidIsLive(owner?.pid)) {
        const lockError = new Error(`daemon lock ${path} is owned by live pid ${owner.pid}`);
        lockError.exitCode = 75;
        throw lockError;
      }
      const stale = `${path}.stale-${process.pid}-${Date.now()}`;
      try {
        renameSync(path, stale);
        unlinkSync(stale);
      } catch (renameError) {
        if (renameError?.code !== "ENOENT") throw renameError;
      }
    }
  }
}

function acquireTaskClaim(stateDir, taskId) {
  const path = join(stateDir, "tasks", `${taskId}.claim`);
  mkdirSync(join(stateDir, "tasks"), { recursive: true });
  while (true) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, "pid"), `${process.pid}\n`, { mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let ownerPid;
      try {
        ownerPid = Number(readFileSync(join(path, "pid"), "utf8").trim());
      } catch {}
      if (pidIsLive(ownerPid)) return false;
      const stale = `${path}.stale-${process.pid}-${Date.now()}`;
      try {
        renameSync(path, stale);
        rmSync(stale, { recursive: true, force: true });
      } catch (renameError) {
        if (renameError?.code !== "ENOENT") throw renameError;
      }
    }
  }
}


const daemonLogChunks = [];

process.stderr.write = ((write) =>
  function (chunk, ...args) {
    daemonLogChunks.push(String(chunk));
    if (daemonLogChunks.length > 200) daemonLogChunks.splice(0, daemonLogChunks.length - 200);
    return write.apply(process.stderr, [chunk, ...args]);
  })(process.stderr.write);

function recentLogTail(limit) {
  return daemonLogChunks.slice(-limit).join("").trim() || null;
}

// W0.5: EVERY terminal post — postFinal and each early terminal blocker (envelope error, past
// deadline, governor refusal/unavailability, invalid task id) — goes through this one formatter
// so no terminal record on the bus can omit which build produced it.
function terminalPostBody(details) {
  return `${details} worker_build=${formatWorkerBuild(workerBuild)} vinci_binary=${formatVinciBinary(vinciBinary)}`;
}

// F8: EVERY early terminal (blocker) post — digest refusal, invalid bounds, past deadline,
// Governor refusal/unavailability, base-checkout refusal — is formatted HERE and nowhere else.
// `record` is the task snapshot (or, before a record exists, the parsed triple / null): a
// digest-form task always yields `contract=<work_order_id>@<digest8>` as the FIRST token; a prose
// task yields no tag and its body is byte-identical to what it was before Wave 1B. `fallback`
// is the tag for a digest handoff whose triple could not even be parsed (`contract=malformed`).
function blockerPostBody(record, details, fallback = null) {
  const tag = contractTag(record) ?? fallback;
  return terminalPostBody(tag ? `${tag} ${details}` : details);
}

async function postFinal(bus, message, envelope, state, evidence) {
  const subject = `task ${message.message_id} ${state.state.toLowerCase()}`;
  // uri/sha256 are advertised only when the bundle actually reached S3 (`uploaded === true`,
  // set by uploadEvidence solely after a successful `aws s3 cp`); a failed upload also carries
  // the intended uri, which must NOT be advertised. evidence_error is present whenever evidence
  // was attempted and did not fully land (upload or metadata POST).
  const landed = evidence?.uploaded === true;
  const evidenceDetails = evidence
    ? [
        landed ? `evidence_uri=${evidence.uri}` : undefined,
        landed ? `evidence_sha256=${evidence.sha256}` : undefined,
        evidence.success ? undefined : `evidence_error=${evidence.error}`,
      ]
    : [];
  const details = [
    `state=${state.state}`,
    `exit_code=${state.exit_code}`,
    `cost_usd=${Number(state.cost_usd).toFixed(6)}`,
    state.limit_tripped ? `limit=${state.limit_tripped}` : undefined,
    state.head ? `head=${state.head}` : undefined,
    state.pr ? `pr=${state.pr}` : undefined,
    contractTag(state),
    ...evidenceDetails,
  ]
    .filter(Boolean)
    .join(" ");
  const body = terminalPostBody(details);
  const options = { inReplyTo: message.message_id };
  if (state.state === "COMPLETED" && isLedgerRef(envelope.ref)) {
    options.refs = [envelope.ref];
    await bus.post("finding", subject, body, options);
  } else if (state.state === "BLOCKED" && state.harness_stop) {
    // An instrument stop: the harness refused the agent's work mid-run. Say so explicitly so the
    // soak ledger attributes the block to the instrument, not to the model's own narrative.
    const stop = state.harness_stop;
    await bus.post(
      "blocker",
      subject,
      terminalPostBody(`${details} stop=instrument harness_stops=${stop.count} reason=instrument stop: ${stop.reason}`),
      options,
    );
  } else if (state.state === "BLOCKED" || state.state === "FAILED") {
    // A FAILED run may also have hit a harness stop; surface count AND reason so the ledger can
    // attribute it. harness_stop_reason is the instrument's text; reason= stays the outcome narrative.
    const stops = state.harness_stop
      ? `${details} harness_stops=${state.harness_stop.count} harness_stop_reason=${state.harness_stop.reason}`
      : details;
    const reason = state.outcome?.reason ? `${stops} reason=${state.outcome.reason}` : stops;
    await bus.post("blocker", subject, terminalPostBody(reason), options);
  } else {
    await bus.post("status", subject, body, options);
  }
}

// Wave 1B: fetch the Governor's pinned registry for a work order and classify non-2xx answers
// so every one of them becomes a BLOCKED refusal before a clone. The digests are recomputed by
// materializeEnvelope against the served record; nothing here is trusted from the handoff triple.
//
// F1: the body is STREAMED under the same AbortController as the connection, with a hard byte
// cap. Content-Length is never trusted (a chunked answer has none; a lying one is just a header):
// an oversized body aborts the read at the cap, and a stalled or trickling body is aborted by the
// single deadline that covers headers AND body. Both are `registry_unavailable`.
const REGISTRY_MAX_BYTES = 262_144;
const REGISTRY_TIMEOUT_MS = 10_000;

function registryTimeoutMs(env = process.env) {
  const configured = Number(env.VINCI_WORKER_REGISTRY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : REGISTRY_TIMEOUT_MS;
}

async function readBodyCapped(response, controller, maxBytes) {
  if (!response.body) return "";
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      controller.abort();
      throw new Error(`registry_unavailable: governor contracts response exceeds ${maxBytes / 1024} KiB (streamed ${total} bytes)`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchWorkOrderRegistry(serverUrl, token, workOrderId, { timeoutMs = registryTimeoutMs() } = {}) {
  const url = `${serverUrl}/v1/governor/contracts/${encodeURIComponent(workOrderId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`registry_unavailable: governor contracts fetch failed: ${error?.cause?.code ?? error.name === "AbortError" ? `timed out after ${timeoutMs} ms` : error.message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`registry_forbidden: governor contracts returned ${response.status}`);
    }
    if (response.status === 404) {
      throw new Error(`work_order_not_found: no contract for ${workOrderId}`);
    }
    if (!response.ok) {
      throw new Error(`registry_error: governor contracts returned ${response.status}`);
    }
    let text;
    try {
      text = await readBodyCapped(response, controller, REGISTRY_MAX_BYTES);
    } catch (error) {
      if (/^registry_unavailable:/.test(error.message)) throw error;
      const why = controller.signal.aborted ? `body stalled; timed out after ${timeoutMs} ms` : (error?.cause?.code ?? error.message);
      throw new Error(`registry_unavailable: governor contracts body read failed: ${why}`);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`registry_malformed: governor contracts returned invalid JSON: ${error.message}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function processHandoff(bus, stateDir, message, governorUrl, workerId) {
  const taskId = message.message_id;
  try {
    assertTaskId(taskId);
  } catch (error) {
    await bus.post("blocker", `task ${taskId} blocked`, blockerPostBody(null, error.message), { inReplyTo: message.message_id });
    return true;
  }

  const lifecycle = new TaskLifecycle(stateDir, taskId);
  if (lifecycle.isTerminal()) return true;
  if (!acquireTaskClaim(stateDir, taskId)) return false;

  let envelope;
  let contractFields = null;
  if (isDigestHandoff(message.body)) {
    // Wave 1B digest form: parse the triple, fetch the pinned registry from the server, and
    // materialize the envelope. Every refusal (malformed triple, 404/unauthorized registry,
    // digest mismatch, binding mismatch, unknown model class, bad field) BLOCKs here, before a
    // clone and before a model spawn.
    // F2: the operator model-class table was validated once at startup (modelConfig); it is
    // passed into materializeEnvelope, which stays pure. A change needs a daemon restart.
    let triple;
    let reason;
    try {
      triple = parseHandoffTriple(message.body);
      const registry = await fetchWorkOrderRegistry(bus.serverUrl, process.env.VINCI_BUS_TOKEN, triple.work_order_id);
      const materialized = materializeEnvelope(triple, registry, {
        modelClasses: modelConfig.table,
        modelClassesConfigured: modelConfig.configured,
      });
      envelope = materialized.envelope;
      contractFields = materialized.contract;
    } catch (error) {
      reason = error.message || "handoff triple refusal";
    }
    if (reason) {
      lifecycle.startAttempt(
        { id: taskId, envelope: { evidence: null, provider: null, model: null } },
        version,
        { workerBuild, serverBuild, vinciBinary },
      );
      lifecycle.transition("BLOCKED", { outcome: { reason } });
      // B7: a malformed post (the triple could not even be parsed) still carries `contract=malformed`;
      // a parsed triple whose registry answer refused carries the work_order_id@digest8 tag.
      await bus.post("blocker", `task ${taskId} blocked`, blockerPostBody(triple ?? null, `state=BLOCKED reason=${reason}`, "contract=malformed"), {
        inReplyTo: message.message_id,
      });
      return true;
    }
  } else {
    try {
      envelope = parseEnvelope(message.body);
    } catch (error) {
      lifecycle.startAttempt(
        { id: taskId, envelope: { evidence: null, provider: null, model: null } },
        version,
        { workerBuild, serverBuild, vinciBinary },
      );
      const state = /^repo must be/.test(error.message) ? "FAILED" : "BLOCKED";
      lifecycle.transition(state, {
        limit_tripped: /budget_usd/.test(error.message) ? "budget_usd" : null,
        outcome: { reason: error.message },
      });
      await bus.post("blocker", `task ${taskId} ${state.toLowerCase()}`, terminalPostBody(`state=${state} reason=${error.message}`), {
        inReplyTo: message.message_id,
      });
      return true;
    }
  }

  const attempt = lifecycle.startAttempt({ id: taskId, envelope }, version, { workerBuild, serverBuild, vinciBinary });
  // Wave 1B: stamp the record with the materialized contract (work_order_id, both digests,
  // base_commit, promotion) so the snapshot and every terminal post can cite the handoff.
  if (contractFields) lifecycle.record(contractFields);
  // B6: bounds validation BEFORE prepareRepository and before any spawn. budget_usd<=0, a
  // non-positive max_runtime_s, or a deadline already in the past each BLOCK the task.
  // For prose envelopes: keep the original reason string. For digest: use the structured format.
  if (contractFields && (envelope.budget_usd <= 0 || envelope.max_runtime_s <= 0 || (envelope.deadline && Date.parse(envelope.deadline) <= Date.now()))) {
    // Digest handoff: full bounds validation with structured post body.
    const limit = envelope.budget_usd <= 0 ? "budget_usd" : envelope.max_runtime_s <= 0 ? "max_runtime_s" : "deadline";
    lifecycle.transition("BLOCKED", { limit_tripped: limit, outcome: { reason: "invalid_bounds: budget_usd, max_runtime_s and deadline must be within permitted bounds" } });
    await bus.post("blocker", `task ${taskId} blocked`, blockerPostBody(lifecycle.snapshot(), `invalid_bounds budget_usd=${envelope.budget_usd} max_runtime_s=${envelope.max_runtime_s} deadline=${envelope.deadline ?? "none"}`), { inReplyTo: message.message_id });
    return true;
  }

  // Prose handoff: only deadline is checked (budget and runtime have safe defaults from parseEnvelope).
  if (!contractFields && envelope.deadline && Date.parse(envelope.deadline) <= Date.now()) {
    lifecycle.transition("BLOCKED", { limit_tripped: "deadline", outcome: { reason: "deadline is in the past" } });
    await bus.post("blocker", `task ${taskId} blocked`, blockerPostBody(lifecycle.snapshot(), "deadline is in the past"), { inReplyTo: message.message_id });
    return true;
  }

  if (attempt.firstAttempt) {
    await bus.post("status", `task ${taskId} claimed`, `claimed ${taskId} attempt ${attempt.attempt}`, {
      inReplyTo: message.message_id,
    });
  }

  try {
    // Stage 2: Governor lease (if configured). FAIL-CLOSED (W0.1): with a Governor URL set,
    // the task proceeds to clone/spawn ONLY on a granted lease. A missing token, an
    // unreachable Governor, a network error, a non-JSON body, an unexpected status, or a
    // missing decision all BLOCK the task here, before prepareRepository and runVinci.
    let envelopeToUse = envelope;
    if (governorUrl) {
      const governorToken = process.env.VINCI_GOVERNOR_TOKEN;
      const claimResult = await claimGovernorPaths({
        governorUrl,
        token: governorToken,
        paths: [envelope.claim],
        taskId,
        attempt: attempt.attempt,
      });

      if (!claimResult?.success) {
        // Two classifications, never conflated: a REFUSAL is a Governor decision (403/409/422,
        // rule text verbatim); everything else is the Governor being unavailable or its answer
        // being unusable. Both BLOCK; the soak ledger attributes them differently.
        const reason = claimResult?.reason ?? "governor returned no lease decision";
        const governor = claimResult?.refused === true ? "refused" : "unavailable";
        const label = governor === "refused" ? "Governor refused the lease" : "Governor unavailable/invalid";
        lifecycle.transition("BLOCKED", { outcome: { reason, governor } });
        // F8: on the digest path this post carries contract=<id>@<digest8> like every other.
        await bus.post("blocker", `task ${taskId} blocked`, blockerPostBody(lifecycle.snapshot(), `${label}: ${reason}`), {
          inReplyTo: message.message_id,
        });
        return true;
      }

      // Lease granted: tighten the envelope (budget, max_runtime_s, deadline, and the lease
      // ttl as a runtime cap) and record both the lease and the effective runtime limit.
      envelopeToUse = tightenEnvelopeLimits(envelopeToUse, claimResult);
      lifecycle.record({
        lease: { ...claimResult, effective_max_runtime_s: envelopeToUse.max_runtime_s },
      });
    }

    const repository = await prepareRepository(
      stateDir,
      envelopeToUse.repo,
      taskId,
      envelopeToUse.branch,
      envelopeToUse.base_commit,
      contractFields ? contractFields.base_ref : undefined,
      attempt.attempt,
    );
    if (repository.debrisReceipt) lifecycle.record({ debris_receipt: repository.debrisReceipt });
    // #18: probe the binary IMMEDIATELY before the spawn — after the Governor lease and the clone,
    // which can take long enough for an operator update to land — and stamp the task with it.
    // runVinci spawns with VINCI_UPDATE_DISABLED=1, so nothing can change between this probe
    // and the run: the recorded version is the executed version.
    vinciBinary = vinciBinaryVersion();
    lifecycle.record({ vinci_binary: vinciBinaryRecord(vinciBinary) });
    await announceBinaryChange(bus, stateDir, workerId);
    lifecycle.transition("RUNNING");
    const run = await runVinci({ envelope: envelopeToUse,
      stateDir,
      taskId, repoDir: repository.repoDir, sessionId: attempt.sessionId });
    const head = await readHead(repository.repoDir);
    lifecycle.record({ ...run, head, outcome: run.outcome ?? null });
    // F6/F7: the output mode decides what publish does; the pinned baseRef/baseCommit (digest
    // path only) are the PR base and the patch/artifact base. The patch text / artifact list ride
    // into the evidence bundle, not into the task record.
    const { patch, artifacts, ...published } = await publish({
      envelope: envelopeToUse,
      limitTripped: run.limit_tripped,
      ...repository,
      taskId,
      baseRef: contractFields?.base_ref ?? undefined,
      baseCommit: contractFields?.base_commit ?? undefined,
    });
    if (Array.isArray(artifacts)) published.artifacts = artifacts;
    const extraFiles = {};
    if (typeof patch === "string") extraFiles[`${attempt.attempt}.patch`] = patch;
    if (Array.isArray(artifacts)) extraFiles["artifacts.json"] = `${JSON.stringify({ base_commit: contractFields?.base_commit ?? null, files: artifacts }, null, 2)}\n`;
    const outcome = published.blocker_reason ? { reason: published.blocker_reason } : run.outcome ?? null;
    const harnessStops = run.harness_stops ?? [];
    const intendedState = finalState({
      exitCode: run.exit_code,
      limitTripped: run.limit_tripped,
      outcome: run.outcome,
      blocker: Boolean(published.blocker_reason),
      pr: published.pr,
      harnessStops,
    });
    // Record the instrument stop on the task whenever one occurred — even when exit/limit outranked it
    // — so the snapshot (and the evidence bundle's result.json) carry the machine-observed reason next
    // to the model's narrative and the soak ledger can see that a latch also fired on a FAILED run.
    const harnessStop =
      harnessStops.length > 0 ? { count: harnessStops.length, reason: harnessStops[0].reason } : null;

    // W0.2 evidence before terminal: the terminal state is written only AFTER the evidence
    // bundle was attempted. `planned` is the exact snapshot that will be committed (state +
    // published fields) and is what ships as result.json. No-op when
    // VINCI_EVIDENCE_URI_PREFIX is unset (soak boxes may run without evidence).
    // sessionJsonl: session transcript from <state-dir>/sessions/<task-id>/ (outside the repo).
    // gitDiff is against the task branch base; it may be empty when the run changed nothing.
    // logTail: last 200 lines of the daemon's stderr so the bundle captures how the run ended.
    const planned = lifecycle.plan(intendedState, { ...published, outcome, evidence_error: null, harness_stop: harnessStop });
    // The bundle is built BEFORE anything is committed, so result.json is marked as a
    // pre-terminal snapshot: `state` is the intended state, `committed_state` is null and
    // `terminal` is false. A bundle-alone reader therefore never sees a committed COMPLETED;
    // the committed state lives only in the task file, which also records
    // `evidence_result_state` so a downgrade after upload is machine-detectable.
    const resultJson = { ...planned, snapshot: "pre-terminal", committed_state: null, terminal: false };
    const session = readSessionState(join(stateDir, "sessions", taskId), attempt.sessionId);
    const sessionJsonl = session.path ? readFileSync(session.path, "utf8") : null;
    // F7: the evidence diff is against the pinned baseCommit on the digest path (never a
    // hardcoded main); the prose path keeps origin/main...HEAD.
    const gitDiffResult = await command("git", [
      "-C",
      repository.repoDir,
      "diff",
      contractFields?.base_commit ? `${contractFields.base_commit}...HEAD` : "origin/main...HEAD",
    ], { allowFailure: true });
    const gitDiff = gitDiffResult.status === 0 ? gitDiffResult.stdout : null;
    const logTail = recentLogTail(200);
    const evidenceResult = await uploadEvidence({
      sessionJsonl,
      gitDiff,
      resultJson,
      logTail,
      uriPrefix: process.env.VINCI_EVIDENCE_URI_PREFIX,
      taskId,
      busUrl: bus.serverUrl,
      busToken: bus.token,
      ref: envelopeToUse.ref,
      extraFiles,
    });

    // Evidence was attempted and did not fully land (S3 upload or /v1/evidence POST failed):
    // a COMPLETED claim without evidence is not a completed claim -> UNVERIFIED.
    // BLOCKED/FAILED keep their state but record why evidence is missing.
    const evidenceError = evidenceResult && !evidenceResult.success ? evidenceResult.error : null;
    const state = evidenceError && intendedState === "COMPLETED" ? "UNVERIFIED" : intendedState;
    lifecycle.transition(state, {
      ...planned,
      evidence_error: evidenceError,
      // State the uploaded result.json names as intended; differs from `state` after a downgrade.
      evidence_result_state: evidenceResult ? intendedState : null,
    });
    await postFinal(bus, message, envelopeToUse, lifecycle.snapshot(), evidenceResult);
  } catch (error) {
    // A terminal state is immutable: if the failure happened after it was committed (e.g. the
    // final bus post), surface the error to the daemon loop instead of rewriting the record.
    if (lifecycle.isTerminal()) throw error;
    // B4: a base-checkout validation failure (missing origin base ref, or base_commit not
    // reachable) is a BLOCKED refusal, not a FAILED run: nothing was spawned, nothing produced.
    if (typeof error?.blockedReason === "string") {
      lifecycle.transition("BLOCKED", { outcome: { reason: error.message } });
      await bus.post("blocker", `task ${taskId} blocked`, blockerPostBody(lifecycle.snapshot(), `state=BLOCKED reason=${error.message}`), { inReplyTo: message.message_id });
      return true;
    }
    lifecycle.transition("FAILED", { outcome: { reason: error.message }, exit_code: 1 });
    await postFinal(bus, message, envelope, lifecycle.snapshot(), null);
  }
  return true;
}

// F2: EX_CONFIG on an unusable model-class table, BEFORE the state dir, the daemon lock, the
// /v1/version fetch and the online post — the same "refuse to start" shape as --require-governor.
function loadModelClassesOrRefuse(env = process.env) {
  try {
    return loadModelClasses(env);
  } catch (error) {
    const configError = new Error(`${error.message}; refusing to start`);
    configError.exitCode = EXIT_CONFIG;
    throw configError;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  modelConfig = loadModelClassesOrRefuse();
  mkdirSync(options.stateDir, { recursive: true });
  const releaseLock = acquireDaemonLock(options.stateDir, options.id);
  const handleSignal = () => {
    releaseLock();
    process.exit(0);
  };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
  try {
    const bus = new BusClient(options.server, options.token);
    // W0.5: record the server's build next to our own and announce both ONCE per daemon start,
    // before the first poll. A failed /v1/version fetch is recorded, never fatal: the bus
    // token check and the first poll already gate startup.
    serverBuild = await fetchServerBuild(options.server);
    // #18: and the version of the `vinci` binary this daemon will spawn (never fatal either).
    vinciBinary = vinciBinaryVersion();
    await bus.post(
      "status",
      `worker ${options.id} online`,
      `worker_build=${formatWorkerBuild(workerBuild)} worker_version=${version} server_build=${formatServerBuild(serverBuild)} vinci_binary=${formatVinciBinary(vinciBinary)}`,
    );
    // A change since the last announced binary (e.g. an update while the daemon was down, or a
    // change whose post failed before a restart) is announced here, once.
    await announceBinaryChange(bus, options.stateDir, options.id);
    do {
      let cursor = loadCursor(options.stateDir, options.id);
      const messages = await bus.poll(options.id, cursor);
      for (const message of messages) {
        if (!(await processHandoff(bus, options.stateDir, message, options.governor, options.id))) continue;
        cursor = advanceCursor(cursor, message);
        saveCursor(options.stateDir, options.id, cursor);
      }
      if (!options.once) await new Promise((resolveWait) => setTimeout(resolveWait, options.pollSeconds * 1000));
    } while (!options.once);
  } finally {
    process.off("SIGTERM", handleSignal);
    process.off("SIGINT", handleSignal);
    releaseLock();
  }
}

main().catch((error) => {
  process.stderr.write(`vinci worker: ${error.message}${error?.cause ? ` (cause: ${error.cause.code ?? error.cause.message})` : ""}\n`);
  process.exitCode = error?.exitCode ?? 1;
});
