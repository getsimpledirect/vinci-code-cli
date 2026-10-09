import { constants, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const LIMIT = 65536;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const HELP = `Usage: vinci runtime <command> [--json]
  create --spec <file|->                  Saved input, stable commandId, optional text attachments
  inspect <run-id>                        Current canonical snapshot
  events <run-id> [--after <n>]            One bounded replay page
  watch <run-id> --timeout <seconds>       Replay until terminal event or deadline
  questions <run-id>                      Current scope question
  answer <run-id> --spec <file|->          Exact question and expectedRevision
  approvals <run-id>                      Exact action, destination and draft
  approve <run-id> --spec <file|->         Exact approvalId, actionDigest, commandId
  correct <run-id> --spec <file|->         Exact reviewed action, feedback and revision
  cancel <run-id>                         Request cancellation; no termination claim
  receipt <run-id>                        Scoped completion evidence
  report <run-id>                         Content-free recorded counters and outcomes
  export <run-id> <artifact-id> <version>  Exact version as text or JSON
Set VINCI_RUNTIME_CONFIG to an owned private JSON file with origin and cookie OR token.
Only an explicitly configured local task listener is supported. No task enumeration,
worker launch, denial, merge, deployment or remote-host authorization is introduced.
`;

export class RuntimeError extends Error {
  constructor(code, exitCode = 2, mutationUnconfirmed = false) { super(code); this.code = code; this.exitCode = exitCode; this.mutationUnconfirmed = mutationUnconfirmed; }
}
function refuse(code, exitCode = 2) { throw new RuntimeError(code, exitCode); }
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid_record");
  return value;
}
function fields(value, allowed) {
  record(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) refuse("unexpected_field");
}
function identity(value) {
  if (typeof value !== "string" || !ID.test(value)) refuse("invalid_identity");
  return value;
}
function count(value, maximum = 999999999) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) refuse("invalid_count");
  return value;
}
async function readJson(path, privateFile = false) {
  let bytes;
  if (path === "-" && !privateFile) {
    const chunks = []; let size = 0;
    const timer = setTimeout(() => process.stdin.destroy(new RuntimeError("stdin_deadline_reached", 124)), 5000);
    try {
      for await (const chunk of process.stdin) { size += chunk.length; if (size > LIMIT) refuse("spec_limit_exceeded"); chunks.push(chunk); }
      bytes = Buffer.concat(chunks);
    } finally { clearTimeout(timer); }
  } else {
    if (privateFile && (!path || !isAbsolute(path))) refuse("private_configuration_required", 78);
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > LIMIT || privateFile && ((metadata.mode & 0o077) !== 0 || typeof process.getuid === "function" && metadata.uid !== process.getuid())) refuse("file_refused", 78);
      const buffer = Buffer.alloc(LIMIT + 1);
      const result = await file.read(buffer, 0, buffer.length, 0);
      if (result.bytesRead > LIMIT) refuse("file_limit_exceeded", 78);
      bytes = buffer.subarray(0, result.bytesRead);
    } catch (error) { if (error instanceof RuntimeError) throw error; refuse("file_unavailable", 78); }
    finally { await file?.close(); }
  }
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { value: record(JSON.parse(raw)), raw };
  } catch (error) { if (error instanceof RuntimeError) throw error; refuse("invalid_json"); }
}

export async function runtimeClient(path) {
  const { value: config } = await readJson(path, true);
  fields(config, ["origin", "cookie", "token"]);
  let url;
  try { url = new URL(config.origin); } catch { refuse("origin_refused", 78); }
  if (config.origin !== url.origin || url.username || url.password || !["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname)) refuse("origin_refused", 78);
  if (typeof config.cookie === "string" && config.token === undefined && config.cookie.length > 0 && config.cookie.length <= 4096 && !/[\r\n]/.test(config.cookie)) {
    // Current personal session and task policy are revalidated by the listener.
  } else if (typeof config.token === "string" && config.cookie === undefined && /^vinci_live_[A-Za-z0-9_-]+$/.test(config.token) && config.token.length <= 500) {
    // A paired key still needs separately admitted task authority on the listener.
  } else refuse("credential_configuration_refused", 78);
  return async (method, route, raw, timeoutMs = 5000, options = {}) => {
    if (options.signal?.aborted) refuse("observation_aborted", 124);
    const signal = options.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal]) : AbortSignal.timeout(timeoutMs);
    const headers = { origin: url.origin, ...(config.cookie ? { cookie: config.cookie } : { authorization: `Bearer ${config.token}` }) };
    if (method === "POST") { headers["content-type"] = "application/json"; headers["x-vinci-task-intent"] = "1"; }
    let response;
    try { response = await fetch(url.origin + route, { method, headers, ...(raw === undefined ? {} : { body: raw }), redirect: "error", cache: "no-store", signal }); }
    catch { throw new RuntimeError(options.signal?.aborted ? "observation_aborted" : "transport_unconfirmed", options.signal?.aborted ? 124 : 69, method === "POST"); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new RuntimeError(response.status === 401 || response.status === 403 ? "authority_refused" : response.status === 409 ? "stale_or_conflicting_command" : "service_refused", response.status === 401 || response.status === 403 ? 77 : 75, method === "POST");
    }
    const chunks = []; let size = 0; const reader = response.body?.getReader();
    try {
      if (!reader) refuse("response_refused", 69);
      while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > LIMIT * 4) refuse("response_limit_exceeded", 69); chunks.push(item.value); }
      return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
    } catch (error) {
      if (!(error instanceof RuntimeError)) error = new RuntimeError(options.signal?.aborted ? "observation_aborted" : "response_unconfirmed", options.signal?.aborted ? 124 : 69);
      error.mutationUnconfirmed = method === "POST"; throw error;
    }
    finally { await reader?.cancel().catch(() => {}); }
  };
}

function reportField(event, name, kind, optional = false) {
  const field = event.payload?.[name];
  if (field === undefined && optional) return null;
  if (!field || Object.keys(field).length !== 2 || !Object.hasOwn(field, "kind") || !Object.hasOwn(field, "value") || field.kind !== kind) refuse("report_field_refused", 75);
  if (kind === "count") {
    if (!Number.isSafeInteger(field.value) || field.value < 0) refuse("report_field_refused", 75);
  } else if (kind === "digest") {
    if (typeof field.value !== "string" || !/^[a-f0-9]{64}$/.test(field.value)) refuse("report_field_refused", 75);
  } else if (typeof field.value !== "string" || !ID.test(field.value)) refuse("report_field_refused", 75);
  return field.value;
}

async function runtimeReport(request, runId) {
  const detail = await request("GET", `/tasks/${runId}`);
  const snapshot = record(detail.view?.snapshot), run = record(snapshot.run);
  const page = await request("GET", `/tasks/${runId}/events?after=0`);
  const revision = snapshot.revision, events = page.events;
  if (run.schemaVersion !== 1 || run.runId !== runId || !Number.isSafeInteger(revision) || revision < 1 || revision > 1000 || page.revision !== revision || !Array.isArray(events) || events.length !== revision || JSON.stringify(detail.view.events) !== JSON.stringify(events)) refuse("report_replay_incomplete", 75);
  const created = events[0], ownerId = created?.actor?.userId;
  if (created?.type !== "run.created" || created.actor?.kind !== "user" || typeof ownerId !== "string" || !ID.test(ownerId) || created.workspaceId !== ownerId || created.organizationId !== null || reportField(created, "workspaceId", "id") !== ownerId || reportField(created, "workOrderDigest", "digest") !== run.workOrderDigest) refuse("report_scope_binding_refused", 75);
  const eventIds = new Set(), keys = new Set(), started = new Set(), turns = new Map(), demands = new Set();
  let inputTokens = 0, outputTokens = 0, costMicrousd = 0, eventCostMicrousd = 0, humanSeconds = 0, decisions = 0;
  let terminal = null, lastTurnModelId = null;
  for (const [index, event] of events.entries()) {
    if (!event || event.schemaVersion !== 4 || event.runId !== runId || event.workspaceId !== ownerId || event.organizationId !== null || event.sequence !== index + 1 || typeof event.eventId !== "string" || !ID.test(event.eventId) || typeof event.idempotencyKey !== "string" || !ID.test(event.idempotencyKey) || eventIds.has(event.eventId) || keys.has(event.idempotencyKey) || index > 0 && event.type === "run.created") refuse("report_replay_incomplete", 75);
    eventIds.add(event.eventId); keys.add(event.idempotencyKey);
    if (event.type === "agent.turn_started") started.add(reportField(event, "turnId", "id"));
    if (event.type === "agent.turn_finished") {
      const turnId = reportField(event, "turnId", "id");
      const usage = { inputTokens: reportField(event, "inputTokens", "count"), outputTokens: reportField(event, "outputTokens", "count"), costMicrousd: reportField(event, "costMicrousd", "count"), modelId: reportField(event, "modelId", "id") };
      lastTurnModelId = usage.modelId;
      eventCostMicrousd += usage.costMicrousd;
      if (!Number.isSafeInteger(eventCostMicrousd)) refuse("report_counter_overflow", 75);
      if (!started.has(turnId)) refuse("report_turn_binding_refused", 75);
      if (turns.has(turnId)) {
        if (JSON.stringify(turns.get(turnId)) !== JSON.stringify(usage)) refuse("report_turn_conflict", 75);
      } else {
        turns.set(turnId, usage);
        inputTokens += usage.inputTokens; outputTokens += usage.outputTokens; costMicrousd += usage.costMicrousd;
        if (![inputTokens, outputTokens, costMicrousd].every(Number.isSafeInteger)) refuse("report_counter_overflow", 75);
      }
    }
    if (["run.question", "approval.requested"].includes(event.type)) demands.add(`${event.type}:${reportField(event, event.type === "run.question" ? "questionId" : "approvalId", "id")}`);
    if (["run.question_answered", "approval.granted", "approval.denied"].includes(event.type)) {
      humanSeconds += reportField(event, "humanSeconds", "count"); decisions += 1;
      if (!Number.isSafeInteger(humanSeconds)) refuse("report_counter_overflow", 75);
    }
    if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) {
      if (terminal || index !== events.length - 1) refuse("report_terminal_binding_refused", 75);
      terminal = event;
    }
  }
  if (!["CREATED", "RUNNING", "PAUSED", "BLOCKED", "STALLED", "TERMINAL"].includes(run.state) || (run.state === "TERMINAL") !== (terminal !== null)) refuse("report_terminal_binding_refused", 75);
  const completed = terminal?.type === "run.completed" ? terminal : null;
  const terminalState = completed ? reportField(completed, "terminalState", "enum") : terminal?.type === "run.failed" ? "FAILED" : terminal?.type === "run.cancelled" ? "CANCELLED" : null;
  const outcome = completed ? reportField(completed, "outcome", "enum", true) : null;
  const tier = completed ? reportField(completed, "tierReached", "enum", true) : null;
  if (completed && !["DONE", "DONE_UNVERIFIED"].includes(terminalState) || outcome !== null && !["SUCCEEDED", "DO_NOT_START", "DUPLICATE", "NO_LONGER_VALUABLE", "SUPERSEDED", "CLOSE_WITH_NEGATIVE_RESULT"].includes(outcome) || tier !== null && !["NONE", "MERGED", "DEPLOYED", "OBSERVED"].includes(tier)) refuse("report_terminal_binding_refused", 75);
  const { receipt } = await request("GET", `/tasks/${runId}/receipt`);
  let receiptDigest = null, verdict = null, activeDurationMs = null, artifactsReported = null, unresolvedConditionsReported = null;
  if (receipt !== null || completed) {
    const workspace = receipt?.workspace, attention = receipt?.humanAttention;
    if (!completed || !receipt || receipt.receiptVersion !== 3 || receipt.runId !== runId || workspace?.kind !== "personal" || workspace.workspaceId !== ownerId || workspace.ownerId !== ownerId || Object.hasOwn(workspace, "organizationId") || receipt.requester?.kind !== "user" || receipt.requester.userId !== ownerId || receipt.objective !== detail.input || receipt.finalState !== terminalState || receipt.digest !== reportField(completed, "receiptDigest", "digest") || !["VERIFIED_PASS", "BLOCKED", "CONDITIONAL"].includes(receipt.verdict) || receipt.spend !== eventCostMicrousd || receipt.startedAt !== run.startedAt || receipt.completedAt !== completed.occurredAt || receipt.policyId !== reportField(created, "policyId", "id") || receipt.policyVersion !== reportField(created, "policyVersion", "count") || receipt.modelId !== lastTurnModelId) refuse("report_receipt_binding_refused", 75);
    if (attention?.seconds !== humanSeconds || attention.decisions !== decisions || attention.interruptions !== demands.size || attention.seconds !== reportField(completed, "humanAttentionSeconds", "count") || attention.decisions !== reportField(completed, "humanDecisions", "count") || attention.interruptions !== reportField(completed, "humanInterruptions", "count") || attention.escalations !== reportField(completed, "escalations", "count") || !Number.isSafeInteger(receipt.activeDuration) || receipt.activeDuration < 0 || !Array.isArray(receipt.artifactsProduced) || !Array.isArray(receipt.unresolvedConditions)) refuse("report_receipt_binding_refused", 75);
    receiptDigest = receipt.digest; verdict = receipt.verdict; activeDurationMs = receipt.activeDuration;
    artifactsReported = receipt.artifactsProduced.length; unresolvedConditionsReported = receipt.unresolvedConditions.length;
  }
  // Revalidate current authority and stable task state before emitting any report.
  const latest = await request("GET", `/tasks/${runId}`);
  if (latest.view?.snapshot?.revision !== revision || JSON.stringify(latest.view.snapshot.run) !== JSON.stringify(run) || JSON.stringify(latest.view.events) !== JSON.stringify(events) || latest.input !== detail.input) refuse("report_state_changed", 75);
  return {
    reportVersion: 1, runId, revision,
    basis: { source: "authorized local task snapshot/events/receipt", eventSchemaVersion: 4, replay: "complete_contiguous", eventCount: events.length },
    execution: { state: run.state, terminalState, outcome, basis: "canonical run and terminal event" },
    assessment: { verdict, receiptDigest, artifactsReported, unresolvedConditionsReported, basis: receiptDigest ? "bound current receipt; no independent reassessment" : "not recorded" },
    publication: { tierReported: tier, basis: "run.completed.tierReached, when present", independentlyConfirmed: null },
    reportedUsage: { basis: "agent.turn_finished counters deduplicated by canonical turnId; not an invoice", startedTurns: started.size, finishedTurns: turns.size, unfinishedTurns: started.size - turns.size, inputTokens: turns.size ? inputTokens : null, outputTokens: turns.size ? outputTokens : null, costMicrousd: turns.size ? costMicrousd : null, distinctModelsRecorded: new Set([...turns.values()].map(turn => turn.modelId)).size, eventCostMicrousd: turns.size ? eventCostMicrousd : null, eventCostBasis: "all recorded agent.turn_finished events before turn deduplication; bound Work receipt spend agrees when present", activeDurationMs, activeDurationBasis: "bound Work receipt counter, when present", authoritativeForBilling: false },
    recordedAttention: { seconds: humanSeconds, decisions, interruptions: demands.size, basis: "canonical presented-decision events", otherSupervisionSeconds: null },
    unknown: { totalIncurredCost: null, providerQuota: null, accountDebit: null, managedCredits: null, nativeAttribution: null, byoAttribution: null },
  };
}

const SPECIFICATIONS = { create: ["saved", "input", "commandId", "attachments"], answer: ["questionId", "answer", "expectedRevision", "humanSeconds"], approve: ["approvalId", "actionDigest", "commandId", "humanSeconds"], correct: ["approvalId", "actionDigest", "text", "target", "commandId", "expectedRevision"] };
function inputAttachments(value) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) refuse("attachments_invalid");
  const names = new Set(); let bytes = 0;
  for (const attachment of value) {
    fields(attachment, ["name", "mediaType", "content", "digest"]);
    if (typeof attachment.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/.test(attachment.name) || names.has(attachment.name)) refuse("attachment_name_invalid");
    names.add(attachment.name);
    if (!["text/plain", "text/markdown"].includes(attachment.mediaType)) refuse("attachment_media_unsupported");
    if (typeof attachment.content !== "string" || Buffer.from(attachment.content, "utf8").toString("utf8") !== attachment.content) refuse("attachment_text_invalid");
    bytes += Buffer.byteLength(attachment.content); if (bytes > LIMIT) refuse("attachment_limit_exceeded");
    if (typeof attachment.digest !== "string" || !/^[a-f0-9]{64}$/.test(attachment.digest) || createHash("sha256").update(attachment.content).digest("hex") !== attachment.digest) refuse("attachment_integrity_failed");
  }
}
function specification(command, source) {
  let raw;
  try { raw = typeof source === "string" ? source : JSON.stringify(record(source)); } catch { refuse("invalid_json"); }
  if (Buffer.byteLength(raw) > LIMIT) refuse("spec_limit_exceeded");
  let spec;
  try { spec = record(JSON.parse(raw)); } catch { refuse("invalid_json"); }
  fields(spec, SPECIFICATIONS[command]);
  if (command === "create") { if (spec.saved !== true || typeof spec.input !== "string" || !spec.input.trim()) refuse("explicit_saved_input_required"); inputAttachments(spec.attachments); }
  else if (command === "correct") { count(spec.expectedRevision); if (typeof spec.text !== "string" || !spec.text.trim() || typeof spec.target !== "string" || !spec.target.length) refuse("exact_correction_required"); }
  else { count(spec.humanSeconds); if (command === "answer") { identity(spec.questionId); count(spec.expectedRevision); if (typeof spec.answer !== "string" || !spec.answer.trim()) refuse("answer_required"); } }
  if (command !== "answer" && (typeof spec.commandId !== "string" || !spec.commandId.length || spec.commandId.length > (command === "create" ? 100 : 80))) refuse("stable_command_id_required");
  if (["approve", "correct"].includes(command)) { identity(spec.approvalId); if (typeof spec.actionDigest !== "string" || !/^[a-f0-9]{64}$/.test(spec.actionDigest)) refuse("exact_action_digest_required"); }
  return { raw, value: spec };
}
function responseText(value) { if (typeof value !== "string" || Buffer.byteLength(value) > LIMIT) refuse("response_refused", 69); return value; }
function responseFlag(value) { if (typeof value !== "boolean") refuse("response_refused", 69); return value; }
function responseDigest(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) refuse("response_refused", 69); return value; }
function bindingDigest(binding) {
  const names = ["actionId", "runId", "ownerId", "workspaceId", "organizationId", "contentRevision", "actionClass", "target", "contentDigest", "toolId", "accountId", "toolVersion", "expiresAt"];
  if (Object.getPrototypeOf(binding) !== Object.prototype || Reflect.ownKeys(binding).length !== names.length || names.some(name => !Object.hasOwn(binding, name))) refuse("response_refused", 69);
  if (["actionId", "runId", "ownerId", "workspaceId", "actionClass", "target", "toolId", "accountId", "toolVersion"].some(name => typeof binding[name] !== "string" || !binding[name].length) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(binding.actionId) || ["__proto__", "constructor", "prototype"].includes(binding.actionId) || !Number.isSafeInteger(binding.contentRevision) || binding.contentRevision < 1 || !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt < 1 || binding.organizationId !== null && typeof binding.organizationId !== "string") refuse("response_refused", 69);
  responseDigest(binding.contentDigest);
  // Match the producer's raw JSON-array ordering; historical expiry is not new authority.
  return createHash("sha256").update(JSON.stringify(names.map(name => binding[name]))).digest("hex");
}
function eventPage(value, runId, after) {
  record(value); const revision = count(value.revision);
  if (revision < after || !Array.isArray(value.events) || value.events.length !== revision - after || value.events.length > 1000) refuse("replay_gap_requires_resync", 75);
  const ids = new Set(), keys = new Set();
  for (const [index, event] of value.events.entries()) {
    record(event);
    if (event.schemaVersion !== 4 || event.runId !== runId || event.sequence !== after + index + 1 || ids.has(event.eventId) || keys.has(event.idempotencyKey)) refuse("replay_gap_requires_resync", 75);
    identity(event.eventId); identity(event.idempotencyKey); responseText(event.type); responseText(event.occurredAt); record(event.payload);
    ids.add(event.eventId); keys.add(event.idempotencyKey);
  }
  return value;
}
function taskSnapshot(value, runId) {
  const snapshot = record(value), run = record(snapshot.run);
  if (run.schemaVersion !== 1 || run.runId !== runId || !["CREATED", "RUNNING", "PAUSED", "BLOCKED", "STALLED", "TERMINAL"].includes(run.state)) refuse("response_refused", 69);
  identity(run.attemptId); count(snapshot.revision);
  for (const key of ["pendingQuestionId", "pendingApprovalId"]) if (snapshot[key] !== null) identity(snapshot[key]);
  return snapshot;
}
function taskView(value, runId) {
  const view = record(value), snapshot = taskSnapshot(view.snapshot, runId);
  responseFlag(view.cancellationRequested);
  eventPage({ revision: snapshot.revision, events: view.events }, runId, 0);
  const created = view.events[0], owner = created?.actor?.userId;
  if (!created || created.type !== "run.created" || created.actor?.kind !== "user" || typeof owner !== "string" || reportField(created, "workspaceId", "id") !== owner || view.events.some(event => event.workspaceId !== owner || event.organizationId !== null)) refuse("response_scope_refused", 75);
  return view;
}
function sameTask(first, latest) {
  return first.input === latest.input && first.view.cancellationRequested === latest.view.cancellationRequested && JSON.stringify(first.view.snapshot) === JSON.stringify(latest.view.snapshot) && JSON.stringify(first.view.events) === JSON.stringify(latest.view.events);
}

// This local consumer facade shares CLI bytes and service-owned command semantics.
export async function createRuntime(configPath) {
  const transport = await runtimeClient(configPath);
  async function request(method, route, raw, options = {}, validate = value => value) {
    fields(options, ["signal", "timeoutMs"]);
    const timeoutMs = options.timeoutMs === undefined ? 5000 : count(options.timeoutMs, 5000);
    if (timeoutMs < 1 || options.signal !== undefined && !(options.signal instanceof AbortSignal)) refuse("invalid_request_options");
    const value = await transport(method, route, raw, timeoutMs, options);
    try { return validate(value); }
    catch (error) { if (error instanceof RuntimeError && method === "POST") error.mutationUnconfirmed = true; throw error; }
  }
  const inspect = (runId, options) => request("GET", `/tasks/${identity(runId)}`, undefined, options, value => { responseText(value.input); taskView(value.view, runId); return value; });
  const approvals = async (runId, options) => {
    const detail = await inspect(runId, options);
    const value = await request("GET", `/tasks/${runId}/approvals`, undefined, options);
    if (value.approval === null) { if (detail.view.snapshot.pendingApprovalId !== null) refuse("response_refused", 69); return value; }
    const approval = record(value.approval), binding = record(approval.binding), draft = record(approval.draft);
    identity(approval.approvalId); responseDigest(approval.actionDigest);
    if (bindingDigest(binding) !== approval.actionDigest) refuse("response_refused", 69);
    for (const flag of ["pending", "effective", "stale"]) responseFlag(approval[flag]);
    if (binding.runId !== runId || binding.organizationId !== null || binding.ownerId !== binding.workspaceId || binding.workspaceId !== reportField(detail.view.events[0], "workspaceId", "id") || (approval.pending ? detail.view.snapshot.pendingApprovalId !== approval.approvalId : detail.view.snapshot.pendingApprovalId === approval.approvalId) || draft.version !== binding.contentRevision || draft.digest !== binding.contentDigest) refuse("response_refused", 69);
    identity(binding.ownerId); identity(binding.workspaceId); responseText(binding.target); count(binding.contentRevision); count(binding.expiresAt, Number.MAX_SAFE_INTEGER); responseDigest(binding.contentDigest);
    const artifact = detail.view.events.find(event => event.type === "artifact.persisted" && event.payload.artifactId?.value === `draft:v${draft.version}`);
    if (draft.version < 1 || createHash("sha256").update(responseText(draft.content)).digest("hex") !== draft.digest || !artifact || reportField(artifact, "contentDigest", "digest") !== draft.digest) refuse("response_refused", 69);
    const latest = await inspect(runId, options); if (!sameTask(detail, latest)) refuse("response_state_changed", 75);
    return value;
  };
  const events = (runId, options = {}) => {
    fields(options, ["after", "signal", "timeoutMs"]); const { after = 0, ...requestOptions } = options; count(after);
    return request("GET", `/tasks/${identity(runId)}/events?after=${after}`, undefined, requestOptions, value => eventPage(value, runId, after));
  };
  return {
    async create(source, options) {
      const payload = specification("create", source);
      return request("POST", "/tasks", payload.raw, options, value => { identity(value.runId); responseText(value.retention); taskView(value.view, value.runId); return value; });
    }, inspect, events, approvals,
    async questions(runId, options) {
      const detail = await inspect(runId, options), value = await request("GET", `/tasks/${runId}/questions`, undefined, options);
      if (value.questionId !== detail.view.snapshot.pendingQuestionId) refuse("response_state_changed", 75);
      if (value.questionId === null && value.question === null) return value;
      identity(value.questionId); responseText(value.question);
      const latest = await inspect(runId, options); if (!sameTask(detail, latest)) refuse("response_state_changed", 75);
      return value;
    },
    async answer(runId, source, options) {
      const payload = specification("answer", source);
      return request("POST", `/tasks/${identity(runId)}/answers`, payload.raw, options, value => taskView(value, runId));
    },
    async approve(runId, source, options) {
      const payload = specification("approve", source), { approval } = await approvals(runId, options), spec = payload.value;
      if (!approval || approval.approvalId !== spec.approvalId || approval.actionDigest !== spec.actionDigest || approval.pending !== true || approval.stale !== false) refuse("stale_approval", 75);
      return request("POST", `/tasks/${identity(runId)}/approve`, payload.raw, options, value => {
        if (value.approvalId !== spec.approvalId || value.effective !== true) refuse("response_refused", 69); return value;
      });
    },
    async correct(runId, source, options) {
      const payload = specification("correct", source);
      return request("POST", `/tasks/${identity(runId)}/corrections`, payload.raw, options, value => { if (count(value.revision) < 1) refuse("response_refused", 69); return value; });
    },
    cancel: (runId, options) => request("POST", `/tasks/${identity(runId)}/cancel`, "{}", options, value => { taskView(value.view, runId); responseFlag(value.acknowledged); return value; }),
    async receipt(runId, options) {
      const detail = await inspect(runId, options);
      const value = await request("GET", `/tasks/${runId}/receipt`, undefined, options), completion = detail.view.events.find(event => event.type === "run.completed");
      if (value.receipt === null) { if (completion) refuse("response_refused", 69); return value; }
      const receipt = record(value.receipt), workspace = record(receipt.workspace), requester = record(receipt.requester), created = detail.view.events[0];
      if (!completion || detail.view.snapshot.run.state !== "TERMINAL" || receipt.receiptVersion !== 3 || receipt.runId !== runId || receipt.digest !== reportField(completion, "receiptDigest", "digest") || receipt.finalState !== reportField(completion, "terminalState", "enum") || !["DONE", "DONE_UNVERIFIED"].includes(receipt.finalState) || !["VERIFIED_PASS", "BLOCKED", "CONDITIONAL"].includes(receipt.verdict) || receipt.objective !== detail.input || workspace.kind !== "personal" || workspace.workspaceId !== reportField(created, "workspaceId", "id") || workspace.ownerId !== workspace.workspaceId || Object.hasOwn(workspace, "organizationId") || requester.kind !== "user" || requester.userId !== workspace.ownerId) refuse("response_refused", 69);
      const latest = await inspect(runId, options); if (!sameTask(detail, latest)) refuse("response_state_changed", 75);
      return value;
    },
    async artifact(runId, artifactId, version, options) {
      identity(artifactId); if (count(version, 999999999) < 1) refuse("invalid_artifact_version");
      const detail = await inspect(runId, options);
      const value = await request("GET", `/tasks/${runId}/artifacts/${artifactId}/${version}`, undefined, options);
      const event = detail.view.events.find(event => event.type === "artifact.persisted" && event.payload.artifactId?.value === `${artifactId}:v${version}`);
      if (value.artifactId !== artifactId || value.version !== version || createHash("sha256").update(responseText(value.content)).digest("hex") !== responseDigest(value.digest) || !event || reportField(event, "contentDigest", "digest") !== value.digest) refuse("artifact_content_refused", 69);
      const latest = await inspect(runId, options); if (!sameTask(detail, latest)) refuse("response_state_changed", 75);
      return value;
    },
    report: (runId, options) => runtimeReport((method, route) => request(method, route, undefined, options), identity(runId)),
    async watch(runId, options, onEvent) {
      fields(options, ["after", "timeoutMs", "signal"]); identity(runId);
      let cursor = count(options.after ?? 0); const duration = count(options.timeoutMs, 3600000), ids = new Set(), keys = new Set();
      if (duration < 1 || typeof onEvent !== "function" || options.signal !== undefined && !(options.signal instanceof AbortSignal)) refuse("invalid_watch_options");
      const deadline = Date.now() + duration, deadlineSignal = AbortSignal.timeout(duration);
      const signal = options.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal;
      while (Date.now() < deadline) {
        let page;
        try { page = await events(runId, { after: cursor, timeoutMs: 5000, signal }); }
        catch (error) {
          if (error instanceof RuntimeError && error.code === "observation_aborted" && deadlineSignal.aborted && !options.signal?.aborted) refuse("watch_deadline_reached", 124);
          throw error;
        }
        for (const event of page.events) {
          if (ids.has(event.eventId) || keys.has(event.idempotencyKey)) refuse("replay_gap_requires_resync", 75);
          ids.add(event.eventId); keys.add(event.idempotencyKey); onEvent(event);
        }
        cursor = page.revision;
        if (page.events.some(event => ["run.completed", "run.failed", "run.cancelled"].includes(event.type))) return { revision: cursor, terminalObserved: true };
        const pause = Math.min(1000, deadline - Date.now());
        if (pause > 0) try { await delay(pause, undefined, { signal }); } catch { refuse(deadlineSignal.aborted && !options.signal?.aborted ? "watch_deadline_reached" : "observation_aborted", 124); }
      }
      refuse("watch_deadline_reached", 124);
    },
  };
}

export async function runRuntime(args, configPath = process.env.VINCI_RUNTIME_CONFIG, write = value => process.stdout.write(value)) {
  if (!args.length || args[0] === "--help" || args[0] === "help") { write(HELP); return; }
  const positional = [], options = {}; let json = false;
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === "--json") { if (json) refuse("duplicate_option"); json = true; }
    else if (["--spec", "--after", "--timeout"].includes(value)) {
      if (Object.hasOwn(options, value) || !args[i + 1] || args[i + 1].startsWith("--")) refuse("invalid_option");
      options[value] = args[++i];
    } else if (value.startsWith("--")) refuse("unsupported_option");
    else positional.push(value);
  }
  const [command, runId, artifactId, version] = positional;
  const reads = { inspect: "", questions: "/questions", approvals: "/approvals", receipt: "/receipt" };
  const specifications = SPECIFICATIONS;
  if (!Object.hasOwn(reads, command) && !Object.hasOwn(specifications, command) && !["events", "watch", "cancel", "export", "report"].includes(command)) refuse("unsupported_command");
  const allowed = Object.hasOwn(specifications, command) ? ["--spec"] : command === "events" ? ["--after"] : command === "watch" ? ["--after", "--timeout"] : [];
  if (Object.keys(options).some(option => !allowed.includes(option)) || positional.length !== (command === "create" ? 1 : command === "export" ? 4 : 2)) refuse("invalid_arguments");
  if (command !== "create") identity(runId);
  let payload;
  if (Object.hasOwn(specifications, command)) {
    if (!options["--spec"]) refuse("explicit_spec_required");
    payload = await readJson(options["--spec"]); specification(command, payload.raw);
  }
  const after = options["--after"] === undefined ? 0 : /^[0-9]{1,9}$/.test(options["--after"]) ? count(Number(options["--after"])) : refuse("invalid_cursor");
  const seconds = options["--timeout"] && /^[1-9][0-9]{0,3}$/.test(options["--timeout"]) ? count(Number(options["--timeout"]), 3600) : command === "watch" ? refuse("bounded_timeout_required") : 0;
  if (command === "export") { identity(artifactId); if (!/^[1-9][0-9]{0,8}$/.test(version)) refuse("invalid_artifact_version"); }
  const client = await createRuntime(configPath);
  if (command === "report") { write(`${JSON.stringify(await client.report(runId), null, json ? undefined : 2)}\n`); return; }
  if (command === "watch") { await client.watch(runId, { after, timeoutMs: seconds * 1000 }, event => write(`${JSON.stringify(event)}\n`)); return; }
  const value = command === "create" ? await client.create(payload.raw)
    : command === "export" ? await client.artifact(runId, artifactId, Number(version))
    : command === "events" ? await client.events(runId, { after })
    : Object.hasOwn(specifications, command) ? await client[command](runId, payload.raw)
    : await client[command](runId);
  if (command === "export" && !json) { if (typeof value.content !== "string") refuse("artifact_content_refused", 69); write(value.content); }
  else if (command === "cancel" && !json) write(`Cancellation requested for ${runId}; termination is ${value.acknowledged === true ? "acknowledged by the host" : "unconfirmed"}.\n`);
  else write(`${JSON.stringify(value, null, json ? undefined : 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try { await runRuntime(process.argv.slice(2)); }
  catch (error) {
    const code = error instanceof RuntimeError ? error.code : "operation_unconfirmed";
    process.stderr.write(`Runtime command refused with code "${code}". Reload current task authority and exact state before retrying; reconcile any unconfirmed mutation first.\n`);
    process.exitCode = error instanceof RuntimeError ? error.exitCode : 69;
  }
}
