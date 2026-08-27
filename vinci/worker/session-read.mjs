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

export function readSessionState(sessionDir, sessionId) {
  const session = fileForSession(sessionDir, sessionId);
  if (!session) return { costUsd: 0, outcome: undefined, path: undefined };

  let accumulatedCostUsd = 0;
  let outcomeCostUsd;
  let outcome;
  for (const entry of session.entries) {
    if (entry?.type === "custom" && entry.customType === "vinci-task-usage") {
      accumulatedCostUsd += usageValue(entry);
    }
    const currentOutcome = taskOutcome(entry);
    if (currentOutcome) {
      outcome = currentOutcome;
      const cost = usageValue(entry);
      if (cost > 0 || currentOutcome?.usage?.estimatedCostUsd === 0) outcomeCostUsd = cost;
    }
  }
  return { costUsd: outcomeCostUsd ?? accumulatedCostUsd, outcome, path: session.path };
}

export function readSessionOutcome(sessionDir, sessionId) {
  return readSessionState(sessionDir, sessionId).outcome;
}

export function readSessionUsage(sessionDir, sessionId) {
  return readSessionState(sessionDir, sessionId).costUsd;
}
