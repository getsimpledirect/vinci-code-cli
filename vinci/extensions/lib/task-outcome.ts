import { formatDuration } from "./format-duration.ts";
import {
  addVinciAccumulatedUsage,
  getVinciTaskUsageSnapshot,
  hydrateVinciTaskUsage,
  isVinciUsageSnapshot,
  microUsdToUsd,
  subscribeVinciTaskUsage,
  summarizeVinciUsageSnapshot,
  type VinciUsageSnapshot,
  usdToMicroUsd,
  vinciResponseKey,
} from "./usage-accumulator.ts";
import {
  hasIncompleteVinciBehavioralAttempt,
  hasVinciZeroCollectionAttempt,
  vinciCheckWarrantedPath,
  vinciVerificationCommand,
  vinciIncompleteBehavioralAttemptSummary,
  type RemoteAcceptanceVerdict,
  type VinciVerificationState,
} from "./verification-state.ts";
import { vinciVerificationDisabled } from "./verification-control.ts";

export const VINCI_TASK_OUTCOME_ENTRY = "vinci-task-outcome";
export const VINCI_FALSE_COMPLETION_ENTRY = "vinci-false-completion-report";
const SCHEMA_VERSION = 1;

export type VinciTaskState = "DONE" | "DONE_UNVERIFIED" | "WAITING" | "BLOCKED";

/**
 * Does a tool result's TEXT report a failed edit? Soft failures carry no `isError` flag, so this
 * pattern is the only signal — but it must not fire on the tool's own success sentence, which
 * echoes the path: an edit to `src/overlap.ts` succeeded and still matched the bare `overlap`
 * pattern, reading as a failure on both sides (and dropping the file from changedFiles).
 * Exported so the receipt and the outcome classifier cannot drift apart by hand-copied regex.
 */
export function vinciToolTextReportsFailure(text: string): boolean {
  if (/^\s*Successfully\b/i.test(text)) return false;
  return /could not find the exact text|no changes|validation failed|overlap|must match exactly/i.test(text);
}

/** One wording for both ask branches (#199 changed-but-unverified, #215 zero-change) so they
 *  cannot drift apart — and deliberately state-neutral about WHAT changed, since the receipt's
 *  session-delta veto may list files the turn never touched on the same record. */
/** Reachable from two adjacent arms (verification off with nothing recorded; verification on with
 *  doc-only paths). Single-sourced so a mutation cannot silently target one copy. */
const VINCI_DOC_ONLY_REASON = "Documentation change applied; no project check was required.";
export const VINCI_ASK_HOLDING_REASON = "The final reply asks for your go-ahead — the work is holding for your answer.";

/**
 * D10 (wave5.md, locked decisions 4-5):
 * VERIFIED_PASS -> DONE; BLOCKED -> BLOCKED; CONDITIONAL/FAILED -> DONE_UNVERIFIED;
 * CANCELLED -> no change. Staled/absent records also leave the local latch authoritative.
 */
export function remoteVerdictTaskState(record: RemoteAcceptanceVerdict | undefined): VinciTaskState | undefined {
  if (!record || record.staled) return undefined;
  switch (record.status) {
    case "VERIFIED_PASS":
      return "DONE";
    case "BLOCKED":
      return "BLOCKED";
    case "CONDITIONAL":
    case "FAILED":
      return "DONE_UNVERIFIED";
    case "CANCELLED":
      return undefined;
  }
}

export type VinciTaskUsage = {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
  providers: string[];
  models: string[];
};

export type VinciTaskOutcome = {
  schemaVersion: typeof SCHEMA_VERSION;
  taskId: string;
  state: VinciTaskState;
  reason: string;
  changedFiles: string[];
  verificationStatus: VinciVerificationState["status"];
  verificationCommand: string;
  activeDurationMs?: number;
  usage: VinciTaskUsage;
  /** Supplemental complete() calls only; assistant-stream usage remains in assistantUsage. */
  supplementalUsage?: VinciUsageSnapshot;
  /** Additive client-accounting detail; future server-authoritative usage can replace this source. */
  assistantUsage?: VinciTaskUsage;
  assistantResponseKeys?: string[];
  recordedAt: string;
};

export type VinciFalseCompletionReport = {
  schemaVersion: typeof SCHEMA_VERSION;
  reportId: string;
  taskId: string;
  outcomeRecordedAt: string;
  claimedState: "DONE" | "DONE_UNVERIFIED";
  verificationStatus: VinciVerificationState["status"];
  verificationCommand: string;
  changedFiles: string[];
  modelCalls: number;
  providers: string[];
  models: string[];
  estimatedCostUsd: number;
  note: string;
  reportedAt: string;
};

type UsageLike = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  reasoning?: unknown;
  cost?: { total?: unknown };
};

type MessageLike = {
  role?: unknown;
  content?: unknown;
  provider?: unknown;
  model?: unknown;
  responseModel?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  usage?: UsageLike;
};

type ContentLike = { type?: unknown; text?: unknown };

type BuildOutcomeInput = {
  taskId: string;
  messages: readonly unknown[];
  usageMessages?: readonly unknown[];
  changedFiles: readonly string[];
  verification: Readonly<VinciVerificationState>;
  activeDurationMs?: number;
  now?: Date;
};

type TaskOutcomeStore = { outcome?: VinciTaskOutcome; usageSubscriptionInstalled?: boolean };
const STORE_KEY = "__vinciTaskOutcomeStore" as const;
const USAGE_STORE_KEY = "__vinciUsageAccumulatorStore" as const;
type UsagePersistenceStore = {
  appendEntry?: (taskId: string, customType: string, data: unknown) => boolean;
};
type VinciGlobal = typeof globalThis & {
  [STORE_KEY]?: TaskOutcomeStore;
  [USAGE_STORE_KEY]?: UsagePersistenceStore;
};
const vinciGlobal = globalThis as VinciGlobal;
const store = vinciGlobal[STORE_KEY] ?? {};
vinciGlobal[STORE_KEY] = store;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isTaskUsageRecord(value: unknown): boolean {
  const usage = record(value);
  if (!usage) return false;
  return (
    [
      usage.modelCalls,
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedTokens,
      usage.cacheWriteTokens,
      usage.reasoningTokens,
      usage.estimatedCostUsd,
    ].every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0) &&
    Array.isArray(usage.providers) &&
    usage.providers.every((provider) => typeof provider === "string") &&
    Array.isArray(usage.models) &&
    usage.models.every((model) => typeof model === "string")
  );
}

function assistantMessages(messages: readonly unknown[]): MessageLike[] {
  return messages
    .map((message) => record(message) as MessageLike | undefined)
    .filter((message): message is MessageLike => message?.role === "assistant");
}

/**
 * Did this run ATTEMPT to change files? Read from the assistant's own edit/write tool calls, not
 * from the resulting file list (#215): a run whose writes were refused — by the workspace guard,
 * a permission gate, a failed match — changes nothing, and calling that "a read-only task" reports
 * the shape of the OUTCOME as if it were the shape of the REQUEST. A refused mutation is not a
 * read-only request that happened to touch nothing.
 */
function attemptedFileChange(messages: readonly unknown[]): { attempted: boolean; failed: boolean } {
  const writeCallIds = new Set<string>();
  let attemptedWithoutId = false;
  for (const message of assistantMessages(messages)) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const content = record(part) as { type?: unknown; name?: unknown; id?: unknown } | undefined;
      if (content?.type !== "toolCall") continue;
      if (content.name !== "edit" && content.name !== "write") continue;
      // Skip id-less calls rather than bucketing them under "": an unrelated id-less error result
      // would otherwise be read as this call's failure.
      if (typeof content.id === "string" && content.id) writeCallIds.add(content.id);
      else attemptedWithoutId = true;
    }
  }
  if (writeCallIds.size === 0) return { attempted: attemptedWithoutId, failed: false };
  // A write can also SUCCEED and still leave changedFiles empty — an edit to a gitignored or
  // artifact-excluded path. Claiming "did not go through" there would be its own false statement,
  // so the failure claim is made only on recorded failure evidence.
  let failed = false;
  for (const entry of messages) {
    const message = record(entry) as
      | { role?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown }
      | undefined;
    if (message?.role !== "toolResult") continue;
    if (typeof message.toolCallId !== "string" || !writeCallIds.has(message.toolCallId)) continue;
    if (message.isError === true) {
      failed = true;
      continue;
    }
    // Soft failures carry no isError flag (the receipt's own failedChange predicate recognises
    // them and drops such files from changedFiles). Keeping the two in agreement stops one from
    // reporting "did write to a file" over what the other treats as a failure.
    const content: readonly unknown[] = Array.isArray(message.content) ? message.content : [];
    const text = content
      .map((part) => record(part) as ContentLike | undefined)
      .filter((part): part is ContentLike => part?.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n");
    if (vinciToolTextReportsFailure(text)) failed = true;
  }
  return { attempted: true, failed };
}

function assistantText(message: MessageLike | undefined): string {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map((part) => record(part) as ContentLike | undefined)
    .filter((part): part is ContentLike => part?.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
    .trim();
}

function userFacingFailure(error: string): string {
  if (/Provider stream timed out after \d+ms without (?:an|a content) event/i.test(error)) {
    return "Vinci's provider stopped responding after repeated attempts. Continue to retry from where it paused.";
  }
  return error;
}

function summarizeAssistantUsage(messages: readonly unknown[]): VinciTaskUsage {
  const providers = new Set<string>();
  const models = new Set<string>();
  // Assistant-stream and supplemental costs both accumulate as integer micro-USD internally.
  let estimatedCostMicroUsd = 0;
  const usage: VinciTaskUsage = {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    providers: [],
    models: [],
  };
  for (const message of assistantMessages(messages)) {
    usage.modelCalls++;
    usage.inputTokens += finite(message.usage?.input);
    usage.outputTokens += finite(message.usage?.output);
    usage.cachedTokens += finite(message.usage?.cacheRead);
    usage.cacheWriteTokens += finite(message.usage?.cacheWrite);
    usage.reasoningTokens += finite(message.usage?.reasoning);
    estimatedCostMicroUsd += usdToMicroUsd(finite(message.usage?.cost?.total));
    if (typeof message.provider === "string" && message.provider) providers.add(message.provider);
    const model = typeof message.responseModel === "string" && message.responseModel
      ? message.responseModel
      : typeof message.model === "string"
        ? message.model
        : "";
    if (model) models.add(model);
  }
  usage.estimatedCostUsd = microUsdToUsd(estimatedCostMicroUsd);
  usage.providers = [...providers].sort();
  usage.models = [...models].sort();
  return usage;
}

function assistantResponseKeys(messages: readonly unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const message of assistantMessages(messages)) {
    const key = vinciResponseKey(message);
    if (key) keys.add(key);
  }
  return keys;
}

function combinedTaskUsage(
  assistantUsage: Readonly<VinciTaskUsage>,
  supplementalUsage: Readonly<VinciUsageSnapshot>,
): VinciTaskUsage {
  return addVinciAccumulatedUsage(
    {
      ...assistantUsage,
      providers: assistantUsage.providers.slice(),
      models: assistantUsage.models.slice(),
    },
    summarizeVinciUsageSnapshot(supplementalUsage),
  );
}

export function summarizeVinciTaskUsage(
  messages: readonly unknown[],
  taskId?: string,
): VinciTaskUsage {
  const streamUsage = summarizeAssistantUsage(messages);
  if (!taskId) return streamUsage;
  return combinedTaskUsage(streamUsage, getVinciTaskUsageSnapshot(taskId, assistantResponseKeys(messages)));
}

export function currentRemoteVerdict(
  verification: Readonly<VinciVerificationState>,
): RemoteAcceptanceVerdict | undefined {
  if (vinciVerificationDisabled()) return undefined;
  return Object.values(verification.remoteAcceptanceVerdicts ?? {})
    .filter((verdict) => remoteVerdictTaskState(verdict) !== undefined)
    .sort(
      (left, right) =>
        right.recordedAtIso.localeCompare(left.recordedAtIso) ||
        (right.eventCursor ?? "").localeCompare(left.eventCursor ?? "") ||
        right.jobId.localeCompare(left.jobId),
    )[0];
}

function remoteVerdictOutcome(record: RemoteAcceptanceVerdict): { state: VinciTaskState; reason: string } {
  const state = remoteVerdictTaskState(record);
  if (!state) throw new Error("A non-current remote verdict cannot determine task state.");
  if (record.status === "FAILED") {
    return {
      state,
      reason: "Vinci could not complete remote acceptance verification. The work is done, but remains unverified.",
    };
  }
  return {
    state,
    reason:
      record.summary ||
      (record.status === "VERIFIED_PASS"
        ? "Remote acceptance verification passed."
        : record.status === "BLOCKED"
          ? "Remote acceptance verification found a blocker."
          : "Remote acceptance verification completed conditionally."),
  };
}

/**
 * What this run looks like from LOCAL evidence only — the checks that actually ran here, with any
 * remote acceptance verdict ignored.
 *
 * This exists because the two audiences differ (#171). The receipt shows a human the remote
 * verdict, which is the more informative answer. The headless exit code answers a script, and a
 * script must never be told "success" by a remote service when the check that ran on this machine
 * failed — that is #22's laundering shape and it would break #127's exit contract.
 */
/**
 * Does the CLOSING of a final message ask the user for a decision the run is holding on? A narrow
 * POSITIVE grammar (#43's lesson: reject-lists are never complete, so this is an allowlist of
 * approval-to-proceed phrasings), matched against the tail only — a mid-message aside must not
 * reclassify a finished answer. False negatives are safe (the outcome keeps today's state);
 * false positives would flip headless exits, so no generic question detection ("?" alone) here.
 */
export function vinciFinalMessageAsksUser(text: string): boolean {
  // 400 chars: Vinci's own appended hedges ("run it yourself to confirm…", ~165 chars) sit inside
  // this tail, and the model's actual closing must still fit in front of them.
  const closing = text.trim().slice(-400);
  // Review-probed exclusions: no bare "say go" (matched "the checks say go" — a completion
  // statement), and "waiting for your" is noun-bounded ("waiting for your infra team" is a
  // third-party dependency, not an ask). Negated or quoted phrasings can still match; that
  // residual is bounded to otherwise-unverified outcomes and accepted.
  return /\b(?:just confirm\b|confirm(?:,)? and i(?:'|’)ll\b|your (?:go-ahead|confirmation|approval|permission)\b|waiting (?:on|for) your (?:go-ahead|confirmation|approval|permission|answer|decision|word)\b|(?:shall|should|may) i (?:apply|proceed|continue|go ahead|commit|push|merge|deploy)\b|want me to (?:apply|proceed|continue|go ahead|commit|push|merge|deploy)\b|\bok(?:ay)? to (?:apply|proceed|continue)\b)/i.test(
    closing,
  );
}

export function classifyVinciLocalTaskState(
  messages: readonly unknown[],
  changedFiles: readonly string[],
  verification: Readonly<VinciVerificationState>,
): { state: VinciTaskState; reason: string } {
  if (verification.variant === "terminal-unverifiable") {
    return { state: "BLOCKED", reason: verification.summary };
  }

  const assistants = assistantMessages(messages);
  const last = assistants.at(-1);
  const text = assistantText(last);
  const incompleteBehavioralAttempt = hasIncompleteVinciBehavioralAttempt(verification);
  const zeroCollection = hasVinciZeroCollectionAttempt(verification);
  const verificationPassed = verification.status === "passed" && !incompleteBehavioralAttempt;
  if (last?.stopReason === "error" || last?.stopReason === "aborted") {
    const error = typeof last.errorMessage === "string" ? last.errorMessage.trim() : "";
    // "passed" is only set while verifiedRevision === mutationRevision (any later edit flips it
    // to stale), so verified changed work interrupted at the very end is complete — telling the
    // user BLOCKED here reads as a failed task when only the wrap-up died (observed live: a
    // provider stall after 21/21 tests passed produced a bare BLOCKED receipt).
    if (verificationPassed && changedFiles.length > 0) {
      return {
        state: "DONE",
        reason: `${verification.summary || "The direct check passed."} The final wrap-up was interrupted (${
          error ? userFacingFailure(error) : "the task stopped early"
        }), but the verified work is complete.`.slice(0, 240),
      };
    }
    return { state: "BLOCKED", reason: error ? userFacingFailure(error) : "The task stopped before completion." };
  }
  if (zeroCollection && !verification.requiredCommand) {
    return {
      state: "DONE_UNVERIFIED",
      reason:
        verification.summary ||
        `The attempted check (${verification.behavioralAttemptCommand || verification.command}) ran without executing tests, so nothing was verified.`,
    };
  }
  if (/^\s*BLOCKED:/i.test(text)) return { state: "BLOCKED", reason: text.split("\n")[0].slice(0, 240) };
  if (/^\s*WAITING:/i.test(text)) return { state: "WAITING", reason: text.split("\n")[0].slice(0, 240) };
  // #10: verification being switched off never changes the STATE — it changes what we may say
  // about it. Two earlier attempts overrode the state and were both wrong: the first erased a
  // genuine current pass, the second downgraded doc-only work that never needed a check. The
  // remaining dishonesty is narrower and lives in the reason text below: claiming "no project
  // check was required" when the truth is "verification was off". Distinguishing changes that
  // NEEDED a check from ones that did not is tracked in #187.
  if (verification.status === "failed") {
    // An honest environmental blocker often EXPLAINS first and puts its "Blocked:" line later (the
    // recovery instruction asks for "a line starting with Blocked:"). Quote that line as the receipt
    // reason — the raw verification summary showed "Command exited with code 1" (the crashed runner)
    // instead of the actual cause (found live 2026-07-16, pytest-not-installed).
    const blockedLine = text.match(/^\s*Blocked\s*[:—]\s*(.+)$/im);
    if (blockedLine) return { state: "BLOCKED", reason: `Blocked: ${blockedLine[1].trim()}`.slice(0, 240) };
    return { state: "BLOCKED", reason: verification.summary || "The recorded verification failed." };
  }
  if (incompleteBehavioralAttempt) {
    return {
      state: "DONE_UNVERIFIED",
      reason:
        vinciIncompleteBehavioralAttemptSummary(verification) ||
        "A stronger behavioral check was attempted but did not produce a result.",
    };
  }
  if (changedFiles.some((file) => vinciCheckWarrantedPath(file)) && verification.status !== "passed") {
    // [#199] A run whose final words ask for the user's go-ahead is not done — it is WAITING, and
    // a headless caller must see exit 3, not 0 over held work ("Just confirm and I'll apply it" —
    // observed live). Only an otherwise-unverified outcome flips: verified work that closes with
    // a courtesy question stays DONE, and a missed phrasing merely keeps today's behavior.
    if (vinciFinalMessageAsksUser(text)) {
      return { state: "WAITING", reason: VINCI_ASK_HOLDING_REASON };
    }
    return {
      state: "DONE_UNVERIFIED",
      reason: verification.summary || "The project changed without a successful direct check.",
    };
  }
  // [#215] A run that changed nothing BECAUSE it is waiting on the user is the clearest WAITING
  // case in the contract — clearer than the changed-but-unverified one #199 already covers — and
  // it was exiting 0 with a "read-only task completed" receipt.
  // Scope honestly: on a ZERO-change run `status === "passed"` is nearly unreachable (a read-only
  // turn runs no checks), so unlike #199's branch this one reduces to the grammar alone. That is
  // the intended widening — a polite read-only turn CAN now exit 3 — and the grammar's accepted
  // residual (negations, quotations) is correspondingly less bounded here than it is for #199.
  if (changedFiles.length === 0 && verification.status !== "passed" && vinciFinalMessageAsksUser(text)) {
    // Deliberately state-neutral about what changed: the receipt's session-delta veto (#203) may
    // add files this turn did not touch, and a "nothing was changed" claim would then contradict
    // the file list on its own record.
    return { state: "WAITING", reason: VINCI_ASK_HOLDING_REASON };
  }
  const attemptedWrite = attemptedFileChange(messages);
  return {
    state: "DONE",
    reason: verification.status === "passed"
      ? verification.summary || "The direct check passed."
      : changedFiles.length > 0
        ? vinciVerificationDisabled()
          // [#187] Three-way honesty under the off switch, read from the EXPLICIT warranted-fact
          // (checkWarrantedRevision — recorded by the sites that know each change's paths), never
          // from mutationRevision alone: that is a shared staleness counter which undo bumps for
          // any revert and older recorders bumped for tracked doc edits, so treating it as
          // "warranted" produced affirmatively false receipts on doc-only sessions (caught in
          // review). warranted-fact recorded → say what was skipped; mutations happened but no
          // fact recorded → the old vague-but-true wording; no mutations at all → the doc-only
          // honest wording survives the switch.
          ? (verification.checkWarrantedRevision ?? -1) > 0
            ? "Changes this session warranted a project check, but verification is switched off."
            : verification.mutationRevision > 0
              ? "No project check was run for this change."
              : VINCI_DOC_ONLY_REASON
          : VINCI_DOC_ONLY_REASON
        : attemptedWrite.failed
          // [#215] The turn tried to write and the write was refused or failed — a guard, a gate,
          // a non-matching edit. Never call that a read-only task.
          ? "No files changed: the attempted change did not go through."
          : attemptedWrite.attempted
            // Wrote without error, yet nothing is listed — a gitignored or excluded path. Report
            // the fact rather than guessing at either "read-only" or "failed".
            ? "No project changes are listed for this run, though the turn did write to a file."
            : "The requested read-only task completed without project changes.",
  };
}

/**
 * What the RECEIPT shows: a current remote acceptance verdict takes precedence, because it is the
 * more informative answer for a human reading the wrap-up. This never starts, retries, or
 * resubmits an acceptance job — and, per #171, it never decides the headless exit code either:
 * that is `classifyVinciLocalTaskState`'s job, combined conservatively at the call site.
 */
export function classifyVinciTaskState(
  messages: readonly unknown[],
  changedFiles: readonly string[],
  verification: Readonly<VinciVerificationState>,
): { state: VinciTaskState; reason: string } {
  const remoteVerdict = currentRemoteVerdict(verification);
  if (remoteVerdict) return remoteVerdictOutcome(remoteVerdict);
  return classifyVinciLocalTaskState(messages, changedFiles, verification);
}

export function buildVinciTaskOutcome(input: BuildOutcomeInput): VinciTaskOutcome {
  const changedFiles = [...new Set(input.changedFiles)].sort();
  const terminal = classifyVinciTaskState(input.messages, changedFiles, input.verification);
  const usageMessages = input.usageMessages ?? input.messages;
  const streamUsage = summarizeAssistantUsage(usageMessages);
  const responseKeys = assistantResponseKeys(usageMessages);
  // Double-count prevention is identity-based and defensive: normal agent-loop calls live only in
  // the assistant-message stream, while explicit extension/grader calls live in the accumulator.
  // If a response is accidentally reported to both, its provider + responseId matches a durable
  // assistant message and is excluded from the supplemental snapshot before totals are combined.
  const supplementalUsage = getVinciTaskUsageSnapshot(input.taskId, responseKeys);
  return {
    schemaVersion: SCHEMA_VERSION,
    taskId: input.taskId,
    state: terminal.state,
    reason: terminal.reason,
    changedFiles,
    // Not gated on the switch: these report what was actually recorded. Blanking them hid the name
    // of a check that genuinely ran and passed — the same evidence-vs-setting conflation narrowed
    // above. When nothing ran, the underlying values are already empty.
    verificationStatus: input.verification.status,
    verificationCommand: vinciVerificationCommand(input.verification),
    activeDurationMs: Math.max(0, input.activeDurationMs ?? 0),
    usage: combinedTaskUsage(streamUsage, supplementalUsage),
    supplementalUsage,
    assistantUsage: streamUsage,
    assistantResponseKeys: [...responseKeys],
    recordedAt: (input.now ?? new Date()).toISOString(),
  };
}

export function isVinciTaskOutcome(value: unknown): value is VinciTaskOutcome {
  const candidate = record(value);
  return (
    candidate?.schemaVersion === SCHEMA_VERSION &&
    typeof candidate.taskId === "string" &&
    (candidate.state === "DONE" ||
      candidate.state === "DONE_UNVERIFIED" ||
      candidate.state === "WAITING" ||
      candidate.state === "BLOCKED") &&
    typeof candidate.reason === "string" &&
    Array.isArray(candidate.changedFiles) &&
    candidate.changedFiles.every((file) => typeof file === "string") &&
    (candidate.verificationStatus === "none" ||
      candidate.verificationStatus === "stale" ||
      candidate.verificationStatus === "failed" ||
      candidate.verificationStatus === "passed") &&
    typeof candidate.verificationCommand === "string" &&
    (candidate.activeDurationMs === undefined ||
      (typeof candidate.activeDurationMs === "number" &&
        Number.isFinite(candidate.activeDurationMs) &&
        candidate.activeDurationMs >= 0)) &&
    typeof candidate.recordedAt === "string" &&
    isTaskUsageRecord(candidate.usage) &&
    (candidate.supplementalUsage === undefined || isVinciUsageSnapshot(candidate.supplementalUsage)) &&
    (candidate.assistantResponseKeys === undefined ||
      (Array.isArray(candidate.assistantResponseKeys) &&
        candidate.assistantResponseKeys.every((key) => typeof key === "string"))) &&
    (candidate.assistantUsage === undefined || isTaskUsageRecord(candidate.assistantUsage))
  );
}

export function isVinciFalseCompletionReport(value: unknown): value is VinciFalseCompletionReport {
  const candidate = record(value);
  return (
    candidate?.schemaVersion === SCHEMA_VERSION &&
    typeof candidate.reportId === "string" &&
    typeof candidate.taskId === "string" &&
    typeof candidate.outcomeRecordedAt === "string" &&
    (candidate.claimedState === "DONE" || candidate.claimedState === "DONE_UNVERIFIED") &&
    (candidate.verificationStatus === "none" ||
      candidate.verificationStatus === "stale" ||
      candidate.verificationStatus === "failed" ||
      candidate.verificationStatus === "passed") &&
    typeof candidate.verificationCommand === "string" &&
    Array.isArray(candidate.changedFiles) &&
    candidate.changedFiles.every((file) => typeof file === "string") &&
    typeof candidate.modelCalls === "number" &&
    Number.isFinite(candidate.modelCalls) &&
    candidate.modelCalls >= 0 &&
    Array.isArray(candidate.providers) &&
    candidate.providers.every((provider) => typeof provider === "string") &&
    Array.isArray(candidate.models) &&
    candidate.models.every((model) => typeof model === "string") &&
    typeof candidate.estimatedCostUsd === "number" &&
    Number.isFinite(candidate.estimatedCostUsd) &&
    candidate.estimatedCostUsd >= 0 &&
    typeof candidate.note === "string" &&
    typeof candidate.reportedAt === "string"
  );
}

/**
 * Read the latest durable child outcome with one initial attempt plus at most three retries.
 * Transient RPC failures back off for 100ms, 200ms, and 400ms; the retry loop is finite. A failed
 * lookup is distinct from a successful branch with no outcome so crew accounting never marks
 * incomplete usage as final.
 */
export async function readLatestVinciTaskOutcomeUsage(
  getEntries: () => Promise<{ entries: readonly unknown[] }>,
): Promise<{ entriesRead: boolean; usage?: VinciTaskUsage }> {
  const backoffMs = [100, 200, 400] as const;
  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    try {
      const { entries } = await getEntries();
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = record(entries[index]);
        if (
          entry?.type === "custom" &&
          entry.customType === VINCI_TASK_OUTCOME_ENTRY &&
          isVinciTaskOutcome(entry.data)
        ) {
          return {
            entriesRead: true,
            usage: {
              ...entry.data.usage,
              providers: entry.data.usage.providers.slice(),
              models: entry.data.usage.models.slice(),
            },
          };
        }
      }
      return { entriesRead: true };
    } catch {
      const delay = backoffMs[attempt];
      if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return { entriesRead: false };
}

export function setVinciTaskOutcome(outcome: VinciTaskOutcome | undefined): void {
  store.outcome = outcome;
  if (outcome?.supplementalUsage) hydrateVinciTaskUsage(outcome.taskId, outcome.supplementalUsage);
}

export function getVinciTaskOutcome(): Readonly<VinciTaskOutcome> | undefined {
  if (store.outcome?.assistantUsage) {
    const supplementalUsage = getVinciTaskUsageSnapshot(
      store.outcome.taskId,
      new Set(store.outcome.assistantResponseKeys ?? []),
    );
    store.outcome.supplementalUsage = supplementalUsage;
    store.outcome.usage = combinedTaskUsage(store.outcome.assistantUsage, supplementalUsage);
  }
  return store.outcome;
}

if (!store.usageSubscriptionInstalled) {
  store.usageSubscriptionInstalled = true;
  subscribeVinciTaskUsage((taskId) => {
    if (store.outcome?.taskId !== taskId) return;
    const refreshed = getVinciTaskOutcome();
    if (!refreshed) return;

    // Persist a complete replacement outcome rather than an incremental usage delta: receipt readers
    // already select the latest full outcome, and historical schema-v1 entries remain independently
    // valid without replaying a second event shape.
    const persisted: VinciTaskOutcome = {
      ...refreshed,
      usage: {
        ...refreshed.usage,
        providers: refreshed.usage.providers.slice(),
        models: refreshed.usage.models.slice(),
      },
      ...(refreshed.supplementalUsage
        ? {
            supplementalUsage: {
              calls: refreshed.supplementalUsage.calls.map((call) => ({
                ...call,
                usage: {
                  ...call.usage,
                  providers: call.usage.providers.slice(),
                  models: call.usage.models.slice(),
                },
              })),
            },
          }
        : {}),
      ...(refreshed.assistantUsage
        ? {
            assistantUsage: {
              ...refreshed.assistantUsage,
              providers: refreshed.assistantUsage.providers.slice(),
              models: refreshed.assistantUsage.models.slice(),
            },
          }
        : {}),
      ...(refreshed.assistantResponseKeys
        ? { assistantResponseKeys: refreshed.assistantResponseKeys.slice() }
        : {}),
      recordedAt: new Date().toISOString(),
    };
    store.outcome = persisted;
    try {
      vinciGlobal[USAGE_STORE_KEY]?.appendEntry?.(
        persisted.taskId,
        VINCI_TASK_OUTCOME_ENTRY,
        persisted,
      );
    } catch {
      // Late accounting must not break the completion path it observes.
    }
  });
}

// Display labels for the receipt widget and /usage — plain language, because "BLOCKED" tells a
// non-programmer a wall exists while "Stopped — needs you" tells them they are the next step, and
// "DONE-UNVERIFIED" reads as a failure when it means "done, please check it" (sweep language batch).
// DISPLAY ONLY: the state enum in the vinci-task-outcome event is the machine contract (corpus
// scoring, checkpoints) and never changes.
export function taskStateLabel(state: VinciTaskState): string {
  return state === "DONE"
    ? "Done"
    : state === "DONE_UNVERIFIED"
      ? "Done — please check it"
      : state === "WAITING"
        ? "Waiting for you"
        : "Stopped — needs you";
}

function tokenLabel(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export function formatVinciTaskUsage(usage: Readonly<VinciTaskUsage>): string {
  const promptTokens = usage.inputTokens + usage.cachedTokens + usage.cacheWriteTokens;
  const cachedPercent = promptTokens > 0 ? Math.round((usage.cachedTokens / promptTokens) * 100) : 0;
  const calls = `${usage.modelCalls} model call${usage.modelCalls === 1 ? "" : "s"}`;
  return `${calls} · ${tokenLabel(promptTokens)} in / ${tokenLabel(usage.outputTokens)} out · ${cachedPercent}% cached · ~$${usage.estimatedCostUsd.toFixed(4)} estimated`;
}

export function formatVinciTaskDuration(milliseconds: number | undefined): string {
  return `${formatDuration(milliseconds ?? 0)} active`;
}
