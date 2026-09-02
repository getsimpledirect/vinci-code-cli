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

// W2 unattended policy profile. The guard appends one `vinci-unattended-policy` entry per gate it
// resolved under the profile, each carrying exactly one outcome. Read back here so the daemon can
// put the THREE counts — not one blended "it ran" — into the terminal post.
export const UNATTENDED_POLICY_ENTRY = "vinci-unattended-policy";
const UNATTENDED_OUTCOMES = Object.freeze(["BLOCKED", "ESCALATED", "PROCEEDED"]);

function unattendedPolicyDecision(entry) {
  if (entry?.type !== "custom" || entry.customType !== UNATTENDED_POLICY_ENTRY) return undefined;
  const data = entry.data;
  if (!data || typeof data !== "object") return undefined;
  // An unrecognised outcome is dropped rather than counted as anything: a decision the daemon
  // cannot classify must never be silently folded into one of the three buckets.
  if (!UNATTENDED_OUTCOMES.includes(data.outcome)) return undefined;
  return {
    outcome: data.outcome,
    site: typeof data.site === "string" ? data.site : "",
    gate: typeof data.gate === "string" ? data.gate : "",
  };
}

/**
 * The three counts plus the sites, kept apart. "was blocked", "escalated for authorization" and
 * "was allowed to skip a confirmation" are three different events and this is the shape that keeps
 * them distinguishable all the way into the bus post.
 */
export function summarizeUnattendedPolicy(decisions, profileActive = false) {
  const list = Array.isArray(decisions) ? decisions : [];
  // `profileActive` is what makes "profile off", "profile on and nothing fired", and "profile on and
  // the records were lost" three DIFFERENT posts. Keying the policy fields on decisions alone made
  // the first two identical and silently absorbed the third (adversarial review, 2026-08-29): a run
  // whose appendEntry failed reported no policy line at all. Whenever the profile was active the
  // post carries the counts, even when all three are zero.
  if (!profileActive && list.length === 0) return null;
  decisions = list;
  const summary = { blocked: 0, escalated: 0, proceeded: 0, sites: { blocked: [], escalated: [], proceeded: [] } };
  for (const decision of decisions) {
    // Explicit mapping with no default: an outcome this daemon does not recognise is DROPPED, never
    // folded into a bucket. A fail-open default here would make an unknown decision read as
    // "PROCEEDED", i.e. the most permissive answer, on the strength of a typo.
    const bucket =
      decision.outcome === "BLOCKED"
        ? "blocked"
        : decision.outcome === "ESCALATED"
          ? "escalated"
          : decision.outcome === "PROCEEDED"
            ? "proceeded"
            : null;
    if (!bucket) continue;
    summary[bucket] += 1;
    if (decision.site && !summary.sites[bucket].includes(decision.site)) summary.sites[bucket].push(decision.site);
  }
  return summary;
}

function usageValue(entry) {
  const usage = entry?.data?.usage;
  return typeof usage?.estimatedCostUsd === "number" &&
    Number.isFinite(usage.estimatedCostUsd) &&
    usage.estimatedCostUsd >= 0
    ? usage.estimatedCostUsd
    : 0;
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

// Convert the persisted per-call `vinci-task-usage` entry into the flat per-call shape the
// economics rollup consumes. The persisted entry carries one call (or an aggregate of calls that
// all share a single response key) in its `data.usage` block; providers/models are arrays because
// a single response can span more than one upstream, but the dominant pair drives the rollup key.
// Cost is emitted as integer micro-USD (never a float) to match server-side storage.
function usageEntryToRecord(entry) {
  const usage = entry?.data?.usage;
  if (!usage || typeof usage !== "object") return null;
  const modelCalls = numberOrZero(usage.modelCalls);
  const providers = Array.isArray(usage.providers) ? usage.providers.filter((p) => typeof p === "string" && p) : [];
  const models = Array.isArray(usage.models) ? usage.models.filter((m) => typeof m === "string" && m) : [];
  const costUsd = numberOrZero(usage.estimatedCostUsd);
  const responseId = typeof entry?.data?.responseKey === "string" && entry.data.responseKey ? entry.data.responseKey : null;
  return {
    provider: providers[0] ?? null,
    model: models[0] ?? null,
    model_calls: modelCalls,
    input_tokens: numberOrZero(usage.inputTokens),
    cached_read_tokens: numberOrZero(usage.cachedTokens),
    cache_write_tokens: numberOrZero(usage.cacheWriteTokens),
    output_tokens: numberOrZero(usage.outputTokens),
    reasoning_tokens: numberOrZero(usage.reasoningTokens),
    cost_microusd: Math.round(costUsd * 1_000_000),
    responseId,
  };
}

// The raw per-call usage records persisted during the session, mapped to the flat shape the
// economics rollup groups by (provider, model). Returned alongside `source` so the terminal
// economics summary can roll up real usage instead of an empty array.
function usageEntries(entries) {
  const result = [];
  for (const entry of entries) {
    if (entry?.type !== "custom" || entry.customType !== "vinci-task-usage") continue;
    const record = usageEntryToRecord(entry);
    if (record) result.push(record);
  }
  return result;
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
  if (!session)
    return {
      costUsd: 0,
      outcome: undefined,
      harnessStops: [],
      unattendedPolicy: [],
      usageEntries: [],
      crewRan: false,
      path: undefined,
      source: undefined,
    };

  let accumulatedCostUsd = 0;
  let hasUsageEntries = false;
  let messageUsageCostUsd = 0;
  let messageEntries = 0;
  let outcomeCostUsd;
  let outcome;
  const harnessStops = [];
  const unattendedPolicy = [];
  session.entries.forEach((entry, index) => {
    const stop = harnessStopReason(entry);
    if (stop) harnessStops.push({ index, reason: stop });
    const decision = unattendedPolicyDecision(entry);
    if (decision) unattendedPolicy.push(decision);
  });
  const extractedUsageEntries = usageEntries(session.entries);
  // Crew helpers run in their own RPC sessions; their usage is NOT in this session. Flag it so the
  // economics summary reports crew_unattributed instead of silently under-counting.
  const crewRan = session.entries.some(
    (entry) => entry?.type === "custom" && (entry.customType === "vinci-crew-helper" || entry.customType === "vinci-crew-result"),
  );
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
  const source = outcomeCostUsd !== undefined
    ? "outcome"
    : hasUsageEntries || accumulatedCostUsd > 0
      ? "usage_entries"
      : "message_fallback";
  return {
    costUsd,
    outcome,
    harnessStops,
    unattendedPolicy,
    usageEntries: extractedUsageEntries,
    crewRan,
    path: session.path,
    source,
  };
}

export function readSessionOutcome(sessionDir, sessionId) {
  return readSessionState(sessionDir, sessionId).outcome;
}

export function readSessionUsage(sessionDir, sessionId) {
  return readSessionState(sessionDir, sessionId).costUsd;
}
