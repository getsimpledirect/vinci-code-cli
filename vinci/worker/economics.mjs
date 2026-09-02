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

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      flags.malformed = true;
      continue;
    }
    const provider = str(entry.provider);
    const model = str(entry.model);
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
        // model_calls outside any responseId (no dedup key available) accumulate directly;
        // responseId-keyed calls are tallied once per unique id so a duplicated response is one
        // call, not two.
        direct_model_calls: 0,
        response_calls: new Map(),
        cost_basis: null,
        cost_confidence: null,
      };
      rollup.set(key, group);
    }

    if (typeof entry.model_calls === "number" && entry.model_calls > 0) {
      if (typeof entry.responseId === "string" && entry.responseId) {
        // First write wins per responseId: a duplicated response contributes its call count once.
        if (!group.response_calls.has(entry.responseId)) group.response_calls.set(entry.responseId, entry.model_calls);
      } else {
        group.direct_model_calls += entry.model_calls;
      }
    }
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
    let modelCalls = group.direct_model_calls;
    for (const calls of group.response_calls.values()) modelCalls += calls;
    result.push({
      phase: group.phase,
      cost_category: group.cost_category,
      provider: group.provider,
      model: group.model,
      source: group.source,
      model_calls: modelCalls,
      input_tokens: group.input_tokens,
      cached_read_tokens: group.cached_read_tokens,
      cache_write_tokens: group.cache_write_tokens,
      output_tokens: group.output_tokens,
      reasoning_tokens: group.reasoning_tokens,
      cost_microusd: group.cost_microusd,
      cost_basis: group.cost_basis,
      cost_confidence: group.cost_confidence,
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

    let sessionId = null;
    if (str(input?.sessionState?.path)) {
      const parts = input.sessionState.path.split("/");
      sessionId = parts[parts.length - 1] || null;
    }

    const workerBuild = typeof input.workerBuild === "object" && input.workerBuild !== null ? input.workerBuild : null;
    const workerBuildDigestValue = workerBuild ? str(workerBuild.commit) || str(workerBuild.digest) : null;

    const vinciBinary = typeof input.vinciBinary === "object" && input.vinciBinary !== null ? input.vinciBinary : null;
    const vinciVersion = vinciBinary ? str(vinciBinary.version) || str(vinciBinary.error) || "unknown" : "unknown";

    const costReconstruction = str(input?.sessionState?.source) || "usage_entries";

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

    const taskOutcome = typeof input.taskOutcome === "object" && input.taskOutcome !== null ? input.taskOutcome : null;
    // `receipt` is the vinci-task-outcome entry the session wrote at its own terminal. Its absence
    // (SIGKILL, provider failure before the receipt) is what killed_before_outcome means; the
    // worker-side run outcome is not a substitute for it.
    const receipt = typeof input.receipt === "object" && input.receipt !== null ? input.receipt : null;
    if (receipt === null && !incomplete.includes("killed_before_outcome")) incomplete.push("killed_before_outcome");
    if (input.crewRan === true && !incomplete.includes("crew_unattributed")) incomplete.push("crew_unattributed");

    let headSha = null;
    if (taskOutcome && typeof taskOutcome.head_sha === "string") headSha = taskOutcome.head_sha;

    const run = typeof input.run === "object" && input.run !== null ? input.run : null;
    const exitCode = run && typeof run.exit_code === "number" ? run.exit_code : null;
    const limitTripped = run && typeof run.limit_tripped === "string" ? run.limit_tripped : null;
    const harnessStops = Array.isArray(run?.harness_stops) ? run.harness_stops : [];
    const harnessStop =
      harnessStops.length > 0 && typeof harnessStops[0] === "object" && harnessStops[0] !== null && typeof harnessStops[0].reason === "string"
        ? harnessStops[0].reason
        : null;

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
