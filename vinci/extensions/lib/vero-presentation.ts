import type { VinciLookToken } from "./cli-look.ts";
import { getVinciUiState } from "./ui-state.ts";

type WorkLabel = "Ready" | "Thinking" | "Done" | "Error" | "Not sure" | "Blocked" | "Needs your OK" | "Waiting for you";
type VeroPresentation = { label: WorkLabel; token: VinciLookToken; detail?: string };

type VeroPresentationSources = {
  automationStopped?: () => boolean;
  taskOutcomeState?: () => string | undefined;
};

const SOURCES_KEY = "__vinciVeroPresentationSources" as const;
type VinciGlobal = typeof globalThis & { [SOURCES_KEY]?: VeroPresentationSources };
const vinciGlobal = globalThis as VinciGlobal;
const sources = vinciGlobal[SOURCES_KEY] ?? {};
vinciGlobal[SOURCES_KEY] = sources;

export function registerVeroAutomationStopSource(fn: () => boolean): void {
  sources.automationStopped = fn;
}

export function registerVeroTaskOutcomeSource(fn: () => string | undefined): void {
  sources.taskOutcomeState = fn;
}

export function getVeroPresentation(): VeroPresentation {
  const ui = getVinciUiState();
  if (ui.promptState === "approval") return { label: "Needs your OK", token: "warning" };
  if (ui.promptState === "input") return { label: "Waiting for you", token: "warning" };
  if (ui.providerError) return { label: "Error", token: "error", detail: ui.providerError };
  const stopped = sources.automationStopped?.() ?? false;
  if (stopped || ui.blockingReason) return { label: "Blocked", token: "error" };
  if (ui.working || ui.continuationPending) {
    const detail = ui.activity === "verifying" ? "Checking..." :
      ui.workingLabel === "Contemplating…" ? undefined : ui.workingLabel;
    return { label: "Thinking", token: "accent", detail };
  }
  switch (sources.taskOutcomeState?.()) {
    case "BLOCKED": return { label: "Blocked", token: "error" }; // canonical-rendering: local task state selects the status label
    case "WAITING": return { label: "Waiting for you", token: "warning" };
    case "DONE_UNVERIFIED": return { label: "Not sure", token: "link" };
    case "DONE": return { label: "Done", token: "success" };
    default: return { label: "Ready", token: "muted" };
  }
}
