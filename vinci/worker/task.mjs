import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const TERMINAL_STATES = new Set(["COMPLETED", "UNVERIFIED", "BLOCKED", "FAILED"]);
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
]);

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
  const claim = values.get("claim") ?? ".";
  const ref = values.get("evidence_ref") ?? values.get("ref");

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
    claim,
    spec,
  };
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
        pr: null,
        publish: null,
        evidence: null,
        limit_tripped: null,
        vinci_version: null,
        provider: null,
        model: null,
        cost_usd: 0,
        terminal: false,
        lease: null,
        evidence_error: null,
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

  startAttempt(task, vinciVersion) {
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
      pr: null,
      publish: null,
      evidence: task.envelope.evidence,
      limit_tripped: null,
      vinci_version: vinciVersion,
      provider: task.envelope.provider,
      model: task.envelope.model,
      cost_usd: 0,
      terminal: false,
      lease: null,
      evidence_error: null,
    };
    this.save();
    return { attempt: this.state.attempt, firstAttempt, sessionId };
  }

  transition(state, fields = {}) {
    this.state = { ...this.state, ...fields, state };
    if (TERMINAL_STATES.has(state)) {
      this.state.finished_at = new Date().toISOString();
      this.state.terminal = true;
    }
    this.save();
  }

  snapshot() {
    return { ...this.state };
  }
}
