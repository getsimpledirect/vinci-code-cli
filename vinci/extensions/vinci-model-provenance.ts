/**
 * Durable model provenance for Vinci sessions.
 *
 * A public Vinci class must not silently become an unauditable model alias. This extension records
 * the requested Vinci model, the client-declared capability fingerprint, and the first concrete
 * route reported by the gateway/stream. It restores the route pin across resume and fork, sends the
 * opaque pin on later requests, and makes any mid-session model/version/capability drift visible.
 *
 * The current gateway can already populate `responseModel` through the OpenAI stream. The dedicated
 * Vinci response headers below are the stronger future contract; until they exist, `auto` remains
 * explicitly unresolved rather than being falsely recorded as its own concrete implementation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

const ENTRY_TYPE = "vinci-model-provenance";
const SCHEMA_VERSION = 1;
const AUTO_MODEL = "auto";

const REQUESTED_TIER_HEADER = "x-vinci-requested-tier";
const CLIENT_CAPABILITY_HEADER = "x-vinci-client-capability-fingerprint";
const RESOLUTION_TOKEN_HEADER = "x-vinci-resolution-token";
const PLATFORM_HEADER = "x-vinci-platform";
const RESOLVED_MODEL_HEADER = "x-vinci-resolved-model";
const RESOLVED_VERSION_HEADER = "x-vinci-model-version";
const SERVER_CAPABILITY_HEADER = "x-vinci-capability-fingerprint";

type VinciModel = NonNullable<ExtensionContext["model"]>;

interface RequestedModel {
  provider: string;
  model: string;
}

interface ClientCapabilities {
  api: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  inputs: string[];
}

type ResolutionEvidence = "gateway-header" | "response-stream" | "requested-model";

interface ResolvedRoute {
  model: string;
  version?: string;
  capabilityFingerprint?: string;
  resolutionToken?: string;
  evidence: ResolutionEvidence;
}

interface SelectionRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  event: "selected";
  requested: RequestedModel;
  clientCapabilities: ClientCapabilities;
  clientCapabilityFingerprint: string;
  source: string;
}

interface ResolutionRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  event: "resolved";
  requested: RequestedModel;
  clientCapabilityFingerprint: string;
  resolved: ResolvedRoute;
}

interface DriftRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  event: "drift";
  requested: RequestedModel;
  pinned: Omit<ResolvedRoute, "resolutionToken">;
  observed: Omit<ResolvedRoute, "resolutionToken">;
}

export type VinciModelProvenanceRecord = SelectionRecord | ResolutionRecord | DriftRecord;

interface ActiveProvenance {
  selection: SelectionRecord;
  resolution?: ResolvedRoute;
  drift?: DriftRecord;
}

interface PendingResponse {
  requested: RequestedModel;
  resolvedModel?: string;
  version?: string;
  capabilityFingerprint?: string;
  resolutionToken?: string;
}

export type VinciModelFailureKind = "account" | "transient" | "unavailable" | "fatal";

const VINCI_CLASS_RANK: Readonly<Record<string, number>> = {
  forte: 0,
  fortissimo: 1,
};
const ACCOUNT_ERROR =
  /\b(?:401|402|403|429)\b|insufficient[_ -]?(?:credits?|funds?|quota)|(?:credit|budget|quota|usage|plan|subscription)[_ -]?(?:exhausted|exceeded|limit|cap|reached)|(?:account )?balance.{0,24}(?:exhausted|insufficient|low|required)|out of (?:credits?|budget)|spend(?:ing)?[_ -]?(?:limit|cap)|billing|payment required|card declined|rate[_ -]?limit|too many requests|unauthori[sz]ed|forbidden|invalid (?:api )?key|expired (?:api )?(?:key|token)|authentication|auth(?:entication)? failed|permission denied|entitlement|not entitled|subscription required|plan limit/i;
const UNAVAILABLE_ERROR =
  /\b(?:404|410)\b|model[_ -]?not[_ -]?found|(?:model|class|tier|route).{0,40}(?:not found|unavailable|not available|unsupported|not serving|no (?:available )?(?:endpoint|route))|no (?:available )?(?:provider|route|endpoint).{0,30}(?:model|class|tier)|unsupported (?:model|class|tier)/i;
const TRANSIENT_ERROR =
  /\b(?:408|425|500|502|503|504|524)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR_[A-Z_]+|timeout|timed out|overloaded|service unavailable|server error|internal error|provider returned error|network error|connection (?:error|refused|lost|reset)|socket hang up|fetch failed|upstream connect|reset before headers|other side closed|stream ended|terminated|temporarily unavailable|please retry|try (?:the|your) request again/i;

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
    $response?: { statusCode?: unknown };
  };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (typeof candidate.$metadata?.httpStatusCode === "number") return candidate.$metadata.httpStatusCode;
  if (typeof candidate.$response?.statusCode === "number") return candidate.$response.statusCode;
  return undefined;
}

export function describeVinciModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll("\r", " ").replaceAll("\n", " ").replace(/\s+/g, " ").trim().slice(0, 500) || "unknown error";
}

export function classifyVinciModelError(error: unknown): VinciModelFailureKind {
  const status = errorStatus(error);
  const name = error instanceof Error ? error.name : "";
  const message = describeVinciModelError(error);
  const text = `${status ?? ""} ${name} ${message}`;
  if (status === 402) {
    if (message.includes("in_flight_budget_exhausted")) return "transient";

    // This preserves a bounded same-class retry for OpenRouter affordability responses. The
    // classifier cannot alter request options, so the caller cannot yet clamp max_tokens here.
    const affordableMatch = /\bbut can only afford ([0-9]+)\b/i.exec(message);
    if (affordableMatch) return "transient";
    return "account";
  }
  if (status === 401 || status === 403 || status === 429 || ACCOUNT_ERROR.test(text)) return "account";
  if (status === 404 || status === 410 || UNAVAILABLE_ERROR.test(text)) return "unavailable";
  if (
    status === 408 ||
    status === 425 ||
    (status !== undefined && status >= 500) ||
    name === "TimeoutError" ||
    TRANSIENT_ERROR.test(text)
  ) {
    return "transient";
  }
  return "fatal";
}

export function assertSuccessfulVinciCompletion(
  response: { stopReason: string; errorMessage?: string },
  signal?: AbortSignal,
): void {
  if (response.stopReason !== "error" && response.stopReason !== "aborted") return;
  if (signal?.aborted && signal.reason instanceof Error) throw signal.reason;
  const error = new Error(response.errorMessage || `Vinci completion ${response.stopReason}`);
  if (response.stopReason === "aborted") error.name = "AbortError";
  throw error;
}

function normalizedVinciClass(value: string): string {
  return value.toLowerCase().replace(/^vinci\//, "").trim();
}

export function isCheaperVinciClass(requested: string, served: string): boolean {
  const requestedRank = VINCI_CLASS_RANK[normalizedVinciClass(requested)];
  const servedRank = VINCI_CLASS_RANK[normalizedVinciClass(served)];
  return requestedRank !== undefined && servedRank !== undefined && servedRank < requestedRank;
}

function sameRequested(left: RequestedModel, right: RequestedModel): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function requestedFrom(model: VinciModel): RequestedModel {
  return { provider: model.provider, model: model.id };
}

export function clientCapabilitiesFor(model: VinciModel): ClientCapabilities {
  return {
    api: model.api,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    reasoning: model.reasoning,
    inputs: [...model.input].sort(),
  };
}

export function fingerprintCapabilities(capabilities: ClientCapabilities): string {
  return createHash("sha256").update(JSON.stringify(capabilities)).digest("hex").slice(0, 16);
}

function cleanHeader(value: string | undefined, maxLength: number): string | undefined {
  const clean = value?.replaceAll("\r", "").replaceAll("\n", "").replaceAll("\0", "").trim();
  return clean ? clean.slice(0, maxLength) : undefined;
}

function headerValue(headers: Record<string, string>, name: string, maxLength = 256): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return cleanHeader(value, maxLength);
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function isRequestedModel(value: unknown): value is RequestedModel {
  const candidate = objectRecord(value);
  return Boolean(candidate && typeof candidate.provider === "string" && typeof candidate.model === "string");
}

function isClientCapabilities(value: unknown): value is ClientCapabilities {
  const candidate = objectRecord(value);
  return Boolean(
    candidate &&
      typeof candidate.api === "string" &&
      typeof candidate.contextWindow === "number" &&
      typeof candidate.maxOutputTokens === "number" &&
      typeof candidate.reasoning === "boolean" &&
      Array.isArray(candidate.inputs) &&
      candidate.inputs.every((input) => typeof input === "string"),
  );
}

function isResolvedRoute(value: unknown): value is ResolvedRoute {
  const candidate = objectRecord(value);
  return Boolean(
    candidate &&
      typeof candidate.model === "string" &&
      (candidate.version === undefined || typeof candidate.version === "string") &&
      (candidate.capabilityFingerprint === undefined || typeof candidate.capabilityFingerprint === "string") &&
      (candidate.resolutionToken === undefined || typeof candidate.resolutionToken === "string") &&
      (candidate.evidence === "gateway-header" ||
        candidate.evidence === "response-stream" ||
        candidate.evidence === "requested-model"),
  );
}

function isRecord(value: unknown): value is VinciModelProvenanceRecord {
  const candidate = objectRecord(value);
  if (
    !candidate ||
    candidate.schemaVersion !== SCHEMA_VERSION ||
    !isRequestedModel(candidate.requested) ||
    typeof candidate.event !== "string"
  ) {
    return false;
  }
  if (candidate.event === "selected") {
    return (
      isClientCapabilities(candidate.clientCapabilities) &&
      typeof candidate.clientCapabilityFingerprint === "string" &&
      typeof candidate.source === "string"
    );
  }
  if (candidate.event === "resolved") {
    return typeof candidate.clientCapabilityFingerprint === "string" && isResolvedRoute(candidate.resolved);
  }
  return candidate.event === "drift" && isResolvedRoute(candidate.pinned) && isResolvedRoute(candidate.observed);
}

function withoutToken(route: ResolvedRoute): Omit<ResolvedRoute, "resolutionToken"> {
  const { resolutionToken: _resolutionToken, ...visible } = route;
  return visible;
}

function isStrongerEvidence(current: ResolutionEvidence, next: ResolutionEvidence): boolean {
  const rank: Record<ResolutionEvidence, number> = {
    "requested-model": 0,
    "response-stream": 1,
    "gateway-header": 2,
  };
  return rank[next] > rank[current];
}

function hasRouteDrift(pinned: ResolvedRoute, observed: ResolvedRoute): boolean {
  if (pinned.model !== observed.model) return true;
  if (pinned.version && observed.version && pinned.version !== observed.version) return true;
  return Boolean(
    pinned.capabilityFingerprint &&
      observed.capabilityFingerprint &&
      pinned.capabilityFingerprint !== observed.capabilityFingerprint,
  );
}

function mergeRoute(current: ResolvedRoute, next: ResolvedRoute): ResolvedRoute {
  return {
    model: next.model,
    version: next.version ?? current.version,
    capabilityFingerprint: next.capabilityFingerprint ?? current.capabilityFingerprint,
    resolutionToken: next.resolutionToken ?? current.resolutionToken,
    evidence: isStrongerEvidence(current.evidence, next.evidence) ? next.evidence : current.evidence,
  };
}

function restoreActive(entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, requested: RequestedModel) {
  let active: ActiveProvenance | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !isRecord(entry.data)) continue;
    const record = entry.data;
    if (record.event === "selected") {
      active = sameRequested(record.requested, requested) ? { selection: record } : undefined;
      continue;
    }
    if (!active || !sameRequested(record.requested, active.selection.requested)) continue;
    if (record.event === "resolved") active.resolution = record.resolved;
    else active.drift = record;
  }
  return active;
}

function routeLabel(route: ResolvedRoute): string {
  return route.version ? `${route.model} (${route.version})` : route.model;
}

export default function (pi: ExtensionAPI) {
  let active: ActiveProvenance | undefined;
  let pendingResponse: PendingResponse | undefined;

  const select = (model: VinciModel, source: string): void => {
    pendingResponse = undefined;
    if (model.provider !== "vinci") {
      active = undefined;
      return;
    }
    const capabilities = clientCapabilitiesFor(model);
    const selection: SelectionRecord = {
      schemaVersion: SCHEMA_VERSION,
      event: "selected",
      requested: requestedFrom(model),
      clientCapabilities: capabilities,
      clientCapabilityFingerprint: fingerprintCapabilities(capabilities),
      source,
    };
    active = { selection };
    pi.appendEntry(ENTRY_TYPE, selection);
  };

  pi.on("session_start", (event, ctx) => {
    pendingResponse = undefined;
    const model = ctx.model;
    if (!model || model.provider !== "vinci") {
      active = undefined;
      return;
    }
    active = restoreActive(ctx.sessionManager.getBranch(), requestedFrom(model));
    if (!active) select(model, event.reason);
  });

  pi.on("model_select", (event) => {
    const requested = requestedFrom(event.model);
    if (event.source === "restore" && active && sameRequested(active.selection.requested, requested)) return;
    select(event.model, event.source);
  });

  pi.on("before_provider_headers", (event, ctx) => {
    const model = ctx.model;
    if (!model || model.provider !== "vinci") return;

    // Attribution: the gateway records which client app spent the tokens. Set before the
    // provenance bookkeeping below so it does not depend on selection state.
    event.headers[PLATFORM_HEADER] = "code";

    const requested = requestedFrom(model);
    if (!active || !sameRequested(active.selection.requested, requested)) select(model, "request");
    if (!active) return;

    if (model.id !== AUTO_MODEL) event.headers[REQUESTED_TIER_HEADER] = model.id;
    event.headers[CLIENT_CAPABILITY_HEADER] = active.selection.clientCapabilityFingerprint;
    if (active.resolution?.resolutionToken) {
      event.headers[RESOLUTION_TOKEN_HEADER] = active.resolution.resolutionToken;
    }
  });

  pi.on("after_provider_response", (event, ctx) => {
    const model = ctx.model;
    if (!model || model.provider !== "vinci" || event.status < 200 || event.status >= 300) {
      pendingResponse = undefined;
      return;
    }
    pendingResponse = {
      requested: requestedFrom(model),
      resolvedModel: headerValue(event.headers, RESOLVED_MODEL_HEADER),
      version: headerValue(event.headers, RESOLVED_VERSION_HEADER),
      capabilityFingerprint: headerValue(event.headers, SERVER_CAPABILITY_HEADER),
      resolutionToken: headerValue(event.headers, RESOLUTION_TOKEN_HEADER, 512),
    };
    if (
      pendingResponse.resolvedModel &&
      isCheaperVinciClass(pendingResponse.requested.model, pendingResponse.resolvedModel)
    ) {
      ctx.ui.notify(
        `Vinci refused a model downgrade before reading the response: requested ${pendingResponse.requested.model}, but the gateway offered cheaper class ${pendingResponse.resolvedModel}. No response content will be accepted.`,
        "error",
      );
    }
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.provider !== "vinci") return;
    const requested = { provider: message.provider, model: message.model };
    const response = pendingResponse && sameRequested(pendingResponse.requested, requested) ? pendingResponse : undefined;
    pendingResponse = undefined;
    if (message.stopReason === "error" || message.stopReason === "aborted") return;

    if (!active || !sameRequested(active.selection.requested, requested)) {
      const model = ctx.model;
      if (!model || !sameRequested(requestedFrom(model), requested)) return;
      select(model, "response");
    }
    if (!active) return;

    const streamedModel = cleanHeader(message.responseModel, 256);
    let evidence: ResolutionEvidence | undefined;
    let resolvedModel: string | undefined;
    if (response?.resolvedModel) {
      resolvedModel = response.resolvedModel;
      evidence = "gateway-header";
    } else if (streamedModel && streamedModel !== requested.model) {
      resolvedModel = streamedModel;
      evidence = "response-stream";
    } else if (!active.resolution && requested.model !== AUTO_MODEL) {
      resolvedModel = requested.model;
      evidence = "requested-model";
    } else if (active.resolution && (response?.version || response?.capabilityFingerprint || response?.resolutionToken)) {
      resolvedModel = active.resolution.model;
      evidence = active.resolution.evidence;
    }
    if (!resolvedModel || !evidence) return;

    const observed: ResolvedRoute = {
      model: resolvedModel,
      version: response?.version,
      capabilityFingerprint: response?.capabilityFingerprint,
      resolutionToken: response?.resolutionToken,
      evidence,
    };

    if (
      active.resolution?.evidence === "requested-model" &&
      active.resolution.model === requested.model &&
      isStrongerEvidence(active.resolution.evidence, observed.evidence)
    ) {
      active.resolution = undefined;
    }

    if (active.resolution && hasRouteDrift(active.resolution, observed)) {
      if (!active.drift) {
        const cheaper = isCheaperVinciClass(requested.model, observed.model);
        const drift: DriftRecord = {
          schemaVersion: SCHEMA_VERSION,
          event: "drift",
          requested,
          pinned: withoutToken(active.resolution),
          observed: withoutToken(observed),
        };
        active.drift = drift;
        pi.appendEntry(ENTRY_TYPE, drift);
        ctx.ui.notify(
          cheaper
            ? `CRITICAL: Vinci received a cheaper model class than requested. Requested ${requested.model}; served ${routeLabel(observed)}. Do not use this response. Start a new session or restore the requested class.`
            : `Vinci model drift detected. This session is pinned to ${routeLabel(active.resolution)}, but the gateway returned ${routeLabel(observed)}. Start a new session or restore the pinned route before trusting further results.`,
          "error",
        );
      }
      return;
    }

    const merged = active.resolution ? mergeRoute(active.resolution, observed) : observed;
    if (JSON.stringify(merged) === JSON.stringify(active.resolution)) return;
    active.resolution = merged;
    const record: ResolutionRecord = {
      schemaVersion: SCHEMA_VERSION,
      event: "resolved",
      requested,
      clientCapabilityFingerprint: active.selection.clientCapabilityFingerprint,
      resolved: merged,
    };
    pi.appendEntry(ENTRY_TYPE, record);
  });

  pi.registerCommand("model-info", {
    description: "Show the requested and resolved Vinci model for this session",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      if (!model || model.provider !== "vinci") {
        ctx.ui.notify("Model provenance is available for Vinci sessions only.", "info");
        return;
      }
      const requested = `${model.provider}/${model.id}`;
      const current = active && sameRequested(active.selection.requested, requestedFrom(model)) ? active : undefined;
      const lines = [
        `Requested: ${requested}`,
        `Resolved: ${current?.resolution ? routeLabel(current.resolution) : "awaiting gateway provenance"}`,
        `Client capabilities: ${current?.selection.clientCapabilityFingerprint ?? fingerprintCapabilities(clientCapabilitiesFor(model))}`,
        `Server capabilities: ${current?.resolution?.capabilityFingerprint ?? "not reported"}`,
        `Session pin: ${current?.resolution?.resolutionToken ? "active" : "not reported"}`,
        `Status: ${current?.drift ? "model drift detected" : current?.resolution ? "stable" : "unresolved"}`,
      ];
      ctx.ui.notify(lines.join("\n"), current?.drift ? "error" : "info");
    },
  });
}
