/**
 * Shared Vinci presentation state.
 *
 * Pi remains responsible for the agent runtime. Vinci extensions publish a small, semantic view
 * model here so the shell never has to infer product state from raw tool output or model text.
 */

export type VinciConnectionState = "unknown" | "signed-in" | "connected" | "reconnect" | "signed-out";
export type VinciMode = "auto" | "plan";
export type VinciActivityState = "idle" | "working" | "verifying";
export type VinciPlanStep = { title: string; status: "todo" | "doing" | "done" };

export type VinciUiState = {
  connection: VinciConnectionState;
  mode: VinciMode;
  plan: readonly VinciPlanStep[];
  activity: VinciActivityState;
  working: boolean;
  workingLabel: string;
  workingSince: number | undefined;
  continuationPending: boolean;
};

type VinciUiStore = {
  listeners: Set<() => void>;
  state: VinciUiState;
};

const STORE_KEY = "__vinciUiStateStore" as const;
type VinciGlobal = typeof globalThis & { [STORE_KEY]?: VinciUiStore };
const vinciGlobal = globalThis as VinciGlobal;
const store =
  vinciGlobal[STORE_KEY] ??
  {
    listeners: new Set<() => void>(),
    state: {
      connection: "unknown",
      mode: "auto",
      plan: [],
      activity: "idle",
      working: false,
      workingLabel: "Contemplating…",
      workingSince: undefined,
      continuationPending: false,
    },
  } satisfies VinciUiStore;
vinciGlobal[STORE_KEY] = store;

function publish(next: VinciUiState): void {
  store.state = next;
  for (const listener of store.listeners) listener();
}

export function resetVinciUiState(): void {
  publish({
    connection: "unknown",
    mode: "auto",
    plan: [],
    activity: "idle",
    working: false,
    workingLabel: "Contemplating…",
    workingSince: undefined,
    continuationPending: false,
  });
}

/** Reset presentation state owned by the shell without clearing auth/connection state. */
export function resetShellUiState(): void {
  publish({
    ...store.state,
    plan: [],
    activity: "idle",
    working: false,
    workingLabel: "Contemplating…",
    workingSince: undefined,
    continuationPending: false,
  });
}

export function getVinciUiState(): VinciUiState {
  return store.state;
}

export function setVinciConnection(connection: VinciConnectionState): void {
  if (store.state.connection === connection) return;
  publish({ ...store.state, connection });
}

export function setVinciMode(mode: VinciMode): void {
  if (store.state.mode === mode) return;
  publish({ ...store.state, mode });
}

export function setVinciPlan(plan: readonly VinciPlanStep[]): void {
  publish({ ...store.state, plan: plan.map((step) => ({ ...step })) });
}

export function setVinciWorking(working: boolean, label?: string): void {
  publish({
    ...store.state,
    activity: working ? "working" : "idle",
    working,
    workingLabel: label?.trim() || (working ? store.state.workingLabel : "Contemplating…"),
    workingSince: working ? (store.state.working ? store.state.workingSince : Date.now()) : undefined,
  });
}

export function setVinciActivity(activity: VinciActivityState): void {
  if (store.state.activity === activity) return;
  publish({ ...store.state, activity });
}

export function setVinciWorkingLabel(label: string): void {
  const clean = label.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || clean === store.state.workingLabel) return;
  publish({ ...store.state, workingLabel: clean });
}

/** Keep the shell visibly alive while a hidden follow-up crosses an agent-run boundary. */
export function setVinciContinuationPending(pending: boolean): void {
  if (store.state.continuationPending === pending) return;
  publish({
    ...store.state,
    continuationPending: pending,
    activity: pending ? "working" : store.state.activity,
    working: pending ? true : store.state.working,
    workingLabel: pending ? "Continuing the task…" : store.state.workingLabel,
    workingSince: pending ? (store.state.workingSince ?? Date.now()) : store.state.workingSince,
  });
}

export function subscribeVinciUiState(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}
