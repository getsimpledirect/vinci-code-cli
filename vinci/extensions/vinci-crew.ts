/**
 * Vinci Crew — background helpers (multi-agent, Phase 1: the engine).
 *
 * The orchestrator (main) can hand a focused sub-task to a HELPER — another full Vinci that works on
 * it in its OWN isolated git worktree, in its own process, while you keep going. Helpers run
 * concurrently up to a cap (the gateway is a shared rate limit — too many at once → 429), the rest
 * queue. When a helper finishes it reports back with a notification and a diff you can review and
 * apply. See vinci/AGENTS_PLAN.md for the full design (this is Phase 1; the visual tree below the
 * input box is Phase 2).
 *
 * How a helper runs (proven in the spike): a git worktree is added off the current repo, a child
 * `vinci --mode rpc` is spawned there via RpcClient with the SAME extension stack as main (minus this
 * one — no recursive helpers), prompted with the task, driven to completion (agent_end), then its
 * diff is captured and independently checked in a disposable integration worktree. Ordinary changes
 * auto-land only after the helper's exact check passes again and an independent review ships. Risky,
 * stale, conflicting, or unverified changes wait for the user in `/agents`.
 *
 * Additive: pure extension, no core patch.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatDuration } from "./lib/format-duration.ts";
import { shortPath } from "./vinci-header.ts";
import {
  type ExtensionAPI,
  type ExtensionContext,
  parseGraderVerdict,
  RpcClient,
  runReview,
  type Theme,
  vinciMaskSecrets,
} from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { Input, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  applyCrewPatch,
  captureCrewPatch,
  createCrewWorktree,
  crewChangedPaths,
  crewPathsUnchanged,
  type CrewPatch,
  type CrewWorktree,
  findOrphanedTempCopyWorktree,
  isConsequentialCrewPatch,
  removeCrewWorktree,
  runCrewVerifier,
  sweepStaleTempCopies,
} from "./lib/crew-worktree.ts";
import { setVinciCrewStatus } from "./lib/crew-status.ts";
import { VINCI_CREW_HELPER_ENV, scanVinciScopeDriftEntries } from "./lib/scope-drift.ts";
import {
  getVinciVerificationState,
  hasIncompleteVinciBehavioralAttempt,
  recordVinciMutation,
  vinciCheckWarrantedPath,
  recordVinciVerification,
  scanVinciVerificationStateBranch,
  vinciVerificationMutationRevision,
  type VinciVerificationClass,
  type VinciVerificationState,
  VINCI_VERIFICATION_ENTRY,
} from "./lib/verification-state.ts";
import {
  readLatestVinciTaskOutcomeUsage,
  summarizeVinciTaskUsage,
  type VinciTaskUsage,
} from "./lib/task-outcome.ts";
import {
  installVinciUsageAccumulator,
  recordVinciTaskCall,
  recordVinciTaskUsage,
} from "./lib/usage-accumulator.ts";

const HELPER_TIMEOUT_MS = 10 * 60 * 1000; // per-helper wall-clock ceiling
const CREW_ENTRY = "vinci-crew-helper";
const MAX_PERSISTED_TRANSCRIPT = 30_000;
const MAX_AGENT_MESSAGE_LENGTH = 4_000;
const STEER_IDLE_POLL_MS = 250;

function capacity(): number {
  const configured = Number.parseInt(process.env.VINCI_CREW_CAPACITY ?? "2", 10);
  return Number.isFinite(configured) ? Math.max(1, Math.min(configured, 8)) : 2;
}

type Status = "queued" | "working" | "verifying" | "reviewing" | "done" | "integrated" | "waiting" | "blocked" | "failed";
type VerificationProof = {
  command: string;
  summary: string;
  mutationRevision: number;
  verifiedRevision: number;
  checkClass: VinciVerificationClass;
  commandKey: string;
  commandCwd?: string;
};
type DeferredItem = { item: string; reason: string };
// Three states, not two. An agent that never attested must never be indistinguishable from one that
// deliberately attested "nothing deferred" — a plain `[]` default is exactly how "DEVIATIONS: none"
// gets narrated over skipped work (#5). `missing` is therefore a first-class value that every
// consumer must surface, not an absence.
type HandoffAttestation = "attested" | "missing";
type HandoffOmission = { deviations: number; deferred: number };
const NO_OMISSION: HandoffOmission = { deviations: 0, deferred: 0 };
interface AgentResult {
  agentId: number;
  name: string;
  task: string;
  status: "done" | "integrated" | "waiting" | "blocked" | "failed";
  summary: string;
  filesChanged: string[];
  verification: VerificationProof | null;
  // Decisions the agent made that its task did not specify. Meaningful only when attestation is
  // "attested" — see HandoffAttestation.
  deviations: string[];
  // Work deliberately left undone, each with its scope reason. This is the field that separates
  // not-done-because-out-of-scope from not-done-because-I-failed, i.e. the false-completion axis.
  deferred: DeferredItem[];
  attestation: HandoffAttestation;
  // How many entries the bound dropped. Non-zero means this attestation is INCOMPLETE — reported
  // rather than silently swallowed, because a quietly-shortened list is the dishonest empty wearing
  // a different hat.
  omitted: HandoffOmission;
  reason?: string;
}
type CrewPatchMetadata = Pick<CrewPatch, "kind" | "paths" | "deletedPaths" | "baselineFingerprints" | "ignorePatterns">;
interface Helper {
  id: number;
  name: string;
  task: string;
  status: Status;
  summary?: string;
  diff?: string;
  diffPath?: string;
  patchMetadata?: CrewPatchMetadata;
  patchPaths?: string[];
  error?: string;
  reason?: string;
  applied?: boolean;
  review?: string;
  // Optional on the Helper record on purpose: a helper restored from a session written before #5
  // simply has none, which lands as `missing` rather than a fabricated empty attestation.
  deviations?: string[];
  deferred?: DeferredItem[];
  attestation?: HandoffAttestation;
  omitted?: HandoffOmission;
  /**
   * Drift the agent's own scope guard OBSERVED while it worked, read out of its child session rather
   * than taken on its word (#179). These are not the agent's claims, so they are labelled apart from
   * `deviations` and are carried whatever the attestation says — an agent that never attested has
   * still had its drift seen, and hiding that would be the quiet empty this whole area guards against.
   */
  scopeDrift?: string[];
  verification?: VerificationProof;
  provider?: string;
  model?: string;
  childSession?: string;
  /** The session ended this helper before it produced any patch (#194) — its task was NOT done. */
  stoppedUnfinished?: boolean;
  /**
   * Continuing an earlier agent: fork ITS conversation (`--fork`) into a FRESH worktree seeded from
   * the project as it stands now. Forking preserves the history while rewriting the session cwd to
   * the fresh worktree; resuming the original file would retain the deleted old worktree as its cwd
   * and RPC startup would refuse to run.
   *
   * The old private worktree is deliberately not kept alive — that would mean unbounded disk growth
   * and a base that drifts further from the project with every commit. But "current state" alone
   * would lose the agent's own work whenever it was still waiting for review, so an unapplied patch
   * is replayed on top. Applied work needs no replay: it is already in the project.
   *
   * The patch is carried as a PATH, never as the diff body: `diff` is excluded from the persisted
   * record precisely so a patch never bloats the session file, and a body stored here would put it
   * straight back in.
   */
  forkSession?: string;
  replayDiffPath?: string;
  continuedFrom?: number;
  transcript?: string[]; // what the helper did, captured before its child was stopped
  tokens?: number;
  childUsage?: VinciTaskUsage;
  usageAccounted?: boolean;
  client?: RpcClient;
  worktree?: CrewWorktree; // held so session_shutdown can preserve/tear down it if in-flight
  startedAt?: number;
  finishedAt?: number;
  notifiedAt?: number;
  deliveredAt?: number;
  dismissedAt?: number; // user cleared this row from the strip; /agents still lists it

  result?: AgentResult;
  liveTranscript?: string[];
  livePartial?: string[];
  livePartialKinds?: Array<TranscriptKind | undefined>;
  activity?: string;
  streaming?: boolean;
  messagedDuringRun?: boolean;
  viewerRepaint?: () => void;
  unsubscribeLive?: () => void;
  unsubscribeEvents?: () => void;
}

type PersistedHelper = Omit<
  Helper,
  | "client"
  | "worktree"
  | "diff"
  | "liveTranscript"
  | "livePartial"
  | "livePartialKinds"
  | "activity"
  | "streaming"
  | "messagedDuringRun"
  | "viewerRepaint"
  | "unsubscribeLive"
  | "unsubscribeEvents"
>;

const helpers: Helper[] = [];
const TERMINAL_STATUSES = ["done", "integrated", "waiting", "blocked", "failed"] as const;

function isTerminalStatus(status: Status): status is AgentResult["status"] {
  return TERMINAL_STATUSES.includes(status as AgentResult["status"]);
}

// A short per-PROCESS token in each helper branch name so a worktree/branch leaked by a crash (or a
// hard quit) in a PRIOR session can't collide with this session's `vinci/helper-1` and silently break
// worktree isolation (git refuses to re-create an existing branch, which must fail closed).
const RUN_TAG = Date.now().toString(36).slice(-4);
let nextId = 1;
let running = 0;
const queue: Helper[] = [];
const crewIdleWaiters: Array<() => void> = [];
let uiRef: ExtensionContext | undefined; // captured for out-of-turn notify/status
// Phase-3 keyboard navigation of the tree (↓ arms, ↑↓ move, Enter opens a helper's transcript).
let navActive = false;
let navIdx = 0;
let viewerOpen = false; // a transcript overlay owns the keyboard — pause tree nav while it's up
let activeViewerClose: (() => void) | undefined;
let activeViewerSwitch: ((direction: 1 | -1) => void) | undefined;

const HELPER_PROMPT = (task: string) =>
  "You are a Vinci agent working on ONE focused task in your own isolated copy of the project. Do it " +
  "fully: make the needed changes, verify they work if you can, then stop and briefly say what you did. " +
  "\n\nEnd your final message with this block, exactly once, and nothing after it:\n" +
  "```vinci-handoff\n" +
  '{"deviations": [], "deferred": []}\n' +
  "```\n" +
  "`deviations` lists decisions you made that the task did not specify, each with its reason. " +
  "`deferred` lists work you deliberately left undone, as {\"item\": \"...\", \"reason\": \"...\"}. " +
  "Both keys are required; empty arrays are fine when they are true. Leaving work out and reporting " +
  "an empty list is the one failure that matters here — if you ran out of room, hit something you " +
  "could not do, or skipped part of the task, it belongs in `deferred` with the honest reason." +
  `\n\nYour task:\n${task}`;

// The closing fence must start its own line. Without that anchor, a block whose JSON legitimately
// contains ``` (an agent describing a code fence it wrote) ends at the embedded backticks: the block
// parses as malformed, downgrades to `missing`, and leaves JSON residue in the human-facing summary.
// Two accepted shapes: the multi-line form the prompt shows, and the same block flattened onto one
// line — ```vinci-handoff {...} ``` — which is how live helpers actually write it often enough to
// matter (#195: 2 of 2 real runs, silently downgrading honest attestations to `missing`). The
// single-line branch keeps the embedded-``` safety property: its close must sit at a line boundary,
// so a ``` inside a JSON string mid-line cannot end the block early.
const HANDOFF_FENCE =
  /(?:^|\n)[ \t]*```[ \t]*vinci-handoff(?:[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```|[ \t]+(.*?)[ \t]*```)[ \t]*(?=\r?\n|$)/g;
const HANDOFF_FENCE_OPENER = /(?:^|\n)[ \t]*```[ \t]*vinci-handoff(?=[ \t]|\r?\n|$)/;
// The attestation is serialized into the orchestrator's turn, so it is bounded like every other
// helper-controlled string here (cf. MAX_AGENT_MESSAGE_LENGTH, MAX_PERSISTED_TRANSCRIPT). Over-long
// content is TRUNCATED rather than rejected: rejecting would turn a verbose but honest attestation
// into `missing`, which reads as "never attested" — strictly worse than a clipped one.
// BUT truncation must never be SILENT. Dropping a 33rd deferred item while still reporting
// `attested` recreates the dishonest empty this whole feature exists to kill, so the count that was
// dropped is carried in `omitted` and surfaced everywhere the fields are.
const MAX_HANDOFF_ENTRIES = 32;
const MAX_HANDOFF_ENTRY_LENGTH = 400;

// Clip on CODE POINTS, not UTF-16 units: slicing mid-surrogate leaves a lone `\uD83D` before the
// ellipsis, corrupting the very text being preserved.
function clipHandoffEntry(value: string): string {
  const points = [...value];
  return points.length > MAX_HANDOFF_ENTRY_LENGTH
    ? `${points.slice(0, MAX_HANDOFF_ENTRY_LENGTH - 1).join("")}…`
    : value;
}

function stringList(value: unknown): { items: string[]; omitted: number } | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  let omitted = 0;
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    const trimmed = entry.trim();
    // A blank entry is not a deviation. Silently dropping it would turn a malformed attestation into
    // a deliberate-looking empty one, so it invalidates the block instead.
    if (!trimmed) return undefined;
    if (items.length >= MAX_HANDOFF_ENTRIES) omitted++;
    else items.push(clipHandoffEntry(trimmed));
  }
  return { items, omitted };
}

function deferredList(value: unknown): { items: DeferredItem[]; omitted: number } | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: DeferredItem[] = [];
  let omitted = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const { item, reason } = entry as { item?: unknown; reason?: unknown };
    if (typeof item !== "string" || typeof reason !== "string") return undefined;
    const trimmedItem = item.trim();
    const trimmedReason = reason.trim();
    // Both are required by the contract. A deferred item with no reason is exactly the "left it out,
    // said nothing about why" case, so it invalidates rather than passing through with reason "".
    if (!trimmedItem || !trimmedReason) return undefined;
    if (items.length >= MAX_HANDOFF_ENTRIES) omitted++;
    else items.push({ item: clipHandoffEntry(trimmedItem), reason: clipHandoffEntry(trimmedReason) });
  }
  return { items, omitted };
}

/**
 * Split a helper's final message into the human-facing summary and its typed honesty attestation.
 *
 * Total by construction: malformed JSON, a wrong shape, a truncated fence or no block at all all
 * yield `missing` rather than throwing or — worse — an empty array that reads as a deliberate
 * "nothing deferred". BOTH keys must be present and well-typed to count as attested; `{}` is
 * ambiguous and is deliberately not accepted, because the contract asks for both.
 *
 * The block is stripped from the summary so the orchestrator never renders it twice. The LAST block
 * wins: a helper that quotes the contract mid-message and then attests at the end must not have the
 * quoted example read as its answer.
 */
/** Remove every handoff block from an already-formatted transcript, preserving line structure. */
export function stripHandoffBlocks(lines: string[]): string[] {
  const stripped: string[] = [];
  let pending: string[] | undefined;
  for (const line of lines) {
    const text = splitTranscriptLine(line).text.replace(/\r$/, "");
    if (pending) {
      pending.push(line);
      if (/^[ \t]*```[ \t]*$/.test(text)) pending = undefined;
    } else if (/^[ \t]*```[ \t]*vinci-handoff[ \t]+.*```[ \t]*$/.test(text)) {
      // The single-line form (#195): opener, JSON and close all on one transcript line — the whole
      // block is this line, so it is dropped without arming the multi-line pending state.
    } else if (/^[ \t]*```[ \t]*vinci-handoff[ \t]*$/.test(text)) {
      pending = [line];
    } else {
      stripped.push(line);
    }
  }
  // An incomplete fence is evidence the final message was truncated, but it is not a complete
  // removable block. Preserve it in the transcript while parseHandoffAttestation voids its fields.
  if (pending) stripped.push(...pending);
  return stripped;
}

export function parseHandoffAttestation(text: string): {
  summary: string;
  deviations: string[];
  deferred: DeferredItem[];
  attestation: HandoffAttestation;
  omitted: HandoffOmission;
} {
  const source = typeof text === "string" ? text : "";
  let parsed: { deviations: string[]; deferred: DeferredItem[]; omitted: HandoffOmission } | undefined;
  // EVERY block is stripped, not just the winning one: a message with two blocks would otherwise
  // leave the earlier one sitting in the human-facing summary as raw JSON.
  const spans: Array<[number, number]> = [];
  let lastCompleteEnd = 0;
  HANDOFF_FENCE.lastIndex = 0;
  for (let match = HANDOFF_FENCE.exec(source); match; match = HANDOFF_FENCE.exec(source)) {
    // The pattern consumes a leading newline so the fence is line-anchored; keep that newline in the
    // summary by starting the span at the fence itself.
    const fenceStart = match.index + (source[match.index] === "\n" ? 1 : 0);
    lastCompleteEnd = match.index + match[0].length;
    spans.push([fenceStart, lastCompleteEnd]);
    let candidate: unknown;
    try {
      candidate = JSON.parse(match[1] ?? match[2]);
    } catch {
      // A malformed block is still the agent's attempt to attest; it is stripped so the summary stays
      // clean, but it does not count as an attestation.
      parsed = undefined;
      continue;
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      parsed = undefined;
      continue;
    }
    const { deviations, deferred } = candidate as { deviations?: unknown; deferred?: unknown };
    const deviationList = stringList(deviations);
    const deferredItems = deferredList(deferred);
    parsed =
      deviationList && deferredItems
        ? {
            deviations: deviationList.items,
            deferred: deferredItems.items,
            omitted: { deviations: deviationList.omitted, deferred: deferredItems.omitted },
          }
        : undefined;
  }
  // A later incomplete attempt is the helper's final word, not trailing prose. It must void an
  // earlier complete example rather than letting that quoted block masquerade as the attestation.
  if (HANDOFF_FENCE_OPENER.test(source.slice(lastCompleteEnd))) parsed = undefined;
  let summary = source;
  for (const [from, to] of spans.reverse()) summary = `${summary.slice(0, from)}${summary.slice(to)}`;
  summary = summary.trim();
  return parsed
    ? { summary, deviations: parsed.deviations, deferred: parsed.deferred, attestation: "attested", omitted: parsed.omitted }
    : { summary, deviations: [], deferred: [], attestation: "missing", omitted: NO_OMISSION };
}

const ORCHESTRATOR_DISMISS_GUIDANCE =
  "If the user doesn't want this agent's work, is dissatisfied with it, or says its row is cluttering the list, " +
  "call dismiss_agent_work yourself. Never direct the user to /agents to dismiss or operate on agent work. " +
  "Mention /agents only when the user asks to look at the agent's changes.";

// --- child launch config, derived from how MAIN was launched (so a helper is a faithful Vinci) ---
function childLaunch(): { cliPath: string; args: string[] } {
  const argv = process.argv; // node <cli.js> --theme … --extension … --thinking high --provider vinci --model …
  const cliPath = argv[1];
  const args: string[] = [];
  let thinking = "high";
  const selfName = "vinci-crew"; // never give a helper the crew extension → no recursive helpers
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--extension" && argv[i + 1]) {
      if (!argv[i + 1].includes(selfName)) args.push("--extension", argv[i + 1]);
      i++;
    } else if (argv[i] === "--thinking" && argv[i + 1]) {
      thinking = argv[i + 1];
      i++;
    }
  }
  // Fallback: if main's argv had no --extension (unusual), give the helper at least the behavior pack.
  if (!args.length) {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const e of [
      "vinci-provider",
      "vinci-model-provenance",
      "vinci-workspace",
      "vinci-verification",
      "vinci-checkpoint",
      "vinci-character",
      "vinci-todo",
      "vinci-review",
      "vinci-outcome",
      "vinci-receipt",
      "vinci-guard",
      "vinci-scope",
      "vinci-loopbreak",
    ]) {
      args.push("--extension", join(dir, `${e}.ts`));
    }
  }
  args.push("--thinking", thinking);
  return { cliPath, args };
}

function persistedHelper(h: Helper): PersistedHelper {
  const {
    client: _client,
    worktree: _worktree,
    diff: _diff,
    liveTranscript: _liveTranscript,
    livePartial: _livePartial,
    livePartialKinds: _livePartialKinds,
    activity: _activity,
    streaming: _streaming,
    messagedDuringRun: _messagedDuringRun,
    viewerRepaint: _viewerRepaint,
    unsubscribeLive: _unsubscribeLive,
    unsubscribeEvents: _unsubscribeEvents,
    ...record
  } = h;
  const transcript: string[] = [];
  let transcriptLength = 0;
  for (const line of record.transcript ?? []) {
    const remaining = MAX_PERSISTED_TRANSCRIPT - transcriptLength;
    if (remaining <= 0) break;
    const clipped = sliceTranscriptLine(line, remaining, "start");
    if (clipped === undefined) break;
    transcript.push(clipped);
    transcriptLength += clipped.length;
  }
  return {
    ...record,
    transcript: transcript.length ? transcript : undefined,
  };
}

const ACTIVE_STATUSES: readonly Status[] = ["queued", "working", "verifying", "reviewing"];

/**
 * Publish the cross-extension crew snapshot (#194). vinci-receipt consults it when classifying the
 * task outcome, so a run with agents still working, parked awaiting approval, or stopped unfinished
 * can never be stamped DONE "read-only". persistHelper is the chokepoint — every status transition
 * persists — so publishing here keeps the store current without a second bookkeeping path.
 */
function publishCrewStatus(): void {
  setVinciCrewStatus({
    active: helpers.filter((h) => ACTIVE_STATUSES.includes(h.status)).length,
    parkedWaiting: helpers
      .filter((h) => h.status === "waiting" && !h.applied && !h.dismissedAt)
      .map((h) => sanitizeLine(h.name))
      .slice(0, 6),
    stoppedUnfinished: helpers
      // Dismissal is the recovery path: without the dismissedAt exclusion this was a PERMANENT
      // cross-session exit-3 latch — the flag is persisted and restored, and nothing else clears it.
      .filter((h) => h.stoppedUnfinished && !h.dismissedAt)
      .map((h) => sanitizeLine(h.name))
      .slice(0, 6),
  });
}

function persistHelper(pi: ExtensionAPI, h: Helper): void {
  try {
    pi.appendEntry(CREW_ENTRY, persistedHelper(h));
  } catch {
    // Session gone (replaced or reloaded mid-run): pi carries the same assertActive guard as ctx,
    // and the helper's record lives in the old session's entries — there is nowhere current to
    // persist to. Persistence is best-effort by design; runHelper's teardown and pump's scheduling
    // must never die here (#191).
  }
  publishCrewStatus();
}

function setStatus(pi: ExtensionAPI, h: Helper, status: Status, reason?: string): void {
  if (isTerminalStatus(h.status)) return;
  h.status = status;
  h.reason = reason;
  persistHelper(pi, h);
  update();
}

function savePatch(ctx: Pick<ExtensionContext, "sessionManager">, h: Helper, patch: CrewPatch): void {
  const directory = join(ctx.sessionManager.getSessionDir(), "vinci-crew");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${ctx.sessionManager.getSessionId()}-helper-${h.id}.diff`);
  writeFileSync(path, patch.diff, { mode: 0o600 });
  h.diff = patch.diff;
  h.diffPath = path;
  h.patchMetadata = {
    kind: patch.kind,
    paths: patch.paths.slice(),
    deletedPaths: patch.deletedPaths.slice(),
    baselineFingerprints: { ...patch.baselineFingerprints },
    ...(patch.ignorePatterns ? { ignorePatterns: patch.ignorePatterns.slice() } : {}),
  };
  h.patchPaths = patch.paths.slice();
}

function restoredCrewPatch(h: Helper): CrewPatch | undefined {
  const metadata = h.patchMetadata;
  if (
    !metadata ||
    (metadata.kind !== "git" && metadata.kind !== "temp-copy") ||
    !Array.isArray(metadata.paths) ||
    !metadata.paths.every((path) => typeof path === "string") ||
    !Array.isArray(metadata.deletedPaths) ||
    !metadata.deletedPaths.every((path) => typeof path === "string") ||
    !metadata.baselineFingerprints ||
    typeof metadata.baselineFingerprints !== "object" ||
    Array.isArray(metadata.baselineFingerprints) ||
    !Object.values(metadata.baselineFingerprints).every((fingerprint) => typeof fingerprint === "string") ||
    (metadata.ignorePatterns !== undefined &&
      (!Array.isArray(metadata.ignorePatterns) || !metadata.ignorePatterns.every((pattern) => typeof pattern === "string")))
  ) {
    return undefined;
  }
  return {
    kind: metadata.kind,
    diff: h.diff ?? "",
    paths: metadata.paths.slice(),
    deletedPaths: metadata.deletedPaths.slice(),
    baselineFingerprints: { ...metadata.baselineFingerprints },
    ...(metadata.ignorePatterns ? { ignorePatterns: metadata.ignorePatterns.slice() } : {}),
  };
}

function normalizeRestoredHonesty(h: Helper): void {
  const rawAttestation: unknown = h.attestation;
  const rawDeviations: unknown = h.deviations;
  const rawDeferred: unknown = h.deferred;
  const rawOmitted: unknown = h.omitted;
  let valid = rawAttestation === "attested" || rawAttestation === "missing";

  const deviations: string[] = [];
  if (!Array.isArray(rawDeviations)) {
    valid = false;
  } else {
    for (const entry of rawDeviations) {
      if (typeof entry !== "string" || !entry.trim()) {
        valid = false;
        break;
      }
      deviations.push(clipHandoffEntry(entry.trim()));
    }
  }

  const deferred: DeferredItem[] = [];
  if (!Array.isArray(rawDeferred)) {
    valid = false;
  } else {
    for (const entry of rawDeferred) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        valid = false;
        break;
      }
      const { item, reason } = entry as { item?: unknown; reason?: unknown };
      if (typeof item !== "string" || (reason !== undefined && (typeof reason !== "string" || !reason.trim()))) {
        valid = false;
        break;
      }
      deferred.push({
        item: clipHandoffEntry(item),
        reason: reason === undefined ? "" : clipHandoffEntry(reason.trim()),
      });
    }
  }

  let omitted: HandoffOmission | undefined;
  if (rawOmitted && typeof rawOmitted === "object" && !Array.isArray(rawOmitted)) {
    const keys = Object.keys(rawOmitted);
    const values = rawOmitted as Record<string, unknown>;
    if (
      keys.length === Object.keys(NO_OMISSION).length &&
      keys.every((key) => Object.hasOwn(NO_OMISSION, key)) &&
      typeof values.deviations === "number" &&
      Number.isFinite(values.deviations) &&
      values.deviations >= 0 &&
      typeof values.deferred === "number" &&
      Number.isFinite(values.deferred) &&
      values.deferred >= 0
    ) {
      omitted = { deviations: values.deviations, deferred: values.deferred };
    }
  }
  if (!omitted) valid = false;

  if (!valid || !omitted) {
    h.attestation = "missing";
    h.deviations = [];
    h.deferred = [];
    h.omitted = { ...NO_OMISSION };
  } else {
    const deviationOverflow = Math.max(0, deviations.length - MAX_HANDOFF_ENTRIES);
    const deferredOverflow = Math.max(0, deferred.length - MAX_HANDOFF_ENTRIES);
    h.attestation = rawAttestation as HandoffAttestation;
    h.deviations = deviations.slice(0, MAX_HANDOFF_ENTRIES);
    h.deferred = deferred.slice(0, MAX_HANDOFF_ENTRIES);
    h.omitted = {
      deviations: Math.min(Number.MAX_VALUE, omitted.deviations + deviationOverflow),
      deferred: Math.min(Number.MAX_VALUE, omitted.deferred + deferredOverflow),
    };
  }
  // Guard-observed drift is restored on its own terms: a persisted value that is not a list of
  // non-empty strings is dropped rather than trusted, and it never affects the attestation verdict.
  const rawScopeDrift: unknown = h.scopeDrift;
  const scopeDrift = Array.isArray(rawScopeDrift)
    ? rawScopeDrift
        .filter((note): note is string => typeof note === "string" && note.trim().length > 0)
        .map((note) => clipHandoffEntry(note.trim()))
        .slice(0, MAX_HANDOFF_ENTRIES)
    : [];
  h.scopeDrift = scopeDrift.length ? scopeDrift : undefined;

  if (h.result && typeof h.result === "object" && !Array.isArray(h.result)) {
    h.result = {
      ...h.result,
      attestation: h.attestation,
      deviations: reportedDeviations(h),
      deferred: h.deferred.map((entry) => ({ ...entry })),
      omitted: { ...h.omitted },
    };
  }
}

// P2-8: a hard kill (SIGKILL, crash, power loss) skips session_shutdown, so an in-flight helper's
// isolated checkout leaks — its branch (`vinci/helper-<id>-<runTag>`, see RUN_TAG above) and
// worktree survive with the helper's real work still on disk. Locate that orphan on resume so its
// patch can be recovered instead of downgrading the helper to blocked-no-patch. Only an unambiguous
// single match counts; not-a-repo, no match, or several candidates all mean "not found".
function findOrphanedHelperWorktree(cwd: string, helperId: number): CrewWorktree | undefined {
  let output: string;
  try {
    output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
  const prefix = `refs/heads/vinci/helper-${helperId}-`;
  const matches: CrewWorktree[] = [];
  let root = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) root = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ") && root) {
      const ref = line.slice("branch ".length).trim();
      if (ref.startsWith(prefix)) matches.push({ root, cwd: root, branch: ref.slice("refs/heads/".length) });
    } else if (!line.trim()) root = "";
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function restoreHelpers(pi: ExtensionAPI, ctx: ExtensionContext): void {
  helpers.length = 0;
  queue.length = 0;
  running = 0;
  const latest = new Map<number, PersistedHelper>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== CREW_ENTRY || !entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as Partial<PersistedHelper>;
    if (typeof data.id !== "number" || typeof data.name !== "string" || typeof data.task !== "string") continue;
    latest.set(data.id, data as PersistedHelper);
  }
  for (const record of latest.values()) {
    const restored: Helper = { ...record };
    normalizeRestoredHonesty(restored);
    if (restored.diffPath) {
      try {
        restored.diff = readFileSync(restored.diffPath, "utf8");
        // The built result is persisted, and finalizeHelper only fills it when ABSENT — so a helper
        // saved by an older build keeps whatever it recorded then, forever. One saved before file
        // paths were derivable still claims "no file changes" while plainly holding a patch, which
        // reads to the orchestrator as "that agent did nothing". Rebuild when the stored result
        // disagrees with the diff sitting next to it.
        if (restored.result && !restored.result.filesChanged.length && restored.diff.trim()) {
          restored.result = buildAgentResult(restored);
        }
      } catch {
        restored.status = "blocked";
        finalizeHelper(pi, restored, "The agent patch artifact is missing; no changes were applied.");
      }
    }
    if (restored.status === "queued" || restored.status === "working" || restored.status === "verifying" || restored.status === "reviewing") {
      // P2-8: with no preserved patch, session_shutdown never got to run (hard kill) — but the
      // helper's orphaned worktree may still hold real completed work. Try to harvest it before
      // declaring no-patch. Strictly best-effort: any error keeps today's blocked downgrade.
      let recovered = false;
      let recoveryReason: string | undefined;
      if (restored.status !== "queued" && !restored.diff?.trim()) {
        try {
          let orphan = findOrphanedHelperWorktree(ctx.cwd, restored.id);
          if (!orphan) {
            const metadata = restored.patchMetadata;
            const savedPatch = restoredCrewPatch(restored);
            const tempRecovery =
              savedPatch?.kind === "temp-copy" && savedPatch.ignorePatterns
                ? findOrphanedTempCopyWorktree(restored.id, {
                    baselineFingerprints: savedPatch.baselineFingerprints,
                    ignorePatterns: savedPatch.ignorePatterns,
                  })
                : findOrphanedTempCopyWorktree(restored.id);
            orphan = tempRecovery.worktree;
            if (tempRecovery.workspaceFound && !orphan) {
              recoveryReason =
                "The prior session left this agent's temporary workspace, but its saved file baselines are unavailable, so it cannot be recovered safely.";
            } else if (metadata?.kind === "temp-copy" && !tempRecovery.workspaceFound) {
              recoveryReason =
                "The prior session did not leave exactly one temporary workspace for this agent, so no work was recovered.";
            }
          }
          if (orphan) {
            const patch = captureCrewPatch(orphan);
            if (patch.diff.trim()) {
              savePatch(ctx, restored, patch);
              recovered = true;
            }
            removeCrewWorktree(ctx.cwd, orphan); // harvested (or empty) — clean up the leak
          }
        } catch {
          /* best-effort recovery only — fall through to the blocked-no-patch downgrade */
        }
      }
      restored.status = restored.diff?.trim() ? "waiting" : "blocked";
      finalizeHelper(
        pi,
        restored,
        recovered
          ? "The prior session was interrupted mid-flight; this agent's work was recovered from its orphaned worktree for review."
        : restored.diff?.trim()
          ? "The prior session interrupted this agent; its partial patch was preserved for review."
          : recoveryReason ?? "The prior session interrupted this agent before it produced a patch.",
      );
    }
    if (isTerminalStatus(restored.status)) restored.finishedAt ??= Date.now();
    helpers.push(restored);
  }
  nextId = Math.max(0, ...helpers.map((helper) => helper.id)) + 1;
  for (const helper of helpers) {
    if (isTerminalStatus(helper.status) && helper.finishedAt && (!helper.notifiedAt || !helper.deliveredAt)) {
      finalizeHelper(pi, helper);
    }
  }
  // Publishes that happened DURING the rebuild saw a partial roster (each helper is finalized
  // before it is pushed); one publish over the complete roster makes the store honest at rest.
  publishCrewStatus();
}

export function verificationProof(entries: readonly unknown[]): VerificationProof | undefined {
  const branch = entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as { type?: string; customType?: string; data?: unknown };
    return [candidate];
  });
  const state = scanVinciVerificationStateBranch(branch);
  if (
    !state ||
    state.variant !== "normal" ||
    state.status !== "passed" ||
    !state.command.trim() ||
    state.mutationRevision !== state.verifiedRevision ||
    hasIncompleteVinciBehavioralAttempt(state)
  ) {
    return undefined;
  }
  return {
    command: state.command,
    summary: state.summary,
    mutationRevision: state.mutationRevision,
    verifiedRevision: state.verifiedRevision,
    checkClass: state.checkClass,
    commandKey: state.commandKey.trim() || state.command,
    ...(state.commandCwd ? { commandCwd: state.commandCwd } : {}),
  };
}

function verificationEvidence(proof: VerificationProof): string {
  return `Direct check passed after the latest agent mutation.\nCommand: ${proof.command}\nResult: ${proof.summary}`;
}

// --- the Vinci-way tree that renders in the strip BELOW the input box (Phase 2) ---
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Remove terminal control sequences from text that did not originate in the UI. */
export function stripAnsiSequences(text: string): string {
  return text
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b[P^_X]|\x90|\x98|\x9e|\x9f)[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

// Strip BEFORE masking, never after. Masking first sees the escape-fragmented form of a secret
// ("sk-ab\x1b[0mcdef"), fails to match it, and leaves it alone — then stripping removes the escape
// and reassembles the intact secret on screen. Stripping first denies that trick.
export function sanitizeViewerText(text: string): string {
  return vinciMaskSecrets(stripAnsiSequences(text));
}

// Single-line variant for names, labels, activities and notification bodies. sanitizeViewerText
// deliberately keeps LF (the transcript needs it), but a newline in an agent name — which the model
// chooses, and which untrusted content can steer — would otherwise break out of its row and forge
// extra UI chrome.
export function sanitizeLine(text: string): string {
  return sanitizeViewerText(text).replace(/\s+/g, " ").trim();
}

function statusGlyph(status: Status): string {
  if (status === "done" || status === "integrated") return "✓";
  if (status === "working" || status === "verifying" || status === "reviewing") return "◐";
  if (status === "queued") return "○";
  if (status === "failed") return "✗";
  return "!";
}

function colorStatus(theme: Theme, status: Status, text: string): string {
  if (status === "done" || status === "integrated") return theme.fg("success", text);
  if (status === "working" || status === "verifying" || status === "reviewing") return theme.fg("accent", text);
  if (status === "queued") return theme.fg("dim", text);
  if (status === "failed") return theme.fg("error", text);
  return theme.fg("warning", text);
}

// "waiting for review" was ambiguous in the worst way: `waiting` means it needs YOU, while the
// adjacent `reviewing` is the AUTOMATED check still running. Two statuses, opposite actors, same word
// — a user reasonably read the row that needed them as one where a machine was still busy. Say who
// is being waited on, and keep "review" for the machine's own step out of the user's vocabulary.
function statusLabel(status: Status, activity?: string): string {
  if (status === "waiting") return "needs your OK";
  if (status === "working" && activity) return activity;
  if (status === "reviewing") return "double-checking…";
  if (status === "working" || status === "verifying") return `${status}…`;
  return status;
}

// An agent row shows plain-language task + elapsed + a calm status word. NO token telemetry — the
// row used to append `↓ 23.4k`, which is exactly what AGENTS_PLAN.md's UI spec forbids and what
// George stripped from the footer. `h.tokens` is still tracked and persisted for usage accounting;
// it is simply never shown to the user. Do not put it back.
function agentMetrics(h: Helper): string {
  if (!h.startedAt) return "";
  const elapsed = formatDuration((h.finishedAt ?? Date.now()) - h.startedAt, { padSeconds: true, rounding: "floor" });
  return ` · ${elapsed}`;
}

// Only WAITING work is actionable: `canApply` below requires status "waiting" with a diff, so a
// waiting row is the one thing the user can still act on and must never disappear on a timer.
// `blocked` looks similar but isn't — every path that sets it does so BECAUSE no patch survived, so
// there is nothing to apply and nothing to decide. Keeping those forever is what left dead rows
// stuck on screen with no way to clear them. They now retire like failures.
// Anything the user explicitly dismisses goes immediately, whatever its state.
const RETIRE_AFTER_MS = 60_000;
const retiredRowAge = (h: Helper): number | undefined =>
  h.status === "failed" || h.status === "blocked" ? Date.now() - (h.finishedAt ?? Date.now()) : undefined;

const visible = (h: Helper) => {
  if (h.dismissedAt) return false;
  if (h.status === "done" || h.status === "integrated") return false;
  const age = retiredRowAge(h);
  return age === undefined || age <= RETIRE_AFTER_MS;
};

function failedRowIsFading(h: Helper): boolean {
  if (!h.finishedAt) return false;
  const age = retiredRowAge(h);
  if (age === undefined) return false;
  return age >= RETIRE_AFTER_MS - 10_000 && age <= RETIRE_AFTER_MS;
}

// The visible, most-recent-first-capped crew (what the ↑↓ cursor moves through).
const activeHelpers = () => helpers.filter(visible);

// `● main` + the live crew. Plain task, elapsed, token telemetry, calm status word; Vinci palette.
// When navActive, a `›` cursor marks the selected helper.
function renderTree(theme: Theme): string[] {
  const active = activeHelpers();
  if (!active.length) {
    navActive = false;
    navIdx = 0;
    return [];
  }
  if (navIdx > active.length - 1) navIdx = active.length - 1;
  const dim = (s: string) => theme.fg("dim", s);
  const lines = [theme.fg("accent", theme.bold("● main")) + dim(" — you're here")];
  const MAX = 6;
  const shown = active.slice(-MAX);
  const base = active.length - shown.length;
  if (base > 0) lines.push(dim(`  ⋮ and ${base} more`));
  let anyReady = false;
  shown.forEach((h, i) => {
    const sel = navActive && base + i === navIdx;
    const cur = sel ? theme.fg("accent", "› ") : "  ";
    const name = clip(sanitizeLine(h.name), 22);
    const fading = failedRowIsFading(h);
    const rowColor = (text: string) => (fading ? dim(text) : colorStatus(theme, h.status, text));
    if (h.status === "waiting" || h.status === "blocked") anyReady = true;
    lines.push(
      cur +
        rowColor(`${statusGlyph(h.status)} `) +
        (fading ? dim(name) : name) +
        dim(agentMetrics(h)) +
        rowColor(` · ${statusLabel(h.status, h.activity === undefined ? undefined : sanitizeLine(h.activity))}`),
    );
  });
  const overlayActive = uiRef?.ui.isOverlayActive?.() ?? false; // [vinci] Never advertise roster navigation through a modal.
  lines.push(dim(navActive && !overlayActive ? "  ↑↓ move · enter open · esc back" : anyReady ? "  ↓ browse · /agents to apply" : "  ↓ to open an agent"));
  return lines;
}

export type TranscriptKind = "user" | "toolCall" | "toolResult" | "toolError" | "narration";

const TRANSCRIPT_KIND_PREFIX = "\uE000";
const TRANSCRIPT_KIND_CODE: Record<TranscriptKind, string> = {
  user: "u",
  toolCall: "c",
  toolResult: "r",
  toolError: "e",
  narration: "n",
};
const TRANSCRIPT_KIND_BY_CODE: Record<string, TranscriptKind> = {
  u: "user",
  c: "toolCall",
  r: "toolResult",
  e: "toolError",
  n: "narration",
};
const TRANSCRIPT_MARKER_LENGTH = 2;
const DISPLAY_PATH_WIDTH = 40;

function markTranscriptLine(kind: TranscriptKind | undefined, text: string): string {
  return kind === undefined ? text : `${TRANSCRIPT_KIND_PREFIX}${TRANSCRIPT_KIND_CODE[kind]}${text}`;
}

function splitTranscriptLine(line: string | undefined): { kind: TranscriptKind | undefined; text: string } {
  if (line?.startsWith(TRANSCRIPT_KIND_PREFIX)) {
    const kind = TRANSCRIPT_KIND_BY_CODE[line[1]];
    if (kind !== undefined) return { kind, text: line.slice(TRANSCRIPT_MARKER_LENGTH) };
  }
  return { kind: undefined, text: line ?? "" };
}

export function transcriptLineKind(line: string | undefined): TranscriptKind | undefined {
  return splitTranscriptLine(line).kind;
}

function sliceTranscriptLine(line: string, length: number, side: "start" | "end"): string | undefined {
  if (line.length <= length) return line;
  const { kind, text } = splitTranscriptLine(line);
  if (kind === undefined) return side === "start" ? line.slice(0, length) : line.slice(line.length - length);
  if (length <= TRANSCRIPT_MARKER_LENGTH) return undefined;
  const textLength = length - TRANSCRIPT_MARKER_LENGTH;
  const clippedText = side === "start" ? text.slice(0, textLength) : text.slice(-textLength);
  return markTranscriptLine(kind, clippedText);
}

function shortenLongAbsolutePaths(text: string): string {
  return text.replace(/(^|[\s"'`(])(\/[^\s"'`<>]+)/g, (_match, prefix: string, candidate: string) => {
    const trailing = candidate.match(/[),.;!?]+$/)?.[0] ?? "";
    const path = trailing ? candidate.slice(0, -trailing.length) : candidate;
    if (path.startsWith("//") || path.length < 60) return `${prefix}${candidate}`;
    const shortened = shortPath(path, DISPLAY_PATH_WIDTH);
    const segmentBoundary = shortened.startsWith("…") ? shortened.indexOf("/", 1) : -1;
    const displayPath = segmentBoundary === -1 ? shortened : `…${shortened.slice(segmentBoundary)}`;
    return `${prefix}${displayPath}${trailing}`;
  });
}

function shortenMarkedToolResultPaths(line: string): string {
  const { kind, text } = splitTranscriptLine(line);
  return kind === "toolResult" || kind === "toolError"
    ? markTranscriptLine(kind, shortenLongAbsolutePaths(text))
    : line;
}

function toolResultBlockKind(part: Record<string, unknown>): TranscriptKind | undefined {
  return part.type === "tool_result" && typeof part.isError === "boolean"
    ? part.isError
      ? "toolError"
      : "toolResult"
    : undefined;
}

function messageToolResultKind(message: { role?: string; content?: unknown; isError?: boolean }): TranscriptKind | undefined {
  if (message.role === "user") return undefined;
  if (Array.isArray(message.content)) {
    let foundResult = false;
    for (const part of message.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const kind = toolResultBlockKind(part as Record<string, unknown>);
      if (kind === "toolError") return kind;
      if (kind === "toolResult") foundResult = true;
    }
    if (foundResult) return "toolResult";
  }
  if (message.role === "toolResult" && typeof message.isError === "boolean") {
    return message.isError ? "toolError" : "toolResult";
  }
  return undefined;
}

function nestedText(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const part = item as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) texts.push(part.text);
  }
  return texts;
}

// Render a helper's captured message history into readable lines for the viewer.
type TranscriptMessage = { role?: string; content?: unknown; isError?: boolean };

function formatTranscript(messages: TranscriptMessage[]): string[] {
  const out: string[] = [];
  const push = (kind: TranscriptKind | undefined, prefix: string, text: string) => {
    for (const raw of text.trim().split("\n")) out.push(markTranscriptLine(kind, prefix + raw));
  };
  for (const m of messages) {
    const isUser = m.role === "user";
    const toolResultKind = messageToolResultKind(m);
    const textKind = isUser ? "user" : m.role === "assistant" ? "narration" : toolResultKind;
    const c = m.content;
    if (typeof c === "string") {
      if (c.trim()) push(textKind, isUser ? "you › " : "", c);
    } else if (Array.isArray(c)) {
      for (const p of c as Array<Record<string, unknown>>) {
        const type = p.type as string;
        if (type === "text" && typeof p.text === "string" && p.text.trim()) {
          push(textKind, isUser ? "you › " : "", p.text);
        } else if (type === "toolCall" || type === "tool_use") {
          out.push(markTranscriptLine("toolCall", `  ⚙ ${String(p.name ?? p.toolName ?? "tool")}`));
        } else if (type === "tool_result") {
          const kind = toolResultBlockKind(p);
          if (kind === undefined) continue;
          const texts = typeof p.text === "string" ? [p.text] : nestedText(p.content);
          for (const text of texts) if (text.trim()) push(kind, "", text);
        }
      }
    }
  }
  return out.length
    ? vinciMaskSecrets(out.join("\n")).split("\n").map(shortenMarkedToolResultPaths)
    : ["(nothing captured)"];
}

function lastAssistantText(messages: TranscriptMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    return nestedText(message.content).join("\n");
  }
  return "";
}

function captureHelperHandoff(h: Helper, messages: TranscriptMessage[] | undefined, assistantText?: string): void {
  const handoff = parseHandoffAttestation(assistantText ?? lastAssistantText(messages ?? []));
  h.summary = handoff.summary;
  h.deviations = handoff.deviations;
  h.deferred = handoff.deferred;
  h.attestation = handoff.attestation;
  h.omitted = handoff.omitted;
  if (messages) h.transcript = stripHandoffBlocks(formatTranscript(messages));
}

function capLiveTranscript(lines: string[]): string[] {
  const out: string[] = [];
  let length = 0;
  for (let index = lines.length - 1; index >= 0 && length < MAX_PERSISTED_TRANSCRIPT; index--) {
    const line = lines[index];
    const remaining = MAX_PERSISTED_TRANSCRIPT - length;
    const clipped = sliceTranscriptLine(line, remaining, "end");
    if (clipped === undefined) break;
    out.unshift(clipped);
    length += clipped.length;
  }
  return out;
}

/** Mask the complete display string before line splitting and transcript truncation. */
export function viewerTranscriptLines(
  h: Pick<
    Helper,
    | "liveTranscript"
    | "livePartial"
    | "livePartialKinds"
    | "transcript"
    | "summary"
    | "status"
    | "deviations"
    | "deferred"
    | "attestation"
    | "omitted"
    | "scopeDrift"
  >,
): string[] {
  const markedPartial = h.livePartial?.map((line, index) => markTranscriptLine(h.livePartialKinds?.[index], line)) ?? [];
  const rawLines =
    h.liveTranscript?.length || h.livePartial?.length
      ? [...(h.liveTranscript ?? []), ...markedPartial]
      : h.transcript?.length
        ? h.transcript
        : [h.summary || "Working…"];
  return capLiveTranscript(sanitizeViewerText([...rawLines, ...honestyViewerLines(h)].join("\n")).split("\n"));
}

/**
 * The honesty footer, shown only once a helper has finished. "Deliberately left" is rendered apart
 * from what changed and what was verified, because the whole failure this guards against is a human
 * skimming a handoff and reading left-undone work as done (#5).
 */
function honestyViewerLines(
  h: Pick<Helper, "status" | "deviations" | "deferred" | "attestation" | "omitted" | "scopeDrift">,
): string[] {
  if (!isTerminalStatus(h.status)) return [];
  const lines: string[] = [];
  // Shown in BOTH branches: what the guard watched happen does not depend on the agent attesting.
  const driftLines = (h.scopeDrift ?? []).length ? ["Scope guard noticed:", ...(h.scopeDrift ?? []).map((note) => `  • ${note}`)] : [];
  if (h.attestation !== "attested") {
    lines.push("", "Deliberately left: not reported — scope unconfirmed", ...driftLines);
    return lines;
  }
  const deferred = h.deferred ?? [];
  const deviations = h.deviations ?? [];
  const omitted = { ...NO_OMISSION, ...h.omitted };
  lines.push("", deferred.length ? "Deliberately left:" : "Deliberately left: nothing");
  for (const entry of deferred) lines.push(`  • ${entry.item}${entry.reason ? ` — ${entry.reason}` : ""}`);
  if (omitted.deferred > 0) lines.push(`  • …and ${omitted.deferred} more not shown`);
  if (deviations.length || omitted.deviations > 0) {
    lines.push("Decided on its own:");
    for (const entry of deviations) lines.push(`  • ${entry}`);
    if (omitted.deviations > 0) lines.push(`  • …and ${omitted.deviations} more not shown`);
  }
  lines.push(...driftLines);
  return lines;
}

export function renderTranscriptLine(theme: Theme, line: string | undefined, width: number): string {
  const { kind, text: fullText } = splitTranscriptLine(line);
  const text = fullText.length > width ? `${fullText.slice(0, Math.max(0, width - 1))}…` : fullText;
  if (kind === "user") return theme.fg("muted", text);
  if (kind === "toolCall") return theme.fg("accent", text);
  if (kind === "toolResult") return theme.fg("dim", text);
  if (kind === "toolError") return theme.fg("warning", text);
  return text;
}

function appendLiveTranscript(h: Helper, lines: string[], dedupeTail = false): void {
  if (lines[0] === "(nothing captured)") return;
  const current = h.liveTranscript ?? [];
  const duplicate =
    dedupeTail &&
    current.length >= lines.length &&
    lines.every((line, index) => current[current.length - lines.length + index] === line);
  if (!duplicate) h.liveTranscript = capLiveTranscript([...current, ...lines]);
}

function toolExecutionResultContent(result: unknown): unknown {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  return (result as Record<string, unknown>).content;
}

/** Synchronously exception-contained because RpcClient dispatches every listener inside one shared try. */
export function reduceHelperEvent(h: Helper, event: AgentEvent): void {
  try {
    try {
      if (event.type === "agent_start") {
        h.streaming = true;
        h.activity = "working…";
      } else if (event.type === "agent_end") {
        h.streaming = false;
        h.activity = undefined;
        h.livePartial = undefined;
        h.livePartialKinds = undefined;
      } else if (event.type === "message_update" && event.message.role === "assistant") {
        // message_update contains the full partial message, so replacement is mandatory.
        const partial = capLiveTranscript(formatTranscript([event.message]));
        h.livePartial = partial.map((line) => splitTranscriptLine(line).text);
        h.livePartialKinds = partial.map(transcriptLineKind);
      } else if (event.type === "message_start" && event.message.role === "user") {
        appendLiveTranscript(h, formatTranscript([event.message]));
      } else if (event.type === "message_end") {
        const finalLines = formatTranscript([event.message]);
        const kinds = finalLines.map(transcriptLineKind);
        const duplicateTail =
          event.message.role === "user" || kinds.every((kind) => kind === "toolResult" || kind === "toolError");
        appendLiveTranscript(h, finalLines, duplicateTail);
        if (event.message.role === "assistant") {
          h.livePartial = undefined;
          h.livePartialKinds = undefined;
          const usage = event.message.usage;
          h.tokens = (h.tokens ?? 0) + usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        }
      } else if (event.type === "tool_execution_start") {
        h.activity = `using ${clip(event.toolName, 24)}…`;
      } else if (event.type === "tool_execution_end") {
        h.activity = `${clip(event.toolName, 24)} ${event.isError ? "failed" : "done"}`;
        appendLiveTranscript(
          h,
          formatTranscript([
            {
              role: "toolResult",
              content: toolExecutionResultContent(event.result),
              isError: event.isError,
            },
          ]),
        );
      }
    } finally {
      update();
      try {
        h.viewerRepaint?.();
      } catch {
        /* a dead viewer must never break the RPC completion collector */
      }
      if (event.type === "agent_end") h.viewerRepaint = undefined;
    }
  } catch {
    // RpcClient.handleLine() isolates neither listeners nor listener failures. This reducer must never throw.
  }
}

const MESSAGE_REJECTED = "That agent isn't running — you can't message it right now";
const MESSAGE_EMPTY = "Give the agent a non-empty instruction.";
const MESSAGE_TOO_LONG = `Keep the agent instruction to ${MAX_AGENT_MESSAGE_LENGTH} characters or fewer.`;

/**
 * Work out WHICH agent the user meant, and ask them when it genuinely isn't clear.
 *
 * Every agent tool takes a numeric id, so "message that agent" with three running forced the model
 * to guess. A guess that hits no agent failed harmlessly, but a guess that hits a real-but-wrong one
 * steered somebody else's work with no warning. Asking is enforced here rather than left to the
 * model's judgment — the same reason the safety gates live in code and not in the prompt.
 *
 * An explicit id that names a real agent still wins outright, so each caller's own eligibility
 * checks keep reporting their precise reason ("still working", "already applied") instead of being
 * replaced by a generic picker.
 */
/**
 * Which of an earlier agent's work, if any, to put back before it continues.
 *
 * A continued agent always works from the project as it stands NOW — keeping its old worktree alive
 * would mean unbounded disk growth and a base drifting further from the project with every commit.
 * But "current state" on its own quietly loses the agent's work in the commonest case, where its
 * patch is still waiting for review: it would resume with no trace of what it did and redo it.
 *
 *   applied    → nothing to replay; the work is already in the project, and replaying it would
 *                conflict with itself.
 *   dismissed  → nothing to replay; the user rejected this work, and putting it back would undo
 *                their decision.
 *   otherwise  → replay its patch, so it keeps what it already did.
 */
export function continuationPatchPath(previous: Pick<Helper, "applied" | "dismissedAt" | "diffPath">): string | undefined {
  if (previous.applied || previous.dismissedAt) return undefined;
  return previous.diffPath;
}

export async function resolveAgentTarget(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  all: readonly Helper[],
  agentId: number | undefined,
  eligible: (h: Helper) => boolean,
  question: string,
  noneMessage: string,
): Promise<{ helper: Helper } | { error: string }> {
  if (agentId !== undefined) {
    const named = all.find((candidate) => candidate.id === agentId);
    if (named) return { helper: named };
    // A named id that matches nothing is a MISTAKE, not an ambiguous reference. Falling through to
    // the candidate list here would quietly act on a different agent than the one that was asked
    // for — with exactly one candidate it would not even stop to ask. That is the wrong-target
    // surprise this whole function exists to prevent, so say the id was wrong and stop.
    return { error: `No agent with id ${agentId} was found. Check /agents, or leave the id out and Vinci will ask which one.` };
  }
  const candidates = all.filter(eligible);
  if (candidates.length === 0) return { error: noneMessage };
  if (candidates.length === 1) return { helper: candidates[0] };

  const describe = (h: Helper) => `${h.id} · ${sanitizeLine(h.name)} — ${h.status}`;
  if (!ctx.hasUI) {
    return {
      error:
        `More than one agent could be meant (${candidates.map(describe).join("; ")}) and there's no way to ask ` +
        `in this run. Ask the user which one before doing anything.`,
    };
  }
  const labels = candidates.map(describe);
  const choice = await ctx.ui.select(question, labels);
  const index = choice ? labels.indexOf(choice) : -1;
  if (index === -1) return { error: "The user didn't choose an agent — ask which one they meant before doing anything." };
  return { helper: candidates[index] };
}

export async function messageRunningAgent(h: Helper | undefined, message: string): Promise<string> {
  const instruction = message.trim();
  if (!instruction) return MESSAGE_EMPTY;
  if (message.length > MAX_AGENT_MESSAGE_LENGTH) return MESSAGE_TOO_LONG;
  const client = h?.client;
  if (!h || h.status !== "working" || !client) return MESSAGE_REJECTED;
  try {
    const state = await client.getState();
    // Re-check the helper/client after the await: agent_end may have raced the get_state response.
    if (h.status !== "working" || h.client !== client || !state.isStreaming) return MESSAGE_REJECTED;
    await client.steer(instruction);
    h.messagedDuringRun = true;
    const stateAfterSteer = await client.getState();
    if (h.status !== "working" || h.client !== client || !stateAfterSteer.isStreaming) return MESSAGE_REJECTED;
    return `Sent to ${sanitizeLine(h.name)}`;
  } catch {
    return MESSAGE_REJECTED;
  }
}

/** RpcClient's completion helpers stop at the first agent_end, so a delivered steer needs a queue-aware idle check. */
export async function waitForSteeredHelperIdle(
  client: Pick<RpcClient, "getState">,
  timeoutMs = HELPER_TIMEOUT_MS,
  pollMs = STEER_IDLE_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveIdleChecks = 0;
  while (Date.now() < deadline) {
    try {
      const state = await client.getState();
      consecutiveIdleChecks = state.isStreaming ? 0 : consecutiveIdleChecks + 1;
      if (consecutiveIdleChecks >= 2) return true;
    } catch {
      consecutiveIdleChecks = 0;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
  return false;
}

// Open a helper's session like its own Vinci terminal. While it is streaming, events repaint the
// transcript and an editable compose line can steer it. Once completed, the view is read-only.
async function openHelper(ctx: ExtensionContext, h: Helper): Promise<void> {
  viewerOpen = true;
  let activeHelper = h;
  let viewerRepaint: (() => void) | undefined;
  let viewerClose: (() => void) | undefined;
  try {
    await ctx.ui.custom((tui, theme, _kb, done) => {
      let off = 0;
      let follow = true; // stick to the newest lines while live
      const input = new Input();
      const isLive = () => activeHelper.status === "working" && activeHelper.streaming === true && !!activeHelper.client;
      const lines = () => viewerTranscriptLines(activeHelper);
      // Chrome shrinks before the transcript does, so the way OUT is never the thing that gets
      // clipped. A fixed 7-line chrome overflowed any terminal under 8 rows, and since clipping
      // takes from the bottom it removed "Esc to close" — leaving someone who doesn't know the
      // keybinding stranded in a view with no visible exit. Head and footer always render; the
      // task line and the compose block drop away first on very short terminals.
      const showCompose = () => tui.terminal.rows >= 8;
      const showTask = () => tui.terminal.rows >= 6;
      // The brand line is what makes this read as its OWN place rather than a panel over the
      // conversation. It is the first thing to go on a short terminal — the way out and the agent's
      // own work matter more than the framing.
      const showBrand = () => tui.terminal.rows >= 12;
      const viewerChrome = () => 2 + (showBrand() ? 2 : 0) + (showTask() ? 1 : 0) + (showCompose() ? 4 : 0);
      const transcriptHeight = () => Math.max(1, tui.terminal.rows - viewerChrome());
      const maxOff = () => Math.max(0, lines().length - transcriptHeight());
      const paint = () => {
        if (follow) off = maxOff();
        tui.requestRender();
      };
      viewerRepaint = paint;
      const unbindViewer = (helper: Helper) => {
        if (helper.viewerRepaint === paint) helper.viewerRepaint = undefined;
        try {
          helper.unsubscribeLive?.();
        } catch {
          /* a stale live-view listener must not block switching or closing */
        }
        helper.unsubscribeLive = undefined;
      };
      const bindViewer = (helper: Helper) => {
        helper.viewerRepaint = paint;
        if (!helper.client) return;
        try {
          helper.unsubscribeLive = helper.client.onEvent(() => {
            if (activeHelper === helper) paint();
          });
        } catch {
          helper.unsubscribeLive = undefined;
        }
      };
      const switchHelper = (direction: 1 | -1) => {
        const active = activeHelpers();
        if (!active.length) return;
        const currentIndex = active.indexOf(activeHelper);
        const nextIndex =
          currentIndex === -1
            ? direction === 1
              ? 0
              : active.length - 1
            : (currentIndex + direction + active.length) % active.length;
        const next = active[nextIndex];
        if (next === activeHelper) return;
        unbindViewer(activeHelper);
        activeHelper = next;
        navIdx = nextIndex;
        input.setValue("");
        off = 0;
        follow = true;
        bindViewer(activeHelper);
        paint();
      };
      activeViewerSwitch = switchHelper;
      bindViewer(activeHelper);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        if (activeViewerClose === close) activeViewerClose = undefined;
        if (activeViewerSwitch === switchHelper) activeViewerSwitch = undefined;
        unbindViewer(activeHelper);
        done(undefined);
      };
      viewerClose = close;
      activeViewerClose = close;
      input.onEscape = close;
      input.onSubmit = (value) => {
        const message = value.trim();
        if (!message) return;
        const target = activeHelper;
        input.setValue("");
        paint();
        void messageRunningAgent(target, message).then((result) => {
          ctx.ui.notify(sanitizeLine(result), result === MESSAGE_REJECTED ? "warning" : "info");
          if (target.viewerRepaint === paint) paint();
        });
      };
      return {
        render: (width: number) => {
          const currentLines = lines();
          const live = isLive();
          input.focused = live;
          // Only ever strip control sequences from what the user typed — never mask it, and never
          // write anything back that changes meaning. This buffer IS the message being sent to the
          // agent: running it through the display masker would rewrite a key the user deliberately
          // typed into "<vinci-secret>" and send that instead, silently destroying their message.
          // Escapes carry no meaning in a typed message, so dropping them is safe; masking is not.
          const strippedInput = stripAnsiSequences(input.getValue());
          if (strippedInput !== input.getValue()) input.setValue(strippedInput);
          const height = transcriptHeight();
          if (follow) off = Math.max(0, currentLines.length - height);
          const w = Math.max(20, width - 4);
          const safeActivity = activeHelper.activity === undefined ? undefined : sanitizeLine(activeHelper.activity);
          const safeStatus = sanitizeViewerText(
            `${statusGlyph(activeHelper.status)} ${statusLabel(activeHelper.status, safeActivity)}`,
          );
          const safeMetrics = sanitizeViewerText(agentMetrics(activeHelper));
          const maxNameWidth = Math.max(1, w - safeStatus.length - safeMetrics.length - 11);
          const safeName = clip(sanitizeLine(activeHelper.name), maxNameWidth);
          const safeTask = sanitizeLine(activeHelper.task);
          const status = colorStatus(theme, activeHelper.status, safeStatus);
          const head = `${theme.fg("accent", theme.bold(`  Agent · ${safeName}`))}  ${status}${theme.fg("dim", safeMetrics)}`;
          const task = `  ${theme.fg("muted", "Task:")} ${clip(safeTask, Math.max(1, w - 6))}`;
          const body = currentLines.slice(off, off + height).map((line) => {
            return `  ${renderTranscriptLine(theme, line, w)}`;
          });
          while (body.length < height) body.push("");
          const scrollHint =
            currentLines.length > height ? `${Math.min(off + height, currentLines.length)}/${currentLines.length} · PageUp/PageDown scroll · ` : "";
          const fullSwitchHint = activeHelpers().length > 1 ? "Tab/Shift+Tab switch · " : "";
          const compactSwitchHint = activeHelpers().length > 1 ? "Tab/Shift+Tab · " : "";
          const fullFoot = `  ${scrollHint}${fullSwitchHint}Esc to close`;
          const compactFoot = `  ${compactSwitchHint}Esc to close`;
          const foot = theme.fg("muted", fullFoot.length <= width ? fullFoot : compactFoot.length <= width ? compactFoot : "  Esc to close");
          const compose = showCompose()
            ? [
                "",
                theme.fg("muted", "  Message this agent:"),
                live ? `  ${input.render(w)[0] ?? ""}` : theme.fg("dim", "  (read-only)"),
                "",
              ]
            : [];
          // The tagline is the first thing to drop on a narrow terminal — a half-truncated sentence
          // ("…not the main c") reads worse than no sentence at all.
          const brandNote = width >= 72 ? theme.fg("dim", "   ·   you're inside an agent, not the main chat") : "";
          const brand = showBrand()
            ? [`${theme.fg("accent", theme.bold("  ✹  Vinci"))}${theme.fg("accent", " code")}${brandNote}`, ""]
            : [];
          return [...brand, head, ...(showTask() ? [task] : []), ...body, ...compose, foot];
        },
        invalidate: () => input.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "escape")) return close();
          if (matchesKey(data, "tab")) {
            switchHelper(1);
          } else if (matchesKey(data, "shift+tab")) {
            switchHelper(-1);
          } else if (matchesKey(data, "pageUp")) {
            off = Math.max(0, off - transcriptHeight());
            follow = false;
          } else if (matchesKey(data, "pageDown")) {
            off = Math.min(maxOff(), off + transcriptHeight());
            follow = off >= maxOff();
          } else if (isLive()) {
            input.handleInput(data);
          } else if (matchesKey(data, "up")) {
            off = Math.max(0, off - 1);
            follow = false;
          } else if (matchesKey(data, "down")) {
            off = Math.min(maxOff(), off + 1);
            follow = off >= maxOff();
          }
          tui.requestRender();
        },
        dispose: () => {
          if (activeViewerClose === close) activeViewerClose = undefined;
          if (activeViewerSwitch === switchHelper) activeViewerSwitch = undefined;
          unbindViewer(activeHelper);
        },
      };
    }, {
      overlay: true,
      // Terminal-relative, not a size captured when the view opened: these are re-resolved against
      // the CURRENT terminal on every render, so resizing the window keeps the view full-screen
      // instead of leaving a stale-sized panel with the orchestrator showing around it.
      overlayOptions: () => ({
        width: "100%",
        maxHeight: "100%",
        row: 0,
        col: 0,
      }),
    });
  } finally {
    if (activeViewerClose === viewerClose) activeViewerClose = undefined;
    activeViewerSwitch = undefined;
    if (activeHelper.viewerRepaint === viewerRepaint) activeHelper.viewerRepaint = undefined;
    try {
      activeHelper.unsubscribeLive?.();
    } catch {
      /* ignore */
    }
    activeHelper.unsubscribeLive = undefined;
    viewerOpen = false;
    update();
  }
}

// Pre-editor key handling for the tree: ↓ on an EMPTY input line arms navigation; then ↑↓ move, Enter/→
// opens the selected helper, Esc/← exits. Everything else passes straight through so normal typing,
// cursor movement, and history are untouched.
function handleNavKey(ctx: ExtensionContext, data: string): { consume?: boolean } | undefined {
  try {
    // [vinci] Modal overlays own terminal input before roster navigation.
    if (ctx.ui.isOverlayActive?.()) {
      navActive = false;
      setImmediate(update); // repaint after the modal has consumed the key
      return undefined;
    }
    if (viewerOpen) {
      if (matchesKey(data, "tab")) {
        activeViewerSwitch?.(1);
        return { consume: true };
      }
      if (matchesKey(data, "shift+tab")) {
        activeViewerSwitch?.(-1);
        return { consume: true };
      }
      return undefined; // the transcript overlay owns the rest of the keyboard
    }
    const active = activeHelpers();
    if (!active.length) {
      navActive = false;
      return undefined;
    }
    if (!navActive) {
      let empty = false;
      try {
        empty = (ctx.ui.getEditorText?.() ?? "").trim() === "";
      } catch {
        empty = false;
      }
      if (matchesKey(data, "down") && empty) {
        navActive = true;
        navIdx = 0;
        update();
        return { consume: true };
      }
      return undefined;
    }
    if (navIdx > active.length - 1) navIdx = active.length - 1;
    if (matchesKey(data, "up")) {
      // Stop at the first row rather than leaving nav. Exiting on ↑ made the top agent easy to
      // overshoot and impossible to come back to — a user reported never being able to select it.
      navIdx = Math.max(0, navIdx - 1);
      update();
      return { consume: true };
    }
    if (matchesKey(data, "down")) {
      navIdx = Math.min(active.length - 1, navIdx + 1);
      update();
      return { consume: true };
    }
    if (matchesKey(data, "escape") || matchesKey(data, "left")) {
      navActive = false;
      update();
      return { consume: true };
    }
    if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      const h = active[navIdx];
      navActive = false;
      update();
      if (h) void openHelper(ctx, h);
      return { consume: true };
    }
    // any other key: leave nav and let the keystroke through (so the user can just start typing)
    navActive = false;
    update();
    return undefined;
  } catch {
    return undefined;
  }
}

let tick: ReturnType<typeof setInterval> | undefined;
let failedExpiryTimer: ReturnType<typeof setTimeout> | undefined;
let failedExpiryTimerAt: number | undefined;

function clearFailedExpiryTimer(): void {
  if (failedExpiryTimer) clearTimeout(failedExpiryTimer);
  failedExpiryTimer = undefined;
  failedExpiryTimerAt = undefined;
}

function update(): void {
  const active = activeHelpers();
  if (!active.length) {
    navActive = false;
    navIdx = 0;
  } else if (navIdx > active.length - 1) {
    navIdx = active.length - 1;
  }
  try {
    const ui = uiRef?.ui;
    const lines = ui ? renderTree(ui.theme) : [];
    ui?.setWidget?.("vinci-crew", lines.length ? lines : undefined, { placement: "belowEditor" });
  } catch {
    /* session may be gone (e.g. switched/torn down) */
  }
  // A 1s heartbeat only while something is actively working, so elapsed ticks and the strip feels live.
  const working = helpers.some((h) => h.status === "working" || h.status === "verifying" || h.status === "reviewing");
  if (working && !tick) tick = setInterval(update, 1000);
  else if (!working && tick) {
    clearInterval(tick);
    tick = undefined;
  }
  if (working) {
    clearFailedExpiryTimer();
    return;
  }

  const now = Date.now();
  const failedTransitions = helpers
    .filter((h) => h.status === "failed" && h.finishedAt)
    .map((h) => {
      const fadeAt = (h.finishedAt as number) + 50_000;
      const hideAt = (h.finishedAt as number) + 60_001;
      if (now < fadeAt) return fadeAt;
      return now < hideAt ? hideAt : undefined;
    })
    .filter((expiry): expiry is number => expiry !== undefined);
  const nextTransition = failedTransitions.length ? Math.min(...failedTransitions) : undefined;
  if (nextTransition === undefined) {
    clearFailedExpiryTimer();
  } else if (failedExpiryTimerAt !== nextTransition) {
    clearFailedExpiryTimer();
    failedExpiryTimerAt = nextTransition;
    failedExpiryTimer = setTimeout(() => {
      failedExpiryTimer = undefined;
      failedExpiryTimerAt = undefined;
      update();
    }, Math.max(0, nextTransition - now));
    failedExpiryTimer.unref?.();
  }
}

/**
 * Record a crew auto-integration honestly against the shared verification state. Exported for tests.
 *
 * The helper's verifier only ever covered ITS patch on the tree as it stood at `baselineRevision`
 * (captured before verification/review began). If the main session recorded other mutations since
 * then, the apply is recorded as a MUTATION ONLY (stale — "patch applied, needs a fresh check");
 * recording the helper's verification too would retroactively bless unverified main edits as
 * "passed". Only when the revision is unchanged is the helper's passed check still a truthful
 * statement about the whole tree.
 */
/** One expression, one place (#187): does an agent patch's path list warrant a project check?
 *  Unknown/absent paths answer false — the fact stays unrecorded rather than guessed. */
export function crewPatchWarrantsCheck(paths?: readonly string[]): boolean {
  return Boolean(paths?.some((path) => vinciCheckWarrantedPath(path)));
}

export function recordCrewIntegrationOutcome(
  baselineRevision: number,
  verification: {
    command: string;
    summary: string;
    checkClass?: VinciVerificationClass;
    commandKey?: string;
    commandCwd?: string;
  },
  integratingCwd?: string,
  patchPaths?: readonly string[],
): { state: VinciVerificationState; mainEditedDuringIntegration: boolean } {
  const before = getVinciVerificationState();
  const mainEditedDuringIntegration =
    before.variant !== "normal" ||
    vinciVerificationMutationRevision(before) !== baselineRevision;
  // The warranted-fact follows the patch's own paths (#187): integrating a docs-only agent patch
  // must not make the session claim a check was warranted. Unknown paths stay unrecorded.
  recordVinciMutation("", crewPatchWarrantsCheck(patchPaths));
  if (!mainEditedDuringIntegration) {
    recordVinciVerification(
      verification.command,
      true,
      verification.summary,
      false,
      verification.checkClass ?? "static",
      verification.commandKey ?? verification.command,
      true,
      // A helper's proof is rebound to the integrating session's directory — a worktree path
      // would strand it (issue #135, ruling 5). No integrating cwd → fail closed to unbound
      // rather than leak the helper's private path into main-session identity.
      verification.commandCwd && integratingCwd ? integratingCwd : undefined,
    );
  }
  return { state: { ...getVinciVerificationState() }, mainEditedDuringIntegration };
}

/**
 * What the orchestrator is told the agent deviated on: the agent's own attested decisions, plus the
 * drift its scope guard observed (#179). The guard's notes are prefixed so nobody can mistake an
 * observation for the agent's own report, and they are never allowed to stand in for an attestation.
 */
function reportedDeviations(h: Pick<Helper, "deviations" | "attestation" | "scopeDrift">): string[] {
  return [
    ...(h.scopeDrift ?? []).map((note) => `Scope guard: ${note}`),
    ...(h.attestation === "attested" ? (h.deviations?.slice() ?? []) : []),
  ];
}

export function buildAgentResult(
  h: Pick<
    Helper,
    | "id"
    | "name"
    | "task"
    | "status"
    | "summary"
    | "reason"
    | "error"
    | "verification"
    | "diff"
    | "patchPaths"
    | "deviations"
    | "deferred"
    | "attestation"
    | "omitted"
    | "scopeDrift"
  >,
  patch?: Pick<CrewPatch, "paths">,
): AgentResult {
  const status: AgentResult["status"] =
    h.status === "done" || h.status === "integrated" || h.status === "waiting" || h.status === "blocked" || h.status === "failed"
      ? h.status
      : "failed";
  const reason = h.reason ?? h.error;
  return {
    agentId: h.id,
    name: h.name,
    task: h.task,
    status,
    summary: h.summary ?? "",
    filesChanged: patch?.paths.slice() ?? h.patchPaths?.slice() ?? derivePatchPaths(h.diff ?? ""),
    verification: h.verification ?? null,
    // Only an explicit "attested" counts. Anything else — a helper that never emitted the block, or
    // one restored from a pre-#5 session — is `missing`, and its arrays stay empty because an
    // unattested agent has said nothing about what it left undone. Guard-observed drift is added
    // beside them under its own label: it is an observation, not a claim, so it neither needs an
    // attestation nor grants one.
    deviations: reportedDeviations(h),
    deferred: h.attestation === "attested" ? (h.deferred?.map((entry) => ({ ...entry })) ?? []) : [],
    attestation: h.attestation === "attested" ? "attested" : "missing",
    omitted: h.attestation === "attested" ? { ...NO_OMISSION, ...h.omitted } : NO_OMISSION,
    ...(reason ? { reason } : {}),
  };
}

function decodeGitQuotedPath(value: string): string | undefined {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) return undefined;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index];
    if (character !== "\\") {
      bytes.push(...encoder.encode(character));
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined) return undefined;
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && index + 1 < value.length - 1 && /[0-7]/.test(value[index + 1])) octal += value[++index];
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
    const decoded = escapes[escaped];
    if (decoded === undefined) return undefined;
    bytes.push(decoded);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function gitPatchPath(value: string, prefix?: "a/" | "b/"): string | undefined {
  const decoded = decodeGitQuotedPath(value);
  if (decoded === undefined || decoded === "/dev/null") return undefined;
  if (prefix && !decoded.startsWith(prefix)) return undefined;
  return prefix ? decoded.slice(prefix.length) : decoded;
}

function gitHeaderTarget(header: string): string | undefined {
  if (header.startsWith('"')) {
    const separator = header.indexOf('" "', 1);
    return separator === -1 ? undefined : gitPatchPath(header.slice(separator + 2), "b/");
  }
  const separators: number[] = [];
  for (let index = header.indexOf(" b/"); index !== -1; index = header.indexOf(" b/", index + 1)) separators.push(index);
  for (const separator of separators) {
    const source = gitPatchPath(header.slice(0, separator), "a/");
    const target = gitPatchPath(header.slice(separator + 1), "b/");
    if (source !== undefined && source === target) return target;
  }
  return separators.length === 1 ? gitPatchPath(header.slice(separators[0] + 1), "b/") : undefined;
}

function derivePatchPaths(diff: string): string[] {
  if (!diff.trim()) return [];
  if (diff.startsWith("VINCI_TEMP_COPY_PATCH_V1\n")) {
    try {
      const payload = JSON.parse(diff.slice("VINCI_TEMP_COPY_PATCH_V1\n".length)) as { changes?: unknown };
      if (!Array.isArray(payload.changes)) return [];
      const paths = payload.changes.flatMap((change) =>
        change && typeof change === "object" && "path" in change && typeof change.path === "string" ? [change.path] : [],
      );
      return [...new Set(paths)].sort();
    } catch {
      return [];
    }
  }

  const paths = new Set<string>();
  let deletedSource: string | undefined;
  let headerTarget: string | undefined;
  let blockHasExplicitPath = false;
  const finishBlock = () => {
    if (!blockHasExplicitPath && headerTarget !== undefined) paths.add(headerTarget);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finishBlock();
      deletedSource = undefined;
      headerTarget = gitHeaderTarget(line.slice("diff --git ".length));
      blockHasExplicitPath = false;
      continue;
    }
    if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      const path = gitPatchPath(line.slice(line.indexOf(" to ") + 4));
      if (path !== undefined) {
        paths.add(path);
        blockHasExplicitPath = true;
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      deletedSource = gitPatchPath(line.slice(4), "a/");
      continue;
    }
    if (!line.startsWith("+++ ")) continue;
    const target = gitPatchPath(line.slice(4), "b/");
    if (target !== undefined) {
      paths.add(target);
      blockHasExplicitPath = true;
    } else if (line.slice(4) === "/dev/null" && deletedSource !== undefined) {
      paths.add(deletedSource);
      blockHasExplicitPath = true;
    }
  }
  finishBlock();
  return [...paths].sort();
}

function formatAgentResult(result: AgentResult): string {
  const safeResult: AgentResult = {
    agentId: result.agentId,
    name: sanitizeLine(result.name),
    task: sanitizeLine(result.task),
    status: result.status,
    summary: sanitizeLine(result.summary),
    filesChanged: result.filesChanged.map(sanitizeLine),
    verification: result.verification
      ? {
          command: sanitizeLine(result.verification.command),
          summary: sanitizeLine(result.verification.summary),
          mutationRevision: result.verification.mutationRevision,
          verifiedRevision: result.verification.verifiedRevision,
          checkClass: result.verification.checkClass ?? "static",
          commandKey: sanitizeLine(result.verification.commandKey ?? result.verification.command),
          ...(result.verification.commandCwd
            ? { commandCwd: sanitizeLine(result.verification.commandCwd) }
            : {}),
        }
      : null,
    // Defensive against a result persisted BEFORE #5: those carry no honesty fields at all, and
    // reading them unguarded threw inside finalizeHelper's best-effort try/catch — so the agent's
    // result was silently NEVER DELIVERED to the orchestrator. Fail open to `missing`, never crash.
    deviations: (result.deviations ?? []).map(sanitizeLine),
    deferred: (result.deferred ?? []).map((entry) => ({ item: sanitizeLine(entry.item), reason: sanitizeLine(entry.reason) })),
    attestation: result.attestation ?? "missing",
    omitted: { ...NO_OMISSION, ...result.omitted },
    ...(result.reason ? { reason: sanitizeLine(result.reason) } : {}),
  };
  const files = safeResult.filesChanged.join(", ");
  const approvalRequired = safeResult.status === "waiting" || (safeResult.status === "blocked" && safeResult.filesChanged.length > 0);
  const guidance = approvalRequired
    ? `The agent finished and its work is saved. Files affected: ${files}. Use use_agent_work with agent_id ${safeResult.agentId} to take this work into the project. If the tool says the work affects sensitive project setup, ask the user in plain language, then call it again with user_approved set to true. If it says files changed after the agent started, tell the user which files changed and ask how to resolve them before retrying. DO NOT redo this work.`
    : safeResult.status === "done" && safeResult.filesChanged.length === 0
      ? "The agent finished. It made no file changes."
      : `The agent finished.${files ? ` Files affected: ${files}.` : ""}`;
  // The whole point of #5 is that these two cannot be read past. State them as instructions, not as
  // fields the orchestrator may skim: "deliberately left" must never be summarised to the user as
  // done, and an agent that never attested must not be reported as if it had said "nothing left".
  const deferredGuidance = safeResult.deferred.length
    ? ` This agent deliberately left work undone: ${safeResult.deferred
        .map((entry) => `${entry.item} (${entry.reason})`)
        .join("; ")}. That work is NOT done — tell the user it remains, and do not describe this task as complete without it.`
    : "";
  const omittedTotal = safeResult.omitted.deviations + safeResult.omitted.deferred;
  const omittedGuidance = omittedTotal
    ? ` The agent reported MORE than could be carried: ${safeResult.omitted.deferred} further deferred item(s) and ${safeResult.omitted.deviations} further deviation(s) are NOT shown, so this list is incomplete — do not treat it as the full picture.`
    : "";
  const attestationGuidance =
    safeResult.attestation === "missing"
      ? " This agent did not report what it deviated on or deliberately left undone, so treat its scope as UNCONFIRMED: do not state that nothing was left over, and check its work before relying on it being complete."
      : "";
  return (
    `[Agent result]\n${JSON.stringify(safeResult, null, 2)}\n\n${guidance}${deferredGuidance}${omittedGuidance}${attestationGuidance} ${ORCHESTRATOR_DISMISS_GUIDANCE} ` +
    "When speaking to the user, use everyday language; do not mention internal states such as waiting or blocked, " +
    "or implementation terms such as patch or diff. Briefly tell the user what this agent did, then continue any " +
    "unfinished parts of the original task."
  );
}

export function finalizeHelper(pi: ExtensionAPI, h: Helper, reason?: string): void {
  if (!isTerminalStatus(h.status)) return;
  h.reason ??= reason;
  h.finishedAt ??= Date.now();
  h.result ??= buildAgentResult(h);

  if (!h.notifiedAt) {
    // The .ui getter is assertActive-guarded like every ctx property; after a session replacement
    // or reload a stale uiRef throws here. Same treatment as update(): no UI beats a crash (#191).
    let ui: ExtensionContext["ui"] | undefined;
    try {
      ui = uiRef?.ui;
    } catch {
      ui = undefined;
    }
    if (ui) {
      try {
        const safeName = sanitizeLine(h.name);
        const safeReason = sanitizeLine(h.reason ?? h.error ?? "unknown");
        if (h.status === "integrated" || h.status === "done" || h.status === "waiting") {
          const notification =
            h.status === "integrated"
              ? "Its changes were checked and added to your project automatically."
              : h.status === "waiting"
                ? "Its changes need your approval before I can use them."
                : h.diff?.trim()
                  ? "Its file changes are complete."
                  : "It made no file changes.";
          ui.notify(`Agent "${safeName}" finished. ${notification}`, h.status === "waiting" ? "warning" : "info");
        } else {
          ui.notify(`Agent "${safeName}" couldn't finish: ${safeReason}.`, "error");
        }
        h.notifiedAt = Date.now();
      } catch {
        /* out-of-turn notification is best-effort and retried after restore */
      }
    }
  }

  if (!h.deliveredAt) {
    try {
      pi.sendMessage<AgentResult>(
        { customType: "vinci-crew-result", content: formatAgentResult(h.result), display: false, details: h.result },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      h.deliveredAt = Date.now();
    } catch {
      /* out-of-turn delivery is best-effort and retried after restore */
    }
  }

  persistHelper(pi, h);
  update();
}

async function qualifyAndIntegrate(pi: ExtensionAPI, ctx: ExtensionContext, h: Helper, patch: CrewPatch): Promise<void> {
  if (!patch.diff.trim()) {
    setStatus(pi, h, "done");
    return;
  }
  savePatch(ctx, h, patch);
  persistHelper(pi, h);
  if (!h.verification) {
    setStatus(pi, h, "waiting", "The agent did not leave a current passed verifier check.");
    return;
  }
  if (vinciMaskSecrets(patch.diff) !== patch.diff) {
    setStatus(pi, h, "waiting", "The patch contains secret-looking material and cannot be reviewed or auto-applied.");
    return;
  }
  if (isConsequentialCrewPatch(patch)) {
    setStatus(pi, h, "waiting", "Deletes, dependencies, infrastructure, and configuration changes require user approval.");
    return;
  }
  if (!crewPathsUnchanged(ctx.cwd, patch)) {
    setStatus(pi, h, "waiting", "The same main-worktree paths changed after this agent started.");
    return;
  }

  // Snapshot the main session's mutation revision BEFORE integration begins. Verification and the
  // LLM review below take seconds-to-minutes while the main agent keeps editing; the helper's check
  // only ever covered its own patch, so if the revision moves before we apply, blessing the current
  // tree as verified would retroactively mark unrelated, unverified main edits as "passed".
  const baselineRevision = getVinciVerificationState().mutationRevision;

  setStatus(pi, h, "verifying");
  const validation = createCrewWorktree(ctx.cwd, `validation-${h.id}`, `${RUN_TAG}-${Date.now().toString(36)}`);
  let check: { passed: boolean; output: string };
  try {
    applyCrewPatch(validation.cwd, patch.diff);
    check = runCrewVerifier(validation, h.verification.command);
  } finally {
    removeCrewWorktree(ctx.cwd, validation);
  }
  if (!check.passed) {
    setStatus(pi, h, "waiting", `The agent's exact verifier failed during integration: ${check.output.slice(0, 240)}`);
    return;
  }

  setStatus(pi, h, "reviewing");
  if (!ctx.model) {
    setStatus(pi, h, "waiting", "No active model was available for independent review.");
    return;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    setStatus(pi, h, "waiting", "Independent review could not authenticate.");
    return;
  }
  h.review = await runReview(
    ctx.model,
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      onUsage: (response) =>
        recordVinciTaskCall(ctx.sessionManager.getSessionId(), response, "crew:integration-review"),
    },
    h.task,
    patch.diff,
    verificationEvidence(h.verification),
  );
  if (parseGraderVerdict(h.review) !== "ships") {
    setStatus(pi, h, "waiting", "Independent review did not return a ships verdict.");
    return;
  }
  if (!crewPathsUnchanged(ctx.cwd, patch)) {
    setStatus(pi, h, "waiting", "The same main-worktree paths changed while the agent was being reviewed.");
    return;
  }

  // crewPathsUnchanged above only re-checks the PATCH's own paths — the main session may have
  // edited OTHER files during the review. recordCrewIntegrationOutcome compares against the
  // pre-integration revision and records a mutation-only (stale) state in that case.
  applyCrewPatch(ctx.cwd, patch.diff);
  h.applied = true;
  const outcome = recordCrewIntegrationOutcome(baselineRevision, h.verification, ctx.cwd, patch.paths);
  pi.appendEntry(VINCI_VERIFICATION_ENTRY, outcome.state);
  setStatus(
    pi,
    h,
    "integrated",
    outcome.mainEditedDuringIntegration
      ? "Applied, but the main session made other edits during review — the combined tree needs a fresh verification."
      : undefined,
  );
}

export async function accountHelperUsage(
  client: Pick<RpcClient, "getEntries" | "getMessages">,
  ctx: Pick<ExtensionContext, "sessionManager">,
  h: Helper,
): Promise<void> {
  if (h.usageAccounted) return;
  const outcomeLookup = await readLatestVinciTaskOutcomeUsage(() => client.getEntries());
  if (!outcomeLookup.entriesRead) {
    console.warn(
      `[Vinci Crew] Unable to account child usage for agent ${h.id} after 3 retry attempts to read its entries.`,
    );
    return;
  }
  let usage = outcomeLookup.usage;
  if (!usage) {
    try {
      usage = summarizeVinciTaskUsage(await client.getMessages());
    } catch {
      console.warn(
        `[Vinci Crew] Unable to account child usage for agent ${h.id}: its messages could not be read.`,
      );
      return;
    }
  }
  if (usage.modelCalls === 0) {
    console.warn(
      `[Vinci Crew] Unable to account child usage for agent ${h.id}: no attributable model calls were found.`,
    );
    return;
  }
  const childUsage = {
    ...usage,
    providers: usage.providers.slice(),
    models: usage.models.slice(),
  };
  const taskId = ctx.sessionManager.getSessionId();
  const recorded = recordVinciTaskUsage(taskId, childUsage, {
    id: `crew:${taskId}:${h.childSession ?? h.id}`,
    source: "crew:child-session",
  });
  if (!recorded) {
    console.warn(
      `[Vinci Crew] Unable to account child usage for agent ${h.id}: recording for task "${taskId}" failed.`,
    );
    return;
  }
  h.childUsage = childUsage;
  h.usageAccounted = true;
}

// --- run one helper to completion in its own process + worktree, then qualify its patch ---
// Exported for integration coverage (like accountHelperUsage): #191 pins that teardown never
// dereferences ctx after entry, which needs to drive this function directly with a stale ctx.
export async function runHelper(pi: ExtensionAPI, ctx: ExtensionContext, h: Helper): Promise<void> {
  // [#191] Captured as a PLAIN VALUE before any await. A helper runs for minutes; if the main
  // session is replaced or reloaded meanwhile, every later `ctx.cwd` read throws "stale ctx" —
  // and the one in `finally` crashed the whole process AFTER the helper's work had integrated
  // (observed live on 0.0.44: 13 minutes of correct work ending in a stack dump, plus a leaked
  // worktree because the throw skipped cleanup). Teardown must never dereference ctx: the
  // sessionManager getter carries the same assertActive guard as cwd, so usage accounting and
  // partial-patch salvage capture it up front too (the manager object itself is not guarded).
  const cwd = ctx.cwd;
  const sessionManager = ctx.sessionManager;
  h.startedAt = Date.now();
  h.messagedDuringRun = false;
  setStatus(pi, h, "working");
  const { cliPath, args: baseArgs } = childLaunch();
  // Fork an earlier agent's conversation into this new worktree. `--session` cannot be used here:
  // the source session records the old helper worktree as its cwd, and that worktree was removed
  // after completion, so non-interactive startup rejects it before RPC mode can begin.
  const args = h.forkSession ? [...baseArgs, "--fork", h.forkSession] : baseArgs;
  let client: RpcClient | undefined;
  let worktree: CrewWorktree | undefined;
  let patch: CrewPatch | undefined;
  try {
    if (!h.provider || !h.model) throw new Error("Crew requires an active main model.");
    worktree = createCrewWorktree(cwd, String(h.id), RUN_TAG);
    h.worktree = worktree;
    // Replay the earlier agent's unapplied work into the fresh worktree. If this fails the agent
    // would silently resume without its own changes and quietly redo them, so fail the run instead
    // of pretending: the original patch is untouched and still reviewable in /agents.
    if (h.replayDiffPath) {
      try {
        const replay = readFileSync(h.replayDiffPath, "utf8");
        if (replay.trim()) applyCrewPatch(worktree.cwd, replay);
      } catch (e) {
        throw new Error(
          `Couldn't put the earlier work back before continuing (${e instanceof Error ? e.message : String(e)}). ` +
            `The project has probably changed underneath it. The original work is untouched — review it in /agents.`,
        );
      }
    }
    if (worktree.kind === "temp-copy") {
      h.patchMetadata = {
        kind: "temp-copy",
        paths: Object.keys(worktree.baselineFingerprints).sort(),
        deletedPaths: [],
        baselineFingerprints: { ...worktree.baselineFingerprints },
        ignorePatterns: worktree.ignorePatterns.slice(),
      };
      persistHelper(pi, h);
    }
    client = new RpcClient({
      cliPath,
      cwd: worktree.cwd,
      provider: h.provider,
      model: h.model,
      args,
      // The helper must be able to tell that its own UI prompts have no answerer: crew handles no
      // `extension_ui_request`, and RPC mode makes ctx.hasUI true anyway (#185). Nothing else can
      // tell it — this marker is the only side of the boundary that knows.
      env: { VINCI_CODE: "1", PI_OFFLINE: "1", [VINCI_CREW_HELPER_ENV]: "1" },
    });
    await client.start();
    h.client = client; // expose the live handle so a helper can be watched while it works
    h.liveTranscript = [];
    h.livePartial = undefined;
    h.livePartialKinds = undefined;
    h.streaming = false;
    h.unsubscribeEvents = client.onEvent((event) => reduceHelperEvent(h, event));
    try {
      await client.setSessionName(`agent: ${h.name}`);
    } catch {
      /* non-fatal */
    }
    try {
      h.childSession = (await client.getState()).sessionFile;
    } catch {
      /* the helper can still run without session metadata */
    }
    await client.promptAndWait(HELPER_PROMPT(h.task), undefined, HELPER_TIMEOUT_MS);
    if (h.messagedDuringRun && !(await waitForSteeredHelperIdle(client, HELPER_TIMEOUT_MS))) {
      setStatus(pi, h, "blocked", "The agent was still working after your message and didn't finish in time.");
      finalizeHelper(pi, h);
      return;
    }
    try {
      h.tokens = (await client.getSessionStats()).tokens.total;
    } catch {
      /* preserve usage observed from live events */
    }
    await accountHelperUsage(client, { sessionManager }, h);
    const assistantText = (await client.getLastAssistantText()) ?? "";
    try {
      // capture BEFORE stop() below. The raw handoff block is stripped here too: the viewer prefers
      // the transcript over the summary, so leaving it in rendered the attestation twice — once as
      // raw JSON and again as the typed footer.
      captureHelperHandoff(h, await client.getMessages(), assistantText);
    } catch {
      captureHelperHandoff(h, undefined, assistantText);
    }
    try {
      // One read, two records: the verifier's proof, and whatever the agent's own scope guard
      // observed drifting while nobody could be asked about it (#179).
      const { entries } = await client.getEntries();
      h.verification = verificationProof(entries);
      const drift = scanVinciScopeDriftEntries(entries);
      h.scopeDrift = drift.length ? drift : undefined;
    } catch {
      /* missing verifier evidence makes the result wait below */
    }
    patch = captureCrewPatch(worktree);
    await qualifyAndIntegrate(pi, ctx, h, patch);
    h.result = buildAgentResult(h, patch);
  } catch (e) {
    h.error = e instanceof Error ? e.message : String(e);
    // The child can die mid-run — killed, OOM, crashed — and `promptAndWait` above rejects. Whatever
    // it had already edited exists ONLY inside the private worktree, and the `finally` below removes
    // that worktree. So the partial patch has to be captured here or the work is gone for good.
    // The graceful-shutdown path has always done this; this path did not, and silently discarded it.
    if (!h.diff?.trim() && worktree) {
      try {
        const partial = captureCrewPatch(worktree);
        if (partial.diff.trim()) savePatch({ sessionManager }, h, partial);
      } catch {
        /* nothing salvageable — the failed status below reports the loss rather than hiding it */
      }
    }
    if (h.diff?.trim()) {
      setStatus(pi, h, "waiting", `The agent stopped before finishing (${h.error}) — the work it had already done is preserved for review.`);
    } else {
      setStatus(pi, h, "failed", h.error);
    }
    finalizeHelper(pi, h);
  } finally {
    try {
      h.unsubscribeEvents?.();
    } catch {
      /* ignore */
    }
    h.unsubscribeEvents = undefined;
    try {
      h.unsubscribeLive?.();
    } catch {
      /* ignore */
    }
    h.unsubscribeLive = undefined;
    h.viewerRepaint = undefined;
    h.streaming = false;
    h.client = undefined; // no more live watching once it's stopping
    try {
      if (client) h.tokens = (await client.getSessionStats()).tokens.total;
    } catch {
      /* preserve usage observed from live events */
    }
    if (client) await accountHelperUsage(client, { sessionManager }, h);
    try {
      await client?.stop();
    } catch {
      /* ignore */
    }
    if (worktree) removeCrewWorktree(cwd, worktree);
    h.worktree = undefined; // torn down — nothing left for shutdown to clean
    h.finishedAt ??= Date.now();
    h.result ??= buildAgentResult(h, patch);
    persistHelper(pi, h);
  }
  finalizeHelper(pi, h);
}

function pump(pi: ExtensionAPI, ctx: ExtensionContext): void {
  while (running < capacity() && queue.length) {
    const h = queue.shift();
    if (!h) break;
    running += 1;
    void runHelper(pi, ctx, h)
      .catch((e: unknown) => {
        // The ctx can go stale while a helper sits in the queue (session replaced) — runHelper's
        // entry captures then throw before any teardown exists. Backstop so a rejected run is
        // recorded as a failure instead of dying as an unhandled rejection (#191).
        h.error ??= e instanceof Error ? e.message : String(e);
        if (!isTerminalStatus(h.status)) h.status = "failed";
        persistHelper(pi, h);
      })
      .finally(() => {
        running -= 1;
        pump(pi, ctx);
      });
  }
  if (running === 0 && queue.length === 0) {
    for (const resolve of crewIdleWaiters.splice(0)) resolve();
  }
  update();
}


/**
 * Wait for all running and queued helpers to reach idle state.
 * Used in print/json mode so a one-shot run doesn't silently destroy in-flight agent work.
 *
 * The timeout is not optional. Without it a single wedged helper (hung child, provider stall)
 * never resolves, `session_shutdown` never returns, and `--print` hangs forever — worse than the
 * dropped work it replaces, because scripted and CI callers have no way out. On expiry we fall
 * through to the normal teardown below, which still preserves each helper's transcript and patch.
 */
const CREW_IDLE_WAIT_MS = Number(process.env.VINCI_CREW_IDLE_WAIT_MS ?? 120_000);

function waitForCrewIdle(timeoutMs = CREW_IDLE_WAIT_MS): Promise<void> {
  if (running === 0 && queue.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    // Don't let a pending wait hold the event loop open on its own.
    timer.unref?.();
    crewIdleWaiters.push(finish);
  });
}

function applyDiff(cwd: string, diff: string): { ok: boolean; msg: string } {
  if (!diff.trim()) return { ok: false, msg: "no changes to apply" };
  try {
    applyCrewPatch(cwd, diff);
    return { ok: true, msg: "applied" };
  } catch (e) {
    return { ok: false, msg: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

export default function (pi: ExtensionAPI) {
  installVinciUsageAccumulator(pi);
  let offInput: (() => void) | undefined;
  pi.on("session_start", async (_e, ctx) => {
    activeViewerClose = undefined;
    activeViewerSwitch = undefined;
    viewerOpen = false;
    for (const helper of helpers) {
      helper.viewerRepaint = undefined;
      try {
        helper.unsubscribeEvents?.();
      } catch {
        /* ignore */
      }
      helper.unsubscribeEvents = undefined;
      try {
        helper.unsubscribeLive?.();
      } catch {
        /* ignore */
      }
      helper.unsubscribeLive = undefined;
    }
    uiRef = ctx;
    try {
      sweepStaleTempCopies();
    } catch {
      /* stale temp-copy cleanup must never block session startup */
    }
    restoreHelpers(pi, ctx);
    try {
      offInput?.();
      offInput = ctx.ui.onTerminalInput?.((data) => handleNavKey(ctx, data));
    } catch {
      /* non-tui contexts have no terminal input */
    }
    update();
  });
  pi.on("agent_start", async (_e, ctx) => {
    uiRef = ctx;
  });
  // [#194] One-shot modes fire this after the last submitted turn, BEFORE deciding the exit code.
  // Helpers run for minutes after the main turn ends; without this wait the old flow exited 0 with
  // a DONE "read-only" outcome while session_shutdown (which runs after the exit decision) stopped
  // them unfinished. Waiting here lets each finishing agent's result trigger its follow-up turn,
  // so the orchestrator applies the work and the receipt re-classifies with everything resolved.
  pi.on("session_before_exit", async (_e, ctx) => {
    uiRef = ctx;
    // Overridable for tests only: driving this handler against a deliberately-hung helper must not
    // take the full production budget. The default covers one whole helper run plus grace.
    const budget = Number(process.env.VINCI_CREW_BEFORE_EXIT_WAIT_MS ?? HELPER_TIMEOUT_MS + 60_000);
    const deadline = Date.now() + budget;
    while ((running > 0 || queue.length > 0) && Date.now() < deadline) {
      const names = helpers
        .filter((h) => ACTIVE_STATUSES.includes(h.status))
        .map((h) => sanitizeLine(h.name))
        .slice(0, 6)
        .join(", ");
      // Progress on stderr, never stdout: print-mode stdout is the answer channel. A long quiet
      // wait must not look like a wedge (#138's lesson applied here).
      console.error(`[vinci-crew] Waiting for background agents to finish: ${names || "(queued)"}`);
      await waitForCrewIdle(Math.max(1, Math.min(30_000, deadline - Date.now())));
    }
    publishCrewStatus();
    if (running > 0 || queue.length > 0) {
      // Past the per-helper budget and still busy: the run cannot honestly claim success. The
      // receipt's crew consult reports the unresolved work; the hint pins the exit code even if
      // no further outcome is written.
      console.error("[vinci-crew] Background agents did not finish in time; this run exits as unresolved.");
      ctx.declareHeadlessExitHint?.(3);
    }
  });
  pi.on("session_shutdown", async () => {
    try {
      activeViewerClose?.();
    } catch {
      /* a stale viewer must not block session teardown */
    }
    activeViewerClose = undefined;
    activeViewerSwitch = undefined;
    viewerOpen = false;
    if (tick) {
      clearInterval(tick);
      tick = undefined;
    }
    clearFailedExpiryTimer();
    navActive = false;
    try {
      offInput?.();
    } catch {
      /* ignore */
    }
    offInput = undefined;
    // Preserve a bounded transcript and partial patch before tearing down any in-flight helper.
    const context = uiRef;
    // [#193] Same failure class as #191, one handler over: every `context` getter carries the
    // runner's assertActive guard, and this teardown runs exactly when a session replacement can
    // have staled uiRef. A throw past this point is swallowed by the allSettled below — which
    // turned missed cleanup into a SILENT worktree leak. Capture plain values up front; if even
    // the entry reads are stale, cleanup proceeds with what the helper itself knows.
    let mode: string | undefined;
    let cwd: string | undefined;
    let sessionManager: ExtensionContext["sessionManager"] | undefined;
    try {
      mode = context?.mode;
      cwd = context?.cwd;
      sessionManager = context?.sessionManager;
    } catch {
      /* session replaced — teardown continues on fallback values below */
    }
    // In print/json mode, wait for all agents to complete before shutting down.
    if (mode === "print" || mode === "json") await waitForCrewIdle();
    // Queued helpers have neither a client nor a worktree, but they were REQUESTED work: skipping
    // them here left their record saying "queued" forever — no terminal status, no result, no
    // disclosure that the session ended before they could start (#194).
    const inflight = helpers.filter((h) => h.client || h.worktree || h.status === "queued");
    await Promise.allSettled(
      inflight.map(async (h) => {
        if (!h.client && !h.worktree) {
          // Also leave the queue: a finalized helper still sitting there would keep
          // waitForCrewIdle reporting pending work forever.
          const queued = queue.indexOf(h);
          if (queued >= 0) queue.splice(queued, 1);
          h.stoppedUnfinished = true;
          h.status = "blocked";
          finalizeHelper(pi, h, "The session ended before this queued agent could start.");
          return;
        }
        const client = h.client;
        try {
          h.unsubscribeEvents?.();
        } catch {
          /* ignore */
        }
        h.unsubscribeEvents = undefined;
        try {
          h.unsubscribeLive?.();
        } catch {
          /* ignore */
        }
        h.unsubscribeLive = undefined;
        h.viewerRepaint = undefined;
        h.streaming = false;
        if (client) {
          try {
            captureHelperHandoff(h, await client.getMessages());
            const { entries } = await client.getEntries();
            h.verification = verificationProof(entries);
            const drift = scanVinciScopeDriftEntries(entries);
            h.scopeDrift = drift.length ? drift : undefined;
          } catch {
            /* preserve whatever was already captured */
          }
          if (sessionManager) await accountHelperUsage(client, { sessionManager }, h);
          try {
            h.tokens = (await client.getSessionStats()).tokens.total;
          } catch {
            /* preserve usage observed from live events */
          }
        }
        h.client = undefined;
        if (client?.stop) {
          try {
            await Promise.race([client.stop(), new Promise((r) => setTimeout(r, 1500))]);
          } catch {
            /* best-effort */
          }
        }
        if (h.worktree) {
          try {
            const patch = captureCrewPatch(h.worktree);
            // Salvage needs somewhere to write; with the session gone there is no session dir, and
            // the loss is reported honestly by the blocked status below rather than hidden.
            if (patch.diff.trim() && sessionManager) savePatch({ sessionManager }, h, patch);
          } catch {
            /* a missing partial patch is recorded as blocked below */
          }
          // Fallback for a stale entry read: the worktree's own cwd. `git worktree remove` may
          // refuse to run from inside the tree being removed, but removeCrewWorktree then falls
          // back to rmSync — the directory is reclaimed either way, which beats leaking it.
          removeCrewWorktree(cwd ?? h.worktree.cwd, h.worktree);
          h.worktree = undefined;
        }
        if (!isTerminalStatus(h.status)) {
          if (!h.diff?.trim()) h.stoppedUnfinished = true;
          h.status = h.diff?.trim() ? "waiting" : "blocked";
        }
        finalizeHelper(
          pi,
          h,
          h.diff?.trim()
            ? "The session stopped this agent; its partial patch was preserved for review."
            : "The session stopped this agent before it produced a patch.",
        );
      }),
    );
    publishCrewStatus();
    clearFailedExpiryTimer();
  });

  pi.registerTool({
    name: "continue_agent",
    label: "Continue agent",
    description:
      "Pick up a finished agent's work where it left off, keeping the conversation it already had. Use this " +
      "when the user wants more from an agent that has already reported back — a fix, a follow-up, another " +
      "pass — rather than starting a fresh agent that would have to work it all out again.",
    promptSnippet: "Continue a finished background agent instead of starting a new one.",
    promptGuidelines: [
      "Omit agent_id when the user's reference is ambiguous and more than one finished agent could be meant — " +
        "Vinci will ask which one. Never guess an id.",
      "The continued agent sees the project as it stands NOW. If its earlier work is still waiting for review, " +
        "that work is put back first, so it never has to redo it.",
    ],
    parameters: Type.Object({
      agent_id: Type.Optional(
        Type.Number({ description: "The numeric id of the finished agent. Omit it if the user didn't clearly identify one." }),
      ),
      instruction: Type.String({
        description: "What to do next, in one or two sentences.",
        minLength: 1,
        pattern: "\\S",
      }),
    }),
    async execute(
      _id,
      params: { agent_id?: number; instruction: string },
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      uiRef = ctx;
      const details = { tool: "continue_agent" };
      if (!ctx.model) {
        return { content: [{ type: "text", text: "BLOCKED: Crew needs an active Vinci model before it can continue an agent." }], details };
      }
      const instruction = params.instruction.trim();
      if (!instruction) return { content: [{ type: "text", text: "Say what the agent should do next." }], details };

      const target = await resolveAgentTarget(
        ctx,
        helpers,
        params.agent_id,
        // Only an agent that finished and left a conversation can be resumed: without its session
        // there is nothing to continue, and a still-working agent should be messaged, not restarted.
        (candidate) => isTerminalStatus(candidate.status) && Boolean(candidate.childSession),
        "Which agent should keep going?",
        "No finished agent can be continued yet.",
      );
      if ("error" in target) return { content: [{ type: "text", text: target.error }], details };

      const previous = target.helper;
      if (!previous.childSession) {
        return {
          content: [{ type: "text", text: `Agent "${sanitizeLine(previous.name)}" has no saved conversation to continue.` }],
          details,
        };
      }

      const queued = running >= capacity();
      const id = nextId++;
      const h: Helper = {
        id,
        name: previous.name,
        task: instruction,
        status: "queued",
        provider: ctx.model.provider,
        model: ctx.model.id,
        tokens: 0,
        forkSession: previous.childSession,
        // Applied work is already in the project, so replaying it would conflict with itself.
        // Dismissed work was explicitly rejected — putting it back would undo the user's decision.
        replayDiffPath: continuationPatchPath(previous),
        continuedFrom: previous.id,
      };
      helpers.push(h);
      queue.push(h);
      persistHelper(pi, h);
      pump(pi, ctx);

      const carried = h.replayDiffPath ? " Its earlier work goes back in first, so it won't redo it." : "";
      const spot = queued ? " (capacity-queued — it'll start when a slot frees up)" : "";
      return {
        content: [
          {
            type: "text",
            text:
              `Agent "${sanitizeLine(h.name)}" is picking that up where it left off${spot}.${carried} It works from the ` +
              `project as it stands now. Do NOT stop or wait for it — keep doing the REST of what the user asked ` +
              `YOURSELF. You'll be told when it finishes. ${ORCHESTRATOR_DISMISS_GUIDANCE}`,
          },
        ],
        details: { ...details, agentId: h.id, continuedFrom: previous.id },
      };
    },
  });

  pi.registerTool({
    name: "spawn_helper",
    label: "Agent",
    description:
      "Hand a focused, self-contained sub-task to a background AGENT — another Vinci that works on it " +
      "in its own isolated copy of the project while you keep going. Use it to parallelise INDEPENDENT " +
      "pieces of a bigger job (e.g. 'write tests for the parser', 'draft the README', 'refactor auth.ts'). " +
      "Give a short name and a clear, standalone task with enough context to do it without you. It runs in " +
      "the background and reports back to you. You own taking its finished work into the project with " +
      "use_agent_work; involve the user only when that tool asks for a decision. Don't use it for trivial " +
      `one-step edits (just do those yourself) or for pieces that depend on each other. ${ORCHESTRATOR_DISMISS_GUIDANCE}`,
    promptSnippet: "Delegate an independent sub-task to a background agent.",
    parameters: Type.Object({
      name: Type.String({ description: "A short 1-3 word label, e.g. 'tests' or 'readme'." }),
      task: Type.String({ description: "The full, self-contained task for the agent — what to do and any context it needs." }),
    }),
    async execute(_id, params: { name: string; task: string }, _signal, _onUpdate, ctx: ExtensionContext) {
      uiRef = ctx;
      if (!ctx.model) {
        return {
          content: [{ type: "text", text: "BLOCKED: Crew needs an active Vinci model before it can start an agent." }],
          details: { tool: "spawn_helper", state: "blocked" },
        };
      }
      const queued = running >= capacity();
      const id = nextId++;
      const h: Helper = {
        id,
        name: params.name.trim() || `agent-${id}`,
        task: params.task.trim(),
        status: "queued",
        provider: ctx.model.provider,
        model: ctx.model.id,
        tokens: 0,
      };
      helpers.push(h);
      queue.push(h);
      persistHelper(pi, h);
      pump(pi, ctx);
      const spot = queued ? " (capacity-queued — it'll start when a slot frees up)" : "";
      return {
        content: [
          {
            type: "text",
            text:
              `Agent "${sanitizeLine(h.name)}" is now working on that in the background${spot}. Do NOT stop or wait for it — ` +
              `right now, keep doing the REST of what the user asked YOURSELF (the parts you didn't hand to the agent). ` +
              `You'll be told when the agent finishes. You own taking its work into the project with use_agent_work; if that ` +
              `tool asks for a user decision, ask in plain language and then continue. Do not redo work the agent completed. ` +
              ORCHESTRATOR_DISMISS_GUIDANCE,
          },
        ],
        details: { tool: "spawn_helper" },
      };
    },
  });

  pi.registerTool({
    name: "message_agent",
    label: "Message agent",
    description: "Send a short steering message to an agent that is currently running.",
    promptSnippet: "Message a running background agent.",
    promptGuidelines: [
      "Omit agent_id when the user's reference is ambiguous (\"that agent\", \"the one doing X\") and more than " +
        "one agent is running — Vinci will ask them which one. Never guess an id.",
    ],
    parameters: Type.Object({
      agent_id: Type.Optional(
        Type.Number({ description: "The numeric id of the running agent. Omit it if the user didn't clearly identify one." }),
      ),
      message: Type.String({
        description: "The non-empty instruction to send to the agent.",
        minLength: 1,
        maxLength: MAX_AGENT_MESSAGE_LENGTH,
        pattern: "\\S",
      }),
    }),
    async execute(_id, params: { agent_id?: number; message: string }, _signal, _onUpdate, ctx: ExtensionContext) {
      uiRef = ctx;
      const target = await resolveAgentTarget(
        ctx,
        helpers,
        params.agent_id,
        (candidate) => candidate.status === "working" && Boolean(candidate.client),
        "Which agent do you want to message?",
        "No agent is running right now, so there's nothing to message.",
      );
      if ("error" in target) {
        return { content: [{ type: "text", text: target.error }], details: { tool: "message_agent", sent: false } };
      }
      const result = await messageRunningAgent(target.helper, params.message);
      return {
        content: [{ type: "text", text: result }],
        details: { tool: "message_agent", agentId: target.helper.id, sent: result.startsWith("Sent to ") },
      };
    },
  });

  pi.registerTool({
    name: "use_agent_work",
    label: "Use agent work",
    description:
      "Take a finished agent's saved work into the project. Ordinary edits are applied directly. Changes to dependencies, " +
      "infrastructure, configuration, or deleted files require the user's explicit approval first.",
    promptSnippet: "Take a finished background agent's work into the project.",
    promptGuidelines: [
      "Omit agent_id when the user's reference is ambiguous (\"that agent\", \"the one doing X\") and more than " +
        "one finished agent has work waiting — Vinci will ask them which one. Never guess an id.",
    ],
    parameters: Type.Object({
      agent_id: Type.Optional(
        Type.Number({ description: "The numeric id of the finished agent. Omit it if the user didn't clearly identify one." }),
      ),
      user_approved: Type.Optional(
        Type.Boolean({ description: "True only after the user explicitly approved sensitive project changes." }),
      ),
    }),
    async execute(
      _id,
      params: { agent_id?: number; user_approved?: boolean },
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      uiRef = ctx;
      const target = await resolveAgentTarget(
        ctx,
        helpers,
        params.agent_id,
        (candidate) =>
          isTerminalStatus(candidate.status) &&
          Boolean(candidate.diff?.trim()) &&
          !candidate.applied &&
          !candidate.dismissedAt,
        "Which agent's work do you want to use?",
        "No finished agent has unused work to take.",
      );
      if ("error" in target) {
        return { content: [{ type: "text", text: target.error }], details: { tool: "use_agent_work", applied: false } };
      }
      const h = target.helper;
      const safeName = sanitizeLine(h.name);
      if (!isTerminalStatus(h.status)) {
        return {
          content: [{ type: "text", text: `Agent "${safeName}" is still working. Its work cannot be used yet.` }],
          details: { tool: "use_agent_work", agentId: h.id, applied: false },
        };
      }
      if (!h.diff?.trim()) {
        return {
          content: [{ type: "text", text: `Agent "${safeName}" did not leave any file changes to use.` }],
          details: { tool: "use_agent_work", agentId: h.id, applied: false },
        };
      }
      if (h.applied) {
        return {
          content: [{ type: "text", text: `Agent "${safeName}"'s work was already applied.` }],
          details: { tool: "use_agent_work", agentId: h.id, applied: false },
        };
      }
      if (h.dismissedAt) {
        return {
          content: [{ type: "text", text: `Agent "${safeName}"'s work was dismissed and was not applied.` }],
          details: { tool: "use_agent_work", agentId: h.id, applied: false },
        };
      }

      const savedPatch = restoredCrewPatch(h);
      if (!savedPatch) {
        return {
          content: [
            {
              type: "text",
              text: `Agent "${safeName}"'s saved file information is incomplete, so its work cannot be applied safely.`,
            },
          ],
          details: { tool: "use_agent_work", agentId: h.id, applied: false },
        };
      }
      if (vinciMaskSecrets(savedPatch.diff) !== savedPatch.diff) {
        return {
          content: [
            {
              type: "text",
              text: `Agent "${safeName}"'s work includes secret-looking information, so it cannot be applied.`,
            },
          ],
          details: { tool: "use_agent_work", agentId: h.id, applied: false },
        };
      }

      let changedPaths: string[];
      try {
        if (crewPathsUnchanged(ctx.cwd, savedPatch)) {
          changedPaths = [];
        } else {
          changedPaths = crewChangedPaths(ctx.cwd, savedPatch);
          if (!changedPaths.length) {
            return {
              content: [
                {
                  type: "text",
                  text: `Vinci could not confirm that Agent "${safeName}"'s files are unchanged, so its work was not applied.`,
                },
              ],
              details: { tool: "use_agent_work", agentId: h.id, applied: false },
            };
          }
        }
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Vinci could not check Agent "${safeName}"'s files safely, so its work was not applied.`,
            },
          ],
          details: { tool: "use_agent_work", agentId: h.id, applied: false },
        };
      }
      if (changedPaths.length) {
        const files = changedPaths.map(sanitizeLine).join(", ");
        return {
          content: [
            {
              type: "text",
              text:
                `These files changed after Agent "${safeName}" started: ${files}. Its work was not applied. ` +
                "Tell the user which files changed and ask how they want to resolve them before trying again.",
            },
          ],
          details: { tool: "use_agent_work", agentId: h.id, applied: false, changedPaths },
        };
      }

      if (isConsequentialCrewPatch(savedPatch) && params.user_approved !== true) {
        return {
          content: [
            {
              type: "text",
              text:
                `Agent "${safeName}" changes dependencies, infrastructure, configuration, or removes files. ` +
                "Before applying it, ask the user in plain language whether they want these changes, then call use_agent_work again with " +
                "user_approved set to true only if they agree.",
            },
          ],
          details: { tool: "use_agent_work", agentId: h.id, applied: false, userApprovalRequired: true },
        };
      }

      const res = applyDiff(ctx.cwd, savedPatch.diff);
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Agent "${safeName}"'s work could not be applied: ${sanitizeLine(res.msg)}.` }],
          details: { tool: "use_agent_work", agentId: h.id, applied: false },
        };
      }
      h.applied = true;
      h.status = "done";
      // [#194] This is the ORCHESTRATOR's tool: in a headless run no user approved anything, and
      // the old "The user approved this patch" wording invented an approval that never happened.
      h.reason = "The main task took this agent's work into the project; it must verify it before claiming DONE.";
      recordVinciMutation("", crewPatchWarrantsCheck(savedPatch.paths));
      pi.appendEntry(VINCI_VERIFICATION_ENTRY, { ...getVinciVerificationState() });
      persistHelper(pi, h);
      update();
      return {
        content: [
          {
            type: "text",
            text: `Applied Agent "${safeName}"'s work. Verify the affected files before claiming the task is complete.`,
          },
        ],
        details: { tool: "use_agent_work", agentId: h.id, applied: true },
      };
    },
  });

  pi.registerTool({
    name: "dismiss_agent_work",
    label: "Dismiss agent work",
    description:
      "Use this when the user doesn't want a finished agent's work, is dissatisfied with it, or says its row is " +
      "cluttering the list. The orchestrator calls this tool itself; the user should not be sent to a menu.",
    promptSnippet: "Dismiss a finished background agent's work without deleting it.",
    promptGuidelines: [
      "Omit agent_id when the user's reference is ambiguous (\"that agent\", \"the one doing X\") and more than " +
        "one finished agent could be meant — Vinci will ask them which one. Never guess an id.",
    ],
    parameters: Type.Object({
      agent_id: Type.Optional(
        Type.Number({ description: "The numeric id of the finished agent. Omit it if the user didn't clearly identify one." }),
      ),
    }),
    async execute(_id, params: { agent_id?: number }, _signal, _onUpdate, ctx: ExtensionContext) {
      uiRef = ctx;
      const target = await resolveAgentTarget(
        ctx,
        helpers,
        params.agent_id,
        (candidate) => isTerminalStatus(candidate.status) && !candidate.dismissedAt,
        "Which agent's work do you want to dismiss?",
        "No finished agent work to dismiss.",
      );
      if ("error" in target) {
        return {
          content: [{ type: "text", text: target.error }],
          details: { tool: "dismiss_agent_work", dismissed: false },
        };
      }
      const h = target.helper;
      const safeName = sanitizeLine(h.name);
      if (!isTerminalStatus(h.status)) {
        return {
          content: [{ type: "text", text: `Agent "${safeName}" is still working and cannot be dismissed yet.` }],
          details: { tool: "dismiss_agent_work", agentId: h.id, dismissed: false },
        };
      }
      if (h.dismissedAt) {
        return {
          content: [{ type: "text", text: `Agent "${safeName}" was already dismissed.` }],
          details: { tool: "dismiss_agent_work", agentId: h.id, dismissed: false },
        };
      }
      h.dismissedAt = Date.now();
      persistHelper(pi, h);
      update();
      return {
        content: [
          {
            type: "text",
            text: `Removed Agent "${safeName}" from the activity list. Its saved work is still available.`,
          },
        ],
        details: { tool: "dismiss_agent_work", agentId: h.id, dismissed: true },
      };
    },
  });

  const manageAgents = async (_args: string, ctx: ExtensionContext) => {
    uiRef = ctx;
    if (!helpers.length) {
      ctx.ui.notify("No agents yet. Ask Vinci to spin one up for a sub-task, or it will on its own.", "info");
      return;
    }
    // Status sat at the END of a truncated task line, so the one row needing the user was the hardest
    // to spot — buried mid-list behind finished and failed ones. Lead with what it needs, then the
    // name, then as much of the task as fits.
    const label = (h: Helper) =>
      `${statusGlyph(h.status)} ${statusLabel(h.status)} · ${sanitizeLine(h.name)} — ${sanitizeLine(h.task).slice(0, 48)}${h.task.length > 48 ? "…" : ""}`;
    // Sort by what the user has to do about it: anything awaiting them first, then still-running,
    // then everything already settled.
    const attention = (h: Helper): number =>
      h.status === "waiting" ? 0 : isTerminalStatus(h.status) ? 2 : 1;
    // Build unique row labels: two helpers can share the same name+task[:48]+status, and select()
    // returns only the chosen string — a plain indexOf would then resolve to the WRONG helper (and
    // apply the wrong diff). Suffix any duplicate so each row maps back to exactly one helper.
    const seen = new Map<string, number>();
    const ordered = [...helpers].sort((a, b) => attention(a) - attention(b));
    const rows = ordered.map((h) => {
      const base = label(h);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { h, text: n > 1 ? `${base} (${n})` : base };
    });
    const pick = await ctx.ui.select("Your agents", rows.map((r) => r.text));
    if (!pick) return;
    const h = rows.find((r) => r.text === pick)?.h;
    if (!h) return;
    if (h.status === "working" || h.status === "queued" || h.status === "verifying" || h.status === "reviewing") {
      ctx.ui.notify(`"${sanitizeLine(h.name)}" is still ${h.status}. I'll let you know when it's done.`, "info");
      return;
    }
    // Waiting helpers require explicit approval; integrated and clean helpers are view-only.
    const canApply = h.status === "waiting" && !!h.diff?.trim() && !h.applied;
    // An agent that went wrong shouldn't be something you live with. Anything finished can be cleared
    // off the strip by hand, whatever state it ended in.
    const canRemove = isTerminalStatus(h.status) && !h.dismissedAt;
    const actions = [
      "View what it did",
      ...(canApply ? ["Apply its changes"] : []),
      ...(canRemove ? ["Remove it from the list"] : []),
      "Close",
    ];
    const action = await ctx.ui.select(`"${sanitizeLine(h.name)}" — ${h.status}`, actions);
    if (!action || action === "Close") return;
    if (action === "Remove it from the list") {
      h.dismissedAt = Date.now();
      persistHelper(pi, h);
      update();
      ctx.ui.notify(
        canApply
          ? `Removed "${sanitizeLine(h.name)}" from the list. Its changes were not used, but are still saved.`
          : `Removed "${sanitizeLine(h.name)}" from the list.`,
        "info",
      );
      return;
    }
    if (action === "View what it did") {
      await openHelper(ctx, h);
      return;
    }
    // Apply
    const diff = h.diff ?? "";
    const masked = vinciMaskSecrets(diff);
    const preview = masked.length > 1600 ? `${masked.slice(0, 1600)}\n… (${diff.split("\n").length} lines total)` : masked;
    const ok = await ctx.ui.confirm(`Apply "${sanitizeLine(h.name)}"'s changes?`, `${preview}\n\nApply this to your project?`);
    if (!ok) return;
    const savedPatch = restoredCrewPatch(h);
    let safety: "verified" | "changed" | "unknown" = "unknown";
    let changedPaths: string[] = [];
    if (savedPatch) {
      try {
        if (crewPathsUnchanged(ctx.cwd, savedPatch)) {
          safety = "verified";
        } else {
          changedPaths = crewChangedPaths(ctx.cwd, savedPatch);
          safety = changedPaths.length ? "changed" : "unknown";
        }
      } catch {
        safety = "unknown";
      }
    }
    if (safety === "changed") {
      const files = changedPaths.map(sanitizeLine).join(", ");
      const confirmed = await ctx.ui.confirm(
        "Your files changed after this agent ran",
        `These files changed after the agent started: ${files}. Applying now may combine or overwrite work. Apply anyway?`,
      );
      if (!confirmed) return;
    } else if (safety === "unknown") {
      const confirmed = await ctx.ui.confirm(
        "Safety check unavailable",
        "This saved agent is from before Vinci recorded file baselines, so Vinci cannot check whether your files changed after it ran. Apply anyway?",
      );
      if (!confirmed) return;
    }
    const res = applyDiff(ctx.cwd, diff);
    if (res.ok) {
      h.applied = true;
      h.status = "done";
      h.reason = "The user approved this patch; the main task must verify it before claiming DONE.";
      recordVinciMutation("", crewPatchWarrantsCheck(h.patchPaths));
      pi.appendEntry(VINCI_VERIFICATION_ENTRY, { ...getVinciVerificationState() });
      persistHelper(pi, h);
      update(); // drop it from the strip now that it's applied
    }
    ctx.ui.notify(
      res.ok
        ? safety === "changed"
          ? `Applied "${sanitizeLine(h.name)}"'s changes after you confirmed newer edits in: ${changedPaths.map(sanitizeLine).join(", ")}. Verify the combined files before continuing.`
          : safety === "unknown"
            ? `Applied "${sanitizeLine(h.name)}"'s changes without a file-change safety check, as you confirmed. Verify the affected files before continuing.`
            : `Applied "${sanitizeLine(h.name)}"'s changes.`
        : res.msg.includes("some changes may be partially applied")
          ? `Some of "${sanitizeLine(h.name)}"'s changes went in and some didn't. Check those files before you keep going — I can help you look.`
          : // A raw "git apply --check --binary" failure is meaningless to someone who never asked for
            // git. Almost always it means the files moved on since the agent worked on them.
            `"${sanitizeLine(h.name)}"'s changes were written for an earlier version of these files, so they no longer fit. Nothing was changed. Ask me to redo that work against the files as they are now.`,
      res.ok ? "info" : "error",
    );
  };

  pi.registerCommand("agents", {
    description: "See your background agents and apply their work",
    handler: manageAgents,
  });
  pi.on("input", async (event, ctx) => {
    const alias = event.text.match(/^\/helpers(?:\s+(.*))?$/);
    if (!alias) return { action: "continue" };
    await manageAgents(alias[1] ?? "", ctx);
    return { action: "handled" };
  });
}
