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
import { command, finalState, noCommitOutcome, prepareRepository, publish, readHead, runVinci } from "./run.mjs";
import { cleanRoomEnv, DEFAULT_DISK_FLOOR_MB, DEFAULT_KEEP_ATTEMPTS, markEvidenceUploaded, prepareCleanRoom, pruneAttempts, publishFromCache, sealAttemptDir } from "./cleanroom.mjs";
import { assertTaskId, parseEnvelope, TaskLifecycle, vinciBinaryRecord } from "./task.mjs";
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
  return "Usage: vinci worker start --id <id> --server <url> [--once] [--poll-seconds 60] [--state-dir <dir>] [--governor <url>] [--require-governor] [--clean-room] [--disk-floor-mb 2048] [--keep-attempts 3]";
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
function terminalPostBody(details) {
  return `${details} worker_build=${formatWorkerBuild(workerBuild)} vinci_binary=${formatVinciBinary(vinciBinary)}`;
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
    const statusBody = state.outcome?.reason
      ? terminalPostBody(`${details} reason=${state.outcome.reason}`)
      : body;
    await bus.post("status", subject, statusBody, options);
  }
}

// One options object rather than a third positional parameter: #25 (fence), #24
// (cleanRoom) and #26 (lease loop) all extend this signature, and positional adds
// silently reorder under a rebase. #26 obeys that: `subjectOf` (the lease-subject
// resolver, injectable for tests) is an OPTION, not a 6th positional parameter — as a
// positional it would have landed on main's options object and silently read `null`.
//
// `fence` stays main's hook shape ({ generation?, check: async ({stage}) => {valid, reason} }).
// It is NOT passed in from main(): the fence closes over THIS attempt's lease, which is acquired
// inside this function, so it is constructed below once a lease is held and handed to publish()
// in main's shape. The option remains for a caller that wants to inject one (tests do).
async function processHandoff(bus, stateDir, message, governorUrl, workerId, { fence: injectedFence = null, cleanRoom = null, subjectOf = leaseSubject } = {}) {
  const taskId = message.message_id;
  try {
    assertTaskId(taskId);
  } catch (error) {
    await bus.post("blocker", `task ${taskId} blocked`, terminalPostBody(error.message), { inReplyTo: message.message_id });
    return true;
  }

  const lifecycle = new TaskLifecycle(stateDir, taskId);
  if (lifecycle.isTerminal()) return true;
  if (!acquireTaskClaim(stateDir, taskId)) return false;

  let envelope;
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

  const attempt = lifecycle.startAttempt({ id: taskId, envelope }, version, { workerBuild, serverBuild, vinciBinary });
  if (envelope.deadline && Date.parse(envelope.deadline) <= Date.now()) {
    lifecycle.transition("BLOCKED", { limit_tripped: "deadline", outcome: { reason: "deadline is in the past" } });
    await bus.post("blocker", `task ${taskId} blocked`, terminalPostBody("deadline is in the past"), { inReplyTo: message.message_id });
    return true;
  }

  // B2 (fail closed, before clone): prepareRepository still forks every branch off origin/main, so
  // a PR whose base is not main would not share its fork point. Until #23 threads base_ref through
  // prepareRepository, any other base is refused here — the header stays parsed so #23 can thread it.
  if (envelope.base_ref !== undefined && envelope.base_ref !== "main") {
    const reason = `base_ref_unsupported: base_ref ${envelope.base_ref} is not main; the branch is forked from origin/main and a PR against another base would not share its fork point`;
    lifecycle.transition("BLOCKED", { outcome: { reason } });
    await bus.post("blocker", `task ${taskId} blocked`, terminalPostBody(reason), { inReplyTo: message.message_id });
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
  if (cleanRoom && governorUrl) {
    const reason = "clean_room_publish_unsupported: --clean-room publishes from the bare cache, which does not honour a Governor fence and lacks the idempotent-retry, lease, read-back, foreign-PR and PR-head guarantees of the standard publisher; refusing before the run rather than publishing under guarantees that are not in force";
    lifecycle.transition("BLOCKED", { outcome: { reason } });
    await bus.post("blocker", `task ${taskId} blocked`, terminalPostBody(reason), { inReplyTo: message.message_id });
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
  const branchLeases =
    process.env.VINCI_BRANCH_LEASE !== "1" || !bus?.serverUrl || !bus?.token
      ? null
      : new BranchLeaseClient(bus.serverUrl, bus.token);
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
        await bus.post("blocker", `task ${taskId} blocked`, terminalPostBody(`${label}: ${reason}`), {
          inReplyTo: message.message_id,
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
        await bus.post("blocker", `task ${taskId} blocked`, terminalPostBody(`${label}: ${reason}`), {
          inReplyTo: message.message_id,
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
          diskFloorBytes: cleanRoom.diskFloorMb * 1048576,
        })
      : await prepareRepository(stateDir, envelopeToUse.repo, taskId, envelopeToUse.branch);
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
    lifecycle.transition("RUNNING");
    const run = await runVinci({ envelope: envelopeToUse,
      stateDir,
      taskId, repoDir: repository.repoDir, sessionId: attempt.sessionId,
      env: cleanRoom ? cleanRoomEnv({ provider: envelopeToUse.provider, homeDir: repository.homeDir, tmpDir: repository.tmpDir }) : undefined,
      envDelta: unattendedPolicy,
      ...(lease ? { abortSignal: abortController.signal } : {}) });
    const head = await readHead(repository.repoDir);
    if (lease) lifecycle.record({ lease: { ...lifecycle.snapshot().lease, ...lease } });
    lifecycle.record({ ...run, head, outcome: run.outcome ?? null });
    // Loss of authority (L2): NO publish at all — not even the branch push. The record says why.
    // Otherwise main's routing stands. `fence` is this attempt's fence in publisher.mjs's shape;
    // it is null when ungoverned, and the clean-room x fence combination never reaches here (it is
    // refused before the run).
    const published = authorityLost
      ? { publish: "skipped", pr: null, fenced_out: authorityLost }
      : cleanRoom
        ? await publishFromCache({ envelope: envelopeToUse, limitTripped: run.limit_tripped, ...repository, taskId })
        : await publish({ envelope: envelopeToUse, limitTripped: run.limit_tripped, ...repository, taskId, attempt: attempt.attempt, fence: composeFences(lease ? fence : null, branchFence) });
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
    const gitDiffResult = await command("git", [
      "-C",
      repository.repoDir,
      "diff",
      "origin/main...HEAD",
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
    lifecycle.transition("FAILED", { outcome: { reason: error.message }, exit_code: 1 });
    await releaseLease("FAILED");
    await postFinal(bus, message, envelope, lifecycle.snapshot(), null);
  }
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
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
    releaseActiveLeases(signal)
      .catch((error) => process.stderr.write(`vinci worker: ${signal}: lease release failed: ${error.message}\n`))
      .finally(() => {
        releaseLock();
        process.exit(0);
      });
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
        if (!(await processHandoff(bus, options.stateDir, message, options.governor, options.id, { cleanRoom }))) continue;
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
