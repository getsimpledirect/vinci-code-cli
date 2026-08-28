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
import { assertTaskId, parseEnvelope, TaskLifecycle } from "./task.mjs";
import { claimGovernorPaths, tightenEnvelopeLimits } from "./governor.mjs";
import { readSessionState } from "./session-read.mjs";
import { uploadEvidence } from "./evidence.mjs";

const version = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../identity.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
})();

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

async function postFinal(bus, message, envelope, state, evidence) {
  const subject = `task ${message.message_id} ${state.state.toLowerCase()}`;
  const evidenceDetails = evidence?.success
    ? [`evidence_uri=${evidence.uri}`, `evidence_sha256=${evidence.sha256}`]
    : evidence && !evidence.success
      ? [`evidence_error=${evidence.error}`]
      : [];
  const details = [
    `state=${state.state}`,
    `exit_code=${state.exit_code}`,
    `cost_usd=${Number(state.cost_usd).toFixed(6)}`,
    state.limit_tripped ? `limit=${state.limit_tripped}` : undefined,
    state.head ? `head=${state.head}` : undefined,
    state.pr ? `pr=${state.pr}` : undefined,
    ...evidenceDetails,
  ]
    .filter(Boolean)
    .join(" ");
  const options = { inReplyTo: message.message_id };
  if (state.state === "COMPLETED" && isLedgerRef(envelope.ref)) {
    options.refs = [envelope.ref];
    await bus.post("finding", subject, details, options);
  } else if (state.state === "BLOCKED" && state.harness_stop) {
    // An instrument stop: the harness refused the agent's work mid-run. Say so explicitly so the
    // soak ledger attributes the block to the instrument, not to the model's own narrative.
    const stop = state.harness_stop;
    await bus.post(
      "blocker",
      subject,
      `${details} stop=instrument harness_stops=${stop.count} reason=instrument stop: ${stop.reason}`,
      options,
    );
  } else if (state.state === "BLOCKED" || state.state === "FAILED") {
    const reason = state.outcome?.reason ? `${details} reason=${state.outcome.reason}` : details;
    await bus.post("blocker", subject, reason, options);
  } else {
    await bus.post("status", subject, details, options);
  }
}

async function processHandoff(bus, stateDir, message, governorUrl) {
  const taskId = message.message_id;
  try {
    assertTaskId(taskId);
  } catch (error) {
    await bus.post("blocker", `task ${taskId} blocked`, error.message, { inReplyTo: message.message_id });
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
    );
    const state = /^repo must be/.test(error.message) ? "FAILED" : "BLOCKED";
    lifecycle.transition(state, {
      limit_tripped: /budget_usd/.test(error.message) ? "budget_usd" : null,
      outcome: { reason: error.message },
    });
    await bus.post("blocker", `task ${taskId} ${state.toLowerCase()}`, `state=${state} reason=${error.message}`, {
      inReplyTo: message.message_id,
    });
    return true;
  }

  const attempt = lifecycle.startAttempt({ id: taskId, envelope }, version);
  if (envelope.deadline && Date.parse(envelope.deadline) <= Date.now()) {
    lifecycle.transition("BLOCKED", { limit_tripped: "deadline", outcome: { reason: "deadline is in the past" } });
    await bus.post("blocker", `task ${taskId} blocked`, "deadline is in the past", { inReplyTo: message.message_id });
    return true;
  }

  lifecycle.transition("CLAIMED");
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
        await bus.post("blocker", `task ${taskId} blocked`, `${label}: ${reason}`, {
          inReplyTo: message.message_id,
        });
        return true;
      }

      // Lease granted: tighten the envelope (budget, max_runtime_s, deadline, and the lease
      // ttl as a runtime cap) and record both the lease and the effective runtime limit.
      envelopeToUse = tightenEnvelopeLimits(envelopeToUse, claimResult);
      lifecycle.transition("CLAIMED", {
        lease: { ...claimResult, effective_max_runtime_s: envelopeToUse.max_runtime_s },
      });
    }

    const repository = await prepareRepository(stateDir, envelopeToUse.repo, taskId, envelopeToUse.branch);
    lifecycle.transition("RUNNING");
    const run = await runVinci({ envelope: envelopeToUse,
      stateDir,
      taskId, repoDir: repository.repoDir, sessionId: attempt.sessionId });
    const head = await readHead(repository.repoDir);
    lifecycle.transition("EVIDENCE_PENDING", { ...run, head, outcome: run.outcome ?? null });
    const published = await publish({ envelope: envelopeToUse, limitTripped: run.limit_tripped, ...repository, taskId });
    const outcome = published.blocker_reason ? { reason: published.blocker_reason } : run.outcome ?? null;
    const harnessStops = run.harness_stops ?? [];
    const state = finalState({
      exitCode: run.exit_code,
      limitTripped: run.limit_tripped,
      outcome: run.outcome,
      blocker: Boolean(published.blocker_reason),
      pr: published.pr,
      harnessStops,
    });
    // Record the instrument stop on the task whenever it decided the state, so the snapshot (and the
    // evidence bundle's result.json) carry the machine-observed reason next to the model's narrative.
    const harnessStop =
      state === "BLOCKED" && harnessStops.length > 0
        ? { count: harnessStops.length, reason: harnessStops[0].reason }
        : null;
    lifecycle.transition(state, { ...published, outcome, harness_stop: harnessStop });

    // Stage 2: upload evidence bundle before the final bus post so uri/sha256 (or the
    // failure) can ride in the post body. No-op when VINCI_EVIDENCE_URI_PREFIX is unset.
    // sessionJsonl: session transcript from <state-dir>/sessions/<task-id>/ (outside the repo).
    // gitDiff is against the task branch base; it may be empty when the run changed nothing.
    // logTail: last 200 lines of the daemon's stderr so the bundle captures how the run ended.
    const session = readSessionState(join(stateDir, "sessions", taskId), attempt.sessionId);
    const sessionJsonl = session.path ? readFileSync(session.path, "utf8") : null;
    const gitDiffResult = await command("git", [
      "-C",
      repository.repoDir,
      "diff",
      "origin/main...HEAD",
    ], { allowFailure: true });
    const gitDiff = gitDiffResult.status === 0 ? gitDiffResult.stdout : null;
    const logTail = recentLogTail(200);
    const evidenceResult = await uploadEvidence({
      sessionJsonl,
      gitDiff,
      resultJson: lifecycle.snapshot(),
      logTail,
      uriPrefix: process.env.VINCI_EVIDENCE_URI_PREFIX,
      taskId,
      busUrl: bus.serverUrl,
      busToken: bus.token,
      ref: envelopeToUse.ref,
    });
    await postFinal(bus, message, envelopeToUse, lifecycle.snapshot(), evidenceResult);
  } catch (error) {
    lifecycle.transition("FAILED", { outcome: { reason: error.message }, exit_code: 1 });
    await postFinal(bus, message, envelope, lifecycle.snapshot(), null);
  }
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
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
    do {
      let cursor = loadCursor(options.stateDir, options.id);
      const messages = await bus.poll(options.id, cursor);
      for (const message of messages) {
        if (!(await processHandoff(bus, options.stateDir, message, options.governor))) continue;
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
