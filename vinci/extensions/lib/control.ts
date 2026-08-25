/** Send model-only guidance without putting implementation instructions in the visible transcript. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  recordRemoteAcceptanceVerdict as recordVerificationRemoteAcceptanceVerdict,
  type RemoteAcceptanceVerdict,
} from "./verification-state.ts";

export type VinciAutomationStop = {
  stopped: boolean;
  reason: string;
  // Who latched the stop: "verification" (the check loop itself) or "other" (loopbreak, todo-stall…).
  // A foreign stop's reason is user-relevant — the closing BLOCKED message quotes it instead of an
  // unrelated verification summary (sweep P2-5).
  source: "verification" | "other";
};

type VinciAutomationStopStore = {
  state: VinciAutomationStop;
};

const STOP_STORE_KEY = "__vinciAutomationStopStore" as const;
type VinciGlobal = typeof globalThis & { [STOP_STORE_KEY]?: VinciAutomationStopStore };
const vinciGlobal = globalThis as VinciGlobal;
const stopStore = vinciGlobal[STOP_STORE_KEY] ?? { state: { stopped: false, reason: "", source: "other" as const } };
vinciGlobal[STOP_STORE_KEY] = stopStore;

export function getVinciAutomationStop(): Readonly<VinciAutomationStop> {
  return stopStore.state;
}

export function requestVinciAutomationStop(reason: string, source: "verification" | "other" = "other"): void {
  stopStore.state = {
    stopped: true,
    reason: reason.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim(),
    source,
  };
}

export function clearVinciAutomationStop(): void {
  stopStore.state = { stopped: false, reason: "", source: "other" };
}

// Consequential actions (a DB migration, an outward call, a system change) the guard held for the
// user's confirmation in a run with no UI to ask. The guard records each held action here when it
// blocks; the verification extension reads them so an unverifiable mutation closes as an honest handoff
// naming the held steps, instead of looping recovery into a misleading generic BLOCKED. A blocked
// tool_call never emits a tool_result, so the guard (which owns the block) is the only place that
// observes this. A LIST, not a slot: one task can gate several steps (migrate, then deploy) and the
// handoff must name them all in the order they were attempted — naming only the last one invites the
// user to run it without its prerequisites. Cleared on new user input (a new/amended task), a passing
// check, or handoff consumption.
const GATE_STORE_KEY = "__vinciConfirmationGateStore" as const;
type VinciGateGlobal = typeof globalThis & { [GATE_STORE_KEY]?: { actions: string[] } };
const gateGlobal = globalThis as VinciGateGlobal;
const gateStore = gateGlobal[GATE_STORE_KEY] ?? { actions: [] };
if (!Array.isArray(gateStore.actions)) gateStore.actions = [];
gateGlobal[GATE_STORE_KEY] = gateStore;

export function recordVinciConfirmationGate(action: string): void {
  const clean = action.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (clean && !gateStore.actions.includes(clean)) gateStore.actions.push(clean);
}

export function getVinciConfirmationGates(): readonly string[] {
  return gateStore.actions;
}

export function clearVinciConfirmationGate(): void {
  gateStore.actions.length = 0;
}

// Set by factcheck when it withholds/disclaims a current-or-version fact this turn. The completion
// receipt (loaded last) reads it so a verified CODE change doesn't append a bare "Verification passed"
// that a non-programmer reads as validating the disclaimed FACT — the two are about different subjects
// (round-2 outward-capability audit). Cleared on new user input / session start.
const FACT_DISCLAIMER_KEY = "__vinciFactDisclaimerStore" as const;
type VinciFactGlobal = typeof globalThis & { [FACT_DISCLAIMER_KEY]?: { disclaimed: boolean } };
const factGlobal = globalThis as VinciFactGlobal;
const factStore = factGlobal[FACT_DISCLAIMER_KEY] ?? { disclaimed: false };
factGlobal[FACT_DISCLAIMER_KEY] = factStore;

export function recordVinciFactDisclaimer(): void {
  factStore.disclaimed = true;
}

export function getVinciFactDisclaimer(): boolean {
  return factStore.disclaimed;
}

export function clearVinciFactDisclaimer(): void {
  factStore.disclaimed = false;
}

// The verification extension owns the only closure that can append a snapshot to the session branch
// (it needs `pi.appendEntry`). Other extensions that mutate the in-memory verification state — notably
// `/undo`, which reverts the tree and marks the prior "passed" stale — must be able to DURABLY record
// that change, or a hard kill in the window before the next event leaves the branch holding the old
// "passed" and resume re-blesses a reverted tree as verified (session-lifecycle audit P1). verification
// registers its persist closure here; undo calls it right after recordVinciMutation().
const PERSIST_STORE_KEY = "__vinciPersistVerificationStore" as const;
type VinciPersistGlobal = typeof globalThis & { [PERSIST_STORE_KEY]?: { persist: (() => void) | null } };
const persistGlobal = globalThis as VinciPersistGlobal;
const persistStore = persistGlobal[PERSIST_STORE_KEY] ?? { persist: null };
persistGlobal[PERSIST_STORE_KEY] = persistStore;

export function setVinciPersistVerification(fn: (() => void) | null): void {
  persistStore.persist = fn;
}

export function persistVinciVerificationState(): void {
  try {
    persistStore.persist?.();
  } catch {
    /* best-effort; a persist failure must never break the caller (undo, etc.) */
  }
}

export function sendVinciControl(pi: ExtensionAPI, customType: string, content: string): void {
  pi.sendMessage(
    {
      customType,
      display: false,
      content,
    },
    { triggerTurn: false, deliverAs: "steer" },
  );
}

// Record a remote acceptance verdict into the verification store. Best-effort: failures never break the caller.
type RemoteAcceptanceVerdictInput = {
  status?: string;
  summary?: string;
  snapshotDigest?: string;
  jobId?: string;
  reportUrl?: string;
  eventCursor?: string;
};

function isRemoteAcceptanceVerdictStatus(
  status: string | undefined,
): status is RemoteAcceptanceVerdict["status"] {
  return (
    status === "VERIFIED_PASS" ||
    status === "BLOCKED" ||
    status === "CONDITIONAL" ||
    status === "FAILED" ||
    status === "CANCELLED"
  );
}

export function recordRemoteAcceptanceVerdict(verdict: RemoteAcceptanceVerdictInput): boolean {
  try {
    if (!isRemoteAcceptanceVerdictStatus(verdict.status)) {
      console.warn("[Vinci acceptance] Remote verdict was not recorded: invalid status.");
      return false;
    }
    const recorded = recordVerificationRemoteAcceptanceVerdict({
      status: verdict.status,
      summary: verdict.summary || "",
      snapshotDigest: verdict.snapshotDigest || "",
      jobId: verdict.jobId || "",
      ...(verdict.reportUrl ? { reportUrl: verdict.reportUrl } : {}),
      ...(verdict.eventCursor ? { eventCursor: verdict.eventCursor } : {}),
    });
    if (!recorded) {
      console.warn("[Vinci acceptance] Remote verdict failed verification-state validation.");
      return false;
    }
    persistVinciVerificationState();
    return true;
  } catch (error) {
    console.warn(
      `[Vinci acceptance] Remote verdict recording failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
