import { resolve } from "node:path";
import { createHash } from "node:crypto";

export const VINCI_PLAN_FILE_REFUSAL = "Plan mode keeps plans in Vinci instead of writing project files.";
export const VINCI_PLAN_HEADLESS_REFUSAL = "Plan mode kept the project unchanged; no approval UI is available.";
export const VINCI_PLAN_CHANGE_REFUSAL = "Plan mode kept the project unchanged.";

export function isVinciPlanRefusal(text: string, details: unknown): boolean {
  return record(details)?.vinciBlocked === true &&
    [VINCI_PLAN_FILE_REFUSAL, VINCI_PLAN_HEADLESS_REFUSAL, VINCI_PLAN_CHANGE_REFUSAL].includes(text);
}

function boundedReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Unfinished work for one request. Optional on older saved outcomes. */
export type VinciRequiredOperation = { key: string; tool: string; target: string; reason: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function isVinciRequiredOperation(value: unknown): value is VinciRequiredOperation {
  const item = record(value);
  return !!item && [item.key, item.tool, item.target, item.reason].every((field) => typeof field === "string" && field.length > 0);
}

/** A user explicitly continuing unfinished work keeps its operation scope. */
export function vinciContinuesRequest(text: string): boolean {
  return /^(?:please\s+)?(?:continue|resume|retry|try again)\b/i.test(text.trim());
}

export function vinciCarriesOperations(text: string, hasUnresolvedOperations: boolean): boolean {
  return vinciContinuesRequest(text) || (hasUnresolvedOperations &&
    /^(?:yes|y|yep|ok|okay|sure|go ahead|proceed|approved|do it|please do|yes please|please proceed|yes go ahead|yes, go ahead)[.!]?$/i.test(text.trim()));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = record(value);
  if (object) return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function vinciToolTextReportsFailure(text: string): boolean {
  if (/^\s*Successfully\b/i.test(text)) return false;
  return /could not find the exact text|no changes|validation failed|overlap|must match exactly/i.test(text);
}

/** Only paired results can complete an operation; prose never attests to execution. */
export function vinciRequiredOperations(
  messages: readonly unknown[],
  prior: readonly VinciRequiredOperation[] = [],
  cwd = process.cwd(),
): VinciRequiredOperation[] {
  const pending = new Map(prior.map((operation) => [operation.key, operation]));
  const calls = new Map<string, { operation: VinciRequiredOperation; order: number; pendingBefore?: VinciRequiredOperation; result?: string; ambiguous?: boolean }>();
  const latestAttempt = new Map<string, number>();
  let serial = 0;
  for (const value of messages) {
    const message = record(value);
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const value of message.content) {
        const part = record(value);
        if (part?.type !== "toolCall" || !["write", "edit", "read", "bash"].includes(String(part.name))) continue;
        const tool = String(part.name);
        const order = ++serial;
        const args = record(part.arguments);
        const rawTarget = tool === "bash" ? args?.command : args?.path;
        const validTarget = typeof rawTarget === "string" && rawTarget.trim().length > 0;
        const target = validTarget
          ? tool === "bash" ? rawTarget : resolve(cwd, rawTarget)
          : "unknown target";
        const key = validTarget
          ? fingerprint({ ...args, tool, cwd: resolve(cwd), ...(tool === "bash" ? { command: target, timeout: undefined } : { path: target }) })
          : `unpaired:${order}`;
        const pendingBefore = pending.get(key);
        const operation = { key, tool, target, reason: `Required ${tool} operation for "${boundedReason(target)}" has no completed tool result.` };
        if (!pending.has(key)) pending.set(key, operation);
        latestAttempt.set(key, order);
        if (typeof part.id !== "string" || !part.id || !validTarget) continue;
        const previous = calls.get(part.id);
        if (previous) {
          previous.ambiguous = true;
          continue;
        }
        calls.set(part.id, { operation, order, pendingBefore });
      }
    }
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string" || !message.toolCallId) continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    const { operation } = call;
    if ((latestAttempt.get(operation.key) ?? 0) > call.order) continue;
    const text = Array.isArray(message.content) ? message.content.map((value) => {
      const part = record(value);
      return part?.type === "text" && typeof part.text === "string" ? part.text : "";
    }).filter(Boolean).join("\n") : "";
    const details = record(message.details);
    const softFailure = (operation.tool === "edit" || operation.tool === "write") && vinciToolTextReportsFailure(text);
    const failed = message.isError === true || details?.vinciBlocked === true || softFailure;
    const execution = record(details?.execution);
    // text match, spoofable by command output (case 6b).
    const bashExit = operation.tool === "bash" && message.isError === true &&
      details?.vinciBlocked !== true && /^Command exited with code [1-9]\d*$/m.test(text) &&
      !text.split(/\r?\n/).some((line) => line === "sandbox-exec: sandbox_apply: Operation not permitted" ||
        /^\/\S*\/(bash|sh): .+: Operation not permitted$/.test(line));
    const success = !failed && (message.isError === false || message.isError === undefined) &&
      (message.toolName === undefined || message.toolName === operation.tool) &&
      (message.details == null || details !== undefined) &&
      (details?.vinciBlocked === undefined || typeof details.vinciBlocked === "boolean") &&
      Array.isArray(message.content) && message.content.every((value) => {
        const part = record(value);
        return part?.type === "text" ? typeof part.text === "string" :
          part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string";
      }) &&
      (operation.tool !== "bash" || (execution?.exitCode === 0 && execution.cwd === cwd &&
        (execution.originalCommand === true || (execution.originalCommand === false &&
          Array.isArray(execution.nonOriginalReasons) && execution.nonOriginalReasons.length > 0 &&
          execution.nonOriginalReasons.every((reason) => reason === "commandPrefix" || reason === "shellPath")))));
    const result = fingerprint({ failed, success, text, details });
    if (call.result === result) continue;
    if (call.result !== undefined && call.result !== result) call.ambiguous = true;
    call.result = result;
    if (call.ambiguous) {
      pending.set(operation.key, { ...operation, reason: `Required ${operation.tool} operation for "${boundedReason(operation.target)}" has conflicting tool results.` });
    } else if (isVinciPlanRefusal(text, details)) {
      if (call.pendingBefore) pending.set(operation.key, call.pendingBefore);
      else pending.delete(operation.key);
    } else if (bashExit) {
      if (call.pendingBefore) pending.set(operation.key, call.pendingBefore);
      else pending.delete(operation.key);
    } else if (failed) {
      pending.set(operation.key, { ...operation, reason: `Required ${operation.tool} operation for "${boundedReason(operation.target)}" failed: ${boundedReason(text.split(/\r?\n/).find((line) => line.trim()) || "the tool refused or failed before completion")}` });
    } else if (success) {
      pending.delete(operation.key);
    }
  }
  return [...pending.values()];
}
