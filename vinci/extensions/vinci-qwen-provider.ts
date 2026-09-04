import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type Api,
  createAssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimpleOpenAICompletions } from "@earendil-works/pi-ai/compat";
import {
  acquireQwenFleetPermit,
  assertQwenCircuitClosed,
  assertQwenContextBindings,
  createQwenInferenceFetch,
  ensureQwenReady,
  QWEN_API,
  QWEN_MODEL,
  QWEN_PROVIDER,
  qwenModelWithOpenAiApi,
  qwenProviderHeaders,
  qwenSha256,
  scrubQwenBootstrapEnvironment,
  type QwenAttemptRecord,
  type QwenFetch,
  type QwenRuntimeConfig,
  type QwenSemanticSettlement,
  settleQwenSemanticOutcome,
  validateQwenOutboundPayload,
} from "./lib/qwen-runtime.ts";

function validUsage(message: { usage?: unknown }): boolean {
  if (!message.usage || typeof message.usage !== "object") return false;
  const usage = message.usage as Record<string, unknown>;
  const allowedUsage = new Set(["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens", "cost"]);
  if (Object.keys(usage).some((key) => !allowedUsage.has(key))) return false;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    if (typeof usage[key] !== "number" || !Number.isSafeInteger(usage[key]) || usage[key] < 0) return false;
  }
  for (const key of ["cacheWrite1h", "reasoning"] as const) {
    if (usage[key] !== undefined && (typeof usage[key] !== "number" || !Number.isSafeInteger(usage[key]) || usage[key] < 0)) return false;
  }
  const countedTokens = (usage.input as number) + (usage.output as number) + (usage.cacheRead as number) + (usage.cacheWrite as number);
  if (usage.totalTokens !== countedTokens) return false;
  if (typeof usage.reasoning === "number" && usage.reasoning > (usage.output as number)) return false;
  if (!usage.cost || typeof usage.cost !== "object") return false;
  const cost = usage.cost as Record<string, unknown>;
  if (Object.keys(cost).sort().join("\0") !== ["cacheRead", "cacheWrite", "input", "output", "total"].join("\0")) return false;
  for (const value of Object.values(cost)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  }
  const costParts = (cost.input as number) + (cost.output as number) + (cost.cacheRead as number) + (cost.cacheWrite as number);
  return Math.abs((cost.total as number) - costParts) <= Number.EPSILON * Math.max(1, costParts) * 8;
}

function validSemanticMessage(message: { content?: unknown; stopReason?: unknown }, context: Context): boolean {
  if (!Array.isArray(message.content) || !["stop", "length", "toolUse"].includes(String(message.stopReason))) return false;
  const qualifiedTools = new Set((context.tools ?? []).map((tool) => tool.name));
  let toolCalls = 0;
  for (const block of message.content) {
    if (!block || typeof block !== "object") return false;
    const value = block as Record<string, unknown>;
    if (value.type === "text") {
      if (typeof value.text !== "string") return false;
      continue;
    }
    if (value.type === "thinking") {
      if (typeof value.thinking !== "string") return false;
      continue;
    }
    if (
      value.type !== "toolCall" ||
      typeof value.id !== "string" || !value.id ||
      typeof value.name !== "string" || !qualifiedTools.has(value.name) ||
      !value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments)
    ) return false;
    toolCalls += 1;
  }
  return (message.stopReason === "toolUse") === (toolCalls > 0);
}

export function qwenProviderConfig(
  runtime: QwenRuntimeConfig,
  streamOpenAI = streamSimpleOpenAICompletions,
  onAttempt: (record: QwenAttemptRecord) => void = () => {},
  injectedFetch?: QwenFetch,
) {
  let inFlight = 0;
  let requestOrdinal = 0;
  return {
    name: "Qwen 3.8 27B (Vinci H200, non-authoritative)",
    baseUrl: runtime.baseUrl,
    // This sentinel is not a credential. The descriptor-resolved secret remains in this closure
    // and replaces the sentinel only at the governed OpenAI-compatible request boundary.
    apiKey: "runtime-resolved-secret-descriptor",
    api: QWEN_API,
    streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
      assertQwenCircuitClosed(runtime);
      assertQwenContextBindings(runtime, context);
      if (inFlight >= runtime.qualification.limits.max_concurrency) {
        throw new Error("qwen_concurrency_exceeded: the qualified single-request bound is already in use");
      }
      const releaseFleetPermit = acquireQwenFleetPermit(runtime);
      inFlight += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          releaseFleetPermit();
        } finally {
          inFlight -= 1;
        }
      };
      requestOrdinal += 1;
      const requestId = qwenSha256(`${runtime.attribution.workOrderId}\0${runtime.attribution.runId}\0${runtime.attribution.attemptId}\0${requestOrdinal}`);
      const semanticSettlement: QwenSemanticSettlement = { transportFailed: false, settled: false };
      let source;
      try {
        source = streamOpenAI(
          qwenModelWithOpenAiApi(model),
          context,
          {
            ...options,
            apiKey: runtime.secret,
            headers: { ...options?.headers, ...qwenProviderHeaders(runtime, requestId) },
            timeoutMs: runtime.qualification.limits.total_timeout_ms,
            maxRetries: 0,
            fetch: createQwenInferenceFetch(runtime, requestId, onAttempt, injectedFetch, semanticSettlement),
            onPayload: (payload) => {
              validateQwenOutboundPayload(runtime, payload);
              return payload;
            },
          } as SimpleStreamOptions & { fetch: typeof globalThis.fetch },
        );
      } catch (error) {
        release();
        throw error;
      }
      const bounded = createAssistantMessageEventStream();
      void (async () => {
        let terminalSeen = false;
        try {
          for await (const event of source) {
            if (event.type === "done" || event.type === "error") {
              terminalSeen = true;
              if (event.type === "error") {
                settleQwenSemanticOutcome(runtime, semanticSettlement, false, "parser_error", onAttempt);
              } else {
                const message = event.message;
                if (
                  message.provider !== QWEN_PROVIDER ||
                  message.model !== QWEN_MODEL ||
                  !validUsage(message) ||
                  !validSemanticMessage(message, context)
                ) {
                  throw new Error("qwen_semantic_invalid: terminal response failed exact identity, usage, finish, or tool semantics");
                }
                // A permit-release failure is itself a failed request. Never persist semantic
                // success until the external concurrency authority has been released cleanly.
                release();
                settleQwenSemanticOutcome(runtime, semanticSettlement, true, "success", onAttempt);
              }
              // Release before the terminal event can resolve result() or become observable to a
              // caller that immediately starts the next qualified request.
              release();
            }
            bounded.push(event);
          }
          if (!terminalSeen) throw new Error("qwen_stream_truncated: provider stream ended without a terminal event");
        } catch (error) {
          settleQwenSemanticOutcome(runtime, semanticSettlement, false, "parser_semantic_invalid", onAttempt);
          release();
          const message = {
            role: "assistant" as const,
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error" as const,
            errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
            timestamp: Date.now(),
          };
          bounded.push({ type: "error", reason: "error", error: message });
          bounded.end(message);
        } finally {
          release();
        }
      })();
      return bounded;
    },
    models: [
      {
        id: QWEN_MODEL,
        name: "Qwen 3.8 27B (qualified, non-authoritative)",
        reasoning: true,
        thinkingLevelMap: { off: "off", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
        input: ["text"] as Array<"text">,
        contextWindow: runtime.qualification.limits.context_window,
        maxTokens: runtime.qualification.limits.max_tokens,
        cost: {
          input: runtime.qualification.pricing.input_per_million_usd,
          output: runtime.qualification.pricing.output_per_million_usd,
          cacheRead: runtime.qualification.pricing.cache_read_per_million_usd,
          cacheWrite: runtime.qualification.pricing.cache_write_per_million_usd,
        },
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens" as const,
          requiresToolResultName: true,
          supportsStrictMode: false,
          supportsLongCacheRetention: false,
          thinkingFormat: "qwen-chat-template" as const,
        },
      },
    ],
  };
}

export default async function (pi: ExtensionAPI) {
  if (process.env.VINCI_QWEN_SELECTED !== "1") {
    throw new Error("qwen_not_selected: the Qwen extension may load only for a Worker-selected Qwen attempt");
  }
  let runtime: QwenRuntimeConfig;
  try {
    runtime = await ensureQwenReady();
  } finally {
    scrubQwenBootstrapEnvironment();
  }
  pi.registerProvider(
    QWEN_PROVIDER,
    qwenProviderConfig(runtime, streamSimpleOpenAICompletions, (record) => {
      pi.appendEntry("vinci-qwen-transport-attempt", {
        ...record,
        work_order_id: runtime.attribution.workOrderId,
        run_id: runtime.attribution.runId,
        attempt_id: runtime.attribution.attemptId,
        qualification_sha256: runtime.qualificationSha256,
      });
    }),
  );

  pi.on("before_provider_headers", (event, ctx) => {
    if (ctx.model?.provider !== QWEN_PROVIDER) return;
    event.headers["x-vinci-work-order-id"] = runtime.attribution.workOrderId;
    event.headers["x-vinci-run-id"] = runtime.attribution.runId;
    event.headers["x-vinci-attempt-id"] = runtime.attribution.attemptId;
    event.headers["x-vinci-qwen-output-authority"] = "non-authoritative";
    event.headers["x-vinci-qwen-qualification-sha256"] = runtime.qualificationSha256;
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || event.message.provider !== QWEN_PROVIDER) return;
    pi.appendEntry("vinci-qwen-output-label", {
      authority: "non-authoritative",
      independent_check_required: true,
      model: QWEN_MODEL,
      revision: runtime.qualification.bindings.revision,
      runtime: runtime.qualification.bindings.runtime,
      qualification_sha256: runtime.qualificationSha256,
      work_order_id: runtime.attribution.workOrderId,
      run_id: runtime.attribution.runId,
      attempt_id: runtime.attribution.attemptId,
      outcome: event.message.stopReason,
      usage: event.message.usage,
      session_id: ctx.sessionManager.getSessionId(),
    });
  });
}
