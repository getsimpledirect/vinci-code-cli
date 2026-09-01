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
import { replayPending } from "./outbox.mjs";

import { BusClient, isLedgerRef } from "./bus.mjs";
import { command, finalState, noCommitOutcome, prepareRepository, publish, readHead, runVinci } from "./run.mjs";
import { childEnv, DEFAULT_DISK_FLOOR_MB, DEFAULT_KEEP_ATTEMPTS, markEvidenceUploaded, prepareCleanRoom, pruneAttempts, publishFromCache, sealAttemptDir } from "./cleanroom.mjs";
import { assertTaskId, contractTag, DEFAULT_ALLOWED_PROVIDERS, isDigestHandoff, loadModelClasses, materializeEnvelope, parseAllowedProviders, parseEnvelope, parseHandoffTriple, providerAllowed, TaskLifecycle, vinciBinaryRecord } from "./task.mjs";
import { claimGovernorPaths, tightenEnvelopeLimits, unattendedPolicyEnv } from "./governor.mjs";
import { DECLARATION_REFRESH_DEFAULT_S, LEASE_TIMEOUT_MS, LeaseClient, buildDeclaration, declarationBody, declarationDigest, leaseSubject, releaseOutcome, startHeartbeat } from "./lease.mjs";
import { BranchLeaseClient, branchLeaseFence } from "./branch-lease.mjs";
import { composeFences } from "./publisher.mjs";
import { readSessionState, summarizeUnattendedPolicy } from "./session-read.mjs";
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

// Wave 1B D1: the capability declaration this daemon posts at startup (behind `--governor`) and
// whose digest every governed lease request and task record carries. Null until `--governor` is
// configured.
let capabilityDeclaration = null;
let capabilityDeclarationDigest = null;

// D1 (#199 review): the Governor EXPIRES a declaration at VGC_DECLARATION_MAX_AGE_S (default
// 86400 s) and then answers admission with `eligible: false, reason: stale_declaration`. A daemon
// that declared only at startup therefore goes silently inadmissible for ALL work after a day
// alive, with no warning and no recovery short of a restart. So the declaration is re-posted on an
// interval comfortably below that max age, overridable with VINCI_DECLARATION_REFRESH_S (a
// positive number of seconds; anything else falls back to the default). The timer is unref'd, so
// it never keeps an otherwise-idle process alive — `--once` still exits.
//
// WHY 6h AND NOT 1h — the binding constraint is RETENTION, not liveness (gpu-control §32). The
// Governor's `worker_declarations` table is append-only and carries a DELETE trigger, and each
// refresh writes an audit row in the same transaction. Hourly is ~8,760 rows/worker/year (~17,500
// across the fleet's two) and, because the trigger forbids DELETE, that volume CANNOT BE PRUNED
// LATER — bounding it after the fact would need a compaction path with its own contract section.
// So the interval is chosen against row growth, and the staleness window only sets the ceiling:
// at 6h a declaration is refreshed FOUR times inside the 24h window, i.e. three consecutive
// failed re-posts can be absorbed before one goes stale, at a quarter the rows. There is no
// liveness argument for going faster — the failure this exists to prevent (a daemon alive >24h
// going silently inadmissible) is prevented identically at 1h and at 6h.
//
// If you are about to lower this: the number you are trading against is rows in an append-only
// table with no prune path, not a heartbeat budget. Raising it above ~21600 eats the failure
// headroom instead; REFRESH_HEADROOM_FACTOR below is the invariant that keeps both honest.
// The numbers themselves live in lease.mjs so a test can import them: this file runs main() at
// import time and cannot be loaded from a test.

// Consecutive failed re-posts, reset by the next success. Surfaced on stderr; a failure never
// changes the daemon's control flow.
let declarationPostFailures = 0;

function declarationRefreshSeconds(env = process.env) {
  const configured = Number(env.VINCI_DECLARATION_REFRESH_S);
  return Number.isFinite(configured) && configured > 0 ? configured : DECLARATION_REFRESH_DEFAULT_S;
}

// The ONE code path that builds, digests and posts the declaration — used by the startup post and
// by every refresh, so an unchanged daemon re-posts a byte-identical body under an identical
// digest. Returns true on a posted declaration. `throwOnFailure` is set only for the startup post,
// where a bus that refuses the very first declaration is a start-up failure; a refused REFRESH is
// logged and swallowed, because losing one re-post must never kill a daemon that is working.
async function postCapabilityDeclaration(bus, options, { throwOnFailure = false } = {}) {
  capabilityDeclaration = buildDeclaration({
    workerId: options.id,
    workerVersion: vinciBinary?.version ?? version,
    adapterVersion: version,
    // Config-derived: evidence bundles exist only when an upload prefix is configured.
    structuredEvidence: Boolean(process.env.VINCI_EVIDENCE_URI_PREFIX),
  });
  capabilityDeclarationDigest = declarationDigest(capabilityDeclaration);
  try {
    await bus.post("status", `worker ${options.id} declaration`, declarationBody(capabilityDeclaration));
    declarationPostFailures = 0;
    return true;
  } catch (error) {
    if (throwOnFailure) throw error;
    declarationPostFailures += 1;
    process.stderr.write(
      `vinci worker: declaration re-post failed (${declarationPostFailures} in a row): ${error.message}; the Governor expires a declaration at VGC_DECLARATION_MAX_AGE_S and will report stale_declaration until one lands\n`,
    );
    return false;
  }
}

// Wave 1B F7: every lease this daemon currently holds, so a SIGTERM/SIGINT can release each one
// (`abandoned`) before the process exits. Entries are added right after acquire and removed by
// the task's own release; the set is empty whenever no governed task is in flight.
const activeLeases = new Set();

// The same promise for §36 branch leases, raised in adversarial review of #43:
// activeLeases holds only Governor work-leases, so a SIGTERM left a branch
// lease held until its TTL expired (default 3600s) and blocked every other
// writer on (repo, branch) for an hour after the daemon was already gone. A
// lease that outlives the process holding it is a stall, not a leak.
// Entries are {client, lease} added right after acquire and removed by the
// task's own release.
const activeBranchLeases = new Set();

async function releaseActiveBranchLeases(signal) {
  for (const entry of [...activeBranchLeases]) {
    activeBranchLeases.delete(entry);
    const l = entry.lease || {};
    process.stderr.write(`vinci worker: ${signal}: releasing branch lease ${l.repo}#${l.branch} gen ${l.fencing_generation}\n`);
    try {
      await entry.client.release({ repo: l.repo, branch: l.branch, fencingGeneration: l.fencing_generation });
    } catch (error) {
      // Shutdown must not be blocked by a release that cannot complete; the
      // TTL is the backstop. Say so rather than exiting silently.
      process.stderr.write(`vinci worker: ${signal}: branch lease release failed (${error.message}); it will expire at TTL\n`);
    }
  }
}

// Bounded shutdown of every active lease: stop the heartbeat, wait for a renew in flight, release
// `abandoned`, then SIGTERM the child so nothing keeps working under a released lease. The whole
// thing is capped at LEASE_TIMEOUT_MS per lease (the release post itself has the same cap) so a
// hung Governor cannot keep the daemon alive after a stop request.
async function releaseActiveLeases(signal) {
  for (const entry of [...activeLeases]) {
    activeLeases.delete(entry);
    entry.heartbeat?.stop();
    process.stderr.write(`vinci worker: ${signal}: releasing lease ${entry.lease.lease_id} (task ${entry.taskId}) as abandoned\n`);
    let bound = null;
    const deadline = new Promise((resolveDeadline) => {
      bound = setTimeout(() => resolveDeadline({ ok: false, timeout: true }), LEASE_TIMEOUT_MS);
      if (typeof bound?.unref === "function") bound.unref();
    });
    const release = (async () => {
      if (entry.heartbeat) await entry.heartbeat.settled();
      return entry.client.release(entry.lease, "abandoned");
    })();
    const result = await Promise.race([release, deadline]);
    clearTimeout(bound);
    if (result?.timeout) process.stderr.write(`vinci worker: ${signal}: lease ${entry.lease.lease_id} release did not complete within ${LEASE_TIMEOUT_MS} ms\n`);
    entry.abortController?.abort(`daemon_${signal.toLowerCase()}`);
  }
}

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
  return "Usage: vinci worker start --id <id> --server <url> [--once] [--poll-seconds 60] [--state-dir <dir>] [--governor <url>] [--require-governor] [--clean-room] [--disk-floor-mb 2048] [--keep-attempts 3] (provider policy: VINCI_WORKER_ALLOWED_PROVIDERS=openrouter,...)";
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
    allowedProviders: parseAllowedProviders(
      env.VINCI_WORKER_ALLOWED_PROVIDERS === undefined
        ? DEFAULT_ALLOWED_PROVIDERS
        : env.VINCI_WORKER_ALLOWED_PROVIDERS,
    ),
    // W1 clean room (cleanroom.mjs). OFF by default this wave; `--clean-room` or
    // VINCI_WORKER_CLEAN_ROOM=1 turns it on. The disk floor and retention only apply to it.
    cleanRoom: env.VINCI_WORKER_CLEAN_ROOM === "1",
    // F8: an env value is parsed exactly like its flag — "0" is an explicit disable of the disk
    // floor, not "use the default"; an unparsable value is refused, not silently defaulted.
    diskFloorMb: env.VINCI_WORKER_DISK_FLOOR_MB === undefined || env.VINCI_WORKER_DISK_FLOOR_MB === "" ? DEFAULT_DISK_FLOOR_MB : Number(env.VINCI_WORKER_DISK_FLOOR_MB),
    keepAttempts: env.VINCI_WORKER_KEEP_ATTEMPTS === undefined || env.VINCI_WORKER_KEEP_ATTEMPTS === "" ? DEFAULT_KEEP_ATTEMPTS : Number(env.VINCI_WORKER_KEEP_ATTEMPTS),
  };
  const seen = new Set();
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--once" || argument === "--require-governor" || argument === "--clean-room") {
      if (seen.has(argument)) throw new Error(`duplicate option: ${argument}`);
      seen.add(argument);
      if (argument === "--once") options.once = true;
      else if (argument === "--clean-room") options.cleanRoom = true;
      else options.requireGovernor = true;
      continue;
    }
    if (!["--id", "--server", "--poll-seconds", "--state-dir", "--governor", "--disk-floor-mb", "--keep-attempts"].includes(argument)) {
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
    else if (argument === "--disk-floor-mb") options.diskFloorMb = Number(value);
    else if (argument === "--keep-attempts") options.keepAttempts = Number(value);
    else options.pollSeconds = Number(value);
  }
  if (!Number.isFinite(options.diskFloorMb) || options.diskFloorMb < 0) throw new Error("--disk-floor-mb / VINCI_WORKER_DISK_FLOOR_MB must be a non-negative number (0 disables the floor)");
  if (!Number.isInteger(options.keepAttempts) || options.keepAttempts < 1) throw new Error("--keep-attempts / VINCI_WORKER_KEEP_ATTEMPTS must be a positive integer");
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
// The typed outcome MIRRORS the lifecycle state rather than inventing a second vocabulary for
// the same fact: two names for one outcome is how a record and its own body come to disagree.
// REFUSED is reserved for a rejection that happens BEFORE any lifecycle exists (a task id that
// will not parse), which is the one case with no lifecycle state to mirror.
function terminalOutcome(lifecycleState) {
  if (lifecycleState === "COMPLETED") return "COMPLETED";
  if (lifecycleState === "FAILED") return "FAILED";
  if (lifecycleState === "BLOCKED") return "BLOCKED";
  // finalState's default: the run produced something and nothing assessed it. Not a success and
  // not a failure, but emphatically a TERMINAL, so it carries a type like every other one.
  if (lifecycleState === "UNVERIFIED") return "UNVERIFIED";
  return null;
}

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
  // W2: never collapse the three profile outcomes into one field. A run that PROCEEDED past a
  // confirmation and a run that never met one look identical without this, which is exactly the
  // downstream ambiguity the profile exists to remove; escalations name their sites so a reader can
  // see WHAT needed authorizing without opening the bundle.
  const policy = state.unattended_policy;
  const policyDetails = policy
    ? [
        `unattended_policy=governed`,
        `policy_blocked=${policy.blocked}`,
        `policy_escalated=${policy.escalated}`,
        `policy_proceeded=${policy.proceeded}`,
        policy.escalated > 0 ? `policy_escalated_sites=${policy.sites.escalated.join(",")}` : undefined,
        policy.proceeded > 0 ? `policy_proceeded_sites=${policy.sites.proceeded.join(",")}` : undefined,
        policy.blocked > 0 ? `policy_blocked_sites=${policy.sites.blocked.join(",")}` : undefined,
      ]
    : [];
  const details = [
    `state=${state.state}`,
    `exit_code=${state.exit_code}`,
    `cost_usd=${Number(state.cost_usd).toFixed(6)}`,
    state.limit_tripped ? `limit=${state.limit_tripped}` : undefined,
    state.head ? `head=${state.head}` : undefined,
    state.pr ? `pr=${state.pr}` : undefined,
    ...policyDetails,
    contractTag(state),
    ...evidenceDetails,
  ]
    .filter(Boolean)
    .join(" ");
  const body = terminalPostBody(details);
  const options = { inReplyTo: message.message_id };
  const outcome = terminalOutcome(state.state);
  if (outcome !== null) options.outcome = outcome;
  if (state.state === "COMPLETED" && isLedgerRef(envelope.ref)) {
    options.refs = [envelope.ref];
    await bus.postTerminal("finding", subject, body, options);
  } else if (state.state === "BLOCKED" && state.harness_stop) {
    // An instrument stop: the harness refused the agent's work mid-run. Say so explicitly so the
    // soak ledger attributes the block to the instrument, not to the model's own narrative.
    const stop = state.harness_stop;
    await bus.postTerminal(
      "status",
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
    await bus.postTerminal("status", subject, terminalPostBody(reason), options);
  } else {
    const statusBody = state.outcome?.reason
      ? terminalPostBody(`${details} reason=${state.outcome.reason}`)
      : body;
    // postTerminal, not post: this branch is reached for UNVERIFIED, which is a terminal and
    // must carry a type. Using the untyped post here was the one path that could still emit a
    // terminal with a null outcome -- the fail-open this contract exists to remove.
    await bus.postTerminal("status", subject, statusBody, options);
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
        // The registry is a PINNED endpoint on the configured server. A redirect would move the
        // contract fetch (and the bearer token) to a host nobody named, so a 3xx is an error
        // here, never something to follow.
        redirect: "error",
      });
    } catch (error) {
      // `??` binds TIGHTER than `?:`, so the obvious spelling
      //   error?.cause?.code ?? error.name === "AbortError" ? A : B
      // parses as `(error?.cause?.code ?? (error.name === "AbortError")) ? A : B` — any truthy
      // cause code (ECONNREFUSED, ENOTFOUND, …) then selects A and EVERY connection failure was
      // reported as "timed out after N ms". The abort test comes first, explicitly parenthesised.
      const why = error?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : (error?.cause?.code ?? error.message);
      throw new Error(`registry_unavailable: governor contracts fetch failed: ${why}`);
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

async function processHandoff(
  bus,
  stateDir,
  message,
  governorUrl,
  workerId,
  { fence: injectedFence = null, cleanRoom = null, allowedProviders = parseAllowedProviders(), subjectOf = leaseSubject } = {},
) {
  // Known before the run: clean-room publication cannot safely hold a Governor or branch fence
  // because its cache publisher does not enforce either fence.
  const branchLeaseEnabled =
    process.env.VINCI_BRANCH_LEASE === "1" && Boolean(bus?.serverUrl) && Boolean(bus?.token);
  const taskId = message.message_id;
  try {
    assertTaskId(taskId);
  } catch (error) {
    // NOTE-4: this refusal fires before the body is ever looked at, so no triple has been parsed
    // — but a DIGEST handoff's terminal post must still carry a contract= tag, or a reader
    // filtering the ledger for contract posts silently loses it. Same fallback the unparseable
    // triple uses: `contract=malformed`. A prose handoff keeps its untagged body byte for byte.
    const fallback = isDigestHandoff(message.body) ? "contract=malformed" : null;
    await bus.postTerminal("status", `task ${taskId} refused`, blockerPostBody(null, error.message, fallback), {
      inReplyTo: message.message_id,
      outcome: "REFUSED",
    });
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
      // NOTE-3: ONE source for the bus credential. The token is read from the environment once
      // (parseArgs) and carried on the bus; re-reading process.env here was a second source for
      // one secret — equal today, and silently divergent the moment anything rotates it in-process.
      const registry = await fetchWorkOrderRegistry(bus.serverUrl, bus.token, triple.work_order_id);
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
      await bus.postTerminal("status", `task ${taskId} blocked`, blockerPostBody(triple ?? null, `state=BLOCKED reason=${reason}`, "contract=malformed"), {
        inReplyTo: message.message_id,
        outcome: "BLOCKED",
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
      await bus.postTerminal("status", `task ${taskId} ${state.toLowerCase()}`, terminalPostBody(`state=${state} reason=${error.message}`), {
        inReplyTo: message.message_id,
        outcome: terminalOutcome(state),
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
    // WARN-3: name the field that actually tripped. `budgetMicrousd: 0` is a legal spec upstream
    // and blocks here; a reason that only listed all three fields left the operator to guess
    // which one they had to fix.
    const why = limit === "deadline"
      ? `deadline ${envelope.deadline} is not in the future`
      : `${limit} must be greater than zero, got ${limit === "budget_usd" ? envelope.budget_usd : envelope.max_runtime_s}`;
    lifecycle.transition("BLOCKED", { limit_tripped: limit, outcome: { reason: `invalid_bounds: ${why}` } });
    await bus.postTerminal("status", `task ${taskId} blocked`, blockerPostBody(lifecycle.snapshot(), `invalid_bounds budget_usd=${envelope.budget_usd} max_runtime_s=${envelope.max_runtime_s} deadline=${envelope.deadline ?? "none"}`), {
      inReplyTo: message.message_id,
      outcome: "BLOCKED",
    });
    return true;
  }

  // Prose handoff: only deadline is checked (budget and runtime have safe defaults from parseEnvelope).
  if (!contractFields && envelope.deadline && Date.parse(envelope.deadline) <= Date.now()) {
    lifecycle.transition("BLOCKED", { limit_tripped: "deadline", outcome: { reason: "deadline is in the past" } });
    await bus.postTerminal("status", `task ${taskId} blocked`, blockerPostBody(lifecycle.snapshot(), "deadline is in the past"), { inReplyTo: message.message_id, outcome: "BLOCKED" });
    return true;
  }

  // F5: refuse before clone, lease acquisition or spawn. Credential presence is not authority to
  // select a provider, and env pruning alone cannot police stored auth or future credential
  // sources. The explicit operator allowlist is the provider decision.
  if (!providerAllowed(envelope.provider, allowedProviders)) {
    const allowed = [...allowedProviders].sort().join(",");
    const reason = `provider_not_allowed: provider ${envelope.provider} is outside VINCI_WORKER_ALLOWED_PROVIDERS=${allowed}`;
    lifecycle.transition("BLOCKED", { outcome: { reason } });
    await bus.postTerminal("status", `task ${taskId} blocked`, terminalPostBody(reason), {
      inReplyTo: message.message_id,
      outcome: "BLOCKED",
    });
    return true;
  }

  // A non-main base_ref is honoured by EITHER of two mechanisms, and refused only when neither
  // is present. A digest handoff carries base_ref + base_commit and is handled by
  // prepareRepository (#23/#46); clean-room mode threads the pinned base through its own checkout
  // and publisher (#44). Shared mode with a prose envelope has neither: prepareRepository forks
  // every branch off origin/main, so a PR against another base would not share its fork point.
  //
  // COMPOSITION NOTE: #46 keyed this guard on `contractFields` and #44 keyed it on `cleanRoom`,
  // each exempting the mechanism its own branch built. Requiring BOTH (the naive conflict
  // resolution) blocks two cases the composed tree can genuinely serve, and each branch's test
  // proves it: worker-handoff-triple (digest, shared) and worker-typed-terminals (prose,
  // clean room). Requiring EITHER is the correct composition and is still closed by default.
  if (!contractFields && !cleanRoom && envelope.base_ref !== undefined && envelope.base_ref !== "main") {
    const reason = `base_ref_unsupported: base_ref ${envelope.base_ref} is not main; a prose handoff does not pin the commit to fork from`;
    lifecycle.transition("BLOCKED", { outcome: { reason } });
    await bus.postTerminal("status", `task ${taskId} blocked`, terminalPostBody(reason), {
      inReplyTo: message.message_id,
      outcome: "BLOCKED",
    });
    return true;
  }

  // #25 x #24. publishFromCache is a fork of the PRE-#25 publisher: besides the
  // fence it lacks the remote-sha sample + --force-with-lease, the push read-back,
  // the alreadyOnRemote idempotent retry (which IS #25's crash-window guarantee,
  // and the clean room is the mode where that window was measured), the foreign-PR
  // refusal and the PR-head check. So under --clean-room a governed run would
  // publish through a path with none of the guarantees the Governor is being told
  // are in force. Refused here, BEFORE the model is spawned, so an unsupported
  // configuration costs nothing rather than producing a paid commit that can never
  // be published. The fix is to route the clean room through publisher.publish()
  // with repoDir = cacheDir (threading the cache's own pushurl/hooks refusal), not
  // to teach this fork a fence.
  //
  // #26 wires the fence, so this guard now BITES and is exercised
  // (worker-clean-room-fence.mjs). Its predicate is `governorUrl`, not `fence`: the fence object
  // closes over a lease acquired further down, so it does not exist yet at this point, and
  // `cleanRoom && fence` would have stayed permanently false — a refusal that reads as enforced
  // and never fires. A configured Governor is exactly "a fence will be in force", and it is known
  // BEFORE the run, which is what this guard promises.
  // Branch leases join this guard for the same reason, found in adversarial
  // review of #43: publishFromCache() takes NO fence parameter and does a raw
  // `git push --no-verify`. Acquiring a branch lease and then publishing
  // through that path is worse than not taking one -- it blocks every other
  // writer on (repo, branch) and does not honour the lease itself. Refuse
  // before the run rather than hold authority we do not enforce.
  if (cleanRoom && (governorUrl || branchLeaseEnabled)) {
    const which = governorUrl && branchLeaseEnabled ? "a Governor fence or a branch lease"
      : governorUrl ? "a Governor fence" : "a branch lease";
    const reason = "clean_room_publish_unsupported: --clean-room publishes from the bare cache, which does not honour " + which + " and lacks the idempotent-retry, lease, read-back, foreign-PR and PR-head guarantees of the standard publisher; refusing before the run rather than publishing under guarantees that are not in force";
    lifecycle.transition("BLOCKED", { outcome: { reason } });
    await bus.postTerminal("status", `task ${taskId} blocked`, terminalPostBody(reason), { inReplyTo: message.message_id, outcome: "BLOCKED" });
    return true;
  }

  if (attempt.firstAttempt) {
    await bus.post("status", `task ${taskId} claimed`, `claimed ${taskId} attempt ${attempt.attempt}`, {
      inReplyTo: message.message_id,
    });
  }

  // Wave 1B: the lease held for this attempt (null until acquired), its heartbeat, and the
  // loss-of-authority latch. `release` runs on EVERY terminal path (L4); it never throws.
  let leaseClient = null;
  let lease = null;
  let heartbeat = null;
  let authorityLost = null;
  // Set when a fence said `valid: false` (the generation is stale for the Governor even though
  // the heartbeat had not yet noticed): the release outcome is then `abandoned`, like a loss.
  let fencedOutReason = null;
  const abortController = new AbortController();
  let leaseEntry = null;
  // §36 branch lease. Declared HERE, above releaseLease, because releaseLease
  // runs on paths that precede acquisition (the clone-time BLOCKED exits) and a
  // `let` declared later would be in its temporal dead zone -- a ReferenceError
  // on the failure path only, which is the half nobody exercises by hand.
  let branchLease = null;
  let branchFence = null;
  let branchLeaseEntry = null;
  // Same server and token as the bus: /v1/branch-leases takes the collector or
  // admin principal, which is what the bus token already is.
  //
  // EXPLICIT OPT-IN (VINCI_BRANCH_LEASE=1), and the reason is measured, not
  // cautious. An earlier revision of this defaulted ON, reasoning that a gate
  // which is off by default is the inert guard §36.5 describes. Running the
  // suite refuted it: all four variants of worker-no-commit-outcome failed and
  // the process hung, because defaulting ON makes every existing caller perform
  // a new network call, and a fail-closed acquire against an unreachable server
  // correctly BLOCKS the attempt. That is the right behaviour and the wrong
  // default -- on the live push path it would refuse real work whenever the
  // control server blinked.
  //
  // This is NOT left inert: the deploy sets it (deploy/worker-box), and F5's W0
  // cohort is where it gets switched on and observed. A gate nobody enables is
  // still the defect; the fix is to enable it deliberately and prove it bit,
  // not to enable it by surprise under everyone already running.
  const branchLeases = branchLeaseEnabled ? new BranchLeaseClient(bus.serverUrl, bus.token) : null;
  const releaseLease = async (state) => {
    // The branch lease is released even when there is no work lease: the two are
    // independent, and an ungoverned worker still holds a branch.
    await releaseBranchLease();
    if (!lease || !leaseClient) return;
    if (leaseEntry) activeLeases.delete(leaseEntry);
    // F5: stop the heartbeat AND wait for a renew already in flight, so the Governor never sees
    // a renew arrive after the release for the same generation.
    if (heartbeat) {
      heartbeat.stop();
      await heartbeat.settled();
    }
    const held = lease;
    lease = null;
    await leaseClient.release(held, releaseOutcome(state, { authorityLost: Boolean(authorityLost || fencedOutReason) }));
  };
  // Released on EVERY terminal, by riding the work-lease release, which already
  // covers the success path (933) and both failure paths (939, 943) as well as
  // the three early BLOCKED exits. A branch lease that outlives its attempt
  // blocks the next writer until it expires, so the failure to release is a
  // stall, not a leak -- and it must never be able to fail the attempt it is
  // cleaning up after, hence the swallow. It is recorded, not silent.
  const releaseBranchLease = async () => {
    if (!branchLeases || !branchLease) return;
    const held = branchLease;
    branchLease = null;
    branchFence = null;
    if (branchLeaseEntry) { activeBranchLeases.delete(branchLeaseEntry); branchLeaseEntry = null; }
    try {
      await branchLeases.release({
        repo: held.repo,
        branch: held.branch,
        fencingGeneration: held.fencing_generation,
      });
    } catch (error) {
      process.stderr.write(`vinci worker: branch lease release failed (${held.repo}#${held.branch} gen ${held.fencing_generation}): ${error.message}\n`);
    }
  };
  // L3: the publisher's fence, in publisher.mjs's shape — `{ generation, check({stage}) }`.
  //
  // GENERATION IS A GETTER, not a captured value. The object is built once, before the lease
  // exists, and lives across the whole attempt; `publisher.prBodyFooter` reads `fence.generation`
  // at PR-creation time, minutes after construction. A snapshot taken here would be `undefined`
  // (no lease yet) and would stay wrong for the life of the run. Today the generation cannot
  // change mid-attempt — `startHeartbeat` mutates only expires_at/ttl_s/renewals on a renew, and a
  // new generation would require a new acquire, of which there is exactly one per attempt — so a
  // snapshot taken AFTER the acquire would happen to be right. The getter is used anyway because
  // that property is an invariant of code elsewhere, not of this line: if a renew ever starts
  // returning a new generation, a snapshot silently keeps fencing on the old one, and a fence that
  // carries a stale generation is a fence that passes when it should not. Reading through to the
  // live lease cannot go stale by construction.
  //
  // `check` never throws in normal operation — no lease, or authority already lost, is answered
  // `{valid:false}` directly. It is safe if it ever does: publisher.checkFence catches and maps a
  // throw to `{valid:false}` (fenced out), which is the fail-closed direction.
  const fence = injectedFence ?? {
    get generation() {
      return lease?.fencing_generation ?? null;
    },
    check: async ({ stage } = {}) => {
      const verdict = !lease || !leaseClient
        ? { valid: false, reason: "no lease held" }
        : authorityLost
          ? { valid: false, reason: authorityLost }
          : await leaseClient.check(lease);
      lifecycle.record({ lease: { ...lifecycle.snapshot().lease, checks: [...(lifecycle.snapshot().lease?.checks ?? []), { effect: stage ?? null, valid: verdict.valid, reason: verdict.reason ?? null, at: new Date().toISOString() }] } });
      return verdict;
    },
  };

  try {
    // Stage 2: Governor lease (if configured). FAIL-CLOSED (W0.1): with a Governor URL set,
    // the task proceeds to clone/spawn ONLY on a granted lease. A missing token, an
    // unreachable Governor, a network error, a non-JSON body, an unexpected status, or a
    // missing decision all BLOCK the task here, before prepareRepository and runVinci.
    let envelopeToUse = envelope;
    // W2: the governed unattended policy profile. Default is "no profile" — the delta returned for a
    // falsy lease explicitly DELETES both variables, so the child of an ungoverned run cannot inherit
    // the profile from the daemon's environment. It is reassigned in exactly one place: after a
    // GRANTED lease, a few lines below.
    let unattendedPolicy = unattendedPolicyEnv(null);
    if (governorUrl) {
      const governorToken = process.env.VINCI_GOVERNOR_TOKEN;
      // Wave 1B L1 (F4): the work-order lease FIRST, then the path claim. The Governor has no
      // endpoint that releases a path claim, so a claim taken before a refused lease would be
      // held until its ttl for a task this worker never runs; acquiring the lease first means a
      // refused/unavailable lease leaves nothing claimed. A 409 "leased" is a Governor decision
      // that the task is not ours (BLOCKED, not a failure); anything else that is not a usable
      // lease is `lease_unavailable` (fail closed). A refused path claim after a granted lease
      // releases the lease (`blocked`) before the task is BLOCKED.
      leaseClient = new LeaseClient({ governorUrl, token: governorToken, busToken: bus.token });
      // ONE attempt identity for this attempt, computed once and reused by BOTH governed calls.
      // The Governor's holder gate compares the claim's attempt_id against the lease holder's, so
      // the two strings must be byte-identical; deriving it twice is how they drift apart.
      const attemptId = `${taskId}/${attempt.attempt}`;
      const acquired = await leaseClient.acquire({
        workOrderId: subjectOf({ id: taskId, envelope: envelopeToUse }),
        attemptId,
        workerBuildDigest: workerBuild.commit ?? formatWorkerBuild(workerBuild),
        adapterVersion: version,
        capabilityDeclarationDigest,
      });
      if (!acquired.success) {
        // Three classifications, never conflated (the same rule the path claim already follows):
        //   leased      a Governor DECISION naming another holder
        //   refused     a Governor DECISION about the order itself (expired, revoked, deadline...)
        //   unavailable no decision at all — unreachable, malformed, unexpected status
        const decided = acquired.leased || acquired.refused;
        const reason = decided ? acquired.reason : `lease_unavailable: ${acquired.reason}`;
        const governor = acquired.leased ? "leased" : acquired.refused ? "refused" : "unavailable";
        const label = acquired.leased ? "Governor lease held elsewhere" : acquired.refused ? "Governor refused the lease" : "Governor lease unavailable";
        lifecycle.transition("BLOCKED", { outcome: { reason, governor } });
        await bus.postTerminal("status", `task ${taskId} blocked`, blockerPostBody(lifecycle.snapshot(), `${label}: ${reason}`), {
          inReplyTo: message.message_id,
          outcome: "BLOCKED",
        });
        return true;
      }
      lease = acquired.lease;
      lifecycle.record({ lease: { ...lease }, capability_declaration_digest: capabilityDeclarationDigest });
      // L2: heartbeat every ttl_s/3 from now (the path claim and the clone count) until release.
      // The first failed renew is LOSS OF AUTHORITY: latch it, abort the child (SIGTERM, SIGKILL
      // after the grace), and let the run's normal exit path classify the task as BLOCKED lease_lost.
      heartbeat = startHeartbeat({
        client: leaseClient,
        lease,
        onLoss: (lossReason, detail) => {
          authorityLost = `lease_lost:${lossReason}`;
          process.stderr.write(`vinci worker: task ${taskId} lost its lease (${lossReason}${detail ? `: ${detail}` : ""}); terminating the run\n`);
          abortController.abort(authorityLost);
        },
      });
      leaseEntry = { client: leaseClient, lease, heartbeat, abortController, taskId };
      activeLeases.add(leaseEntry);

      // Stage 2 path claim, under the lease. FAIL-CLOSED (W0.1): the task proceeds to
      // clone/spawn ONLY on a granted claim. A missing token, an unreachable Governor, a network
      // error, a non-JSON body, an unexpected status, or a missing decision all BLOCK the task
      // here, before prepareRepository and runVinci.
      // Same `attemptId` string the acquire above sent: this claim is made UNDER that lease, and
      // the Governor refuses a claim whose attempt_id is not the holder's (an absent one included).
      const claimResult = await claimGovernorPaths({
        governorUrl,
        token: governorToken,
        paths: [envelope.claim],
        attemptId,
      });

      if (!claimResult?.success) {
        // Two classifications, never conflated: a REFUSAL is a Governor decision (403/409/422,
        // rule text verbatim); everything else is the Governor being unavailable or its answer
        // being unusable. Both BLOCK; the soak ledger attributes them differently.
        const reason = claimResult?.reason ?? "governor returned no lease decision";
        const governor = claimResult?.refused === true ? "refused" : "unavailable";
        const label = governor === "refused" ? "Governor refused the lease" : "Governor unavailable/invalid";
        lifecycle.transition("BLOCKED", { outcome: { reason, governor }, lease: { ...lifecycle.snapshot().lease, ...lease } });
        await releaseLease("BLOCKED");
        // F8: on the digest path this post carries contract=<id>@<digest8> like every other.
        await bus.postTerminal("status", `task ${taskId} blocked`, blockerPostBody(lifecycle.snapshot(), `${label}: ${reason}`), {
          inReplyTo: message.message_id,
          outcome: "BLOCKED",
        });
        return true;
      }

      // Claim granted: tighten the envelope (budget, max_runtime_s, deadline, and the claim
      // ttl as a runtime cap) and record the claim next to the lease plus the effective runtime limit.
      envelopeToUse = tightenEnvelopeLimits(envelopeToUse, claimResult);
      // The ONLY place the profile is turned on. Reaching this line means claimGovernorPaths()
      // returned success with a valid ttl — i.e. a Governor lease actually backs this run.
      unattendedPolicy = unattendedPolicyEnv(claimResult);
      lifecycle.record({
        lease: { ...lifecycle.snapshot().lease, ...claimResult, effective_max_runtime_s: envelopeToUse.max_runtime_s },
        unattended_policy_profile: unattendedPolicy.VINCI_UNATTENDED_POLICY ?? null,
      });
    }

    // W1 clean room: a fresh worktree per attempt from a per-org/repo bare cache, an allowlisted
    // child env, and publishing from the cache. Shared-checkout mode is byte-for-byte the old path.
    const repository = cleanRoom
      ? await prepareCleanRoom({
          stateDir,
          repo: envelopeToUse.repo,
          taskId,
          attempt: attempt.attempt,
          branchOverride: envelopeToUse.branch,
          baseRef: envelopeToUse.base_ref,
          diskFloorBytes: cleanRoom.diskFloorMb * 1048576,
        })
      : await prepareRepository(
          stateDir,
          envelopeToUse.repo,
          taskId,
          envelopeToUse.branch,
          envelopeToUse.base_commit,
          contractFields ? contractFields.base_ref : envelopeToUse.base_ref,
          attempt.attempt,
          contractFields ? contractFields.execution_spec_digest : undefined,
        );
    if (repository.debrisReceipt) lifecycle.record({ debris_receipt: repository.debrisReceipt });
    lifecycle.record({
      ...(attempt.firstAttempt ? { base_commit: repository.baseCommit ?? null } : {}),
      ...(cleanRoom
        ? {
            attempt_dir: repository.attemptDir,
            cache_ref: repository.cacheRef,
            stale_ref: repository.staleRef,
          }
        : {}),
    });
    // --- §36 branch lease: claim (repo, branch) for the whole attempt ---------
    // Acquired HERE, not immediately before the push: the guarantee §36 sells is
    // one writer per branch, and a lease taken at push time leaves the whole run
    // unprotected. head_sha is the base commit, which is what makes the detector
    // work -- a later observation of a different head while this lease is live is
    // a foreign write, reported without this lane's cooperation.
    //
    // Refusal is a REFUSAL, not a warning: if another lane holds the branch this
    // attempt does not run. That is the entire point, and it is why the failure
    // path below is a terminal transition rather than a log line.
    if (branchLeases) {
      let acquired;
      try {
        acquired = await branchLeases.acquire({
          repo: envelopeToUse.repo,
          branch: repository.branch,
          sessionId: attempt.sessionId,
          attemptId: String(attempt.attempt),
          headSha: repository.baseCommit ?? "",
        });
      } catch (error) {
        // Unreachable server is not permission to write. Refuse and say so.
        acquired = { ok: false, reason: `branch lease unavailable: ${error.message}` };
      }
      if (!acquired.ok) {
        const reason = `branch_lease_refused: ${acquired.reason}`;
        lifecycle.transition("BLOCKED", { outcome: { reason }, publish: "skipped", pr: null, fenced_out: reason });
        await releaseLease("BLOCKED");
        await postFinal(bus, message, envelopeToUse, lifecycle.snapshot(), null);
        return true;
      }
      branchLease = acquired.lease;
      branchLeaseEntry = { client: branchLeases, lease: acquired.lease };
      activeBranchLeases.add(branchLeaseEntry);
      branchFence = branchLeaseFence(branchLeases, {
        repo: envelopeToUse.repo,
        branch: repository.branch,
        fencingGeneration: acquired.lease?.fencing_generation,
      });
      lifecycle.record({ branch_lease: { fencing_generation: acquired.lease?.fencing_generation ?? null, reason: acquired.reason } });
    }

    if (authorityLost) {
      // The lease was lost while cloning: nothing is spawned. BLOCKED lease_lost, no publish,
      // release `abandoned` — a resumed attempt re-acquires.
      lifecycle.transition("BLOCKED", { outcome: { reason: authorityLost }, publish: "skipped", pr: null, fenced_out: authorityLost, lease: { ...lifecycle.snapshot().lease, ...lease } });
      await releaseLease("BLOCKED");
      await postFinal(bus, message, envelopeToUse, lifecycle.snapshot(), null);
      return true;
    }
    // #18: probe the binary IMMEDIATELY before the spawn — after the Governor lease and the clone,
    // which can take long enough for an operator update to land — and stamp the task with it.
    // runVinci spawns with VINCI_UPDATE_DISABLED=1, so nothing can change between this probe
    // and the run: the recorded version is the executed version.
    vinciBinary = vinciBinaryVersion();
    lifecycle.record({ vinci_binary: vinciBinaryRecord(vinciBinary) });
    await announceBinaryChange(bus, stateDir, workerId);
    const providerAgentDir = cleanRoom
      ? undefined
      : join(stateDir, "provider-slots", taskId, String(attempt.attempt), envelopeToUse.provider);
    if (providerAgentDir) mkdirSync(providerAgentDir, { recursive: true, mode: 0o700 });
    lifecycle.transition("RUNNING");
    const run = await runVinci({ envelope: envelopeToUse,
      stateDir,
      taskId, repoDir: repository.repoDir, sessionId: attempt.sessionId,
      // The provider boundary applies on BOTH paths now. It used to be `: undefined` here --
      // inherit every provider key the daemon holds -- so the scoping promise was kept only in
      // clean-room mode, which is itself refused under a Governor.
      env: childEnv({ cleanRoom, provider: envelopeToUse.provider, homeDir: repository.homeDir, tmpDir: repository.tmpDir, agentDir: providerAgentDir }),
      envDelta: unattendedPolicy,
      ...(lease ? { abortSignal: abortController.signal } : {}) });
    const head = await readHead(repository.repoDir);
    if (lease) lifecycle.record({ lease: { ...lifecycle.snapshot().lease, ...lease } });
    lifecycle.record({ ...run, head, outcome: run.outcome ?? null });
    // Loss of authority means no publication. Otherwise compute PR eligibility before opening a
    // PR, while still allowing non-eligible branch results to be pushed as durable evidence.
    const preOutcome = noCommitOutcome({
      head,
      baseCommit: lifecycle.snapshot().base_commit,
      outcome: authorityLost ? { reason: authorityLost } : run.outcome ?? null,
    });
    const prEligible = !authorityLost && finalState({
      exitCode: run.exit_code,
      limitTripped: run.limit_tripped,
      outcome: preOutcome,
      blocker: null,
      pr: true,
      harnessStops: run.harness_stops ?? [],
    }) === "COMPLETED";
    const objective = typeof envelopeToUse.spec === "string" ? envelopeToUse.spec : null;
    const outputMode = envelopeToUse.output ?? "branch";
    const publication = authorityLost
      ? { publish: "skipped", pr: null, fenced_out: authorityLost }
      : cleanRoom && outputMode === "branch"
        ? await publishFromCache({ envelope: envelopeToUse, limitTripped: run.limit_tripped, ...repository, taskId, prEligible, objective })
        : await publish({
            envelope: envelopeToUse,
            limitTripped: run.limit_tripped,
            ...repository,
            taskId,
            attempt: attempt.attempt,
            fence: composeFences(lease ? fence : null, branchFence),
            prEligible,
            objective,
            outcome: prEligible ? "COMPLETED" : null,
            ref: envelopeToUse.ref ?? null,
            baseRef: contractFields?.base_ref ?? envelopeToUse.base_ref,
            baseCommit: contractFields?.base_commit ?? lifecycle.snapshot().base_commit,
          });
    const { patch, artifacts, ...published } = publication;
    if (Array.isArray(artifacts)) published.artifacts = artifacts;
    const extraFiles = {};
    if (typeof patch === "string") extraFiles[`${attempt.attempt}.patch`] = patch;
    if (Array.isArray(artifacts)) {
      extraFiles["artifacts.json"] = `${JSON.stringify({
        base_commit: contractFields?.base_commit ?? lifecycle.snapshot().base_commit ?? null,
        files: artifacts,
      }, null, 2)}\n`;
    }
    const fencedOut = authorityLost ?? published.fenced_out ?? null;
    if (!authorityLost && published.fenced_out) fencedOutReason = published.fenced_out;
    // Build outcome: start with fence/blocker reasons, then augment with no_commit if needed (so both can coexist).
    let outcome = fencedOut ? { reason: fencedOut } : published.blocker_reason ? { reason: published.blocker_reason } : run.outcome ?? null;
    outcome = noCommitOutcome({ head, baseCommit: lifecycle.snapshot().base_commit, outcome });
    const harnessStops = run.harness_stops ?? [];
    const intendedState = fencedOut
      ? "BLOCKED"
      : finalState({
          exitCode: run.exit_code,
          limitTripped: run.limit_tripped,
          outcome,
          blocker: Boolean(published.blocker_reason),
          pr: published.pr,
          harnessStops,
        });
    // Record the instrument stop on the task whenever one occurred — even when exit/limit outranked it
    // — so the snapshot (and the evidence bundle's result.json) carry the machine-observed reason next
    // to the model's narrative and the soak ledger can see that a latch also fired on a FAILED run.
    const harnessStop =
      harnessStops.length > 0 ? { count: harnessStops.length, reason: harnessStops[0].reason } : null;
    // W2: the three profile outcomes, counted separately and carried onto the task record and the
    // terminal post. This is the whole point of the profile: downstream, "the guard refused it",
    // "it was escalated for Governor authorization" and "it was allowed to skip a confirmation"
    // must never be the same signal. `null` when the profile resolved nothing (the normal case,
    // and the ONLY case when the profile is off) so an ordinary run's post is unchanged.
    const unattendedPolicySummary = summarizeUnattendedPolicy(
      run.unattended_policy ?? [],
      unattendedPolicy.VINCI_UNATTENDED_POLICY === "governed",
    );

    // W0.2 evidence before terminal: the terminal state is written only AFTER the evidence
    // bundle was attempted. `planned` is the exact snapshot that will be committed (state +
    // published fields) and is what ships as result.json. No-op when
    // VINCI_EVIDENCE_URI_PREFIX is unset (soak boxes may run without evidence).
    // sessionJsonl: session transcript from <state-dir>/sessions/<task-id>/ (outside the repo).
    // gitDiff is against the task branch base; it may be empty when the run changed nothing.
    // logTail: last 200 lines of the daemon's stderr so the bundle captures how the run ended.
    const planned = lifecycle.plan(intendedState, { ...published, outcome, evidence_error: null, harness_stop: harnessStop, unattended_policy: unattendedPolicySummary });
    // The bundle is built BEFORE anything is committed, so result.json is marked as a
    // pre-terminal snapshot: `state` is the intended state, `committed_state` is null and
    // `terminal` is false. A bundle-alone reader therefore never sees a committed COMPLETED;
    // the committed state lives only in the task file, which also records
    // `evidence_result_state` so a downgrade after upload is machine-detectable.
    const resultJson = { ...planned, snapshot: "pre-terminal", committed_state: null, terminal: false };
    if (lease) resultJson.authority = authorityLost ? "lost" : "held";
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
    // The attempt is over and its diff is captured: seal the tree (evidence, read-only). Retention
    // runs AFTER the evidence upload below, because only an uploaded attempt is prunable (F6).
    if (cleanRoom) sealAttemptDir(repository.attemptDir);
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
      fence: lease ? fence : null,
      extraFiles,
    });

    // Wave 1B L3 (F1): the evidence POST is the third fence. `valid: false` there is the same
    // loss of authority as at the push or the PR: the task is BLOCKED `fenced_out:<reason>`, the
    // release outcome is `abandoned`, and the blocker post says so — not a mere UNVERIFIED
    // downgrade. Folded into fencedOutReason BEFORE the state transition. When authority was
    // already lost (or an earlier fence fired) the earlier reason stands.
    const evidenceFencedOut = !fencedOut && evidenceResult?.fenced_out ? evidenceResult.fenced_out : null;
    if (evidenceFencedOut) fencedOutReason = evidenceFencedOut;
    // Evidence was attempted and did not fully land (S3 upload or /v1/evidence POST failed):
    // a COMPLETED claim without evidence is not a completed claim -> UNVERIFIED.
    // BLOCKED/FAILED keep their state but record why evidence is missing.
    const evidenceError = evidenceResult && !evidenceResult.success ? evidenceResult.error : null;
    if (cleanRoom) {
      // F6: the marker that makes this attempt's sealed dir prunable is written ONLY after its
      // bundle landed (uploaded: true, set solely after a successful `aws s3 cp`). No evidence
      // configured, or a failed upload ⇒ no marker ⇒ the dir is the only evidence and is kept.
      // Retention then applies to marked dirs: never the newest, never this attempt.
      if (evidenceResult?.uploaded === true) {
        markEvidenceUploaded({ stateDir, repo: envelopeToUse.repo, taskId, attempt: attempt.attempt, uri: evidenceResult.uri, sha256: evidenceResult.sha256 });
      }
      await pruneAttempts({ stateDir, repo: envelopeToUse.repo, taskId, keep: cleanRoom.keepAttempts, protect: attempt.attempt });
    }
    const state = evidenceFencedOut ? "BLOCKED" : evidenceError && intendedState === "COMPLETED" ? "UNVERIFIED" : intendedState;
    lifecycle.transition(state, {
      ...planned,
      ...(evidenceFencedOut ? { outcome: { reason: evidenceFencedOut }, fenced_out: evidenceFencedOut } : {}),
      ...(lease ? { lease: { ...lifecycle.snapshot().lease, ...lease } } : {}),
      evidence_error: evidenceError,
      // State the uploaded result.json names as intended; differs from `state` after a downgrade.
      evidence_result_state: evidenceResult ? intendedState : null,
    });
    // L4: release with the committed state's outcome, BEFORE the final post so the lease is not
    // held across a bus retry. A release failure is logged; the state above is already final.
    await releaseLease(state);
    await postFinal(bus, message, envelopeToUse, lifecycle.snapshot(), evidenceResult);
  } catch (error) {
    // A terminal state is immutable: if the failure happened after it was committed (e.g. the
    // final bus post), surface the error to the daemon loop instead of rewriting the record.
    if (lifecycle.isTerminal()) {
      await releaseLease(lifecycle.snapshot().state);
      throw error;
    }
    // B4: a base-checkout validation failure (missing origin base ref, or base_commit not
    // reachable) is a BLOCKED refusal, not a FAILED run: nothing was spawned, nothing produced.
    if (typeof error?.blockedReason === "string") {
      lifecycle.transition("BLOCKED", { outcome: { reason: error.message } });
      await releaseLease("BLOCKED");
      await bus.postTerminal("status", `task ${taskId} blocked`, blockerPostBody(lifecycle.snapshot(), `state=BLOCKED reason=${error.message}`), {
        inReplyTo: message.message_id,
        outcome: "BLOCKED",
      });
      return true;
    }
    lifecycle.transition("FAILED", { outcome: { reason: error.message }, exit_code: 1 });
    await releaseLease("FAILED");
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
  if (options.cleanRoom) {
    // The effective bounds, on stderr once per start, so an operator (and the F8 test) can see
    // what "0" or an env value resolved to instead of inferring it from a later refusal.
    process.stderr.write(`vinci worker: clean room on (disk floor ${options.diskFloorMb} MiB${options.diskFloorMb === 0 ? ", disabled" : ""}, keep ${options.keepAttempts} attempts)\n`);
  }
  const releaseLock = acquireDaemonLock(options.stateDir, options.id);
  // F7: a stop request with a lease in flight releases it (`abandoned`, bounded by
  // LEASE_TIMEOUT_MS) and SIGTERMs the child before the daemon exits; the task record stays
  // RUNNING and is resumed as the next attempt by the next daemon start. Without an active
  // lease this is the plain exit it always was.
  let stopping = false;
  // D1 refresh timer (governed daemons only); cleared on exit.
  let declarationTimer = null;
  const handleSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    Promise.all([releaseActiveLeases(signal), releaseActiveBranchLeases(signal)])
      .catch((error) => process.stderr.write(`vinci worker: ${signal}: lease release failed: ${error.message}\n`))
      .finally(() => {
        releaseLock();
        process.exit(0);
      });
  };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
  try {
    const bus = new BusClient(options.server, options.token, 100, join(options.stateDir, "outbox"));
    // W0.5: record the server's build next to our own and announce both ONCE per daemon start,
    // before the first poll. A failed /v1/version fetch is recorded, never fatal: the bus
    // token check and the first poll already gate startup.
    serverBuild = await fetchServerBuild(options.server);
    // #18: and the version of the `vinci` binary this daemon will spawn (never fatal either).
    vinciBinary = vinciBinaryVersion();
    await bus.post(
      "status",
      `worker ${options.id} online`,
      `worker_build=${formatWorkerBuild(workerBuild)} worker_version=${version} server_build=${formatServerBuild(serverBuild)} vinci_binary=${formatVinciBinary(vinciBinary)} branch_lease=${process.env.VINCI_BRANCH_LEASE === "1" ? "on" : "off"} allowed_providers=${[...options.allowedProviders].sort().join(",")}`,
    );
    process.stderr.write(
      `vinci worker: provider allowlist ENFORCED (${[...options.allowedProviders].sort().join(",")}); set VINCI_WORKER_ALLOWED_PROVIDERS to change it\n`,
    );
    // Say out loud whether the §36 fence is in force. Raised in adversarial
    // review of #43: a guard that is off by default is indistinguishable from
    // one that is on and working, and "we enabled it in the deploy" is a claim
    // nobody can check from outside the box. Now the online post carries it,
    // so `vgc msg` and the chaos gate's own build audit both see it, and a
    // cohort can be graded on whether the fence was actually up.
    process.stderr.write(
      `vinci worker: branch leases (CONTRACT §36) ${process.env.VINCI_BRANCH_LEASE === "1"
        ? "ENFORCED -- acquire/check/release around every push"
        : "OFF (set VINCI_BRANCH_LEASE=1 to enforce); pushes are not fenced by a branch lease"}\n`,
    );
    // ANY TERMINAL RECORD THAT NEVER REACHED THE BUS IS SETTLED FIRST, before
    // this daemon claims new work. The worker transitions a task to a terminal
    // state and then announces it, and those steps are not atomic: a bus
    // failure or a crash between them left the task terminal and unannounced,
    // and the restart skipped it precisely BECAUSE it was already terminal.
    // Replay runs before the poll loop so a failure that happened while we were
    // down is visible before anything new can bury it.
    //
    // It never throws: a bus that is still unreachable must not stop the worker
    // from starting, and the records stay on disk for the next attempt.
    // The SAME directory the bus records into -- read off the bus rather than
    // rebuilt from options, so the two can never drift apart.
    const replayed = await replayPending(bus, bus.outboxDir, {
      warn: (m) => process.stderr.write(`${m}\n`),
      error: (m) => process.stderr.write(`${m}\n`),
    });
    if (replayed.attempted || replayed.corrupt) {
      process.stderr.write(
        `vinci worker: terminal outbox -- attempted ${replayed.attempted}, `
        + `delivered ${replayed.delivered}, failed ${replayed.failed}, `
        + `unreadable ${replayed.corrupt}\n`,
      );
    }

    // A change since the last announced binary (e.g. an update while the daemon was down, or a
    // change whose post failed before a restart) is announced here, once.
    await announceBinaryChange(bus, options.stateDir, options.id);
    // Wave 1B D1 (behind --governor): declare what this daemon actually does, once, right after
    // `online`. The body is the canonical JSON of the WorkerDeclaration; its sha256 is the
    // capability_declaration_digest every governed lease request and task record carries.
    if (options.governor) {
      await postCapabilityDeclaration(bus, options, { throwOnFailure: true });
      // …and again every VINCI_DECLARATION_REFRESH_S, on the SAME code path, so the Governor never
      // ages this daemon out into `stale_declaration`. Unref'd: it cannot keep the process alive
      // (`--once` still exits) and it is cleared in the finally below.
      declarationTimer = setInterval(() => {
        void postCapabilityDeclaration(bus, options);
      }, declarationRefreshSeconds() * 1000);
      if (typeof declarationTimer?.unref === "function") declarationTimer.unref();
    }
    do {
      let cursor = loadCursor(options.stateDir, options.id);
      const messages = await bus.poll(options.id, cursor);
      for (const message of messages) {
        const cleanRoom = options.cleanRoom ? { diskFloorMb: options.diskFloorMb, keepAttempts: options.keepAttempts } : null;
        if (!(await processHandoff(bus, options.stateDir, message, options.governor, options.id, { cleanRoom, allowedProviders: options.allowedProviders }))) continue;
        cursor = advanceCursor(cursor, message);
        saveCursor(options.stateDir, options.id, cursor);
      }
      if (!options.once) await new Promise((resolveWait) => setTimeout(resolveWait, options.pollSeconds * 1000));
    } while (!options.once);
  } finally {
    if (declarationTimer) clearInterval(declarationTimer);
    process.off("SIGTERM", handleSignal);
    process.off("SIGINT", handleSignal);
    releaseLock();
  }
}

main().catch((error) => {
  process.stderr.write(`vinci worker: ${error.message}${error?.cause ? ` (cause: ${error.cause.code ?? error.cause.message})` : ""}\n`);
  process.exitCode = error?.exitCode ?? 1;
});
