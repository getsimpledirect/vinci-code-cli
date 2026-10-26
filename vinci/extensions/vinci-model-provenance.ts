/**
 * Durable model provenance for Vinci sessions.
 *
 * A public Vinci class must not silently become an unauditable model alias. This extension records
 * the requested Vinci model, the client-declared capability fingerprint, and the first concrete
 * route reported by the gateway/stream. It restores the route pin across resume and fork, sends the
 * opaque pin on later requests, and stops mid-session model/class/version/capability drift.
 * Streamed provider spellings remain visible without being treated as model changes.
 *
 * The current gateway can already populate `responseModel` through the OpenAI stream. The dedicated
 * Vinci response headers below are the stronger future contract; until they exist, `auto` remains
 * explicitly unresolved rather than being falsely recorded as its own concrete implementation.
 */

import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalVinciClass } from "./lib/vinci-class.ts";

// vinci-model-classes 0.2.0, src/provenance.ts:22-27
// (dist/provenance.d.ts:16-17). Pinned by private-contracts-drift.types.ts only.
export type ResolutionEvidence = "gateway-header" | "response-stream" | "requested-model";

const ENTRY_TYPE = "vinci-model-provenance";
const SCHEMA_VERSION = 1;
const AUTO_MODEL = "auto";

const REQUESTED_TIER_HEADER = "x-vinci-requested-tier";
const CLIENT_CAPABILITY_HEADER = "x-vinci-client-capability-fingerprint";
const RESOLUTION_TOKEN_HEADER = "x-vinci-resolution-token";
const PLATFORM_HEADER = "x-vinci-platform";
const RESOLVED_MODEL_HEADER = "x-vinci-resolved-model";
const RESOLVED_CLASS_HEADER = "x-vinci-resolved-class";
const RESOLVED_VERSION_HEADER = "x-vinci-model-version";
const SERVER_CAPABILITY_HEADER = "x-vinci-capability-fingerprint";
// Match vinci-loopbreak's deferred turn-stop; aborting synchronously inside a hook can deadlock.
const DRIFT_STOP = process.env.VINCI_NO_DRIFT_STOP !== "1";

type VinciModel = NonNullable<ExtensionContext["model"]>;

interface RequestedModel {
  provider: string;
  model: string;
  alias?: true;
}

interface ClientCapabilities {
  api: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  inputs: string[];
}

interface ResolvedRoute {
  model: string;
  resolvedClass?: string;
  expectedClass?: string;
  streamModels?: string[];
  routeChanges?: number;
  lastStreamModel?: string;
  version?: string;
  capabilityFingerprint?: string;
  resolutionToken?: string;
  evidence: ResolutionEvidence;
}

interface SelectionRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  event: "selected";
  requested: RequestedModel;
  effectiveClass?: string;
  clientCapabilities: ClientCapabilities;
  clientCapabilityFingerprint: string;
  source: string;
}

interface ResolutionRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  event: "resolved";
  requested: RequestedModel;
  effectiveClass?: string;
  clientCapabilityFingerprint: string;
  resolved: ResolvedRoute;
}

interface DriftRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  event: "drift";
  requested: RequestedModel;
  effectiveClass?: string;
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
  resolvedClass?: string;
  version?: string;
  capabilityFingerprint?: string;
  resolutionToken?: string;
}

export type VinciModelFailureKind = "account" | "transient" | "unavailable" | "fatal";

const VINCI_CLASS_RANK: Readonly<Record<string, number>> = {
  mezzo: 0,
  forte: 1,
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
  return (
    message.replaceAll("\r", " ").replaceAll("\n", " ").replace(/\s+/g, " ").trim().slice(0, 500) || "unknown error"
  );
}

export function classifyVinciModelError(error: unknown): VinciModelFailureKind {
  const status = errorStatus(error);
  const name = error instanceof Error ? error.name : "";
  const text = `${status ?? ""} ${name} ${describeVinciModelError(error)}`;
  if (status === 401 || status === 402 || status === 403 || status === 429 || ACCOUNT_ERROR.test(text))
    return "account";
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
  return canonicalVinciClass(value)
    .trim()
    .toLowerCase()
    .replace(/^vinci\//, "");
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
  const original = (model as VinciModel & { vinciRequestedClass?: string }).vinciRequestedClass ?? model.id;
  return {
    provider: model.provider,
    model: original,
    ...(canonicalVinciClass(original) !== original ? { alias: true as const } : {}),
  };
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
      (candidate.resolvedClass === undefined || typeof candidate.resolvedClass === "string") &&
      (candidate.expectedClass === undefined || typeof candidate.expectedClass === "string") &&
      (candidate.streamModels === undefined ||
        (Array.isArray(candidate.streamModels) &&
          candidate.streamModels.every((model) => typeof model === "string"))) &&
      (candidate.routeChanges === undefined ||
        (Number.isSafeInteger(candidate.routeChanges) && Number(candidate.routeChanges) >= 0)) &&
      (candidate.lastStreamModel === undefined || typeof candidate.lastStreamModel === "string") &&
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
  if (pinned.resolvedClass && observed.resolvedClass && pinned.resolvedClass !== observed.resolvedClass) return true;
  if (isStrongerEvidence(pinned.evidence, observed.evidence)) return false;
  if (pinned.evidence === "response-stream" && observed.evidence === "response-stream") return false;
  if (pinned.evidence === observed.evidence && pinned.model !== observed.model) return true;
  if (pinned.version && observed.version && pinned.version !== observed.version) return true;
  return Boolean(
    pinned.capabilityFingerprint &&
      observed.capabilityFingerprint &&
      pinned.capabilityFingerprint !== observed.capabilityFingerprint,
  );
}

function mergeRoute(current: ResolvedRoute, next: ResolvedRoute): ResolvedRoute {
  return {
    model: isStrongerEvidence(next.evidence, current.evidence) ? current.model : next.model,
    resolvedClass: next.resolvedClass ?? current.resolvedClass,
    expectedClass: next.expectedClass ?? current.expectedClass,
    streamModels: next.streamModels,
    routeChanges: next.routeChanges,
    lastStreamModel: next.lastStreamModel,
    version: next.version ?? current.version,
    capabilityFingerprint: next.capabilityFingerprint ?? current.capabilityFingerprint,
    resolutionToken: next.resolutionToken ?? current.resolutionToken,
    evidence: isStrongerEvidence(current.evidence, next.evidence) ? next.evidence : current.evidence,
  };
}

function restoreActive(
  entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
  requested: RequestedModel,
) {
  let active: ActiveProvenance | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !isRecord(entry.data)) continue;
    const record = entry.data;
    if (record.event === "selected") {
      // A historical alias pin may identify its retired occupant. Preserve the record, but
      // establish a new Forte route rather than carrying that occupant's token forward.
      active =
        sameRequested(record.requested, requested) && (!requested.alias || record.effectiveClass === "forte")
          ? { selection: record }
          : undefined;
      continue;
    }
    if (!active || !sameRequested(record.requested, active.selection.requested)) continue;
    if (record.event === "resolved") active.resolution = record.resolved;
    else active.drift = record;
  }
  return active;
}

function routeLabel(route: ResolvedRoute): string {
  const label = canonicalVinciClass(route.model) !== route.model ? "Vinci Forte" : route.model;
  return route.version ? `${label} (${route.version})` : label;
}

export default function (pi: ExtensionAPI) {
  let active: ActiveProvenance | undefined;
  let pendingResponse: PendingResponse | undefined;
  const aliasNotedSessions = new Set<string>();

  const recordResolution = (resolved: ResolvedRoute): void => {
    if (!active || JSON.stringify(resolved) === JSON.stringify(active.resolution)) return;
    active.resolution = resolved;
    const record: ResolutionRecord = {
      schemaVersion: SCHEMA_VERSION,
      event: "resolved",
      requested: active.selection.requested,
      effectiveClass: active.selection.effectiveClass ?? normalizedVinciClass(active.selection.requested.model),
      clientCapabilityFingerprint: active.selection.clientCapabilityFingerprint,
      resolved,
    };
    pi.appendEntry(ENTRY_TYPE, record);
  };

  const explainAlias = (model: VinciModel, ctx: ExtensionContext): void => {
    if (model.provider !== "vinci" || !requestedFrom(model).alias) return;
    const sessionId = ctx.sessionManager.getSessionId?.() ?? "current";
    if (aliasNotedSessions.has(sessionId)) return;
    aliasNotedSessions.add(sessionId);
    ctx.ui.notify("Vinci Fortissimo now uses Vinci Forte", "info");
  };

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
      effectiveClass: normalizedVinciClass(model.id),
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
    explainAlias(model, ctx);
    active = restoreActive(ctx.sessionManager.getBranch(), requestedFrom(model));
    if (!active) select(model, event.reason);
  });

  pi.on("model_select", (event, ctx) => {
    explainAlias(event.model, ctx);
    const requested = requestedFrom(event.model);
    if (event.source === "restore" && active && sameRequested(active.selection.requested, requested)) return;
    select(event.model, event.source);
  });

  pi.on("before_provider_headers", (event, ctx) => {
    const model = ctx.model;
    if (!model || model.provider !== "vinci") return;
    explainAlias(model, ctx);

    // Attribution: the gateway records which client app spent the tokens. Set before the
    // provenance bookkeeping below so it does not depend on selection state.
    event.headers[PLATFORM_HEADER] = "code";

    const requested = requestedFrom(model);
    if (!active || !sameRequested(active.selection.requested, requested)) select(model, "request");
    if (!active) return;

    if (model.id !== AUTO_MODEL) event.headers[REQUESTED_TIER_HEADER] = requested.model;
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
      resolvedClass: headerValue(event.headers, RESOLVED_CLASS_HEADER),
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
    const matchesMessage = (requested: RequestedModel) =>
      requested.provider === message.provider &&
      canonicalVinciClass(requested.model) === canonicalVinciClass(message.model);
    const response = pendingResponse && matchesMessage(pendingResponse.requested) ? pendingResponse : undefined;
    const requested =
      response?.requested ??
      (active && matchesMessage(active.selection.requested)
        ? active.selection.requested
        : { provider: message.provider, model: message.model });
    pendingResponse = undefined;
    if (message.stopReason === "error" || message.stopReason === "aborted") return;

    if (!active || !sameRequested(active.selection.requested, requested)) {
      const model = ctx.model;
      if (!model || !sameRequested(requestedFrom(model), requested)) return;
      select(model, "response");
    }
    if (!active) return;

    const streamedModel = cleanHeader(message.responseModel, 256);
    const streamModels = [...(active.resolution?.streamModels ?? [])];
    if (streamedModel && !streamModels.includes(streamedModel)) streamModels.push(streamedModel);
    const lastStreamModel = active.resolution?.lastStreamModel;
    const routeChanges =
      (active.resolution?.routeChanges ?? 0) +
      (streamedModel && lastStreamModel && streamedModel !== lastStreamModel ? 1 : 0);
    const routeHistory = { streamModels, routeChanges, lastStreamModel: streamedModel ?? lastStreamModel };
    const requestedClass = normalizedVinciClass(requested.model);
    const resolvedClass = response?.resolvedClass ? normalizedVinciClass(response.resolvedClass) : undefined;
    // Auto and non-class requests learn their expectation from the first server class signal.
    const expectedClass = Object.hasOwn(VINCI_CLASS_RANK, requestedClass)
      ? requestedClass
      : (active.resolution?.expectedClass ?? active.resolution?.resolvedClass ?? resolvedClass);
    let evidence: ResolutionEvidence | undefined;
    let resolvedModel: string | undefined;
    if (response?.resolvedModel) {
      resolvedModel = response.resolvedModel;
      evidence = "gateway-header";
    } else if (streamedModel && streamedModel !== requested.model) {
      resolvedModel = streamedModel;
      evidence = "response-stream";
    } else if (!active.resolution && requested.model !== AUTO_MODEL) {
      resolvedModel = canonicalVinciClass(requested.model);
      evidence = "requested-model";
    } else if (
      response?.resolvedClass ||
      (active.resolution &&
        (streamedModel || response?.version || response?.capabilityFingerprint || response?.resolutionToken))
    ) {
      resolvedModel = active.resolution?.model ?? canonicalVinciClass(requested.model);
      evidence = active.resolution?.evidence ?? "requested-model";
    }
    if (!resolvedModel || !evidence) return;

    const observed: ResolvedRoute = {
      model: resolvedModel,
      resolvedClass,
      expectedClass,
      ...routeHistory,
      version: response?.version,
      capabilityFingerprint: response?.capabilityFingerprint,
      resolutionToken: response?.resolutionToken,
      evidence,
    };

    const classChanged = Boolean(expectedClass && resolvedClass && expectedClass !== resolvedClass);
    const cheaper = isCheaperVinciClass(requested.model, observed.resolvedClass ?? observed.model);
    if (classChanged || cheaper || (active.resolution && hasRouteDrift(active.resolution, observed))) {
      // Persist route history even when the observed occupant cannot replace the session pin.
      if (active.resolution) recordResolution({ ...active.resolution, ...routeHistory });
      const pinned: ResolvedRoute = active.resolution ?? {
        model: canonicalVinciClass(requested.model),
        expectedClass,
        resolvedClass: expectedClass,
        evidence: "requested-model",
        ...routeHistory,
      };
      if (!active.drift) {
        const drift: DriftRecord = {
          schemaVersion: SCHEMA_VERSION,
          event: "drift",
          requested,
          effectiveClass: active.selection.effectiveClass ?? normalizedVinciClass(requested.model),
          pinned: withoutToken(pinned),
          observed: withoutToken(observed),
        };
        active.drift = drift;
        pi.appendEntry(ENTRY_TYPE, drift);
        const from = classChanged ? expectedClass : routeLabel(pinned);
        const to = classChanged ? resolvedClass : routeLabel(observed);
        ctx.ui.notify(
          `${cheaper ? "CRITICAL: " : ""}Vinci stopped this turn: the model changed from ${from} to ${to}. This session stays stopped; start a new session (/new) to continue with ${to}.`,
          "error",
        );
      }
      if (DRIFT_STOP) {
        setTimeout(() => {
          try {
            ctx.abort();
          } catch {
            /* best-effort, as in vinci-loopbreak */
          }
        }, 200);
      }
      return;
    }

    const merged = active.resolution ? mergeRoute(active.resolution, observed) : observed;
    recordResolution(merged);
  });

  pi.registerCommand("model-info", {
    description: "Show the requested and resolved Vinci model for this session",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      if (!model || model.provider !== "vinci") {
        ctx.ui.notify("Model provenance is available for Vinci sessions only.", "info");
        return;
      }
      const selection = requestedFrom(model);
      const requested = selection.alias
        ? `Vinci Forte (alias selection: ${selection.model})`
        : `${model.provider}/${model.id}`;
      const current = active && sameRequested(active.selection.requested, requestedFrom(model)) ? active : undefined;
      const routeChanges = current?.resolution?.routeChanges ?? 0;
      const streamModels = current?.resolution?.streamModels ?? current?.drift?.observed.streamModels ?? [];
      let status = current?.resolution ? "stable" : "unresolved";
      if (current?.drift) status = "model drift detected";
      else if (routeChanges) status = `stable (provider route changed ${routeChanges} times; same model class)`;
      const lines = [
        `Requested: ${requested}`,
        ...(selection.alias ? ["Effective class: Vinci Forte"] : []),
        `Resolved: ${current?.resolution ? routeLabel(current.resolution) : "awaiting gateway provenance"}`,
        `Client capabilities: ${current?.selection.clientCapabilityFingerprint ?? fingerprintCapabilities(clientCapabilitiesFor(model))}`,
        `Server capabilities: ${current?.resolution?.capabilityFingerprint ?? "not reported"}`,
        `Session pin: ${current?.resolution?.resolutionToken ? "active" : "not reported"}`,
        ...(streamModels.length ? [`Provider routes seen: ${streamModels.join(", ")}`] : []),
        `Status: ${status}`,
      ];
      ctx.ui.notify(lines.join("\n"), current?.drift ? "error" : "info");
    },
  });
}
