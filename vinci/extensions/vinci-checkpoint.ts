/**
 * Durable mutation checkpoints for Vinci sessions.
 *
 * Pi already persists the assistant tool call before executing it and persists the tool result after
 * execution. A process can therefore stop in the narrow interval after a side effect lands but before
 * its result reaches the JSONL session. This extension records a small, non-context checkpoint around
 * write/edit/bash execution, restores dangling calls on resume, and prevents an exact unsafe replay.
 *
 * The existing session UUID is the task ID. No second transcript or task database is introduced.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, vinciMaskSecrets } from "@earendil-works/pi-coding-agent";
import {
  formatVinciTaskDuration,
  formatVinciTaskUsage,
  getVinciTaskOutcome,
  taskStateLabel,
} from "./lib/task-outcome.ts";

const ENTRY_TYPE = "vinci-tool-checkpoint";
const SCHEMA_VERSION = 1;
const MAX_RESULT_SUMMARY = 1000;

type TrackedTool = "write" | "edit" | "bash";
type RecoveryBasis = "completed-event" | "file-postcondition";

interface CheckpointBase {
  schemaVersion: typeof SCHEMA_VERSION;
  toolCallId: string;
  toolName: TrackedTool;
  fingerprint: string;
  path?: string;
}

interface StartedCheckpoint extends CheckpointBase {
  event: "started";
}

interface CompletedCheckpoint extends CheckpointBase {
  event: "completed";
  isError: boolean;
  resultSummary: string;
}

interface RecoveredCheckpoint extends CheckpointBase {
  event: "recovered";
  basis: RecoveryBasis;
}

interface UncertainCheckpoint extends CheckpointBase {
  event: "uncertain";
  reason: string;
}

export type VinciToolCheckpoint =
  | StartedCheckpoint
  | CompletedCheckpoint
  | RecoveredCheckpoint
  | UncertainCheckpoint;

interface ToolCallSnapshot {
  toolCallId: string;
  toolName: TrackedTool;
  input: unknown;
}

interface ActiveCheckpoint {
  record: StartedCheckpoint;
  input: unknown;
}

interface RestoredMutation {
  record: RecoveredCheckpoint | UncertainCheckpoint;
  input: unknown;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function trackedTool(value: string): value is TrackedTool {
  return value === "write" || value === "edit" || value === "bash";
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  const record = objectRecord(value);
  if (!record) {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    return value === undefined ? null : value;
  }
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) canonical[key] = canonicalValue(record[key]);
  return canonical;
}

export function mutationFingerprint(toolName: TrackedTool, input: unknown): string {
  return createHash("sha256")
    .update(`${toolName}\0${JSON.stringify(canonicalValue(input))}`)
    .digest("hex")
    .slice(0, 24);
}

function pathFromInput(input: unknown): string | undefined {
  const record = objectRecord(input);
  const value = record?.path ?? record?.file_path;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1000) : undefined;
}

function projectPath(cwd: string, input: unknown): string | undefined {
  const raw = pathFromInput(input);
  if (!raw) return undefined;
  const absolute = resolve(cwd, raw);
  const within = relative(cwd, absolute);
  if (within === "" || within === ".") return undefined;
  if (within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within)) {
    return undefined;
  }
  return absolute;
}

function normalizeText(value: string): string {
  const withoutBom = value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  return withoutBom.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function editEntries(input: unknown): Array<{ oldText: string; newText: string }> | undefined {
  const record = objectRecord(input);
  if (!record) return undefined;
  let edits = record.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(edits) && typeof record.oldText === "string" && typeof record.newText === "string") {
    edits = [{ oldText: record.oldText, newText: record.newText }];
  }
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  const normalized: Array<{ oldText: string; newText: string }> = [];
  for (const edit of edits) {
    const candidate = objectRecord(edit);
    if (!candidate || typeof candidate.oldText !== "string" || typeof candidate.newText !== "string") {
      return undefined;
    }
    normalized.push({ oldText: normalizeText(candidate.oldText), newText: normalizeText(candidate.newText) });
  }
  return normalized;
}

/**
 * Minimum trimmed length for an edit fragment to count as postcondition evidence. Short generic
 * fragments ('}', '"enabled": false', a common import) routinely occur elsewhere in a file, so
 * their presence or absence proves nothing about whether this specific edit landed.
 */
const MIN_DISTINCTIVE_EDIT_TEXT = 24;

function distinctiveEditText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= MIN_DISTINCTIVE_EDIT_TEXT || trimmed.includes("\n");
}

/** Conservative proof that a dangling structured file mutation is already reflected on disk. */
export function mutationPostcondition(cwd: string, toolName: TrackedTool, input: unknown): boolean {
  if (toolName === "bash") return false;
  const absolute = projectPath(cwd, input);
  if (!absolute) return false;
  let current: string;
  try {
    current = readFileSync(absolute, "utf8");
  } catch {
    return false;
  }

  if (toolName === "write") {
    const content = objectRecord(input)?.content;
    return typeof content === "string" && current === content;
  }

  const edits = editEntries(input);
  if (!edits) return false;
  const normalizedCurrent = normalizeText(current);
  let hasObservableReplacement = false;
  for (const edit of edits) {
    if (!edit.oldText || edit.oldText === edit.newText) return false;
    // Evidence bar: "oldText is absent and newText appears somewhere" is only proof for
    // distinctive fragments. An edit whose oldText never existed (stale read — it would have
    // errored, never applying) can otherwise be misclassified as completed when its newText is a
    // short generic fragment that happens to exist elsewhere in the file. Fall through to the
    // uncertain path instead, which unblocks the retry after one read of the target.
    if (!distinctiveEditText(edit.oldText) || !distinctiveEditText(edit.newText)) return false;
    if (normalizedCurrent.includes(edit.oldText)) return false;
    if (!normalizedCurrent.includes(edit.newText)) return false;
    hasObservableReplacement = true;
  }
  return hasObservableReplacement;
}

function isCheckpoint(value: unknown): value is VinciToolCheckpoint {
  const record = objectRecord(value);
  if (
    !record ||
    record.schemaVersion !== SCHEMA_VERSION ||
    typeof record.toolCallId !== "string" ||
    typeof record.toolName !== "string" ||
    !trackedTool(record.toolName) ||
    typeof record.fingerprint !== "string" ||
    (record.path !== undefined && typeof record.path !== "string")
  ) {
    return false;
  }
  if (record.event === "started") return true;
  if (record.event === "completed") {
    return typeof record.isError === "boolean" && typeof record.resultSummary === "string";
  }
  if (record.event === "recovered") {
    return record.basis === "completed-event" || record.basis === "file-postcondition";
  }
  return record.event === "uncertain" && typeof record.reason === "string";
}

function resultSummary(result: unknown): string {
  const content = objectRecord(result)?.content;
  if (!Array.isArray(content)) return "Tool execution finished without a text summary.";
  const text = content
    .map((part) => objectRecord(part))
    .filter((part): part is Record<string, unknown> => part !== undefined)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
    .trim();
  return vinciMaskSecrets(text || "Tool execution finished.").slice(0, MAX_RESULT_SUMMARY);
}

function branchToolCalls(entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>): Map<string, ToolCallSnapshot> {
  const calls = new Map<string, ToolCallSnapshot>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const part of entry.message.content) {
      if (part.type !== "toolCall" || !trackedTool(part.name)) continue;
      calls.set(part.id, { toolCallId: part.id, toolName: part.name, input: part.arguments });
    }
  }
  return calls;
}

function branchToolResults(entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>): Set<string> {
  const results = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "toolResult") results.add(entry.message.toolCallId);
  }
  return results;
}

function checkpointRecords(
  entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
): Map<string, VinciToolCheckpoint[]> {
  const records = new Map<string, VinciToolCheckpoint[]>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !isCheckpoint(entry.data)) continue;
    const values = records.get(entry.data.toolCallId) ?? [];
    values.push(entry.data);
    records.set(entry.data.toolCallId, values);
  }
  return records;
}

function latestRecord<T extends VinciToolCheckpoint["event"]>(
  records: readonly VinciToolCheckpoint[],
  event: T,
): Extract<VinciToolCheckpoint, { event: T }> | undefined {
  for (let index = records.length - 1; index >= 0; index--) {
    if (records[index].event === event) return records[index] as Extract<VinciToolCheckpoint, { event: T }>;
  }
  return undefined;
}

function mutationLabel(mutation: RestoredMutation): string {
  if (mutation.record.toolName === "bash") return "shell command";
  return mutation.record.path ? `${mutation.record.toolName} ${mutation.record.path}` : `${mutation.record.toolName} call`;
}

/**
 * Cross-loader registry so /undo (loaded through a separate isolated extension loader) can drop
 * recovery records for paths it just reverted. A restored file makes "already completed — do not
 * repeat" guidance and the exact-replay block stale: the mutation no longer exists on disk (audit
 * P2-7). Mirrors the globalThis pattern in lib/verification-state.ts.
 */
type CheckpointRecordClearer = (paths: readonly string[]) => void;
const CLEARERS_KEY = "__vinciCheckpointRecordClearers" as const;
type CheckpointGlobal = typeof globalThis & { [CLEARERS_KEY]?: Set<CheckpointRecordClearer> };
const checkpointGlobal = globalThis as CheckpointGlobal;
const checkpointRecordClearers = checkpointGlobal[CLEARERS_KEY] ?? new Set<CheckpointRecordClearer>();
checkpointGlobal[CLEARERS_KEY] = checkpointRecordClearers;

/** Drop recovered/uncertain checkpoint records whose target path was reverted (e.g. by /undo). */
export function clearVinciCheckpointRecordsForPaths(paths: readonly string[]): void {
  for (const clear of checkpointRecordClearers) {
    try {
      clear(paths);
    } catch {
      /* best-effort — a failed cleanup must never break the caller's restore */
    }
  }
}

export default function (pi: ExtensionAPI) {
  const active = new Map<string, ActiveCheckpoint>();
  const recovered = new Map<string, RestoredMutation>();
  const uncertain = new Map<string, RestoredMutation>();
  const inspectedPaths = new Set<string>();
  let taskId = "";
  let sessionCwd = "";

  // Registered globally so clearVinciCheckpointRecordsForPaths reaches this instance's records
  // even when the caller (/undo) was loaded through a different isolated extension loader.
  checkpointRecordClearers.add((paths) => {
    if (paths.length === 0) return;
    const targets = new Set(paths.map((path) => resolve(sessionCwd || ".", path)));
    for (const records of [recovered, uncertain]) {
      for (const [fingerprint, mutation] of records) {
        const recordPath = mutation.record.path;
        if (recordPath && targets.has(resolve(sessionCwd || ".", recordPath))) records.delete(fingerprint);
      }
    }
  });

  const append = (record: VinciToolCheckpoint): void => {
    pi.appendEntry(ENTRY_TYPE, record);
  };

  pi.on("session_start", (_event, ctx) => {
    active.clear();
    recovered.clear();
    uncertain.clear();
    inspectedPaths.clear();
    taskId = ctx.sessionManager.getSessionId();
    sessionCwd = ctx.cwd;
    if (process.env.VINCI_NO_CHECKPOINT === "1") return;

    const branch = ctx.sessionManager.getBranch();
    const calls = branchToolCalls(branch);
    const results = branchToolResults(branch);
    const records = checkpointRecords(branch);
    for (const call of calls.values()) {
      if (results.has(call.toolCallId)) continue;
      const history = records.get(call.toolCallId) ?? [];
      const started = latestRecord(history, "started");
      if (!started) continue;

      const previousRecovery = latestRecord(history, "recovered");
      const previousUncertain = latestRecord(history, "uncertain");
      const completed = latestRecord(history, "completed");
      if (previousRecovery) {
        recovered.set(previousRecovery.fingerprint, { record: previousRecovery, input: call.input });
        continue;
      }
      if (previousUncertain && !mutationPostcondition(ctx.cwd, call.toolName, call.input)) {
        uncertain.set(previousUncertain.fingerprint, { record: previousUncertain, input: call.input });
        continue;
      }

      const postcondition = mutationPostcondition(ctx.cwd, call.toolName, call.input);
      if ((completed && !completed.isError) || postcondition) {
        const record: RecoveredCheckpoint = {
          ...started,
          event: "recovered",
          basis: completed && !completed.isError ? "completed-event" : "file-postcondition",
        };
        recovered.set(record.fingerprint, { record, input: call.input });
        append(record);
      } else {
        const record: UncertainCheckpoint = {
          ...started,
          event: "uncertain",
          reason:
            call.toolName === "bash"
              ? "The process stopped while this shell command was in flight; its external side effects are unknown."
              : "The process stopped before the structured file mutation produced a durable tool result.",
        };
        uncertain.set(record.fingerprint, { record, input: call.input });
        append(record);
      }
    }

    if (ctx.hasUI && (recovered.size > 0 || uncertain.size > 0)) {
      const parts = [];
      if (recovered.size > 0) parts.push(`${recovered.size} completed change${recovered.size === 1 ? "" : "s"} recovered`);
      if (uncertain.size > 0) parts.push(`${uncertain.size} interrupted action${uncertain.size === 1 ? "" : "s"} needs inspection`);
      ctx.ui.notify(`Task ${taskId}: ${parts.join("; ")}. Vinci will not replay them blindly.`, uncertain.size > 0 ? "warning" : "info");
    }
  });

  pi.on("before_agent_start", (event) => {
    if (process.env.VINCI_NO_CHECKPOINT === "1" || (recovered.size === 0 && uncertain.size === 0)) return undefined;
    const completedLabels = [...recovered.values()].slice(0, 5).map(mutationLabel);
    const uncertainLabels = [...uncertain.values()].slice(0, 5).map(mutationLabel);
    const lines = [
      "## Resumed task checkpoint",
      `Task ID: ${taskId}. This session ended between tool execution and durable result recording.`,
    ];
    if (completedLabels.length > 0) {
      lines.push(`Recovered as already completed: ${completedLabels.join(", ")}. Do not repeat these exact actions; continue from their current state.`);
    }
    if (uncertainLabels.length > 0) {
      lines.push(`Outcome needs inspection: ${uncertainLabels.join(", ")}. Inspect the target state before choosing a repair. Never automatically replay an interrupted shell command.`);
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n")}` };
  });

  pi.on("tool_call", (event, ctx) => {
    if (process.env.VINCI_NO_CHECKPOINT === "1" || !trackedTool(event.toolName)) return undefined;
    const fingerprint = mutationFingerprint(event.toolName, event.input);
    const recoveredMutation = recovered.get(fingerprint);
    if (recoveredMutation) {
      return {
        block: true,
        reason: `This exact ${mutationLabel(recoveredMutation)} was recovered as already completed after the session interruption. Inspect its current state and continue without replaying it.`,
      };
    }

    const uncertainMutation = uncertain.get(fingerprint);
    if (uncertainMutation) {
      const absolute = projectPath(ctx.cwd, event.input);
      const inspected = absolute ? inspectedPaths.has(absolute) : false;
      if (event.toolName === "bash" || !inspected) {
        return {
          block: true,
          reason:
            event.toolName === "bash"
              ? "This exact shell command was interrupted and may already have external side effects. Do not replay it automatically; inspect the state or ask the user for a recovery decision."
              : "This file mutation was interrupted. Read the current target file before retrying or choosing a smaller repair.",
        };
      }
      uncertain.delete(fingerprint);
    }

    const record: StartedCheckpoint = {
      schemaVersion: SCHEMA_VERSION,
      event: "started",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      fingerprint,
      path: pathFromInput(event.input),
    };
    active.set(event.toolCallId, { record, input: event.input });
    append(record);
    return undefined;
  });

  pi.on("tool_execution_end", (event) => {
    if (process.env.VINCI_NO_CHECKPOINT === "1") return;
    const started = active.get(event.toolCallId);
    if (!started) return;
    active.delete(event.toolCallId);
    append({
      ...started.record,
      event: "completed",
      isError: event.isError,
      resultSummary: resultSummary(event.result),
    });
  });

  pi.on("tool_result", (event, ctx) => {
    if (process.env.VINCI_NO_CHECKPOINT === "1" || event.isError || event.toolName !== "read") return undefined;
    const absolute = projectPath(ctx.cwd, event.input);
    if (absolute) inspectedPaths.add(absolute);
    return undefined;
  });

  pi.registerCommand("task-info", {
    description: "Show this task ID, terminal state, usage, and interruption checkpoints",
    handler: async (_args, ctx) => {
      const id = ctx.sessionManager.getSessionId();
      const outcome = getVinciTaskOutcome();
      ctx.ui.notify(
        [
          `Task: ${id}`,
          `State: ${outcome ? taskStateLabel(outcome.state) : "in progress or not recorded"}`,
          ...(outcome ? [`Usage: ${formatVinciTaskUsage(outcome.usage)}`] : []),
          ...(outcome ? [`Active time: ${formatVinciTaskDuration(outcome.activeDurationMs)}`] : []),
          `Recovered actions: ${recovered.size}`,
          `Needs inspection: ${uncertain.size}`,
          ...(outcome?.state === "DONE" || outcome?.state === "DONE_UNVERIFIED"
            ? [`Report wrong: vinci report-wrong ${id}`]
            : []),
          `Resume: vinci resume ${id}`,
        ].join("\n"),
        uncertain.size > 0 ? "warning" : "info",
      );
    },
  });
}
