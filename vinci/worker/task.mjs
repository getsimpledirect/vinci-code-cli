import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const TERMINAL_STATES = new Set(["COMPLETED", "UNVERIFIED", "BLOCKED", "FAILED"]);
// Lifecycle table (W0.3). Every transition() is checked against it; anything not listed throws.
// PENDING  -> RUNNING immediately before the child is spawned, or straight to BLOCKED/FAILED
//             when the task fails fast (past deadline, envelope error, governor refusal).
// RUNNING  -> exactly one terminal state, written only AFTER the evidence bundle was attempted.
// terminal -> nothing: a finished task is immutable; the daemon skips it on restart.
const TRANSITIONS = new Map([
  ["PENDING", new Set(["RUNNING", "BLOCKED", "FAILED"])],
  ["RUNNING", new Set(TERMINAL_STATES)],
  ["COMPLETED", new Set()],
  ["UNVERIFIED", new Set()],
  ["BLOCKED", new Set()],
  ["FAILED", new Set()],
]);
export const LIFECYCLE_STATES = Object.freeze([...TRANSITIONS.keys()]);

export function assertTransition(from, to) {
  if (!TRANSITIONS.has(from)) throw new Error(`unknown lifecycle state: ${from}`);
  if (!TRANSITIONS.has(to)) throw new Error(`unknown lifecycle state: ${to}`);
  if (!TRANSITIONS.get(from).has(to)) throw new Error(`illegal transition ${from} → ${to}`);
}
const HEADER_KEYS = new Set([
  "repo",
  "evidence",
  "provider",
  "model",
  "budget_usd",
  "max_runtime_s",
  "deadline",
  "ref",
  "branch",
  "claim",
  "evidence_ref",
  "base_ref",
]);

// The ONE plain-branch-name rule (PR #22 hardening), shared by `branch:` and `base_ref:`: a git
// ref NAME, never a refspec, an option, or anything git-check-ref-format rejects.
const PLAIN_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
export function isPlainRefName(value) {
  return (
    typeof value === "string" &&
    PLAIN_REF.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("/.") &&
    !value.includes("@{") &&
    !/^refs[\/.]/.test(value) &&
    !value.includes("refs/") &&
    !value.endsWith(".lock") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    value !== "HEAD"
  );
}
export function assertPlainRefName(value, name) {
  if (!isPlainRefName(value)) {
    throw new Error(`${name} must be a plain git branch name (letters, digits, ._/-; no leading -/+, no .., no //, no /., no @{, no .lock, no refs/ prefix, no refspec syntax)`);
  }
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
  return number;
}

export function assertTaskId(taskId) {
  if (!TASK_ID.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
}

export function parseEnvelope(body) {
  if (typeof body !== "string") throw new Error("handoff body must be text");
  const normalized = body.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  if (separator === -1) throw new Error("handoff envelope requires a blank line before the spec");

  const values = new Map();
  for (const line of normalized.slice(0, separator).split("\n")) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!match) throw new Error(`invalid envelope header: ${line}`);
    const [, key, rawValue] = match;
    if (!HEADER_KEYS.has(key)) throw new Error(`unknown envelope header: ${key}`);
    if (values.has(key)) throw new Error(`duplicate envelope header: ${key}`);
    const value = rawValue.trim();
    if (!value) throw new Error(`${key} must not be empty`);
    values.set(key, value);
  }

  const repo = values.get("repo");
  if (!repo || !REPO.test(repo)) throw new Error("repo must be in org/name form");
  const evidence = values.get("evidence") ?? "pr";
  if (evidence !== "pr" && evidence !== "none") throw new Error("evidence must be pr or none");
  const provider = values.get("provider") ?? "openrouter";
  const model = values.get("model") ?? "z-ai/glm-5.2";
  const budgetUsd = positiveNumber(values.get("budget_usd") ?? "5", "budget_usd");
  const maxRuntimeS = positiveNumber(values.get("max_runtime_s") ?? "14400", "max_runtime_s");
  const deadline = values.get("deadline");
  if (deadline && (!UTC_TIMESTAMP.test(deadline) || Number.isNaN(Date.parse(deadline)))) {
    throw new Error("deadline must be an ISO-8601 UTC timestamp");
  }
  const spec = normalized.slice(separator + 2).trim();
  if (!spec) throw new Error("task spec must not be empty");
  const branchValue = values.get("branch");
  if (branchValue !== undefined) assertPlainRefName(branchValue, "branch");
  const claim = values.get("claim") ?? ".";
  const ref = values.get("evidence_ref") ?? values.get("ref");
  // base_ref: the PR base the publisher targets (default main); same name rules as `branch`.
  const baseRef = values.get("base_ref");
  if (baseRef !== undefined) assertPlainRefName(baseRef, "base_ref");

  return {
    repo,
    evidence,
    provider,
    model,
    budget_usd: budgetUsd,
    max_runtime_s: maxRuntimeS,
    deadline,
    ref,
    branch: branchValue,
    base_ref: baseRef,
    claim,
    spec,
  };
}

// The task-record shape of a vinciBinaryVersion() result: `{ version, path }`, `{ error }`, or null.
export function vinciBinaryRecord(binary) {
  if (!binary || typeof binary !== "object") return null;
  if (binary.error) return { error: binary.error };
  return { version: binary.version, path: binary.path };
}

export class TaskLifecycle {
  constructor(stateDir, taskId) {
    assertTaskId(taskId);
    this.taskFile = join(stateDir, "tasks", `${taskId}.json`);
    mkdirSync(dirname(this.taskFile), { recursive: true });
    this.state = this.load(taskId);
  }

  load(taskId) {
    try {
      const state = JSON.parse(readFileSync(this.taskFile, "utf8"));
      if (!state || typeof state !== "object") throw new Error("state is not an object");
      return state;
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`cannot read task state ${this.taskFile}: ${error.message}`);
      return {
        task: taskId,
        attempt: 0,
        session_id: taskId,
        state: "PENDING",
        started_at: null,
        finished_at: null,
        exit_code: null,
        head: null,
        base_commit: null,
        base_ref: null,
        pr: null,
        publish: null,
        evidence: null,
        limit_tripped: null,
        vinci_version: null,
        worker_build: null,
        server_build: null,
        vinci_binary: null,
        provider: null,
        model: null,
        cost_usd: 0,
        outcome: null,
        terminal: false,
        lease: null,
        evidence_error: null,
        harness_stop: null,
        evidence_result_state: null,
      };
    }
  }

  save() {
    const temporary = `${this.taskFile}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.taskFile);
  }

  isTerminal() {
    return this.state.terminal === true || TERMINAL_STATES.has(this.state.state);
  }

  // builds (W0.5): `{ workerBuild: { version, commit, dirty, source }, serverBuild: <payload|{error}>,
  // vinciBinary: { version, path } | { error } }`.
  // `vinci_version` is kept for compatibility and is the DAEMON CHECKOUT's identity.json version
  // (same as worker_build.version) — it is NOT the version of the `vinci` binary that ran the
  // task; that is `vinci_binary` (#18). At startAttempt it is the daemon's LAST OBSERVED probe
  // (what an early blocker that never spawns gets); a task that reaches the spawn re-probes
  // immediately before it and overwrites the field via record({ vinci_binary }).
  // `worker_build` / `server_build` name the exact builds that produced this record and ride
  // into result.json unchanged.
  startAttempt(task, vinciVersion, builds = {}) {
    if (this.isTerminal()) throw new Error(`cannot start an attempt on terminal state ${this.state.state}`);
    const firstAttempt = !(Number.isInteger(this.state.attempt) && this.state.attempt > 0);
    const sessionId = typeof this.state.session_id === "string" && this.state.session_id ? this.state.session_id : task.id;
    this.state = {
      ...this.state,
      task: task.id,
      attempt: (Number.isInteger(this.state.attempt) ? this.state.attempt : 0) + 1,
      session_id: sessionId,
      state: "PENDING",
      started_at: new Date().toISOString(),
      finished_at: null,
      exit_code: null,
      head: null,
      base_commit: null,
      base_ref: task.envelope.base_ref ?? "main",
      pr: null,
      publish: null,
      evidence: task.envelope.evidence,
      limit_tripped: null,
      vinci_version: vinciVersion,
      worker_build: builds.workerBuild
        ? { version: builds.workerBuild.version, commit: builds.workerBuild.commit, dirty: builds.workerBuild.dirty }
        : null,
      server_build: builds.serverBuild ?? null,
      vinci_binary: vinciBinaryRecord(builds.vinciBinary),
      provider: task.envelope.provider,
      model: task.envelope.model,
      cost_usd: 0,
      outcome: null,
      terminal: false,
      lease: null,
      evidence_error: null,
      harness_stop: null,
      evidence_result_state: null,
    };
    this.save();
    return { attempt: this.state.attempt, firstAttempt, sessionId };
  }

  // Update published fields without changing state (lease grant, run results before publish).
  record(fields = {}) {
    if (this.isTerminal()) throw new Error(`illegal update of terminal state ${this.state.state}`);
    this.state = { ...this.state, ...fields, state: this.state.state };
    this.save();
  }

  // The snapshot transition(state, fields) WOULD write, validated against the table but not
  // saved. The worker uploads this as result.json BEFORE committing the terminal state.
  plan(state, fields = {}) {
    assertTransition(this.state.state, state);
    const next = { ...this.state, ...fields, state };
    if (TERMINAL_STATES.has(state)) {
      next.finished_at = typeof fields.finished_at === "string" ? fields.finished_at : new Date().toISOString();
      next.terminal = true;
    }
    return next;
  }

  transition(state, fields = {}) {
    this.state = this.plan(state, fields);
    this.save();
  }

  snapshot() {
    return { ...this.state };
  }
}
