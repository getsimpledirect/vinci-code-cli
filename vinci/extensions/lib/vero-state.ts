/** Vero explains observed activity; the completion receipt remains the evidence. */
import { getVinciAutomationStop } from "./control.ts";
import { getVinciTaskOutcome } from "./task-outcome.ts";
import { getVinciUiState } from "./ui-state.ts";

export type VeroPose = "pixel" | "rich" | "working" | "review" | "blocked" | "done";
export type VeroPresentation = { pose: VeroPose; label: string; nextAction: string };

export function getVeroPresentation(): VeroPresentation {
  const ui = getVinciUiState();
  const stop = getVinciAutomationStop();
  if (stop.stopped || ui.blockingReason) {
    return { pose: "blocked", label: "BLOCKED", nextAction: "Resolve the blocker." };
  }
  if (ui.activity === "verifying") {
    return { pose: "review", label: "REVIEW", nextAction: "Checking; no verdict yet." };
  }
  if (ui.working || ui.continuationPending) {
    return { pose: "working", label: "WORKING", nextAction: ui.workingLabel };
  }
  const outcome = getVinciTaskOutcome();
  if (outcome?.state === "BLOCKED") {
    return { pose: "blocked", label: "BLOCKED", nextAction: "Resolve the blocker." };
  }
  if (outcome?.state === "WAITING") {
    return { pose: "review", label: "WAITING", nextAction: "Answer or approve." };
  }
  if (outcome?.state === "DONE_UNVERIFIED") {
    return { pose: "review", label: "DONE-UNVERIFIED", nextAction: "Check the result." };
  }
  if (outcome?.state === "DONE") {
    return { pose: "done", label: "DONE", nextAction: "Read the receipt." };
  }
  return { pose: "pixel", label: "READY", nextAction: "Ask Vinci to begin a task." };
}

export function vinciPlainPresentation(): boolean {
  return process.env.NO_COLOR !== undefined || process.env.TERM === "dumb" ||
    process.env.VINCI_PLAIN === "1" || process.env.VINCI_SCREEN_READER === "1";
}

export function vinciReducedMotion(): boolean {
  return vinciPlainPresentation() || process.env.VINCI_REDUCED_MOTION === "1";
}
