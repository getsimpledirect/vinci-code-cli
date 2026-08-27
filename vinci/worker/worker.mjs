#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { BusClient } from "./bus.mjs";
import { finalState, prepareRepository, publish, readHead, runVinci } from "./run.mjs";
import { assertTaskId, parseEnvelope, TaskLifecycle } from "./task.mjs";

const version = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../identity.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
})();

function usage() {
  return "Usage: vinci worker start --id <id> --server <url> [--once] [--poll-seconds 60] [--state-dir <dir>]";
}

function parseArgs(args) {
  if (args.shift() !== "start") throw new Error(usage());
  const options = { once: false, pollSeconds: 60, stateDir: resolve(".vinci-worker-state") };
  const seen = new Set();
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--once") {
      if (seen.has(argument)) throw new Error(`duplicate option: ${argument}`);
      seen.add(argument);
      options.once = true;
      continue;
    }
    if (!["--id", "--server", "--poll-seconds", "--state-dir"].includes(argument)) {
      throw new Error(`unknown option: ${argument}\n${usage()}`);
    }
    if (seen.has(argument)) throw new Error(`duplicate option: ${argument}`);
    seen.add(argument);
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--id") options.id = value;
    else if (argument === "--server") options.server = value;
    else if (argument === "--state-dir") options.stateDir = resolve(value);
    else options.pollSeconds = Number(value);
  }
  if (!options.id) throw new Error("--id is required");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(options.id)) throw new Error("invalid worker id");
  if (!options.server) throw new Error("--server is required");
  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds <= 0) {
    throw new Error("--poll-seconds must be a positive number");
  }
  const token = process.env.VINCI_BUS_TOKEN;
  if (!token) throw new Error("VINCI_BUS_TOKEN is required");
  return { ...options, token };
}

function cursorPath(stateDir) {
  return join(stateDir, "cursor.json");
}

function loadCursor(stateDir, workerId) {
  try {
    const cursors = JSON.parse(readFileSync(cursorPath(stateDir), "utf8"));
    return cursors?.[workerId] ?? "";
  } catch {
    return "";
  }
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

async function postFinal(bus, message, envelope, state) {
  const subject = `task ${message.id} ${state.state.toLowerCase()}`;
  const details = [
    `state=${state.state}`,
    `exit_code=${state.exit_code}`,
    `cost_usd=${Number(state.cost_usd).toFixed(6)}`,
    state.limit_tripped ? `limit=${state.limit_tripped}` : undefined,
    state.head ? `head=${state.head}` : undefined,
    state.pr ? `pr=${state.pr}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const options = { inReplyTo: message.id };
  if (state.state === "COMPLETED") {
    options.refs = [envelope.ref ?? `handoff:${message.id}`];
    if (state.pr) options.refs.push(state.pr);
    if (state.head) options.refs.push(`commit:${state.head}`);
    await bus.post("finding", subject, details, options);
  } else if (state.state === "BLOCKED" || state.state === "FAILED") {
    const reason = state.outcome?.reason ? `${details} reason=${state.outcome.reason}` : details;
    await bus.post("blocker", subject, reason, options);
  } else {
    await bus.post("status", subject, details, options);
  }
}

async function processHandoff(bus, stateDir, message) {
  const taskId = String(message.id);
  try {
    assertTaskId(taskId);
  } catch (error) {
    await bus.post("blocker", `task ${taskId} blocked`, error.message, { inReplyTo: message.id });
    return;
  }

  const lifecycle = new TaskLifecycle(stateDir, taskId);
  if (lifecycle.isTerminal()) return;

  let envelope;
  try {
    envelope = parseEnvelope(message.body);
  } catch (error) {
    lifecycle.startAttempt(
      { id: taskId, envelope: { evidence: null, provider: null, model: null } },
      version,
    );
    lifecycle.transition("BLOCKED", {
      limit_tripped: /budget_usd/.test(error.message) ? "budget_usd" : null,
      outcome: { reason: error.message },
    });
    await bus.post("blocker", `task ${taskId} blocked`, error.message, { inReplyTo: message.id });
    return;
  }

  const attempt = lifecycle.startAttempt({ id: taskId, envelope }, version);
  if (envelope.deadline && Date.parse(envelope.deadline) <= Date.now()) {
    lifecycle.transition("BLOCKED", { limit_tripped: "deadline", outcome: { reason: "deadline is in the past" } });
    await bus.post("blocker", `task ${taskId} blocked`, "deadline is in the past", { inReplyTo: message.id });
    return;
  }

  lifecycle.transition("CLAIMED");
  if (attempt.firstAttempt) {
    await bus.post("status", `task ${taskId} claimed`, `claimed ${taskId} attempt ${attempt.attempt}`, {
      inReplyTo: message.id,
    });
  }

  try {
    const repository = await prepareRepository(stateDir, envelope.repo, taskId);
    lifecycle.transition("RUNNING");
    const run = await runVinci({ envelope, repoDir: repository.repoDir, sessionId: attempt.sessionId });
    const head = await readHead(repository.repoDir);
    lifecycle.transition("EVIDENCE_PENDING", { ...run, head, outcome: run.outcome ?? null });
    const published = await publish({ envelope, ...repository, taskId });
    const state = finalState({
      envelope,
      exitCode: run.exit_code,
      limitTripped: run.limit_tripped,
      outcome: run.outcome,
      blocker: existsSync(join(repository.repoDir, "BLOCKER.md")),
      pr: published.pr,
    });
    lifecycle.transition(state, published);
    await postFinal(bus, message, envelope, lifecycle.snapshot());
  } catch (error) {
    lifecycle.transition("FAILED", { outcome: { reason: error.message }, exit_code: 1 });
    await postFinal(bus, message, envelope, lifecycle.snapshot());
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.stateDir, { recursive: true });
  const bus = new BusClient(options.server, options.token);
  do {
    const cursor = loadCursor(options.stateDir, options.id);
    const messages = await bus.poll(options.id, cursor);
    for (const message of messages) {
      await processHandoff(bus, options.stateDir, message);
      saveCursor(options.stateDir, options.id, message.id);
    }
    if (!options.once) await new Promise((resolveWait) => setTimeout(resolveWait, options.pollSeconds * 1000));
  } while (!options.once);
}

main().catch((error) => {
  process.stderr.write(`vinci worker: ${error.message}\n`);
  process.exitCode = 1;
});
