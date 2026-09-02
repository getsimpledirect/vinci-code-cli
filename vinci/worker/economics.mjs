// CCM-V0-PROTOCOL.md §4 canonical work-order economics summary.
//
// Emitted on EVERY terminal worker path (DONE/BLOCKED/FAILED/UNVERIFIED, budget trip, deadline
// trip, harness stop) so a reader can reconstruct cost and custody for a work-order attempt from
// a single canonical file. The emitter never throws: a malformed input is answered with an
// `incomplete` entry (and a usable, minimal payload), never a crash that would lose the terminal
// record.
import { createHash } from "node:crypto";

export const ECONOMICS_SCHEMA = "vinci.work-order-economics-summary.v1";

// ---------------------------------------------------------------------------
// 1. canonicalJson — sorted keys, no whitespace, deterministic, never throws
// ---------------------------------------------------------------------------
export function canonicalJson(obj) {
  try {
    const ser = (value) => {
      if (value === null) return "null";
      if (value === undefined) return "null";
      const type = typeof value;
      if (type === "string") return JSON.stringify(value);
      if (type === "number") {
        if (!Number.isFinite(value)) return "null";
        return JSON.stringify(value);
      }
      if (type === "boolean") return value ? "true" : "false";
      if (type === "bigint") return value.toString();
      if (Array.isArray(value)) return `[${value.map(ser).join(",")}]`;
      if (type === "object") {
        const keys = Object.keys(value).sort();
        const parts = keys.map((key) => `${JSON.stringify(key)}:${ser(value[key])}`);
        return `{${parts.join(",")}}`;
      }
      return "null";
    };
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      return "{}";
    }
    return ser(obj);
  } catch {
    return "{}";
  }
}

// ---------------------------------------------------------------------------
// 2. buildEconomicsSummary — WorkOrderEconomicsSummary v1 emitter
// ---------------------------------------------------------------------------

function str(value) {
  return typeof value === "string" && value.length <= 512 ? value : null;
}

function rollupUsage(entries, flags) {
  const rollup = new Map();
  // One provider response is one response regardless of which (provider, model) row it lands in.
  const seenResponseIds = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      flags.malformed = true;
      continue;
    }
    const provider = str(entry.provider);
    const model = str(entry.model);
    if ((entry.provider != null && provider === null) || (entry.model != null && model === null)) flags.malformed = true;
    const key = `${provider}|${model}`;
    let group = rollup.get(key);
    if (!group) {
      group = {
        phase: "UNPHASED",
        cost_category: "unclassified",
        provider,
        model,
        source: "api",
        model_calls: 0,
        input_tokens: 0,
        cached_read_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cost_microusd: 0,
        // A responseId names one provider response. The accumulator persists an entry per call and
        // a killed session can replay the same response into two entries; the WHOLE duplicate is
        // skipped (calls, tokens and cost), otherwise cost double-counts while calls do not.
        cost_basis: null,
        cost_confidence: null,
      };
      rollup.set(key, group);
    }

    if (typeof entry.responseId === "string" && entry.responseId) {
      if (seenResponseIds.has(entry.responseId)) continue;
      seenResponseIds.add(entry.responseId);
    }
    if (typeof entry.model_calls === "number" && entry.model_calls > 0) group.model_calls += entry.model_calls;
    if (typeof entry.input_tokens === "number") group.input_tokens += entry.input_tokens;
    if (typeof entry.cached_read_tokens === "number") group.cached_read_tokens += entry.cached_read_tokens;
    if (typeof entry.cache_write_tokens === "number") group.cache_write_tokens += entry.cache_write_tokens;
    if (typeof entry.output_tokens === "number") group.output_tokens += entry.output_tokens;
    if (typeof entry.reasoning_tokens === "number") group.reasoning_tokens += entry.reasoning_tokens;
    if (typeof entry.cost_microusd === "number") group.cost_microusd += Math.round(entry.cost_microusd);

    if (str(entry.cost_basis)) group.cost_basis = entry.cost_basis;
    if (str(entry.cost_confidence)) group.cost_confidence = entry.cost_confidence;
  }

  const result = [];
  for (const group of rollup.values()) {
    result.push({
      phase: group.phase,
      cost_category: group.cost_category,
      provider: group.provider,
      model: group.model,
      source: group.source,
      model_calls: group.model_calls,
      input_tokens: group.input_tokens,
      cached_read_tokens: group.cached_read_tokens,
      cache_write_tokens: group.cache_write_tokens,
      output_tokens: group.output_tokens,
      reasoning_tokens: group.reasoning_tokens,
      cost_microusd: group.cost_microusd,
      cost_basis: group.cost_basis ?? "estimated",
      cost_confidence: group.cost_confidence ?? "estimated",
    });
  }
  return result;
}

export function buildEconomicsSummary(input = {}) {
  const incomplete = [];
  const flags = { malformed: false };

  try {
    const taskRef = str(input?.task?.envelope?.ref);
    if (!taskRef) incomplete.push("missing");

    const lease =
      typeof input.lease === "object" && input.lease !== null ? input.lease : null;
    const leaseId = lease ? str(lease.lease_id) : null;
    const fencingGeneration = lease && typeof lease.fencing_generation === "number" ? lease.fencing_generation : null;
    if (lease === null) incomplete.push("no_lease");

    const attemptLabel = str(input.attemptLabel) || (input?.task?.id && typeof input.task.attempt === "number" ? `${input.task.id}/${input.task.attempt}` : null);

    // The worker holds the real session id (attempt.sessionId); the session file name is
    // `<timestamp>_<id>.jsonl` and is not the id.
    const sessionId = str(input.sessionId);

    const workerBuild = typeof input.workerBuild === "object" && input.workerBuild !== null ? input.workerBuild : null;
    const workerBuildDigestValue = workerBuild ? str(workerBuild.commit) || str(workerBuild.digest) : null;

    const vinciBinary = typeof input.vinciBinary === "object" && input.vinciBinary !== null ? input.vinciBinary : null;
    const vinciVersion = vinciBinary ? str(vinciBinary.version) || str(vinciBinary.error) || "unknown" : "unknown";

    const hasSession = Boolean(str(input?.sessionState?.path));
    const costReconstruction = hasSession ? (str(input?.sessionState?.source) || "none") : "none";
    if (!hasSession && !incomplete.includes("no_session")) incomplete.push("no_session");

    const startedAt = typeof input.started === "string" ? input.started : null;
    const finishedAt = typeof input.finished === "string" ? input.finished : null;

    let work = null;
    if (typeof input.work === "object" && input.work !== null) {
      const w = input.work;
      const pieces = {
        class: typeof w.class === "string" ? w.class : null,
        risk_class: typeof w.risk_class === "string" ? w.risk_class : null,
        repository: typeof w.repository === "string" ? w.repository : null,
        base_sha: typeof w.base_sha === "string" ? w.base_sha : null,
        required_terminal: typeof w.required_terminal === "string" ? w.required_terminal : null,
      };
      const filtered = {};
      for (const [k, v] of Object.entries(pieces)) if (v !== null) filtered[k] = v;
      if (Object.keys(filtered).length > 0) work = filtered;
    }

    const usageArray = Array.isArray(input.usageEntries) ? input.usageEntries : [];
    const usage = rollupUsage(usageArray, flags);
    // No per-call entries survived but the session still knows what it spent (receipt total or
    // assistant-message fallback): carry that figure as one estimated row rather than omitting
    // usage[] and reading as zero spend. The entries' absence is itself reported.
    const receiptForUsage = typeof input.receipt === "object" && input.receipt !== null ? input.receipt : null;
    const sessionCostUsd = typeof input?.sessionState?.costUsd === "number" && Number.isFinite(input.sessionState.costUsd) ? input.sessionState.costUsd : 0;
    if (usage.length === 0 && (sessionCostUsd > 0 || receiptForUsage?.usage)) {
      const ru = receiptForUsage?.usage && typeof receiptForUsage.usage === "object" ? receiptForUsage.usage : {};
      const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
      usage.push({
        phase: "UNPHASED",
        cost_category: "unclassified",
        provider: str(Array.isArray(ru.providers) ? ru.providers[0] : null) ?? "unknown",
        model: str(Array.isArray(ru.models) ? ru.models[0] : null) ?? "unknown",
        source: "api",
        model_calls: n(ru.modelCalls),
        input_tokens: n(ru.inputTokens),
        cached_read_tokens: n(ru.cachedTokens),
        cache_write_tokens: n(ru.cacheWriteTokens),
        output_tokens: n(ru.outputTokens),
        reasoning_tokens: n(ru.reasoningTokens),
        cost_microusd: Math.round(sessionCostUsd * 1_000_000),
        cost_basis: "estimated",
        cost_confidence: "estimated",
      });
      if (!incomplete.includes("usage_persistence_failed")) incomplete.push("usage_persistence_failed");
    }

    const taskOutcome = typeof input.taskOutcome === "object" && input.taskOutcome !== null ? input.taskOutcome : null;
    // `receipt` is the vinci-task-outcome entry the session wrote at its own terminal. Its absence
    // (SIGKILL, provider failure before the receipt) is what killed_before_outcome means; the
    // worker-side run outcome is not a substitute for it.
    const receipt = typeof input.receipt === "object" && input.receipt !== null ? input.receipt : null;
    if (hasSession && receipt === null && !incomplete.includes("killed_before_outcome")) incomplete.push("killed_before_outcome");
    if (input.crewRan === true && !incomplete.includes("crew_unattributed")) incomplete.push("crew_unattributed");

    let headSha = null;
    if (taskOutcome && typeof taskOutcome.head_sha === "string") headSha = taskOutcome.head_sha;

    const run = typeof input.run === "object" && input.run !== null ? input.run : null;
    const exitCode = run && typeof run.exit_code === "number" ? run.exit_code : null;
    const limitTripped = run && typeof run.limit_tripped === "string" ? run.limit_tripped : null;
    const harnessStops = Array.isArray(run?.harness_stops) ? run.harness_stops : [];
    // The stop reason is the blocked tool call's own text; R3 forbids tool output in the ledger,
    // so the summary carries a closed token and the count, never the text.
    const harnessStop = harnessStops.length > 0 ? `instrument_stop:${harnessStops.length}` : null;

    const taskState = str(input.taskState) || (typeof input.terminalState === "string" ? input.terminalState : null);

    const localResult = {
      task_state: taskState,
      verification_state: str(receipt?.verificationStatus) ?? null,
      changed_files: typeof input.changed_files === "number" ? input.changed_files : null,
      head_sha: headSha,
      pr_number: typeof input.pr_number === "number" ? input.pr_number : null,
      limit_tripped: limitTripped,
      harness_stop: harnessStop,
    };

    if (flags.malformed) incomplete.push("malformed_entries");

    const summary = {
      schema: "vinci.work-order-economics-summary.v1",
      work_order_id: taskRef,
      attempt_label: attemptLabel,
    };
    if (leaseId !== null) summary.lease_id = leaseId;
    if (fencingGeneration !== null) summary.fencing_generation = fencingGeneration;
    if (sessionId !== null) summary.session_id = sessionId;
    if (workerBuildDigestValue !== null) summary.worker_build_digest = workerBuildDigestValue;
    summary.vinci_version = vinciVersion;
    summary.started_at = startedAt;
    summary.finished_at = finishedAt;
    if (work !== null) summary.work = work;
    if (usage.length > 0) summary.usage = usage;
    summary.route = { policy_id: "none", initial_provider: null, initial_model: null, escalations: [] };
    summary.assets_consumed = [];
    summary.compactions = 0;
    summary.human_interventions = [];
    summary.local_result = localResult;
    // §8.3 (Revision 1) fields. Nullable; every null carries its closed code so the ledger can
    // tell "unobserved" from "zero". A bk_ task ref is the backlog row; nothing else is bound yet.
    const backlogRowId = taskRef && /^bk_[A-Za-z0-9._-]+$/.test(taskRef) ? taskRef : null;
    summary.lineage = { root_objective_id: null, backlog_row_id: backlogRowId, parent_work_order_id: null };
    incomplete.push("lineage_unbound");
    summary.execution_world_ref = null;
    incomplete.push("execution_world_missing");
    summary.capacity_events = null;
    incomplete.push("capacity_unobserved");
    summary.decision_refs = [];
    summary.measurement_cost = null;
    incomplete.push("measurement_cost_unknown");
    if (incomplete.length > 0) summary.incomplete = incomplete;
    summary.cost_reconstruction = costReconstruction;

    return summary;
  } catch {
    if (!incomplete.includes("malformed_entries")) incomplete.push("malformed_entries");
    return {
      schema: "vinci.work-order-economics-summary.v1",
      work_order_id: str(input?.task?.envelope?.ref),
      attempt_label: str(input?.attemptLabel),
      vinci_version: "unknown",
      started_at: null,
      finished_at: null,
      route: { policy_id: "none", initial_provider: null, initial_model: null, escalations: [] },
      assets_consumed: [],
      compactions: 0,
      human_interventions: [],
      local_result: {
        task_state: null,
        verification_state: null,
        changed_files: null,
        head_sha: null,
        pr_number: null,
        limit_tripped: null,
        harness_stop: null,
      },
      cost_reconstruction: "usage_entries",
      incomplete,
    };
  }
}

// ---------------------------------------------------------------------------
// 3. economicsSha256
// ---------------------------------------------------------------------------
export function economicsSha256(canonicalString) {
  try {
    const input = typeof canonicalString === "string" ? canonicalString : "";
    return createHash("sha256").update(input, "utf8").digest("hex");
  } catch {
    return createHash("sha256").update("", "utf8").digest("hex");
  }
}
