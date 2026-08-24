import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const VINCI_TASK_USAGE_ENTRY = "vinci-task-usage";

export type VinciAccumulatedUsage = {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
  providers: string[];
  models: string[];
};

export type VinciUsageCall = {
  id: string;
  source: string;
  responseKey?: string;
  usage: VinciAccumulatedUsage;
};

export type VinciUsageSnapshot = {
  calls: VinciUsageCall[];
};

type UsageLike = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  reasoning?: unknown;
  cost?: { total?: unknown };
};

type ModelResponseLike = {
  provider?: unknown;
  model?: unknown;
  responseModel?: unknown;
  responseId?: unknown;
  usage?: UsageLike;
};

type UsageEntry = VinciUsageCall & {
  schemaVersion: 1;
  taskId: string;
  recordedAt: string;
};

type UsageAccumulatorStore = {
  activeTaskId?: string;
  callsByTask: Map<string, Map<string, VinciUsageCall>>;
  installedApis: WeakSet<object>;
  listeners: Set<(taskId: string) => void>;
  appendEntry?: (taskId: string, customType: string, data: unknown) => boolean;
};

const STORE_KEY = "__vinciUsageAccumulatorStore" as const;
const REPORTER_KEY = "__vinciRecordTaskCall" as const;
type VinciGlobal = typeof globalThis & {
  [STORE_KEY]?: UsageAccumulatorStore;
  [REPORTER_KEY]?: (response: ModelResponseLike, source: string) => void;
};
const vinciGlobal = globalThis as VinciGlobal;
const store =
  vinciGlobal[STORE_KEY] ??
  {
    callsByTask: new Map<string, Map<string, VinciUsageCall>>(),
    installedApis: new WeakSet<object>(),
    listeners: new Set<(taskId: string) => void>(),
  } satisfies UsageAccumulatorStore;
vinciGlobal[STORE_KEY] = store;
vinciGlobal[REPORTER_KEY] = (response, source) => {
  if (store.activeTaskId) {
    recordVinciTaskCall(store.activeTaskId, response, source);
  } else {
    console.warn(`[Vinci usage] Dropped ${source} usage: active task is undefined.`);
  }
};

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Convert USD dollars to micro-USD (integer units, matching server-side storage). */
export function usdToMicroUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/** Convert micro-USD back to USD dollars. */
export function microUsdToUsd(microUsd: number): number {
  return microUsd / 1_000_000;
}

export function emptyVinciAccumulatedUsage(): VinciAccumulatedUsage {
  return {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    providers: [],
    models: [],
  };
}

function normalizedUsage(usage: Readonly<VinciAccumulatedUsage>): VinciAccumulatedUsage {
  return {
    modelCalls: finite(usage.modelCalls),
    inputTokens: finite(usage.inputTokens),
    outputTokens: finite(usage.outputTokens),
    cachedTokens: finite(usage.cachedTokens),
    cacheWriteTokens: finite(usage.cacheWriteTokens),
    reasoningTokens: finite(usage.reasoningTokens),
    estimatedCostUsd: finite(usage.estimatedCostUsd),
    providers: [...new Set(usage.providers.filter(Boolean))].sort(),
    models: [...new Set(usage.models.filter(Boolean))].sort(),
  };
}

export function addVinciAccumulatedUsage(
  target: VinciAccumulatedUsage,
  addition: Readonly<VinciAccumulatedUsage>,
): VinciAccumulatedUsage {
  target.modelCalls += finite(addition.modelCalls);
  target.inputTokens += finite(addition.inputTokens);
  target.outputTokens += finite(addition.outputTokens);
  target.cachedTokens += finite(addition.cachedTokens);
  target.cacheWriteTokens += finite(addition.cacheWriteTokens);
  target.reasoningTokens += finite(addition.reasoningTokens);
  // Accumulate cost as integer micro-USD to avoid floating point drift.
  // This matches server-side usage storage and prevents discrepancies as N calls grows.
  const targetMicroUsd = usdToMicroUsd(target.estimatedCostUsd);
  const additionMicroUsd = usdToMicroUsd(addition.estimatedCostUsd);
  target.estimatedCostUsd = microUsdToUsd(targetMicroUsd + additionMicroUsd);
  target.providers = [...new Set([...target.providers, ...addition.providers.filter(Boolean)])].sort();
  target.models = [...new Set([...target.models, ...addition.models.filter(Boolean)])].sort();
  return target;
}

function responseKey(response: ModelResponseLike): string | undefined {
  if (typeof response.responseId !== "string" || !response.responseId) return undefined;
  const provider = typeof response.provider === "string" ? response.provider : "";
  return `${provider}\0${response.responseId}`;
}

export function vinciResponseKey(response: ModelResponseLike): string | undefined {
  return responseKey(response);
}

function usageFromResponse(response: ModelResponseLike): VinciAccumulatedUsage {
  const provider = typeof response.provider === "string" && response.provider ? [response.provider] : [];
  const model =
    typeof response.responseModel === "string" && response.responseModel
      ? response.responseModel
      : typeof response.model === "string" && response.model
        ? response.model
        : "";
  return {
    modelCalls: 1,
    inputTokens: finite(response.usage?.input),
    outputTokens: finite(response.usage?.output),
    cachedTokens: finite(response.usage?.cacheRead),
    cacheWriteTokens: finite(response.usage?.cacheWrite),
    reasoningTokens: finite(response.usage?.reasoning),
    estimatedCostUsd: finite(response.usage?.cost?.total),
    providers: provider,
    models: model ? [model] : [],
  };
}

function taskCalls(taskId: string): Map<string, VinciUsageCall> {
  const existing = store.callsByTask.get(taskId);
  if (existing) return existing;
  const created = new Map<string, VinciUsageCall>();
  store.callsByTask.set(taskId, created);
  return created;
}

function recordCall(taskId: string, call: VinciUsageCall, persist: boolean): boolean {
  if (!taskId || !call.id) return false;
  const calls = taskCalls(taskId);
  if (calls.has(call.id)) return false;
  const normalized: VinciUsageCall = {
    id: call.id,
    source: call.source,
    ...(call.responseKey ? { responseKey: call.responseKey } : {}),
    usage: normalizedUsage(call.usage),
  };
  calls.set(normalized.id, normalized);
  let recorded = true;
  if (persist && store.appendEntry) {
    try {
      const entry: UsageEntry = {
        schemaVersion: 1,
        taskId,
        ...normalized,
        recordedAt: new Date().toISOString(),
      };
      recorded = store.appendEntry(taskId, VINCI_TASK_USAGE_ENTRY, entry);
    } catch {
      recorded = false;
      console.warn(`[Vinci usage] Failed to persist ${VINCI_TASK_USAGE_ENTRY} for task "${taskId}".`);
    }
  }
  for (const listener of store.listeners) listener(taskId);
  return recorded;
}

export function recordVinciTaskCall(taskId: string, response: ModelResponseLike, source: string): boolean {
  const key = responseKey(response);
  return recordCall(
    taskId,
    {
      id: key ? `response:${key}` : `call:${randomUUID()}`,
      source,
      ...(key ? { responseKey: key } : {}),
      usage: usageFromResponse(response),
    },
    true,
  );
}

export function recordVinciTaskUsage(
  taskId: string,
  usage: Readonly<VinciAccumulatedUsage>,
  options: { id?: string; source: string; responseKey?: string },
): boolean {
  return recordCall(
    taskId,
    {
      id: options.id ?? `aggregate:${randomUUID()}`,
      source: options.source,
      ...(options.responseKey ? { responseKey: options.responseKey } : {}),
      usage: normalizedUsage(usage),
    },
    true,
  );
}

export function getVinciTaskUsageSnapshot(
  taskId: string,
  excludedResponseKeys: ReadonlySet<string> = new Set(),
): VinciUsageSnapshot {
  const calls = [...(store.callsByTask.get(taskId)?.values() ?? [])]
    .filter((call) => !call.responseKey || !excludedResponseKeys.has(call.responseKey))
    .map((call) => ({
      ...call,
      usage: {
        ...call.usage,
        providers: call.usage.providers.slice(),
        models: call.usage.models.slice(),
      },
    }));
  return { calls };
}

export function summarizeVinciUsageSnapshot(snapshot: Readonly<VinciUsageSnapshot>): VinciAccumulatedUsage {
  const usage = emptyVinciAccumulatedUsage();
  for (const call of snapshot.calls) addVinciAccumulatedUsage(usage, call.usage);
  return usage;
}

export function hydrateVinciTaskUsage(taskId: string, snapshot: Readonly<VinciUsageSnapshot> | undefined): void {
  if (!snapshot) return;
  for (const call of snapshot.calls) recordCall(taskId, call, false);
}

export function isVinciUsageSnapshot(value: unknown): value is VinciUsageSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<VinciUsageSnapshot>;
  return (
    Array.isArray(snapshot.calls) &&
    snapshot.calls.every((call) => {
      if (!call || typeof call !== "object") return false;
      const usage = call.usage as Partial<VinciAccumulatedUsage> | undefined;
      const usageNumbers = usage
        ? [
            usage.modelCalls,
            usage.inputTokens,
            usage.outputTokens,
            usage.cachedTokens,
            usage.cacheWriteTokens,
            usage.reasoningTokens,
            usage.estimatedCostUsd,
          ]
        : [];
      return (
        typeof call.id === "string" &&
        typeof call.source === "string" &&
        (call.responseKey === undefined || typeof call.responseKey === "string") &&
        !!usage &&
        usageNumbers.every(
          (number) => typeof number === "number" && Number.isFinite(number) && number >= 0,
        ) &&
        Array.isArray(usage.providers) &&
        usage.providers.every((provider) => typeof provider === "string") &&
        Array.isArray(usage.models) &&
        usage.models.every((model) => typeof model === "string")
      );
    })
  );
}

function isUsageEntry(value: unknown): value is UsageEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<UsageEntry>;
  return (
    entry.schemaVersion === 1 &&
    typeof entry.taskId === "string" &&
    typeof entry.id === "string" &&
    typeof entry.source === "string" &&
    (entry.responseKey === undefined || typeof entry.responseKey === "string") &&
    isVinciUsageSnapshot({ calls: [entry] })
  );
}

/**
 * Read the session task ID from a host context, or undefined when the host does not expose a
 * session manager. Returning undefined is the graceful-degradation path, not an error: callers
 * must then leave the accumulator unbound so usage is dropped with a warning rather than filed
 * against a stale task.
 */
function sessionTaskId(ctx: ExtensionContext): string | undefined {
  const manager = ctx?.sessionManager;
  if (!manager || typeof manager.getSessionId !== "function") return undefined;
  const taskId = manager.getSessionId();
  return typeof taskId === "string" && taskId.length > 0 ? taskId : undefined;
}

function restoreVinciTaskUsage(ctx: ExtensionContext, taskId: string): void {
  const manager = ctx?.sessionManager;
  if (!manager || typeof manager.getBranch !== "function") return;
  for (const entry of manager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== VINCI_TASK_USAGE_ENTRY || !isUsageEntry(entry.data)) continue;
    if (entry.data.taskId === taskId) recordCall(taskId, entry.data, false);
  }
}

/**
 * Register durable accumulator restoration once for a shared ExtensionAPI. The store itself lives on
 * globalThis, so duplicate extension loaders share calls, listeners, persistence, and de-duplication.
 */
export function installVinciUsageAccumulator(pi: ExtensionAPI): void {
  if (store.installedApis.has(pi)) return;
  store.installedApis.add(pi);
  let boundTaskId: string | undefined;
  // Degrades gracefully if the host does not expose event handlers or persistence methods.
  // Persistence is bound to the session task ID. Late completions from another session, or calls
  // made before any task is active, are dropped and logged instead of entering the wrong stream.
  const bindAppendEntry = (taskId: string | undefined): void => {
    boundTaskId = taskId;
    store.appendEntry = (entryTaskId, customType, data) => {
      const activeTaskId = store.activeTaskId;
      if (!activeTaskId || !boundTaskId) {
        console.warn(
          `[Vinci usage] Dropped ${customType} for task "${entryTaskId}": active task is undefined.`,
        );
        return false;
      }
      if (entryTaskId !== activeTaskId || boundTaskId !== activeTaskId) {
        console.warn(
          `[Vinci usage] Dropped ${customType} for task "${entryTaskId}": task mismatch; active task is "${activeTaskId}".`,
        );
        return false;
      }
      try {
        if (typeof pi.appendEntry !== "function") return false;
        pi.appendEntry(customType, data);
        return true;
      } catch {
        return false;
      }
    };
  };
  bindAppendEntry(undefined);
  try {
    if (typeof pi.on === "function") {
      pi.on("session_start", (_event, ctx) => {
        // A host that does not expose a session manager is a capability gap, not an integrity
        // signal: keep in-memory accumulation alive and leave the accumulator unbound, so later
        // calls are dropped with a warning instead of being filed against the previous task.
        let taskId: string | undefined;
        try {
          taskId = sessionTaskId(ctx);
        } catch {
          taskId = undefined;
        }
        store.activeTaskId = taskId;
        bindAppendEntry(taskId);
        if (taskId === undefined) {
          console.warn(
            "[Vinci usage] Session started without a readable session ID; usage will not be persisted for this session.",
          );
          return;
        }
        try {
          restoreVinciTaskUsage(ctx, taskId);
        } catch (error) {
          console.warn(`[Vinci usage] Could not restore persisted usage for task "${taskId}": ${error}`);
        }
      });
    }
  } catch {
    // In-memory accumulation remains available without session event handlers.
  }
}

export function subscribeVinciTaskUsage(listener: (taskId: string) => void): () => void {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

export function resetVinciTaskUsage(taskId: string): void {
  store.callsByTask.delete(taskId);
}
