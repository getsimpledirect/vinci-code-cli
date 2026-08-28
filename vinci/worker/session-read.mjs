import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function sessionFiles(directory) {
  const files = [];
  const visit = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  };
  visit(directory);
  return files;
}

function readEntries(path) {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function fileForSession(sessionDir, sessionId) {
  const candidates = sessionFiles(sessionDir)
    .map((path) => ({ path, entries: readEntries(path) }))
    .filter(({ entries }) => entries.some((entry) => entry?.type === "session" && entry.id === sessionId))
    .sort((left, right) => {
      try {
        return statSync(right.path).mtimeMs - statSync(left.path).mtimeMs;
      } catch {
        return 0;
      }
    });
  return candidates[0];
}

function usageValue(entry) {
  const usage = entry?.data?.usage;
  return typeof usage?.estimatedCostUsd === "number" &&
    Number.isFinite(usage.estimatedCostUsd) &&
    usage.estimatedCostUsd >= 0
    ? usage.estimatedCostUsd
    : 0;
}

function taskOutcome(entry) {
  if (entry?.type === "custom" && entry.customType === "vinci-task-outcome" && entry.data) return entry.data;
  return undefined;
}

// Machine-observed hard stops. A tool call an extension refused is serialized by the agent loop as a
// toolResult message whose text IS the extension's block reason (packages/agent/src/agent-loop.ts
// createErrorToolResult; details.vinciBlocked marks it under VINCI_CODE=1):
//   {"type":"message","message":{"role":"toolResult","toolCallId":"...","toolName":"bash",
//     "content":[{"type":"text","text":"Vinci reserved the remaining actions for implementation or an answer."}],
//     "details":{"vinciBlocked":true},"isError":true,"timestamp":...}}
// Anchored on stable substrings of the reasons vinci-todo.ts (no-progress latch) and vinci-loopbreak.ts
// (mutation / post-mutation runway) emit. Case-sensitive. Shared with the harness side so the two
// halves cannot drift apart silently.
export const HARNESS_STOP_PATTERNS = Object.freeze([
  "Wait for the user's next instruction",
  "Vinci reserved the remaining actions",
  "Vinci stopped autonomous changes",
]);

function toolResultText(entry) {
  if (entry?.type !== "message" || entry?.message?.role !== "toolResult") return undefined;
  const content = Array.isArray(entry.message.content) ? entry.message.content : [];
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

// Only error-flagged tool results count: a blocked call is always isError=true, whereas a successful
// grep/cat over the extension sources would echo the same strings without being a stop.
// Authoritative signal: details.vinciBlocked === true — the marker the agent loop sets when an
// extension blocks a call (packages/agent/src/agent-loop.ts), independent of the reason wording.
// The substring patterns are a legacy fallback for sessions written by builds without the marker.
function harnessStopReason(entry) {
  if (entry?.message?.isError !== true) return undefined;
  const text = toolResultText(entry);
  if (entry.message?.details?.vinciBlocked === true) return text || "Tool execution was blocked";
  if (!text) return undefined;
  return HARNESS_STOP_PATTERNS.some((pattern) => text.includes(pattern)) ? text : undefined;
}

function messageCostUsd(entry) {
  if (entry?.message?.role !== "assistant") return 0;
  const total = entry?.message?.usage?.cost?.total;
  return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : 0;
}

export function readSessionState(sessionDir, sessionId) {
  const session = fileForSession(sessionDir, sessionId);
  if (!session) return { costUsd: 0, outcome: undefined, harnessStops: [], path: undefined };

  let accumulatedCostUsd = 0;
  let hasUsageEntries = false;
  let messageUsageCostUsd = 0;
  let messageEntries = 0;
  let outcomeCostUsd;
  let outcome;
  const harnessStops = [];
  session.entries.forEach((entry, index) => {
    const stop = harnessStopReason(entry);
    if (stop) harnessStops.push({ index, reason: stop });
  });
  for (const entry of session.entries) {
    if (entry?.type === "custom" && entry.customType === "vinci-task-usage") {
      hasUsageEntries = true;
      accumulatedCostUsd += usageValue(entry);
    }
    if (entry?.type === "message" && entry?.message?.role === "assistant") {
      messageUsageCostUsd += messageCostUsd(entry);
      messageEntries += 1;
    }
    const currentOutcome = taskOutcome(entry);
    if (currentOutcome) {
      outcome = currentOutcome;
      const cost = usageValue(entry);
      if (cost > 0 || currentOutcome?.usage?.estimatedCostUsd === 0) outcomeCostUsd = cost;
    }
  }
  const messageFallbackCostUsd = messageUsageCostUsd > 0 || messageEntries > 0 ? messageUsageCostUsd : 0;
  // Precedence: explicit outcome cost > accumulated vinci-task-usage (>0 or entries present) > sum of
  // message-usage costs (killed sessions carry their cost only in message entries).
  const costUsd =
    outcomeCostUsd ??
    (hasUsageEntries || accumulatedCostUsd > 0 ? accumulatedCostUsd : messageFallbackCostUsd);
  return { costUsd, outcome, harnessStops, path: session.path };
}

export function readSessionOutcome(sessionDir, sessionId) {
  return readSessionState(sessionDir, sessionId).outcome;
}

export function readSessionUsage(sessionDir, sessionId) {
  return readSessionState(sessionDir, sessionId).costUsd;
}
