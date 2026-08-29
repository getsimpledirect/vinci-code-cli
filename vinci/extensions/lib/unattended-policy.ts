/**
 * The `governed` unattended policy profile (W2).
 *
 * ── The problem this exists for ────────────────────────────────────────────────────────────────
 * Across 430 real unattended worker runs (2026-08-29/30) three tasks died inside `blockHeadless()`
 * in vinci-guard.ts. Two were "run a command that needs the internet"; one was "read a file that may
 * contain credentials". None of the three was a SAFETY refusal — each was an INTERACTION-MODEL
 * artifact: the interactive UX would have opened a confirmation dialog, the run had no UI, so the
 * gate degraded into a dead end whose text ("tell the user this step is waiting on their go-ahead")
 * is addressed to a human who does not exist. In a governed fleet the authority question is already
 * answered upstream by the Governor lease, so a confirmation dialog is the wrong mechanism.
 *
 * ── What this module is NOT ────────────────────────────────────────────────────────────────────
 * It is not a bypass, and it is not reachable by accident. Three facts must ALL hold:
 *
 *   1. `VINCI_UNATTENDED_POLICY=governed` — an explicit operator opt-in. Unset (the default, and
 *      what every CI job, script and other headless caller sees) means the guard behaves exactly as
 *      it does today, byte for byte.
 *   2. `VINCI_UNATTENDED_LEASE=<token>` — the worker daemon sets this ONLY after
 *      `claimGovernorPaths()` returned a granted lease, and explicitly DELETES both variables on
 *      every other path, so a daemon whose own environment happens to carry the profile cannot leak
 *      it into an ungoverned child.
 *   3. The token carries an `#expires=<ISO-8601>` bound that has not passed. A token without a
 *      parseable expiry is rejected: an unbounded grant is not a lease.
 *
 * ── What is ENFORCED vs what is merely TRUE ────────────────────────────────────────────────────
 * Be precise about this, because a permission system that overstates itself is worse than one that
 * does less. What the code ENFORCES is: the opt-in string is present, a lease token is present, and
 * the token's expiry is in the future. That is a cooperative signal plus a time bound — NOT proof
 * that a Governor granted anything. The token is not signed and the guard has no key to verify one
 * against, so ANYTHING that can set this child's environment can set the pair, and a `vinci -p`
 * launched in CI with both exported would get the relaxed guard.
 *
 * What is TRUE but not enforced here: `vinci/worker/governor.mjs::unattendedPolicyEnv()` is the only
 * producer of either variable in this repository, and it produces them only on a granted lease. That
 * is a property of this codebase, checkable by grep, not a control this module imposes.
 *
 * The controls that actually carry the safety argument are therefore: (a) the relaxed set is TINY
 * and fail-closed — one allowlisted dev-toolchain network case and the unrequested-checkpoint gate,
 * with every safety guard untouched; (b) every relaxation is durably recorded or it is not granted;
 * (c) the expiry bounds the window to the lease TTL. Not the env pair on its own.
 *
 * The env var alone is deliberately not enough. An unattended run with no authority behind it is
 * exactly the run that should keep the conservative gate: there is nothing upstream that answered
 * the authority question, so nothing downstream may assume it was answered.
 *
 * ── Three buckets, three records ───────────────────────────────────────────────────────────────
 * The whole point of the profile is that "the run was allowed to skip a check" must never look like
 * "the run worked". Every gate the profile touches emits exactly one decision:
 *
 *   BLOCKED   — a KEEP-BLOCKING guard. Safety, not interaction. Still a hard block under the
 *               profile; the profile only makes the block machine-readable.
 *   ESCALATED — a consequential action the Governor COULD authorize but the guard must not
 *               self-grant. The run still stops, but it stops with a structured reason naming the
 *               gate and the grantor instead of a prose apology aimed at nobody.
 *   PROCEEDED — a pure interaction artifact under a governed lease. Allowed, and RECORDED, so a
 *               reader downstream can always tell it happened.
 *
 * Decisions are held in-process (for the closing handoff and for tests) and, when the host supports
 * it, appended to the session transcript as `vinci-unattended-policy` entries so the worker daemon
 * can read them back out of the JSONL and put the three counts in the terminal post.
 */

/** Session-transcript custom entry type. The worker's session-read.mjs anchors on this string. */
export const VINCI_UNATTENDED_POLICY_ENTRY = "vinci-unattended-policy";

/** How a gate was resolved under the profile. One value per held action, never conflated. */
export type UnattendedOutcome = "BLOCKED" | "ESCALATED" | "PROCEEDED";

export type UnattendedProfile = {
  /** Always "governed" today; a named profile so a future second profile cannot be confused with it. */
  profile: "governed";
  /** Lease token the daemon stamped in. Non-empty and carrying a future `#expires=` by construction. */
  lease: string;
  /** The token's expiry, already validated as parseable and in the future. */
  expiresAt: string;
};

export type UnattendedDecision = {
  outcome: UnattendedOutcome;
  /** Stable identifier of the guard call site (see GATE_SITES in vinci-guard.ts). */
  site: string;
  /** The human-readable action the gate held, verbatim from the guard. */
  gate: string;
  lease: string;
};

type EnvLike = Record<string, string | undefined>;

/**
 * The profile, or null. Null means "behave exactly as today" — every caller treats it that way, so
 * there is one place where the opt-in is decided and it cannot drift per call site.
 *
 * BOTH conditions are load-bearing:
 *   - a wrong/absent profile name means the operator did not opt in;
 *   - an absent lease means no Governor authority backs this run, and the profile's entire
 *     justification is that the authority question was already answered upstream.
 */
export function unattendedPolicyProfile(env: EnvLike = process.env): UnattendedProfile | null {
  if (env.VINCI_UNATTENDED_POLICY?.trim() !== "governed") return null;
  const lease = env.VINCI_UNATTENDED_LEASE?.trim();
  if (!lease) return null;
  // The expiry is REQUIRED and enforced. A lease that cannot say when it stops being a lease is not
  // a lease, and without this the profile would outlive the Governor lease that justified it for as
  // long as the process ran. This does not make the token unforgeable — nothing here can — but it
  // does mean the grant is bounded rather than permanent, which is the difference between a window
  // and a standing permission.
  const expires = /#expires=([^#\s]+)$/.exec(lease)?.[1];
  if (!expires) return null;
  const expiresAtMs = Date.parse(expires);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
  return { profile: "governed", lease, expiresAt: new Date(expiresAtMs).toISOString() };
}

/** Convenience predicate. Same two conditions; never re-derive them anywhere else. */
export function isGovernedUnattended(env: EnvLike = process.env): boolean {
  return unattendedPolicyProfile(env) !== null;
}

// ── Decision store ─────────────────────────────────────────────────────────────────────────────
// Same globalThis-keyed pattern as lib/control.ts's confirmation-gate store: extensions are loaded
// more than once in some hosts, and a module-local array would silently split the record in two.
const DECISION_STORE_KEY = "__vinciUnattendedPolicyStore" as const;
type DecisionGlobal = typeof globalThis & { [DECISION_STORE_KEY]?: { decisions: UnattendedDecision[] } };
const decisionGlobal = globalThis as DecisionGlobal;
const decisionStore = decisionGlobal[DECISION_STORE_KEY] ?? { decisions: [] };
if (!Array.isArray(decisionStore.decisions)) decisionStore.decisions = [];
decisionGlobal[DECISION_STORE_KEY] = decisionStore;

function clean(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

export function recordUnattendedDecision(decision: UnattendedDecision): UnattendedDecision {
  const entry: UnattendedDecision = {
    outcome: decision.outcome,
    site: clean(decision.site),
    gate: clean(decision.gate),
    lease: clean(decision.lease),
  };
  decisionStore.decisions.push(entry);
  return entry;
}

export function getUnattendedDecisions(): readonly UnattendedDecision[] {
  return decisionStore.decisions;
}

export function clearUnattendedDecisions(): void {
  decisionStore.decisions.length = 0;
}

export type UnattendedSummary = { blocked: number; escalated: number; proceeded: number };

/**
 * The three counts, kept separate on purpose. A run stopped by a KEEP-BLOCKING guard, a run that
 * ESCALATED, and a run that PROCEEDED under the profile must be distinguishable downstream —
 * collapsing any two of them is the exact defect this profile exists to remove.
 */
export function summarizeUnattendedDecisions(
  decisions: readonly UnattendedDecision[] = getUnattendedDecisions(),
): UnattendedSummary {
  const summary: UnattendedSummary = { blocked: 0, escalated: 0, proceeded: 0 };
  for (const decision of decisions) {
    if (decision.outcome === "BLOCKED") summary.blocked += 1;
    else if (decision.outcome === "ESCALATED") summary.escalated += 1;
    else if (decision.outcome === "PROCEEDED") summary.proceeded += 1;
  }
  return summary;
}

/**
 * The machine-readable trailer every profile decision carries. This is the part today's
 * `Blocked (X) — no UI to confirm this…` cannot offer: a downstream reader can route on
 * `outcome=` and `site=` without parsing prose, and `grantor=` names who could actually
 * unblock it instead of an absent "user".
 */
export function unattendedDecisionTag(decision: UnattendedDecision): string {
  return `[vinci-unattended outcome=${decision.outcome} site=${decision.site} gate="${decision.gate}" grantor=governor lease=${decision.lease}]`;
}

/**
 * The ESCALATE terminal text. Deliberately NOT "waiting on their go-ahead": nobody is at a
 * keyboard. It tells the model to stop and let the run end BLOCKED, and it tells the fleet what
 * was needed and who could grant it.
 */
export function escalationReason(decision: UnattendedDecision, extra = ""): string {
  return (
    `Blocked (${decision.gate}) — held for Governor authorization. This unattended run holds a ` +
    `Governor lease, but that lease does not grant this action, and there is no human here to ` +
    `grant it either. Do NOT work around it and do NOT retry: make the code changes you can, then ` +
    `stop and let this run end BLOCKED naming this step, so the Governor can widen the work order ` +
    `and re-dispatch.${extra ? ` ${extra}` : ""} ${unattendedDecisionTag(decision)}`
  );
}

/**
 * The terminal text for a PROCEED that could not be recorded durably. This is a refusal, and it says
 * why in a way an operator can act on: the gate itself would have been allowed, so the thing to fix
 * is the transcript, not the command.
 */
export function unrecordableProceedReason(decision: UnattendedDecision, extra = ""): string {
  return (
    `Blocked (${decision.gate}) — the governed unattended profile would have allowed this, but it ` +
    `could not durably record the decision, and an unrecorded relaxation is not granted. This is an ` +
    `instrument failure, not a policy decision: the session transcript could not be appended to. Do ` +
    `not retry or work around it; stop and let this run end BLOCKED so the operator can fix the ` +
    `session store.${extra ? ` ${extra}` : ""} ` +
    `[vinci-unattended outcome=BLOCKED site=${decision.site} gate="${decision.gate}" ` +
    `grantor=governor lease=${decision.lease} cause=unrecordable]`
  );
}

/**
 * The KEEP-BLOCKING terminal text. Same refusal as today plus the routable trailer — the wording
 * stays a refusal because these sites are safety, not interaction, and no lease widens them.
 */
export function keepBlockingReason(decision: UnattendedDecision, extra = ""): string {
  return (
    `Blocked (${decision.gate}) — refused by a safety guard that a Governor lease does not override. ` +
    `This is not a missing confirmation: the action stays blocked in a governed unattended run. Do ` +
    `not retry it or achieve the same effect another way.${extra ? ` ${extra}` : ""} ` +
    `${unattendedDecisionTag(decision)}`
  );
}
