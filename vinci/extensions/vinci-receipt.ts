/**
 * Deterministic completion receipt.
 *
 * Vinci should finish like a teammate: what changed, what evidence exists, and how to recover. This
 * is grounded in executed tool events and adds no model call or unverified success claim.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  getVinciVerificationState,
  type RemoteAcceptanceVerdict,
} from "./lib/verification-state.ts";
import { getVinciCrewStatus } from "./lib/crew-status.ts";
import { VINCI_BILLING_URL } from "./vinci-links.ts";
import {
  buildVinciTaskOutcome,
  classifyVinciLocalTaskState,
  currentRemoteVerdict,
  formatVinciTaskDuration,
  formatVinciTaskUsage,
  getVinciTaskOutcome,
  isVinciTaskOutcome,
  setVinciTaskOutcome,
  taskStateLabel,
  VINCI_FALSE_COMPLETION_ENTRY,
  VINCI_TASK_OUTCOME_ENTRY,
  isVinciFalseCompletionReport,
  VINCI_ASK_HOLDING_REASON,
  vinciFinalMessageAsksUser,
  vinciToolTextReportsFailure,
  type VinciTaskOutcome,
} from "./lib/task-outcome.ts";

function textContent(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

// A changed-file name is rendered into the receipt (a terminal widget). Paths come from `git status
// -z` (no core.quotePath applied) and tool-call inputs — already literal — but a filename can itself
// contain ANSI/control characters. Strip CSI escape sequences and C0 controls + DEL so a hostile or
// odd filename can't corrupt the receipt or move the cursor (#6/#7 review, BLOCK 1).
export function sanitizeFilename(name: string): string {
  // Strip whole ANSI escape sequences (OSC `ESC ] … BEL/ST`, and any `ESC Fe …` incl. CSI), then any
  // remaining C0 control (incl. tab/newline/CR/ESC), DEL, and C1 control (0x80–0x9f) — all of which
  // could corrupt, reflow, or drive the cursor from a single-line receipt.
  // eslint-disable-next-line no-control-regex
  return name.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_][0-?]*[ -/]*[@-~]|[\x00-\x1f\x7f-\x9f]/g, "");
}

/** One sentence, three post-processors (#215 review): the session-delta append, the crew floor,
 *  and the veto's own downgrade all state this — single-sourced so they cannot drift. */
const SESSION_DELTA_NOTE = "Files changed after this session began are in your project.";

function failedChange(content: readonly { type: string; text?: string }[]): boolean {
  // Shared with the outcome classifier so the two cannot drift apart, and success-guarded: the
  // edit tool echoes the path in its success sentence, so an edit to `src/overlap.ts` used to
  // read as a failure here and be dropped from the changed-file list.
  return vinciToolTextReportsFailure(textContent(content));
}

/**
 * Map a remote acceptance verdict status to a local task outcome state.
 * Per Wave 5 decision 4 (frozen).
 */
function mapRemoteVerdictToState(status?: string): string | undefined {
  if (!status) return undefined;
  switch (status) {
    case "VERIFIED_PASS": return "DONE";
    case "CONDITIONAL": return "DONE_UNVERIFIED";
    case "BLOCKED": return "BLOCKED";
    case "FAILED": return "DONE_UNVERIFIED";
    default: return undefined;
  }
}

/**
 * Get Vinci-owned copy for FAILED verdicts (never blames user code).
 */
function getFailedVerdictCopy(): string {
  return "A verification step encountered an error. Please review the verification report for details.";
}

/**
 * Get the latest remote acceptance verdict from the verification state if it exists.
 */
export function getLatestRemoteVerdict(): RemoteAcceptanceVerdict | undefined {
  try {
    return currentRemoteVerdict(getVinciVerificationState());
  } catch {
    return undefined;
  }
}

/** Pure display decision for D10 (wave5.md decision 4): a non-staled remote
 *  verdict overrides the local outcome; a staled one adds context only. */
export function remoteVerdictDisplay(
  outcome: Readonly<Pick<VinciTaskOutcome, "state" | "reason" | "hardStop">>,
  remoteVerdict?: { status?: string; staled?: boolean; summary?: string },
): { state: string; reason: string } {
  let displayState: string = outcome.state;
  let displayReason = outcome.reason;
  // [#5/#6, review BLOCK-5] A BLOCKED that a hard stop forced is a fact about THIS session's
  // ability to finish; a remote VERIFIED_PASS speaks to the snapshot it verified, not to the
  // commit the harness refused. The verdict may sit alongside, the state stays BLOCKED.
  if (outcome.hardStop && outcome.state === "BLOCKED") {
    if (remoteVerdict && !remoteVerdict.staled && remoteVerdict.summary) {
      displayReason = `${outcome.reason}\nRemote verification reported: ${remoteVerdict.summary}`;
    }
    return { state: displayState, reason: displayReason };
  }
  if (remoteVerdict && !remoteVerdict.staled) {
    const mappedState = mapRemoteVerdictToState(remoteVerdict.status);
    if (mappedState) {
      displayState = mappedState;
      // Vinci-owned copy for FAILED: never blames the user's code.
      displayReason = remoteVerdict.status === "FAILED"
        ? getFailedVerdictCopy()
        : remoteVerdict.summary || outcome.reason;
    }
  } else if (remoteVerdict && remoteVerdict.staled) {
    displayReason = outcome.reason + "\nA verification from before your latest changes found: " + (remoteVerdict.summary || "");
  }
  return { state: displayState, reason: displayReason };
}

function receiptWidget(outcome: Readonly<VinciTaskOutcome>, remoteVerdict?: any): (_tui: unknown, theme: Theme) => Component {
  return (_tui, theme) => ({
    render(width: number): string[] {
      const { state: displayState, reason: displayReason } = remoteVerdictDisplay(outcome, remoteVerdict);

      const files = outcome.changedFiles;
      const fileLabel = files.length === 1 ? "1 file" : `${files.length} files`;
      // Plain-language badges (sweep): "Stopped — needs you" makes the user the next step instead of
      // announcing a wall; "Done — please check it" is a warning, not an error — the work IS done.
      const title = displayState === "DONE"
        ? theme.fg("success", theme.bold("  ✓ Done"))
        : displayState === "BLOCKED"
          ? theme.fg("error", theme.bold("  ! Stopped — needs you"))
          : displayState === "WAITING"
            ? theme.fg("warning", theme.bold("  ? Waiting for you"))
            : theme.fg("warning", theme.bold("  ! Done — please check it"));
      const head = title + (files.length > 0 ? theme.fg("dim", `  ·  ${fileLabel}`) : "");
      const names = files.slice(0, 3).join(", ") + (files.length > 3 ? ` +${files.length - 3} more` : "");
      const evidence = displayState === "DONE" && outcome.verificationStatus === "passed"
        ? theme.fg("success", `check: ${outcome.verificationCommand}`)
        : displayState === "BLOCKED"
          ? theme.fg("error", displayReason)
          : theme.fg("warning", displayReason);
      const detail = theme.fg("muted", "  ") +
        (names ? theme.fg("muted", names) + theme.fg("dim", "  ·  ") : "") +
        evidence +
        (files.length > 0 ? theme.fg("dim", "  ·  /undo available") : "");
      const usage = theme.fg(
        "dim",
        `  ${formatVinciTaskUsage(outcome.usage)} · ${formatVinciTaskDuration(outcome.activeDurationMs)}`,
      );
      // [#230] Only Vinci-managed turns are billed in Platform. On a turn served by the user's own
      // provider the credential never reaches us and neither does the charge, so saying otherwise
      // is wrong in the one line whose job is telling the user what a turn cost. usage.providers
      // records who actually served it, so this follows the evidence rather than the sign-in
      // state: a user can be signed in to Vinci and still run the turn on their own key.
      const providers = outcome.usage.providers ?? [];
      const foreign = providers.filter((name) => name && name !== "vinci");
      const billing = providers.length === 0
        ? undefined
        : foreign.length === 0
          ? theme.fg("dim", "  Billed total in Platform.")
          : theme.fg("dim", `  Billed by ${[...new Set(foreign)].sort().join(", ")}, not Vinci.`);
      return [
        truncateToWidth(head, width, theme.fg("dim", "…")),
        truncateToWidth(detail, width, theme.fg("dim", "…")),
        truncateToWidth(usage, width, theme.fg("dim", "…")),
        ...(billing ? [truncateToWidth(billing, width, theme.fg("dim", "…"))] : []),
      ];
    },
    invalidate(): void {},
  });
}

function messageKey(message: AgentMessage): string {
  if (message.role === "assistant") {
    return `assistant:${message.timestamp}:${message.responseId ?? ""}:${message.stopReason}:${message.usage.totalTokens}`;
  }
  if (message.role === "toolResult") return `tool:${message.timestamp}:${message.toolCallId}`;
  return `user:${message.timestamp}`;
}

function taskMessages(ctx: ExtensionContext, current: readonly AgentMessage[] = []): AgentMessage[] {
  const messages = ctx.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
  const keys = new Set(messages.map(messageKey));
  for (const message of current) {
    const key = messageKey(message);
    if (keys.has(key)) continue;
    keys.add(key);
    messages.push(message);
  }
  return messages;
}

function toolChangedPaths(messages: readonly AgentMessage[], cwd: string): string[] {
  const filesByCall = new Map<string, string>();
  const files = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        if (part.name === "edit" || part.name === "write") {
          const path = String((part.arguments as { path?: unknown }).path ?? "");
          if (path) filesByCall.set(part.id, isAbsolute(path) ? resolve(path) : resolve(cwd, path));
        }
      }
    } else if (message.role === "toolResult" && !message.isError) {
      const file = filesByCall.get(message.toolCallId);
      if (file && !failedChange(message.content)) files.add(file);
    }
  }
  return [...files];
}

type GitTreeSnapshot = {
  root: string;
  files: Map<string, string>;
};

// [#204] The persisted form of the session baseline. Dirty-file snapshots are small in practice
// (git status entries only), but a pathological repo could carry thousands of untracked paths, so
// oversized snapshots persist as an overflow marker and a resume falls back to a fresh capture —
// exactly today's (degraded but honest) behavior, never a bloated session file.
const VINCI_SESSION_BASELINE_ENTRY = "vinci-session-baseline";
const SESSION_BASELINE_MAX_FILES = 500;

function persistSessionBaseline(pi: ExtensionAPI, snapshot: GitTreeSnapshot): void {
  try {
    pi.appendEntry(
      VINCI_SESSION_BASELINE_ENTRY,
      snapshot.files.size > SESSION_BASELINE_MAX_FILES
        ? { overflow: true }
        : { root: snapshot.root, files: [...snapshot.files.entries()] },
    );
  } catch {
    /* best-effort: an unpersisted baseline degrades a future resume, never this run */
  }
}

function sessionBaselineEntryExists(ctx: ExtensionContext): boolean {
  try {
    return ctx.sessionManager
      .getBranch()
      .some((entry) => entry.type === "custom" && (entry as { customType?: string }).customType === VINCI_SESSION_BASELINE_ENTRY);
  } catch {
    return false;
  }
}

function restoreSessionBaseline(ctx: ExtensionContext): GitTreeSnapshot | undefined {
  try {
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "custom" || (entry as { customType?: string }).customType !== VINCI_SESSION_BASELINE_ENTRY) continue;
      const data = (entry as { data?: unknown }).data as { overflow?: unknown; root?: unknown; files?: unknown } | undefined;
      if (!data || data.overflow === true) return undefined;
      if (typeof data.root !== "string" || !Array.isArray(data.files)) return undefined;
      const files = new Map<string, string>();
      for (const record of data.files) {
        if (!Array.isArray(record) || typeof record[0] !== "string" || typeof record[1] !== "string") return undefined;
        files.set(record[0], record[1]);
      }
      return { root: data.root, files };
    }
  } catch {
    /* fall through to a fresh capture */
  }
  return undefined;
}

function gitTreeSnapshot(cwd: string): GitTreeSnapshot | undefined {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024, // 32 MiB for large repos
    }).trim();
    const records = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024, // 32 MiB for large repos
    }).split("\0");
    const files = new Map<string, string>();
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record) continue;
      const status = record.slice(0, 2);
      const path = record.slice(3);
      if (status.includes("R") || status.includes("C")) index++;
      const absolutePath = resolve(root, path);
      if (!existsSync(absolutePath)) {
        // A tracked file DELETED this turn (git shows a `D`) is a real change and must appear, even
        // though it is gone from disk. A created-then-deleted UNTRACKED file never shows up in
        // `git status` here, so it is correctly absent — this only rescues genuine deletions.
        if (status.includes("D")) files.set(absolutePath, `${status}:deleted`);
        continue;
      }
      const stat = statSync(absolutePath, { bigint: true });
      files.set(absolutePath, `${status}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
    }
    return { root, files };
  } catch {
    return undefined;
  }
}

// Check if a file is a known build artifact or cache file that should be excluded from receipts.
// Fails OPEN: unknown files are included (honesty principle).
// Only excludes files matching known artifact patterns to avoid over-reporting.
function isKnownArtifact(filePath: string): boolean {
  const name = basename(filePath);
  const lowerName = name.toLowerCase();

  // Check if any path component is a known artifact directory (for nested files like __pycache__/module.pyc)
  const parts = filePath.split(sep);
  for (const part of parts) {
    if (part === "__pycache__") return true;
    if (part === ".pytest_cache") return true;
    if (part === ".mypy_cache") return true;
    if (part === ".cache") return true;
    if (part === "node_modules") return true;
    if (part === "build" || part === "dist" || part === "target") return true;
    if (/\.egg-info$/.test(part)) return true;
  }

  // Exact match for common C/C++ artifact
  if (name === "a.out") return true;

  // Compiled artifacts: .o, .a, .so, .dll (C/C++), .pyc (Python), .class (Java), etc.
  if (/\.(pyc|pyo|o|obj|class|so|dll|a|exe|app|lib)$/.test(lowerName)) return true;

  // Other cache/coverage/OS artifacts
  if (name === ".coverage") return true;
  if (name === ".DS_Store") return true;
  if (/^\.[a-z]+-cache$/.test(lowerName)) return true;

  return false;
}

// Bug #6: reconcile successful write/edit history with the tree that actually survives the turn.
// Bug #34/#39: Fixed to handle committed changes and exclude build artifacts.
function changedFiles(
  messages: readonly AgentMessage[],
  cwd: string,
  baseline?: Readonly<GitTreeSnapshot>,
): string[] {
  const toolPaths = toolChangedPaths(messages, cwd);
  const toolPathsSet = new Set(toolPaths);
  const current = gitTreeSnapshot(cwd);
  if (!current) {
    // No git available: keep the tool-call list but drop files that no longer exist on disk (fixes the
    // reported bug — a created-then-deleted file no longer appears). Bash-driven changes can't be
    // recovered without a baseline here; that's an honest limitation of the no-git path, not a wrong list.
    return [...new Set(toolPaths.filter((path) => existsSync(path)).map((path) => sanitizeFilename(basename(path))))];
  }

  const files = new Set<string>();
  for (const path of toolPaths) {
    const insideRepository = path === current.root || path.startsWith(current.root + sep);
    // Fix #34: when baseline exists, include tool-edited files if they exist (covers committed case).
    // when baseline is missing, use original behavior (file must be dirty or outside repo).
    if (baseline) {
      if (existsSync(path)) files.add(sanitizeFilename(basename(path)));
    } else {
      if (current.files.has(path) || (!insideRepository && existsSync(path))) files.add(sanitizeFilename(basename(path)));
    }
  }
  for (const [path, signature] of current.files) {
    if (baseline?.root === current.root && baseline.files.get(path) === signature) continue;
    
    // Fix #39/#105: exclude known build artifacts, but fail OPEN for unknown files.
    // Issue #105 regressed by failing CLOSED on ALL untracked files not in tool calls, even those
    // the user explicitly created via bash. So now we only exclude files matching known artifact
    // patterns, and include everything else (honesty principle). The signature format is "XY:..."
    // where XY is the git status code.
    const statusCode = signature.split(":")[0];
    if (statusCode === "??") {
      // Untracked file: include if explicitly edited/wrote it, OR if it's not a known artifact.
      if (toolPathsSet.has(path) || !isKnownArtifact(path)) {
        files.add(sanitizeFilename(basename(path)));
      }
      // else: skip untracked files matching known artifact patterns.
    } else {
      // Tracked file (modified, deleted, etc.): always include.
      files.add(sanitizeFilename(basename(path)));
    }
  }
  return [...files];
}

function latestOutcomeIndex(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>): number {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "custom" && entry.customType === VINCI_TASK_OUTCOME_ENTRY && isVinciTaskOutcome(entry.data)) {
      return index;
    }
  }
  return -1;
}

function latestOutcome(ctx: ExtensionContext): VinciTaskOutcome | undefined {
  const branch = ctx.sessionManager.getBranch();
  const index = latestOutcomeIndex(branch);
  if (index < 0) return undefined;
  const entry = branch[index];
  return entry.type === "custom" && isVinciTaskOutcome(entry.data) ? entry.data : undefined;
}

/**
 * P2-9: a resume can land right beside the checkpoint layer's "interrupted action needs
 * inspection" warning. The latest persisted outcome then predates the interruption — the branch
 * tail holds assistant tool calls NEWER than that outcome that never got a durable tool result
 * (the same kill -9 signature the checkpoint scan keys on). Detected independently here (no
 * coupling into vinci-checkpoint) so the stale "✓ Done" widget is never re-pinned verbatim next
 * to a recovery note it contradicts.
 */
function interruptedTailAfterOutcome(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch();
  const outcomeIndex = latestOutcomeIndex(branch);
  if (outcomeIndex < 0) return false;
  const results = new Set<string>();
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "toolResult") results.add(entry.message.toolCallId);
  }
  for (let index = outcomeIndex + 1; index < branch.length; index++) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const part of entry.message.content) {
      if (part.type === "toolCall" && !results.has(part.id)) return true;
    }
  }
  return false;
}

function reportedWrong(ctx: ExtensionContext, outcome: Readonly<VinciTaskOutcome>): boolean {
  return ctx.sessionManager.getBranch().some(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === VINCI_FALSE_COMPLETION_ENTRY &&
      isVinciFalseCompletionReport(entry.data) &&
      entry.data.taskId === outcome.taskId &&
      entry.data.outcomeRecordedAt === outcome.recordedAt,
  );
}

function showReceipt(outcome: Readonly<VinciTaskOutcome>): boolean {
  return outcome.changedFiles.length > 0 || outcome.state === "BLOCKED" || outcome.state === "WAITING";
}

export default function (pi: ExtensionAPI) {
  let agentStartedAt = 0;
  let priorActiveDurationMs = 0;
  let treeBaseline: GitTreeSnapshot | undefined;
  let sessionTreeBaseline: GitTreeSnapshot | undefined;
  let dialogDepth = 0;
  let dialogStartedAt = 0;
  let dialogDurationMs = 0;
  let instrumentedUI: ExtensionContext["ui"] | undefined;

  // Bug #7: all extension permission/select/input dialogs share this UI object. Wrapping EVERY
  // user-input primitive present on it (select/confirm/input plus editor/custom when the host exposes
  // them) gives the receipt an exact open/close interval without changing core APIs — so no dialog kind
  // is silently counted as active work.
  const instrumentDialogs = (ctx: ExtensionContext): void => {
    const ui = ctx.ui;
    if (instrumentedUI === ui) return;
    const whileDialogOpen = async <T>(run: () => Promise<T>): Promise<T> => {
      if (dialogDepth++ === 0 && agentStartedAt > 0) dialogStartedAt = Date.now();
      try {
        return await run();
      } finally {
        // Clamp: a dialog that settles after the meter was finalized (agent_end) must never drive the
        // depth negative or re-open a phantom interval.
        dialogDepth = Math.max(0, dialogDepth - 1);
        if (dialogDepth === 0 && dialogStartedAt > 0) {
          dialogDurationMs += Date.now() - dialogStartedAt;
          dialogStartedAt = 0;
        }
      }
    };
    const uiRecord = ui as unknown as Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined>;
    for (const name of ["select", "confirm", "input", "editor", "custom"]) {
      const original = uiRecord[name];
      if (typeof original === "function") {
        const bound = original.bind(ui);
        uiRecord[name] = (...args: unknown[]) => whileDialogOpen(() => bound(...args));
      }
    }
    instrumentedUI = ui;
  };

  const clear = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) ctx.ui.setWidget("vinci-receipt", undefined);
  };

  pi.on("session_start", (event, ctx) => {
    clear(ctx);
    const restored = latestOutcome(ctx);
    agentStartedAt = 0;
    priorActiveDurationMs = restored?.activeDurationMs ?? 0;
    treeBaseline = undefined;
    // [#199] The whole-session baseline. treeBaseline above is reset every agent_start, which is
    // right for the per-turn receipt but let a multi-turn run's LAST outcome claim "without
    // project changes" over a tree that earlier turns had changed. This one is captured once per
    // session instance and only ever consulted to veto that claim.
    // [#204] It is also a session fact that must SURVIVE the instance: re-capturing on resume
    // measured the delta from the resume point, so a headless --continue over a still-dirty tree
    // re-persisted the exact "without project changes" claim #203 fixed.
    // Keyed on ENTRY PRESENCE, not the event reason (review round 2): a process-start --continue
    // emits reason "startup" — the reason cannot distinguish a session's first start from its
    // fifth. An existing vinci-session-baseline entry IS that distinction: present → this session
    // already began once, restore it (resume, --continue, reload alike) and never re-persist —
    // re-persisting a later capture made the newest, most-wrong entry shadow the true origin.
    // Absent/overflowed/malformed → fresh capture, persisted exactly once per session.
    const restoredBaseline = restoreSessionBaseline(ctx);
    sessionTreeBaseline = restoredBaseline ?? gitTreeSnapshot(ctx.cwd);
    if (!restoredBaseline && !sessionBaselineEntryExists(ctx) && sessionTreeBaseline) {
      persistSessionBaseline(pi, sessionTreeBaseline);
    }
    dialogDepth = 0;
    dialogStartedAt = 0;
    dialogDurationMs = 0;
    setVinciTaskOutcome(restored);
    if (!restored || !ctx.hasUI || !showReceipt(restored)) return;
    // Display-only downgrade (the persisted outcome record is untouched): when a later turn was
    // interrupted mid-mutation, the restored "✓ Done" belongs to the PREVIOUS turn and would sit
    // beside the checkpoint recovery warning claiming everything is fine.
    const shown: VinciTaskOutcome =
      (restored.state === "DONE" || restored.state === "DONE_UNVERIFIED") && interruptedTailAfterOutcome(ctx)
        ? { ...restored, state: "DONE_UNVERIFIED", verificationStatus: "stale", reason: "interrupted — see recovery note" }
        : restored;
    const remoteVerdict = getLatestRemoteVerdict();
    ctx.ui.setWidget("vinci-receipt", receiptWidget(shown, remoteVerdict), { placement: "aboveEditor" });
  });

  pi.on("agent_start", (_event, ctx) => {
    agentStartedAt = Date.now();
    priorActiveDurationMs = latestOutcome(ctx)?.activeDurationMs ?? 0;
    treeBaseline = gitTreeSnapshot(ctx.cwd);
    dialogDepth = 0;
    dialogStartedAt = 0;
    dialogDurationMs = 0;
    instrumentDialogs(ctx);
    clear(ctx);
    setVinciTaskOutcome(undefined);
  });

  pi.on("agent_end", async (event, ctx) => {
    const messages = taskMessages(ctx, event.messages);
    const endedAt = Date.now();
    const openDialogDurationMs = dialogStartedAt > 0 ? endedAt - dialogStartedAt : 0;
    priorActiveDurationMs += agentStartedAt > 0
      ? Math.max(0, endedAt - agentStartedAt - dialogDurationMs - openDialogDurationMs)
      : 0;
    agentStartedAt = 0;
    // Finalize dialog tracking: any still-open dialog's elapsed time is already accounted for above, so
    // close the interval. Its later finally() clamps the depth and sees dialogStartedAt === 0 (no
    // double-count); the meter can't resume or go negative after the turn ends.
    dialogStartedAt = 0;
    let outcome = buildVinciTaskOutcome({
      taskId: ctx.sessionManager.getSessionId(),
      messages: event.messages,
      usageMessages: messages,
      changedFiles: changedFiles(event.messages, ctx.cwd, treeBaseline),
      verification: getVinciVerificationState(),
      activeDurationMs: priorActiveDurationMs,
    });
    // [#199] An outcome may never claim "no changes" while the SESSION's own tree delta says
    // otherwise. The outcome is rebuilt per turn but the run persists only the LAST one: a
    // multi-turn headless run edited files mid-conversation, closed on a question, and was
    // stamped DONE "read-only … without project changes" over a dirty tree (exit 0, observed
    // live). The per-turn changedFiles above stays turn-scoped for display; this corrects only
    // the empty claim, and only downgrades DONE when no passed check covers the changes.
    let sessionDeltaCorrected = false;
    if (outcome.changedFiles.length === 0 && sessionTreeBaseline) {
      // Session-scoped MESSAGES too, not just the tree delta: work an earlier turn edited AND
      // committed is git-clean by the final turn, but "without project changes" is still false.
      // The session branch also survives a resume, so tool-made edits from a prior process keep
      // vetoing even after the baseline re-captures (review finding on #203).
      const sessionChanged = changedFiles(messages, ctx.cwd, sessionTreeBaseline);
      if (sessionChanged.length > 0) {
        sessionDeltaCorrected = true;
        // [#199] The corrected outcome distinguishes held work from merely-unverified work: a
        // closing ask for the user's go-ahead over the corrected files is WAITING (exit 3 via
        // the blocks() check below) — the exact live shape: two files fixed mid-conversation,
        // final turn "Just confirm and I'll apply it", exit 0.
        const finalAssistant = [...event.messages].reverse().find((m) => (m as { role?: string }).role === "assistant");
        const finalText = finalAssistant ? textContent((finalAssistant as { content: readonly { type: string; text?: string }[] }).content) : "";
        outcome = {
          ...outcome,
          changedFiles: sessionChanged,
          // [#215 review] A WAITING outcome reaches here too now (a zero-change run holding for the
          // user), and it must not keep a reason that ignores the files this veto just added —
          // the note is appended so the state's own meaning survives alongside the correction.
          ...(outcome.state === "WAITING"
            ? {
                reason: `${outcome.reason}${/[.!?]$/.test(outcome.reason.trim()) ? "" : "."} ${SESSION_DELTA_NOTE}`,
              }
            : {}),
          ...(outcome.state === "DONE" && outcome.verificationStatus !== "passed"
            ? vinciFinalMessageAsksUser(finalText)
              ? {
                  state: "WAITING" as const,
                  reason: VINCI_ASK_HOLDING_REASON,
                }
              : {
                  state: "DONE_UNVERIFIED" as const,
                  // "after this session began", not "in this session": with the baseline surviving
                  // the instance (#204), edits made BETWEEN runs — including the user's — are in
                  // the delta, and attributing them to the session would overclaim authorship.
                  reason: `${SESSION_DELTA_NOTE.replace(/\.$/, "")}; the final turn did not verify them.`,
                }
            : {}),
        };
      }
    }
    // [#194] Unresolved crew work floors the outcome in HEADLESS runs. A one-shot session whose
    // background agents are still working, parked awaiting an approval nobody can give, or were
    // stopped unfinished must never read as a clean completion — observed live: three agents
    // spawned, outcome DONE "completed without project changes", exit 0, nothing done. Floors UP
    // only (an existing BLOCKED stays), and only when there is no UI: interactively the crew
    // widget shows this state directly, and the user can still act on it.
    const crew = getVinciCrewStatus();
    if (
      !ctx.hasUI &&
      crew &&
      outcome.state !== "BLOCKED" &&
      (crew.active > 0 || crew.parkedWaiting.length > 0 || crew.stoppedUnfinished.length > 0)
    ) {
      const clauses: string[] = [];
      if (crew.stoppedUnfinished.length > 0) clauses.push(`agents stopped before finishing (${crew.stoppedUnfinished.join(", ")})`);
      if (crew.active > 0) clauses.push(`${crew.active} agent${crew.active === 1 ? "" : "s"} still working`);
      if (crew.parkedWaiting.length > 0) clauses.push(`finished agent work awaiting approval, not applied (${crew.parkedWaiting.join(", ")})`);
      outcome = {
        ...outcome,
        state: crew.stoppedUnfinished.length > 0 ? "BLOCKED" : "WAITING",
        // Keep the #199 correction visible: the floor owns the state, but "files changed earlier"
        // is separate information the user still needs (review finding on #203).
        reason:
          `Delegated background work is unresolved: ${clauses.join("; ")}.` +
          (sessionDeltaCorrected ? ` ${SESSION_DELTA_NOTE}` : ""),
      };
    }
    pi.appendEntry(VINCI_TASK_OUTCOME_ENTRY, outcome);
    setVinciTaskOutcome(outcome);
    // [vinci #171] Split precedence. The receipt above DISPLAYS the remote acceptance verdict, but
    // the exit code answers a script, so it takes whichever of local and remote is more
    // conservative: a remote pass can never report success on a run whose own check failed (#22
    // laundering, #127 exit contract), and a remote block still blocks a locally-clean run.
    const localState = classifyVinciLocalTaskState(event.messages, outcome.changedFiles, getVinciVerificationState()).state;
    const blocks = (state: string) => state === "BLOCKED" || state === "WAITING";
    if (blocks(outcome.state) || blocks(localState)) {
      ctx.declareHeadlessExitHint?.(3);
    }
    if (!ctx.hasUI || !showReceipt(outcome)) return;
    const remoteVerdict = getLatestRemoteVerdict();
    ctx.ui.setWidget("vinci-receipt", receiptWidget(outcome, remoteVerdict), { placement: "aboveEditor" });
  });

  pi.registerCommand("usage", {
    description: "Show this task's model calls, tokens, cache use, and local cost estimate",
    handler: async (_args, ctx) => {
      const messages = taskMessages(ctx);
      const outcome = getVinciTaskOutcome() ?? buildVinciTaskOutcome({
        taskId: ctx.sessionManager.getSessionId(),
        messages,
        changedFiles: changedFiles(messages, ctx.cwd),
        verification: getVinciVerificationState(),
      });
      const provider = outcome.usage.providers.join(", ") || "unavailable";
      const model = outcome.usage.models.join(", ") || "unavailable";
      ctx.ui.notify(
        [
          `Task: ${outcome.taskId}`,
          `State: ${taskStateLabel(outcome.state)}`,
          `Usage: ${formatVinciTaskUsage(outcome.usage)}`,
          `Active time: ${formatVinciTaskDuration(outcome.activeDurationMs)}`,
          `Provider: ${provider}`,
          `Model: ${model}`,
          `Reported wrong: ${reportedWrong(ctx, outcome) ? "yes" : "no"}`,
          ...(outcome.state === "DONE" || outcome.state === "DONE_UNVERIFIED"
            ? [`Report wrong: vinci report-wrong ${outcome.taskId}`]
            : []),
          `Account credits: ${VINCI_BILLING_URL} (authoritative)`,
        ].join("\n"),
        outcome.state === "BLOCKED" ? "warning" : "info",
      );
    },
  });
}
