/**
 * Vinci cachewatch — VERIFY prefix-cache hygiene (roadmap #52 code half; GAP_ANALYSIS).
 *
 * OPS_ASKS #2 asserts "the CLI prefix is already cache-friendly." That was an UNVERIFIED claim — the
 * exact overclaim pattern the verification system exists to kill. This turns it into a MEASUREMENT.
 *
 * For vLLM automatic prefix caching, the request's leading tokens must be byte-stable turn-to-turn: a
 * cache hit covers the longest identical PREFIX of (system message → tool defs → message history).
 * The first divergent token ends the reuse. So the two things that matter are (1) does the FOUNDATION
 * (system message + tool definitions) stay identical — if it changes, reuse is 0% that turn — and
 * (2) how many leading messages are byte-identical to last turn (= the cache-eligible prefix length).
 *
 * On every provider request this hashes both and reports them. It is DIAGNOSTIC ONLY — it returns
 * nothing, so the request passes through untouched (runner keeps the payload when a handler returns
 * undefined), and a throw is caught by the runner. Zero-cost when off: the handler is only registered
 * when VINCI_CACHE_DEBUG=1. Trust the check, not the claim.
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const h = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 12);

export type PrefixSnapshot = { sys: string; tools: string; msgs: string[] };

/** Reduce a provider request payload to stable hashes of its cacheable regions. */
export function snapshotPayload(payload: unknown): PrefixSnapshot | null {
  const messages = (payload as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return null;
  const first = messages[0] as { role?: string } | undefined;
  const sys = first && first.role === "system" ? h(JSON.stringify(first)) : "(no-system)";
  const tools = h(JSON.stringify((payload as { tools?: unknown })?.tools ?? []));
  const msgs = messages.map((m) => h(JSON.stringify(m)));
  return { sys, tools, msgs };
}

export type PrefixAnalysis = {
  /** system message + tool defs byte-identical to the previous turn (else reuse is 0% this turn) */
  foundationStable: boolean;
  /** which of ["system","tools"] changed since last turn */
  changed: string[];
  /** count of leading messages byte-identical to last turn = the cache-eligible prefix length */
  commonPrefix: number;
  /** messages in this request */
  total: number;
};

/** Compare this turn's snapshot to the previous one: is the foundation stable, and how long is the
 *  shared message prefix? First turn (prev === null) is the baseline. */
export function analyzePrefix(prev: PrefixSnapshot | null, curr: PrefixSnapshot): PrefixAnalysis {
  if (!prev) return { foundationStable: true, changed: [], commonPrefix: 0, total: curr.msgs.length };
  const changed: string[] = [];
  if (prev.sys !== curr.sys) changed.push("system");
  if (prev.tools !== curr.tools) changed.push("tools");
  let commonPrefix = 0;
  const n = Math.min(prev.msgs.length, curr.msgs.length);
  while (commonPrefix < n && prev.msgs[commonPrefix] === curr.msgs[commonPrefix]) commonPrefix++;
  return { foundationStable: changed.length === 0, changed, commonPrefix, total: curr.msgs.length };
}

/** One human-readable status line per turn. */
export function formatLine(turn: number, snap: PrefixSnapshot, a: PrefixAnalysis): string {
  if (turn === 1) return `[vinci-cache] turn 1 baseline · ${a.total} msgs · sys=${snap.sys} tools=${snap.tools}`;
  if (a.foundationStable) return `[vinci-cache] turn ${turn} prefix STABLE · ${a.commonPrefix}/${a.total} msgs cache-eligible`;
  return `[vinci-cache] turn ${turn} prefix BUSTED (${a.changed.join("+")} changed) · only ${a.commonPrefix}/${a.total} msgs cache-eligible`;
}

export default function (pi: ExtensionAPI) {
  // Zero-cost unless explicitly debugging: register nothing when off (upstream/normal runs untouched).
  if (process.env.VINCI_CACHE_DEBUG !== "1") return;
  let prev: PrefixSnapshot | null = null;
  let turn = 0;
  pi.on("before_provider_request", async (event) => {
    const curr = snapshotPayload((event as { payload?: unknown }).payload);
    if (!curr) return; // unknown payload shape → observe nothing, never touch the request
    turn++;
    const a = analyzePrefix(prev, curr);
    prev = curr;
    process.stderr.write(`${formatLine(turn, curr, a)}\n`);
    // Diagnostic only: return nothing so the runner keeps the payload untouched.
  });
}
