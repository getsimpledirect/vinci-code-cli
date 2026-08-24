/**
 * Vinci loop-breaker + escalate-on-stuck — the mechanical safety net for the failure that most
 * "spoils the fun": the agent going in circles. A small non-reasoning model, stuck on a sub-problem
 * it can't crack, will happily run the SAME command over and over forever (observed live: 156
 * byte-identical `node -e …` calls in a row until the process was killed). A non-programmer just
 * sees Vinci "working" for minutes and force-quits.
 *
 * Detection (per user-turn): the SAME tool call (normalized) repeating with no state change (no
 * edit/write) in between is a no-progress loop; a per-turn non-navigation action ceiling backstops
 * non-identical runaways. Structured source navigation never enters the stop-and-report ladder: a
 * byte-identical lookup is redirected with a concrete recovery hint. Other fixation responses escalate:
 *
 *   1st time  — a quick steer: you're repeating, try a different angle.
 *   2nd time  — TAKE CHARGE: pull in a stronger teammate. Gather the real context (the user's task,
 *               the stuck step, the recent errors) and ask the strongest SERVING class for one
 *               concrete fix, injected straight back so Vinci can act on it. With one frontier class
 *               serving, it explicitly identifies that class before a fresh reframed pass.
 *   3rd / ceiling — stop and report an honest partial result.
 *
 * Guardrails on the guardrails (from the 2026-07-09 bozza review-runaway): identical-fixation is
 * checked BEFORE the explore limits so the ladder stays reachable; meta tools (todo/ask_user/advisor/…)
 * are never counted as exploration or blocked (the steers prescribe them); substantive narration resets
 * the explore streak (a real "review the repo" turn reads a lot — that's work, not a spiral); block
 * messages carry attempt counts so a stuck model never sees the same text twice. The companion core
 * patch (PATCHES.md §15) makes blocked/failed results LOOK like errors on the completions wire —
 * without it a block reads exactly like a success and the model retries forever.
 *
 * Additive except that §15 wire marker. The stronger-model completion path only runs when the
 * fixation ladder actually escalates.
 */
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { classifyCompletionResult, complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearVinciAutomationStop, requestVinciAutomationStop, sendVinciControl } from "./lib/control.ts";
import { isPendingVinciSourceOwnershipInspection } from "./lib/source-ownership-state.ts";
import { getVinciUiState } from "./lib/ui-state.ts";
import {
  installVinciUsageAccumulator,
  recordVinciTaskCall,
} from "./lib/usage-accumulator.ts";
import {
  getVinciVerificationState,
  vinciRequiredVerificationCommand,
  vinciVerificationCheckClass,
  vinciVerificationClassRank,
  vinciVerificationCommand,
  vinciVerificationMutationRevision,
} from "./lib/verification-state.ts";
import {
  classifyVerificationCommand,
  contextualVerificationKey,
  isDirectVerificationCommand,
} from "./vinci-verification.ts";
import {
  assertSuccessfulVinciCompletion,
  classifyVinciModelError,
  describeVinciModelError,
} from "./vinci-model-provenance.ts";

const IDENTICAL_LIMIT = 3; // block the 3rd identical no-progress repeat
// Non-navigation calls; preserve room to report before corpus limits/timeouts. Restored to 25 (the
// pre-3cd1a377 value) after 18 truncated a legitimate 10-file project scaffold mid-way — a real user
// hit it building a React site. Reads/greps are already free (b2e57811), so this budget is writes +
// shell only; runaway loops are still caught by the identical-fixation ladder and ERROR_LIMIT.
export const TURN_CALL_CEILING = 25;
// Read-only navigation is exempt from the action ceiling, but not from ALL bounds: endlessly
// VARIED reads (git diff X, git show Y, cat Z…) never trip repeat detection, and without a
// cumulative cap they are an unbounded paid loop. Generous — real investigation fits easily.
export const READ_ONLY_NAVIGATION_CEILING = 120;
const EXPLORE_LIMIT = 14; // enough room for a real repo audit before a convergence steer
const EXPLORE_HARD = 19; // hard-stop continued non-navigation investigation after the steer
const PRE_MUTATION_STEER = 8; // source-localization checkpoint early enough for edit + proof inside 14 calls
const PRE_MUTATION_GRACE_CALLS = 2; // after the checkpoint, reserve the remaining calls for edit + direct proof
const POST_MUTATION_INSPECTION_LIMIT = 3; // bounds non-navigation investigation after a successful change
const ERROR_LIMIT = 4; // failing tool calls in a row (bad edits, invalid calls) before we stop
const NARRATE_MIN = 200; // an assistant text this long = it's synthesizing, not spiraling → relax limits
const MAX_INCOMPLETE_UPGRADE_ATTEMPTS = 2;
const TRACKED_PATH_CACHE_TTL_MS = 2_000;
const TRACKED_PATH_LOOKUP_TIMEOUT_MS = 2_000;

// Interaction / meta tools are NOT exploration: a `todo` update or a teammate ask must never trip the
// explore detector — and the steers themselves prescribe `ask_user`/`advisor`, so blocking those tools
// hands the model a contradiction it can't resolve (observed: a blocked `todo` rendered mid-spiral).
const META_TOOLS = new Set(["ask_user", "todo", "present_plan", "advisor", "convene_council", "review_changes", "remember", "rerun_check", "spawn_helper", "orchestrate"]);

// Source navigation is how an agent locates exact edit regions. These calls may be numerous without
// being wasteful: reading the same file at another offset or grepping another pattern is new
// information. They can receive a convergence steer, but must not consume the mutation/action budget
// or be hard-blocked by broad-exploration pacing. Only a byte-identical no-progress call is blocked.
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "glob", "ls", "search"]);

// Grounding tools (web) are also NOT the aimless exploration the explore-limit targets: when a fetch
// 404s or a search misses, the RIGHT move is to search again with a better query — "fire up more
// searches" is productive persistence, not a spiral. So web_search/web_fetch are exempt from the
// explore streak. They stay bounded by the tighter, sharper backstops: identical-repeat (same query
// 3× → blocked), consecutive-failure (4 failed fetches in a row → stop), and the per-turn ceiling.
const GROUNDING_TOOLS = new Set(["web_search", "web_fetch"]);

// Dependency hydration is runway to verification, but is not itself verification evidence.
const VERIFICATION_RUNWAY_COMMAND =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|ci|install|add)\b|\b(?:pip|pip3|uv|poetry)\s+(?:install|sync)\b|\bbundle\s+install\b|\bgo\s+mod\s+download\b|\bcargo\s+fetch\b/i;

function isVerificationCall(toolName: string, input: unknown): boolean {
  if (toolName !== "bash" || !input || typeof input !== "object") return false;
  const command = (input as { command?: unknown }).command;
  return (
    typeof command === "string" &&
    (classifyVerificationCommand(command) !== undefined || VERIFICATION_RUNWAY_COMMAND.test(command))
  );
}

// Deferred turn-stop — VALIDATED 2026-07-09 in a live headless run: a setTimeout-deferred
// ctx.abort() ends the TURN cleanly (partial output kept, no deadlock, no zombie — the sync
// mid-hook call was what deadlocked). Default ON; kill switch VINCI_NO_TURNSTOP=1.
const TURNSTOP = process.env.VINCI_NO_TURNSTOP !== "1";

const ERROR_STEER =
  "Several tools in a row have FAILED (edits not matching the file, invalid tool calls, writes that " +
  "didn't work). You are not converging — stop retrying. Tell the user plainly: what you were trying to " +
  "do, what keeps failing, and where you're stuck. If you may have damaged a file, say so and tell them " +
  "they can run /undo to restore it. Then end your turn — do NOT attempt another edit/write right now.";

const EXPLORE_STEER =
  "You've read/searched many times in a row without converging — STOP exploring now. You already have " +
  "enough to be useful: summarize what you've found and ANSWER the user's question from what you've seen " +
  "so far (it's fine to say what you're less sure about). If you truly cannot answer, ask the user ONE " +
  "short, specific question with the ask_user tool. Do NOT run another bespoke shell inspection or " +
  "reproduction right now — it will be blocked. A targeted read at a different range remains available " +
  "if exact source lines are still needed.";
const READ_RECOVERY_STEER =
  "That exact read-only lookup has already returned the same information. Do not abandon the task: " +
  "read the whole file once, use a different path/offset/range, or search for a different nearby pattern, " +
  "then make the scoped change once you have the exact lines.";
const READ_CONVERGENCE_STEER =
  "You've done many read-only lookups. Source navigation is still available: if the exact edit region " +
  "is missing, read the whole file once, try a different offset/range, or search for a different nearby " +
  "pattern. Otherwise use what you found to make the scoped change or answer now.";
const OWNERSHIP_STEER =
  "You're deep into this turn without a successful project change. Stop widening the search. Use the " +
  "evidence already gathered to identify the narrowest function that OWNS where the behavior is " +
  "configured or composed — do not patch a downstream wrapper or generic helper just because it is " +
  "easy to edit. If implementation was requested, re-read only the exact edit region if needed, make " +
  "one small source-local change, then run the focused verifier directly with no pipe. If this is a " +
  "read-only task, answer now from the evidence instead.";
const MUTATION_RUNWAY_STEER =
  "The investigation window is exhausted and the remaining tool budget is reserved for completing " +
  "the task. Do not run another bespoke reproduction. If exact source lines are still missing, use a " +
  "targeted read with a different range or search pattern; otherwise make one small edit/write at the " +
  "narrowest owning source location and run the existing focused verifier directly.";
const POST_MUTATION_STEER =
  "The code change is already in place. Stop broad investigation and use the remaining actions only for " +
  "the narrowest existing verification command, a repair directly justified by that check, or the final " +
  "answer. A targeted source read remains available if exact repair lines are still missing.";
const RECENT_KEEP = 6; // recent (call, result) pairs kept for escalation context
const ESCALATE_TIMEOUT_MS = 9000; // never let a stronger-model hand-off hang the session
const TIER_ORDER = ["forte", "fortissimo"];
const SAME_CLASS_ATTEMPTS = 2;

const TRY_DIFFERENT =
  "You've already run this exact step " +
  IDENTICAL_LIMIT +
  " times and gotten the same result each time — running it again will not change anything, so stop " +
  "repeating it. Instead do ONE of: (a) try a genuinely different approach; (b) if you're unsure how, " +
  "ask a teammate with the `advisor` or `convene_council` tool; or (c) if this one piece is truly out " +
  "of reach right now, leave it and finish everything else. Do NOT run this same step again.";

const STOP_AND_REPORT =
  "You're going in circles on the same step. Stop now — it is better to stop with an honest, useful " +
  "partial result than to keep looping. Tell the user in plain language: what IS working now, what " +
  "isn't, exactly what's blocking the last piece, and what you'd try next. Give this status summary " +
  "once, then end your turn. Do not repeat or rephrase it, and don't run more commands on this.";

const MENTOR_SYSTEM =
  "You are a senior engineer helping a junior coding agent that is STUCK — it keeps repeating the same " +
  "step with no progress. Read what it's trying and the error, then give ONE concrete way forward: the " +
  "actual fix, command, or code, specific to what you see — not generic advice. 2–4 sentences. If that " +
  "last piece genuinely isn't worth the effort, tell it to skip that piece and finish the rest.";

// Normalize a call so trivial whitespace tweaks don't dodge the detector, but real argument changes
// still read as a different call.
function callKey(toolName: string, input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(input ?? {});
  } catch {
    s = String(input);
  }
  return toolName + " " + s.replace(/\s+/g, " ").trim();
}

function readOnlyShellSegments(command: string): string[] | undefined {
  const segments: string[] = [];
  let quote: "'" | '"' | null = null;
  let start = 0;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (quote) {
      if (quote === '"' && (character === "`" || (character === "$" && command[index + 1] === "("))) {
        return undefined;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "`" || character === "<" || character === ">" || character === "\n") return undefined;
    if (character === "$" && command[index + 1] === "(") return undefined;
    if (character === "|" || (character === "&" && command[index + 1] !== "&")) return undefined;
    if (character === ";") return undefined;
    if (character === "&" && command[index + 1] === "&") {
      const segment = command.slice(start, index).trim();
      if (!segment) return undefined;
      segments.push(segment);
      index++;
      start = index + 1;
    }
  }
  if (quote) return undefined;
  const segment = command.slice(start).trim();
  if (!segment) return undefined;
  segments.push(segment);
  return segments;
}

function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"' && index + 1 < command.length) token += command[++index];
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\" && index + 1 < command.length) {
      token += command[++index];
      continue;
    }
    if (/\s/.test(character)) {
      if (token) words.push(token);
      token = "";
      continue;
    }
    token += character;
  }
  if (quote) return undefined;
  if (token) words.push(token);
  return words;
}

function trackedReadOperands(words: readonly string[]): string[] {
  const operands: string[] = [];
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (word === "--") {
      operands.push(...words.slice(index + 1));
      break;
    }
    if (word === "-n" || word === "-c" || word === "--lines" || word === "--bytes") {
      index++;
      continue;
    }
    if (word.startsWith("-")) continue;
    operands.push(word);
  }
  return operands;
}

type TrackedPathCacheEntry = {
  expiresAt: number;
  paths: ReadonlySet<string>;
};
const trackedPathCache = new Map<string, TrackedPathCacheEntry>();

function trackedPaths(cwd: string): ReadonlySet<string> {
  const cached = trackedPathCache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) return cached.paths;
  const paths = new Set<string>();
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: TRACKED_PATH_LOOKUP_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const output = execFileSync("git", ["ls-files", "-z", "--full-name"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: TRACKED_PATH_LOOKUP_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const path of output.split("\0")) {
      if (path) paths.add(resolve(root, path));
    }
  } catch {
    // A non-repository or timed-out lookup has no safely known tracked paths.
  }
  trackedPathCache.set(cwd, { expiresAt: Date.now() + TRACKED_PATH_CACHE_TTL_MS, paths });
  return paths;
}

function isTrackedFile(cwd: string, path: string): boolean {
  if (!path || path === "-" || /[*?\[\]{}]/.test(path)) return false;
  const absolute = resolve(cwd, path);
  const repoPath = relative(cwd, absolute);
  if (!repoPath || repoPath.startsWith("..")) return false;
  return trackedPaths(cwd).has(absolute);
}

function readOnlyGitSubcommand(words: readonly string[]): string | undefined {
  // Configuration and textconv/ext-diff options can execute helpers/hooks even under read-only
  // subcommands; any of them disqualifies the whole command from read-only classing (round-12).
  if (words.some((w) => w === "-c" || w === "--textconv" || w === "--ext-diff" || w.startsWith("-O"))) {
    return undefined;
  }
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (word === "--no-pager") {
      index++;
      continue;
    }
    if (word === "-C" || word === "--git-dir" || word === "--work-tree") {
      if (!words[index + 1]) return undefined;
      index += 2;
      continue;
    }
    if (word.startsWith("--git-dir=") || word.startsWith("--work-tree=")) {
      if (!word.slice(word.indexOf("=") + 1)) return undefined;
      index++;
      continue;
    }
    if (word.startsWith("-")) return undefined;
    return word;
  }
  return undefined;
}

function isReadOnlyShellCommand(command: string, cwd: string): boolean {
  const segments = readOnlyShellSegments(command);
  if (!segments) return false;
  return segments.every((segment) => {
    const words = shellWords(segment);
    if (!words || words.length === 0) return false;
    const executable = words[0];
    if (executable === "git") {
      const subcommand = readOnlyGitSubcommand(words);
      return (
        (subcommand === "status" ||
          subcommand === "diff" ||
          subcommand === "log" ||
          subcommand === "show" ||
          subcommand === "rev-parse") &&
        !words.some((word) => /^--(?:output|ext-diff)(?:=|$)/.test(word))
      );
    }
    if (executable === "pwd") return words.length === 1 || (words.length === 2 && /^-[LP]$/.test(words[1]));
    if (executable === "ls") return true;
    if (executable === "echo") return true;
    if (executable === "cat" || executable === "head" || executable === "tail" || executable === "wc") {
      const operands = trackedReadOperands(words);
      return operands.length > 0 && operands.every((path) => isTrackedFile(cwd, path));
    }
    return false;
  });
}

const clip = (v: unknown, n: number): string => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

type Step = { tool: string; input: unknown; result: string; isError: boolean };
const um = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
function textOf(resp: { content: Array<{ type: string; text?: string }> }): string {
  return resp.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function stuckPrompt(task: string, stuckKey: string, recent: Step[], cwd: string): string {
  const steps = recent
    .map((r) => `- ${r.tool}(${clip(JSON.stringify(r.input), 80)}) → ${r.isError ? "ERROR: " : ""}${clip(r.result, 140)}`)
    .join("\n");
  return [
    "A junior coding agent is stuck in a loop. Here's the situation.",
    task ? `\nThe user's task:\n${clip(task, 400)}` : "",
    `\nIt keeps repeating this step with no change:\n${clip(stuckKey, 220)}`,
    recent.length ? `\nRecent steps and their results:\n${steps}` : "",
    `\nThe project is at ${cwd}.`,
    "\nGive ONE concrete next action to get it unstuck.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Take charge: ask the strongest SERVING tier for a concrete fix; disclose a fresh reframed pass
 *  by the current model; return null only if even that fails (→ caller falls back to stop-and-report).
 *  `escalated` is true only when a genuinely different, stronger model answered — the caller's
 *  user-facing notify must not claim a "stronger teammate" on the same-model reframe path (P2-5). */
type UnstuckResult = { text: string; escalated: boolean };
export async function getUnstuck(ctx: ExtensionContext, stuckKey: string, recent: Step[], task: string): Promise<UnstuckResult | null> {
  if (!ctx.model || !ctx.modelRegistry) return null;
  const announce = (message: string, level: "warning" | "error") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.error(message);
  };
  let auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  } catch (error) {
    const message = `Loop recovery stopped before model selection; Vinci will not fall back after an authentication error: ${describeVinciModelError(error)}`;
    announce(message, "error");
    throw new Error(message, { cause: error });
  }
  if (!auth.ok || !auth.apiKey) {
    const detail = auth.ok ? "no API key returned" : auth.error;
    const message = `Loop recovery stopped before model selection; Vinci will not fall back after an authentication error: ${detail}`;
    announce(message, "error");
    throw new Error(message);
  }

  const prompt = stuckPrompt(task, stuckKey, recent, ctx.cwd);
  const opts = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
  const unavailableClasses: string[] = [];

  // Climb to the strongest tier ABOVE the current model that actually answers.
  const idx = TIER_ORDER.indexOf(ctx.model.id);
  if (idx >= 0) {
    for (let i = TIER_ORDER.length - 1; i > idx; i--) {
      const classId = TIER_ORDER[i];
      const m = ctx.modelRegistry.find("vinci", classId) as typeof ctx.model | undefined;
      if (!m) {
        unavailableClasses.push(classId);
        continue;
      }
      for (let attempt = 1; attempt <= SAME_CLASS_ATTEMPTS; attempt++) {
        try {
          const attemptSignal = AbortSignal.timeout(ESCALATE_TIMEOUT_MS);
          const response = await complete(
            m,
            { systemPrompt: MENTOR_SYSTEM, messages: [um(prompt)] },
            { ...opts, signal: attemptSignal },
          );
          assertSuccessfulVinciCompletion(response, attemptSignal);
          const status = classifyCompletionResult(response);
          recordVinciTaskCall(ctx.sessionManager.getSessionId(), response, "loopbreak:escalation");
          // Empty content: skip this tier and try the next, don't throw
          const t = textOf(response);
          if (t && status.ok) {
            return {
              text: `A stronger teammate — ${m.name ?? m.id} — looked at where you're stuck and suggests:\n\n${t}\n\nDo this now instead of repeating the last step.`,
              escalated: true,
            };
          }
          unavailableClasses.push(classId);
          break;
        } catch (error) {
          const kind = classifyVinciModelError(error);
          if (kind === "transient" && attempt < SAME_CLASS_ATTEMPTS) continue;
          if (kind === "transient" || kind === "unavailable") {
            unavailableClasses.push(classId);
            break;
          }
          const message = `Loop recovery stopped on ${classId}; Vinci will not downgrade after an account or terminal error: ${describeVinciModelError(error)}`;
          announce(message, "error");
          throw new Error(message, { cause: error });
        }
      }
    }
  }
  const fallbackNotice =
    unavailableClasses.length > 0
      ? `Stronger Vinci ${unavailableClasses.join(", ")} ${unavailableClasses.length === 1 ? "class is" : "classes are"} unavailable. Loop recovery will be served by ${ctx.model.name ?? ctx.model.id}; Vinci is not silently selecting a cheaper class.`
      : undefined;
  if (fallbackNotice) announce(fallbackNotice, "warning");
  try {
    const attemptSignal = AbortSignal.timeout(ESCALATE_TIMEOUT_MS);
    const response = await complete(
      ctx.model,
      { systemPrompt: MENTOR_SYSTEM, messages: [um(prompt)] },
      { ...opts, signal: attemptSignal },
    );
    assertSuccessfulVinciCompletion(response, attemptSignal);
    const status = classifyCompletionResult(response);
    recordVinciTaskCall(ctx.sessionManager.getSessionId(), response, "loopbreak:fallback");
    // Empty content: log and skip, don't escalate to fatal
    if (!status.ok) {
      console.warn("Loop recovery: fallback escalation returned empty content");
    }
    const t = textOf(response);
    if (t) {
      return {
        text:
          `${fallbackNotice ? `${fallbackNotice}\n\n` : ""}Stepping back for a fresh look at where you're stuck:\n\n` +
          `${t}\n\nTry a genuinely different approach along these lines — do NOT repeat the last step.`,
        escalated: false,
      };
    }
  } catch (error) {
    const kind = classifyVinciModelError(error);
    if (kind === "account" || kind === "fatal") {
      const message = `Loop recovery stopped on ${ctx.model.id}; Vinci will not downgrade after an account or terminal error: ${describeVinciModelError(error)}`;
      announce(message, "error");
      throw new Error(message, { cause: error });
    }
    announce(
      `Loop-recovery class ${ctx.model.id} is unavailable. No cheaper model was selected; Vinci will stop and report the blocked step.`,
      "warning",
    );
  }
  return null;
}

// A whole-message "continue" (any casing/punctuation) — the nudge people type at a stalled agent.
const CONTINUEISH = /^\s*(?:(?:ok(?:ay)?|yes|yeah|yep|sure)[,\s]+)?(?:continue|keep going|go on|carry on|resume|finish(?:\s+it)?)[\s.!…]*$/i;

export default function (pi: ExtensionAPI) {
  installVinciUsageAccumulator(pi);
  let calls = 0; // total tool calls this user-turn
  let actionCalls = 0; // calls subject to the absolute ceiling; source navigation does not spend it
  let readOnlyNavigationCalls = 0; // read-only shell calls; bounded by READ_ONLY_NAVIGATION_CEILING
  let interventions = 0; // loops broken this turn (escalates the response)
  let readOnlyStreak = 0; // reads/searches since the last edit/write (catches varied exploration spirals)
  let errorStreak = 0; // failing tool calls in a row (catches edit/write thrashing after a self-inflicted mess)
  let hardBlocks = 0; // firm blocks issued this turn (arms the opt-in deferred turn-stop)
  let stopScheduled = false; // the deferred turn-stop fires at most once per turn
  let carryRepeats = false; // set by a continue-ish input: keep `seen`/`interventions` across the turn boundary
  let silentRounds = 0; // consecutive tool rounds with no narration (drives the talk-more nudge)
  let narrationNudges = 0; // nudges sent this turn (capped — remind, don't nag)
  let exploreSteerSent = false; // one recovery steer per exploration streak (prevents duplicate answers)
  let ownershipSteerSent = false; // one source-localization checkpoint before the first successful mutation
  let ownershipSteerCall = 0; // absolute call index where the checkpoint was delivered
  let mutationRunwaySteerSent = false; // one firm convergence steer after the checkpoint grace
  let preMutationVerificationUsed = false; // one focused check may resolve the final uncertainty
  let mutationSucceeded = false; // real edit/write evidence, not an attempted or narrated change
  let postMutationInspections = 0; // bounded allowance to find the focused check after an edit
  let finalVerificationUsed = false; // one direct proof command remains available after the call ceiling
  let fixationAdvisorExemption = false; // armed by a fixation intervention: the first advisor/council call may pass the ceiling (P2-6)
  let upgradeVerifierFingerprint = "";
  let incompleteUpgradeAttempts = 0;
  let task = ""; // the user's current request (for escalation context)
  const seen = new Map<string, number>(); // normalized call -> repeats since the last edit/write
  const lastResultSig = new Map<string, string>(); // normalized call -> its last RESULT text (result-aware fixation)
  const failedMutationCalls = new Set<string>(); // a byte-identical failed edit/write cannot succeed on retry
  const recent: Step[] = []; // rolling (call, result) history for escalation context

  pi.on("session_start", async () => clearVinciAutomationStop());

  // agent_start fires once per user prompt — reset the per-turn counters (keep `task`, set on input).
  // EXCEPTION: user continuations and extension-owned recovery turns are the same task, so their
  // cumulative budget and convergence state carry over. Otherwise an automatic verification retry
  // can silently buy another full tool budget after the original turn has already exhausted it.
  pi.on("agent_start", async () => {
    stopScheduled = false;
    if (!carryRepeats) {
      calls = 0;
      actionCalls = 0;
      readOnlyNavigationCalls = 0;
      interventions = 0;
      readOnlyStreak = 0;
      errorStreak = 0;
      hardBlocks = 0;
      silentRounds = 0;
      narrationNudges = 0;
      exploreSteerSent = false;
      ownershipSteerSent = false;
      ownershipSteerCall = 0;
      mutationRunwaySteerSent = false;
      preMutationVerificationUsed = false;
      mutationSucceeded = false;
      postMutationInspections = 0;
      finalVerificationUsed = false;
      fixationAdvisorExemption = false;
      upgradeVerifierFingerprint = "";
      incompleteUpgradeAttempts = 0;
      invalidTool = null;
      invalidCount = 0;
      lastCallClamped = false;
      recent.length = 0;
      seen.clear();
      lastResultSig.clear();
      failedMutationCalls.clear();
    }
    carryRepeats = false;
  });

  // Capture the user's request (before agent processing) so a stronger teammate knows the goal.
  // A continue-ish message carries the repeat counters (see agent_start) and does NOT overwrite the
  // real task — "continue" as escalation context would tell a stronger teammate nothing.
  pi.on("input", async (event) => {
    const text = event.text?.trim();
    if (!text) return;
    // Only a REAL new prompt lifts the stop: a mid-stream keystroke ("wait, what?") un-latching a
    // firm stop resumed the exact frozen loop with a fresh call budget (round-2 audit P1-4).
    if (event.source !== "extension" && !event.streamingBehavior) clearVinciAutomationStop();
    // Read-only bash calls never touch `calls`, so recovery inputs mid-navigation must also see
    // the navigation counter or they reset the turn and re-grant the whole budget (round-12 P0).
    carryRepeats =
      CONTINUEISH.test(text) || (event.source === "extension" && (calls > 0 || readOnlyNavigationCalls > 0));
    if (!carryRepeats) task = text;
  });

  // ── Invalid-call coach ─────────────────────────────────────────────────────────────────────────
  // Pi VALIDATES tool arguments BEFORE any tool_call hook runs, so an invalid call never reaches the
  // detectors above — a model stuck re-sending the same invalid call loops with no guard at all
  // (observed live: `edit {path}` with no `edits`, 10+ times — the gateway's 256-token clamp cut the
  // big multi-edit JSON mid-stream, Pi salvaged only {path}, and every retry was clamped again). We
  // can't block what the hook never sees, but we CAN rewrite the failure RESULT the model reads:
  // coach it to split the change into small calls, escalating on repeats.
  const INVALID_RE = /validation failed for tool|must have required propert/i;
  let invalidTool: string | null = null;
  let invalidCount = 0;
  let lastCallClamped = false; // the previous assistant tool-call message hit the ~256 output clamp
  pi.on("message_end", async (event) => {
    const m = event.message;
    if (m.role !== "assistant") return;
    const out = (m as { usage?: { output?: number } }).usage?.output ?? 0;
    lastCallClamped = (m.content ?? []).some((c) => c.type === "toolCall") && out >= 250 && out <= 260;
  });
  pi.on("message_end", async (event, ctx) => {
    const m = event.message;
    if (m.role !== "toolResult") return;
    // A clamped write/edit SUCCEEDS with truncated content — the silent killer: the file is
    // incomplete but nothing errors, so the model either moves on (broken file) or rewrites the
    // whole thing and gets clamped again (observed live: the same truncated useDragAndDrop.ts
    // re-written 4×). Append a warning to the result the model reads next.
    if (!m.isError && (m.toolName === "write" || m.toolName === "edit") && lastCallClamped) {
      lastCallClamped = false;
      if (ctx.hasUI) {
        ctx.ui.notify("That file change may have been cut off mid-write — telling Vinci to check and finish it in small pieces.", "warning");
      }
      const warn =
        `CAUTION: this ${m.toolName} call hit the reply-length limit — the content you sent was probably CUT OFF, ` +
        `so the file is likely INCOMPLETE. Read the END of the file to check. Then APPEND what's missing with SMALL ` +
        `edit calls (a few lines each). Do NOT rewrite the whole file in one call — it will be cut off again.`;
      sendVinciControl(pi, "vinci-truncated-change", warn);
      return;
    }
    const text = (m.content ?? [])
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof (c as { text?: unknown }).text === "string")
      .map((c) => c.text)
      .join("\n");
    if (!INVALID_RE.test(text)) {
      if (!m.isError) {
        invalidTool = "";
        invalidCount = 0;
      }
      return;
    }
    const tool = m.toolName ?? "";
    invalidCount = tool === invalidTool ? invalidCount + 1 : 1;
    invalidTool = tool;
    if (invalidCount < 2) return; // first failure: Pi's own error (ERROR-marked on the wire) gets a fair shot
    // 6+ identical invalid calls = the coaching AND two stop-tiers were ignored (a clamped call the
    // model keeps re-sending, or a context groove it can't escape). Nothing can BLOCK an invalid
    // call (they never reach tool_call hooks), so END THE TURN — deferred, validated safe.
    if (TURNSTOP && invalidCount >= 6 && !stopScheduled) {
      stopScheduled = true;
      if (ctx.hasUI) {
        ctx.ui.notify("Vinci can't get this change through — ending the turn so you can redirect it.", "warning");
      }
      setTimeout(() => {
        try {
          ctx.abort();
        } catch {
          /* best-effort */
        }
      }, 200);
    }
    if (invalidCount >= 4) {
      requestVinciAutomationStop(`Vinci repeated an invalid ${tool} call ${invalidCount} times.`);
    }
    const example =
      tool === "edit"
        ? `{"path": "<file>", "edits": [{"oldText": "<exact text copied from the file>", "newText": "<replacement>"}]}`
        : `a complete call with every required field filled in`;
    const coach =
      invalidCount >= 4
        ? `${text}\n\nSTOP — you have sent ${invalidCount} invalid ${tool} calls in a row and repeating it will fail again. ` +
          `If you cannot make the change in ONE SMALL call, tell the user plainly what you were trying to change and ask them with the ask_user tool. Do not retry the same call.`
        : `${text}\n\nThat is ${invalidCount} invalid ${tool} calls in a row. Your call was probably TOO BIG and got cut off before it finished. ` +
          `Do it differently now: send ONE SMALL call at a time — ${example} — with just a few lines per edit, and make several calls for several changes.`;
    if (ctx.hasUI) {
      ctx.ui.notify(
        invalidCount >= 4
          ? "Vinci keeps sending a broken edit — telling it to stop and ask. Press Ctrl+C to step in."
          : "Vinci's change didn't fit in one call — coaching it to split the edit.",
        invalidCount >= 4 ? "warning" : "info",
      );
    }
    sendVinciControl(pi, "vinci-invalid-tool", coach);
    return;
  });

  /** Firmly block a runaway + tell the user (so they can Ctrl+C if they want out).
   *
   *  IMPORTANT: a tool_call hook can only turn ONE call into an error result — it can NOT truly end the
   *  turn. The model keeps generating, each round a full re-send of the (growing) context, which is what
   *  blows up to millions of tokens on a stuck small model. A SYNC `ctx.abort()` from inside this hook
   *  was tried and HANGS both the TUI and print mode (the loop is mid-hook when the abort fires —
   *  verified). So the defense is prevention (low limits + strong steers) and, DEFAULT ON (kill
   *  switch VINCI_NO_TURNSTOP=1), a DEFERRED abort on the 3rd firm block: deferred so it fires after
   *  the hook returns (validated to end the turn cleanly), 3rd not 1st so the model gets real
   *  chances to answer the steer first. */
  // `reason` is the MODEL-facing steer; `humanReason` is the short plain sentence recorded on the
  // automation stop — verification's closing message quotes it as "Why I stopped: …", so steer prose
  // ("Stop now — … Tell the user in plain language…") must never land there (round-2 audit P1-3).
  function firmBlock(ctx: ExtensionContext, note: string, reason: string, humanReason: string): { block: true; reason: string } {
    if (ctx.hasUI && hardBlocks === 0) ctx.ui.notify(note, "warning");
    requestVinciAutomationStop(humanReason);
    sendVinciControl(pi, "vinci-loop-stop", reason);
    hardBlocks += 1;
    // The first three blocks deliver increasingly explicit stop-and-report guidance. A fourth tool
    // attempt means the guidance was ignored three times, so end the turn before it reaches the
    // public-corpus call ceiling or a wall-clock timeout.
    if (TURNSTOP && hardBlocks >= 4 && !stopScheduled) {
      stopScheduled = true;
      setTimeout(() => {
        try {
          ctx.abort();
        } catch {
          /* best-effort — the block already capped this call */
        }
      }, 200);
    }
    return { block: true, reason: "Vinci stopped a repeated action before it could run again." };
  }

  // A substantive assistant message = it's narrating findings and converging, so reset the
  // consecutive read-only streak. It must NOT refund the non-navigation action budget: a runaway can narrate
  // between every mutation and otherwise keep the turn alive forever (observed in the auth-migration
  // loop). Communication changes how the work feels; it is not proof that the work is converging.
  pi.on("message_end", async (event) => {
    const m = event.message;
    if (m.role !== "assistant" || m.stopReason === "error") return;
    const text = m.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof (c as { text?: unknown }).text === "string")
      .map((c) => c.text)
      .join(" ")
      .trim();
    if (text.length >= NARRATE_MIN) {
      readOnlyStreak = 0;
      exploreSteerSent = false;
    }
    // Narration nudger — the mechanical half of "narrate every step". A 9B's silent-tool-chain
    // prior beats a prompt bullet, so after every 4 consecutive tool rounds with no words we inject
    // a hidden mid-turn steer asking for ONE sentence. Narrating also resets the explore streak, so
    // a model that talks never meets the explore limits at all (a silent shell-analysis turn was blocked
    // and aborted, observed live — the fix is making silence rare, not raising the limits).
    const hasCalls = m.content.some((c) => c.type === "toolCall");
    if (text.length >= 30) {
      silentRounds = 0;
    } else if (hasCalls) {
      silentRounds++;
      if (silentRounds % 4 === 0 && narrationNudges < 3) {
        narrationNudges++;
        sendVinciControl(
          pi,
          "vinci-narrate-nudge",
          "You've taken several actions in a row without telling the user anything. Before your " +
            "next tool call, say one short plain-language sentence: what you found and what you're doing next. " +
            "If you have enough to answer, answer now instead.",
        );
      }
    }
  });

  // Keep a short trail of what happened, to hand a stronger teammate real context when stuck.
  // (Only genuinely-EXECUTED calls reach here — a blocked call skips afterToolCall in agent-core,
  // so this never sees a fixation block's own steer text. That's what makes the result-aware reset
  // below safe: lastResultSig only ever holds real tool output.)
  pi.on("tool_result", async (event, ctx) => {
    const result = Array.isArray(event.content)
      ? event.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join(" ")
      : "";
    // A failure = an error flag OR a known "didn't work" result (edit tools report these as plain text,
    // not isError): "could not find the exact text", "no changes made", "validation failed", overlap, …
    // Web-fetch failures ("page doesn't exist", "couldn't read/reach/resolve") count too, so a
    // guess-spiral of different fake URLs (each 404 → a different callKey the identical-detector
    // misses) still hits the consecutive-failure backstop after 4 in a row. Structured source
    // navigation is exempt: a missing path/range must not poison the later edit, while an identical
    // failed lookup is still caught by the result-aware fixation detector. Any success resets it.
    const failed =
      !isVerificationCall(event.toolName, event.input) &&
      (!!event.isError ||
        /could not find the exact text|no changes|validation failed|overlap|must match exactly|didn'?t match|required propert/i.test(result) ||
        /page doesn'?t exist|couldn'?t (?:read|reach|resolve)|took too long to load|resolves to an internal/i.test(result));
    errorStreak = failed && !READ_ONLY_TOOLS.has(event.toolName) ? errorStreak + 1 : 0;

    // Result-aware fixation: the identical-call counter (`seen`) is keyed on tool+args only, so three
    // `bash: npm test` calls with the SAME command but DIFFERENT output (polling a rebuild, re-running
    // a flaky test, a command with a real side effect) used to read as a stuck loop and get blocked —
    // even though each call made progress. Here, if a repeated call produced a result DIFFERENT from
    // its last one, that's genuine progress: drop its repeat count so the fixation ladder restarts.
    // Deliberately conservative — ANY difference (digits included) counts as progress, and this only
    // ever makes the blocker MORE lenient (the action ceiling + turn-stop still backstop a true runaway).
    // Matches vinci-degroove.ts's result-aware definition of "no progress" (PI_ARCHITECTURE.md §8).
    const key = callKey(event.toolName, event.input);
    const sig = result.replace(/\s+/g, " ").trim();
    const prevSig = lastResultSig.get(key);
    if (prevSig !== undefined && prevSig !== sig) seen.delete(key); // repeat made progress → restart streak
    lastResultSig.set(key, sig);
    if (failed && (event.toolName === "edit" || event.toolName === "write")) {
      failedMutationCalls.add(key);
    } else if (!failed && (event.toolName === "edit" || event.toolName === "write")) {
      trackedPathCache.delete(ctx.cwd);
      failedMutationCalls.clear();
      mutationSucceeded = true;
      postMutationInspections = 0;
    }

    recent.push({ tool: event.toolName, input: event.input, result, isError: !!event.isError });
    while (recent.length > RECENT_KEEP) recent.shift();
  });

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    const tool = event.toolName;
    // ask_user hands control back to the user — the designed exit every steer prescribes. Never block
    // it (the old code counted it as exploration and, past the limits, blocked even this — leaving a
    // steered model with no legal move at all).
    if (tool === "ask_user") return undefined;

    // The identical-fixation ladder (nudge → stronger teammate → stop-and-report) applies to actions
    // that can mutate state, fail repeatedly, or otherwise run away. Read-only navigation has a
    // separate recovery block below so it never escalates into abandoning the task.
    const fixation = async (key: string, n: number) => {
      interventions += 1;
      // TRY_DIFFERENT prescribes advisor/convene_council — arm the one-shot ceiling exemption so
      // the prescription isn't immediately blocked by the per-turn ceiling (round-2 audit P2-6).
      fixationAdvisorExemption = true;
      if (interventions === 1) {
        if (ctx.hasUI) ctx.ui.notify("Vinci was repeating itself — nudging it to try another way.", "info");
        sendVinciControl(pi, "vinci-loop-reframe", TRY_DIFFERENT);
        return { block: true as const, reason: "Vinci paused a repeated action to try another approach." };
      }
      if (interventions === 2) {
        // Notify AFTER getUnstuck resolves, worded by the path actually taken: with one frontier
        // tier serving, the climb never happens — announcing a "stronger teammate" up front was a
        // lie on every reframe/failure path (round-2 audit P2-5).
        const help = await getUnstuck(ctx, key, recent, task);
        if (ctx.hasUI) {
          ctx.ui.notify(
            help?.escalated
              ? "Vinci's stuck — asking a stronger teammate for a hand."
              : "Vinci's stuck — taking a fresh look at where it went wrong.",
            "info",
          );
        }
        sendVinciControl(pi, "vinci-loop-advice", help?.text ?? STOP_AND_REPORT);
        return { block: true as const, reason: "Vinci paused a repeated action and reconsidered it." };
      }
      return firmBlock(
        ctx,
        "Vinci's going in circles — telling it to stop and report where it's stuck. Press Ctrl+C to step in.",
        `${STOP_AND_REPORT}\n\n(Blocked repeat #${n} of this exact call — the result cannot change. Write your answer as plain text now.)`,
        "Vinci kept repeating the same action without progress.",
      );
    };

    const command = tool === "bash" ? String((event.input as { command?: unknown }).command ?? "") : "";
    if (tool === "bash" && isReadOnlyShellCommand(command, ctx.cwd)) {
      const key = callKey(tool, event.input);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n >= IDENTICAL_LIMIT) return fixation(key, n);
      readOnlyNavigationCalls += 1;
      if (readOnlyNavigationCalls > READ_ONLY_NAVIGATION_CEILING) {
        return firmBlock(
          ctx,
          "Vinci's been reading for a long time — telling it to stop and answer. Press Ctrl+C if you want to step in.",
          `${STOP_AND_REPORT}\n\n(Read-only call ${readOnlyNavigationCalls} this turn — over the navigation limit. Write your answer as plain text now.)`,
          "Vinci hit its per-turn navigation limit before finishing.",
        );
      }
      return undefined;
    }

    const verificationState = getVinciVerificationState();
    const checkClass = tool === "bash" ? classifyVerificationCommand(command) : undefined;
    const verificationCall = tool === "rerun_check" || isVerificationCall(tool, event.input);
    const commandIdentity = tool === "bash" ? contextualVerificationKey(command) : "";
    const recordedCommand = vinciVerificationCommand(verificationState);
    const requiredCommand = vinciRequiredVerificationCommand(verificationState);
    const recordedCommandKey =
      verificationState.variant === "normal"
        ? verificationState.commandKey
        : "";
    const requiredCommandKey =
      verificationState.variant === "normal"
        ? verificationState.requiredCommandKey
        : "";
    const recordedIdentity = contextualVerificationKey(
      recordedCommandKey || recordedCommand,
    );
    const requiredIdentity = contextualVerificationKey(
      requiredCommandKey || requiredCommand,
    );
    const recordedDirectoryMatch =
      verificationState.variant !== "normal" ||
      verificationState.commandCwd === undefined ||
      verificationState.commandCwd === ctx.cwd;
    const contextualIdentityMatch = Boolean(
      checkClass &&
      commandIdentity &&
      recordedDirectoryMatch &&
      ((recordedIdentity && commandIdentity === recordedIdentity) ||
        (requiredIdentity && commandIdentity === requiredIdentity)),
    );
    const higherClassCheck =
      verificationState.variant === "normal" &&
      !contextualIdentityMatch &&
      Boolean(checkClass && recordedCommand) &&
      vinciVerificationClassRank(checkClass) >
        vinciVerificationClassRank(vinciVerificationCheckClass(verificationState));
    const verifierFingerprint = [
      verificationState.variant,
      vinciVerificationMutationRevision(verificationState),
      vinciVerificationCheckClass(verificationState),
      recordedCommandKey || recordedCommand,
      verificationState.variant === "normal" ? verificationState.commandCwd ?? "" : "",
    ].join("\0");
    if (verifierFingerprint !== upgradeVerifierFingerprint) {
      upgradeVerifierFingerprint = verifierFingerprint;
      incompleteUpgradeAttempts = 0;
    }
    const upgradeAllowance =
      higherClassCheck && incompleteUpgradeAttempts < MAX_INCOMPLETE_UPGRADE_ATTEMPTS;
    if (upgradeAllowance) incompleteUpgradeAttempts++;

    if (verificationState.variant === "terminal-unverifiable" && verificationCall) {
      requestVinciAutomationStop(verificationState.summary, "verification");
      sendVinciControl(
        pi,
        "vinci-verification-terminal",
        "The saved verification state is unreadable and has no safe recovery command. Stop verification attempts and report this task as Blocked.",
      );
      return { block: true, reason: verificationState.summary };
    }
    const readOnlyNavigation = READ_ONLY_TOOLS.has(tool);
    calls += 1;
    if (!readOnlyNavigation) actionCalls += 1;
    if (!readOnlyNavigation && actionCalls > TURN_CALL_CEILING) {
      if (upgradeAllowance) return undefined;
      if (!finalVerificationUsed && (tool === "rerun_check" || isDirectVerificationCommand(command))) {
        finalVerificationUsed = true;
        return undefined;
      }
      // One-shot mirror of the verification escape above: a fixation steer prescribed asking a
      // teammate — the ceiling must not block the very tool the steer just prescribed (P2-6).
      if (fixationAdvisorExemption && (tool === "advisor" || tool === "convene_council")) {
        fixationAdvisorExemption = false;
        return undefined;
      }
      return firmBlock(
        ctx,
        "Vinci's been at this a while — telling it to stop and answer. Press Ctrl+C if you want to step in.",
        `${STOP_AND_REPORT}\n\n(Action ${actionCalls} this turn — over the limit. Write your answer as plain text now; further non-navigation calls will also be blocked.)`,
        "Vinci hit its per-turn action limit before finishing.",
      );
    }
    // A stronger check is the ratchet's upgrade path. Two attempts against one recorded verifier may
    // bypass reservations, but they still spend the ordinary action budget above. If neither attempt
    // records a result, later attempts follow normal pacing.
    if (upgradeAllowance) return undefined;

    if (
      mutationSucceeded &&
      verificationState.variant === "normal" &&
      checkClass &&
      (verificationState.status === "passed" ||
        verificationState.status === "stale" ||
        (verificationState.status === "failed" && Boolean(verificationState.requiredCommand))) &&
      tool === "bash" &&
      vinciVerificationClassRank(checkClass) <= vinciVerificationClassRank(verificationState.checkClass) &&
      !contextualIdentityMatch
    ) {
      sendVinciControl(
        pi,
        "vinci-verification-complete",
        "The latest mutation already has a passing verifier at this strength. Keep that evidence and write the completion and verification receipt now.",
      );
      return { block: true, reason: "Vinci kept the passing focused verification as the completion evidence." };
    }

    if (
      mutationSucceeded &&
      verificationState.variant === "normal" &&
      verificationState.status === "failed" &&
      /piped or compound check cannot prove success/i.test(verificationState.summary) &&
      tool !== "rerun_check" &&
      !contextualIdentityMatch &&
      verificationCall
    ) {
      sendVinciControl(pi, "vinci-verification-converge", "Call rerun_check now instead of broadening or retyping the filtered command.");
      return { block: true, reason: "Vinci reserved verification for the recorded direct rerun." };
    }

    // A talkative model can reset the consecutive exploration streak indefinitely while still
    // spending nearly the whole turn before its first edit. Live Express and Execa runs both found
    // the owning function, then widened into sibling layers after 18+ calls. This one-time steer does
    // not block the current action or reveal an expected file; it asks the model to commit to the
    // narrowest ownership point already supported by evidence. Read-only work is told to answer.
    // Plan mode is read-only BY DESIGN: steering toward "make one small edit" or reserving calls for
    // a mutation contradicts the mode and deadlocks against the plan gate (round-2 audit P1-1) — the
    // ownership/runway machinery is implementation pacing, so it is skipped entirely while planning.
    const planningMode = getVinciUiState().mode === "plan";
    if (
      !planningMode &&
      !mutationSucceeded &&
      !ownershipSteerSent &&
      calls >= PRE_MUTATION_STEER &&
      tool !== "edit" &&
      tool !== "write" &&
      !META_TOOLS.has(tool)
    ) {
      ownershipSteerSent = true;
      ownershipSteerCall = calls;
      if (ctx.hasUI) ctx.ui.notify("Vinci has inspected a lot — nudging it to choose the owning code.", "info");
      sendVinciControl(pi, "vinci-source-ownership", OWNERSHIP_STEER);
    }

    // A checkpoint without a mechanical consequence did not preserve enough runway in the live
    // Execa run: the model acknowledged it, spent five more calls on bespoke reproductions and
    // rereads, then hit the absolute ceiling immediately after its edit. Source navigation is now
    // exempt; after two grace calls this gate still bounds bespoke/non-navigation investigation and
    // leaves the action budget for edit, test, diagnosis, correction, and final proof.
    const preMutationVerification = verificationCall;
    const requiredOwnershipInspection = isPendingVinciSourceOwnershipInspection(tool, event.input);
    if (
      !planningMode &&
      !mutationSucceeded &&
      ownershipSteerCall > 0 &&
      calls > ownershipSteerCall + PRE_MUTATION_GRACE_CALLS &&
      tool !== "edit" &&
      tool !== "write" &&
      !META_TOOLS.has(tool) &&
      !GROUNDING_TOOLS.has(tool) &&
      !readOnlyNavigation &&
      !requiredOwnershipInspection
    ) {
      if (preMutationVerification && !preMutationVerificationUsed) {
        preMutationVerificationUsed = true;
      } else {
        if (!mutationRunwaySteerSent) {
          mutationRunwaySteerSent = true;
          if (ctx.hasUI) ctx.ui.notify("Vinci has enough evidence — reserving the remaining actions for the fix.", "info");
          sendVinciControl(pi, "vinci-mutation-runway", MUTATION_RUNWAY_STEER);
        }
        return { block: true, reason: "Vinci reserved the remaining actions for implementation or an answer." };
      }
    }

    // Thrashing: several tool calls in a row have failed (bad edits, invalid calls, failed writes).
    // Stop before it burns the whole turn retrying — this is what ran away for 2.3M tokens on a botched
    // file rewrite. One fresh chance after the steer, then we stop again if it keeps failing.
    if (errorStreak >= ERROR_LIMIT) {
      errorStreak = 0;
      if (ctx.hasUI) ctx.ui.notify("Several edits in a row failed — stopping to explain.", "info");
      sendVinciControl(pi, "vinci-error-streak", ERROR_STEER);
      return { block: true, reason: "Vinci paused after several failed actions." };
    }

    if (
      mutationSucceeded &&
      tool !== "edit" &&
      tool !== "write" &&
      !META_TOOLS.has(tool) &&
      !GROUNDING_TOOLS.has(tool) &&
      !readOnlyNavigation &&
      !verificationCall
    ) {
      postMutationInspections++;
      if (postMutationInspections > POST_MUTATION_INSPECTION_LIMIT) {
        sendVinciControl(pi, "vinci-post-mutation-runway", POST_MUTATION_STEER);
        return { block: true, reason: "Vinci reserved the remaining actions for verification or the final answer." };
      }
    }

    // A change to the project moved the world — legit to re-run OTHER things, so clear their repeat
    // counters. But the edit/write ITSELF repeating byte-identically is a loop like any other
    // (observed live: the gateway clamp truncated a `write`'s content mid-JSON, the model re-sent
    // the exact same truncated write again and again — silently rewriting the same incomplete
    // file, with nothing erroring). Keep the call's OWN count across the reset so the ladder fires.
    if (tool === "edit" || tool === "write") {
      const key = callKey(tool, event.input);
      const n = (seen.get(key) ?? 0) + 1;
      seen.clear();
      seen.set(key, n);
      readOnlyStreak = 0;
      exploreSteerSent = false;
      return (failedMutationCalls.has(key) && n >= 2) || n >= IDENTICAL_LIMIT ? fixation(key, n) : undefined;
    }

    // IDENTICAL fixation first — BEFORE the explore checks AND before the meta-tool exemption. It
    // used to run after the explore checks, so past EXPLORE_HARD the escalation ladder (nudge →
    // stronger teammate → stop) was unreachable and a fixated model got the SAME steer verbatim
    // forever — 12 identical block/retry rounds observed live. And meta tools must NOT skip this:
    // an identical `todo` update repeated verbatim is a loop too (observed live: three identical
    // todo calls after a length-cut "continue", uncaught while meta tools bypassed everything).
    const key = callKey(tool, event.input);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (readOnlyNavigation && n >= IDENTICAL_LIMIT) {
      sendVinciControl(pi, "vinci-read-recovery", `${READ_RECOVERY_STEER}\n\n(Exact lookup repeat #${n}.)`);
      return {
        block: true,
        reason: "Vinci paused this identical lookup. Read the whole file, use another path/offset, or search a different pattern.",
      };
    }
    if (n >= IDENTICAL_LIMIT) return fixation(key, n);

    // Meta tools + grounding (web) tools aren't the aimless exploration the explore detector targets —
    // a `todo` update, a teammate ask, or a search-again-after-a-miss must not trip it. They still
    // count toward the turn ceiling and the identical-fixation check above, nothing else.
    if (META_TOOLS.has(tool) || GROUNDING_TOOLS.has(tool)) return undefined;

    // A test/check/build is the action a healthy investigation should converge on. Let it run even
    // at the exploration threshold and restart the read-only allowance for any follow-up diagnosis.
    if (isVerificationCall(tool, event.input)) {
      if (!mutationSucceeded && ownershipSteerCall > 0) preMutationVerificationUsed = true;
      readOnlyStreak = 0;
      exploreSteerSent = false;
      return undefined;
    }

    // Runaway exploration: many inspections in a row with no edit can be broad, non-converging work.
    // Structured source navigation gets a soft convergence steer and remains available. Bespoke shell
    // investigation is still hard-stopped after the steer because a stuck model re-sends the growing
    // context on every blocked attempt (observed: 1.4M in one turn). Substantive narration resets the
    // streak (see message_end above), so a healthy review turn never trips it.
    readOnlyStreak += 1;
    if (readOnlyNavigation) {
      // Structured navigation shares the cumulative budget with read-only shell calls: varied
      // reads never repeat, so without this they are the same unbounded paid loop (round-12 P0).
      readOnlyNavigationCalls += 1;
      if (readOnlyNavigationCalls > READ_ONLY_NAVIGATION_CEILING) {
        return firmBlock(
          ctx,
          "Vinci's been reading for a long time — telling it to stop and answer. Press Ctrl+C if you want to step in.",
          `${STOP_AND_REPORT}\n\n(Read-only call ${readOnlyNavigationCalls} this turn — over the navigation limit. Write your answer as plain text now.)`,
          "Vinci hit its per-turn navigation limit before finishing.",
        );
      }
      if (readOnlyStreak >= EXPLORE_LIMIT && !exploreSteerSent) {
        exploreSteerSent = true;
        if (ctx.hasUI) ctx.ui.notify("Vinci's inspected a lot — nudging it to use or refine the evidence.", "info");
        sendVinciControl(pi, "vinci-read-convergence", READ_CONVERGENCE_STEER);
      }
      return undefined;
    }
    if (readOnlyStreak >= EXPLORE_HARD) {
      return firmBlock(
        ctx,
        "Vinci keeps exploring in circles — telling it to stop and answer. Press Ctrl+C to step in and ask something specific.",
        `${EXPLORE_STEER}\n\n(Read-only call #${readOnlyStreak} without answering — write what you know as plain text now.)`,
        "Vinci kept reading without reaching an answer.",
      );
    }
    if (readOnlyStreak >= EXPLORE_LIMIT) {
      if (!exploreSteerSent) {
        exploreSteerSent = true;
        if (ctx.hasUI) ctx.ui.notify("Vinci's been exploring a lot — nudging it to act or ask.", "info");
        sendVinciControl(pi, "vinci-explore-limit", EXPLORE_STEER);
      }
      return { block: true, reason: "Vinci paused broad exploration to synthesize what it found." };
    }
    return undefined;
  });
}
