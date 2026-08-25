import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { setVinciConnection } from "./lib/ui-state.ts";
import { VINCI_BILLING_URL, VINCI_GATEWAY_BASE_URL, VINCI_PLATFORM_BASE_URL } from "./vinci-links.ts";

/**
 * Vinci provider for Vinci Code — the default (and only) provider.
 *
 * AUTH = "Connect to Vinci" device pairing (RFC 8628). No API key to paste: `/login vinci`
 * opens the browser to platform.getsimpledirect.com/device, you authorize with one click,
 * and the CLI receives its own (revocable) key. The static VINCI_API_KEY stays as a
 * fallback/CI escape hatch only. Inference goes to the gateway (/api/v1); pairing goes to
 * the platform. Backend: vinci-chat #91 (device_pairings) + vinci-platform #2 (/api/device/*).
 */

// Shared, env-following endpoints from vinci-links (one resolution of VINCI_BASE_URL /
// VINCI_PLATFORM_URL for every extension) — no independent re-derivation here.
const BASE_URL = VINCI_GATEWAY_BASE_URL;
const PLATFORM_URL = VINCI_PLATFORM_BASE_URL;
const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";
const FORT_MODEL_ID = "zai-org/GLM-5.2";
const FAR_FUTURE = 4102444800000; // 2100 — the minted key doesn't expire, so never auto-refresh.
const VINCI_BUDGET_ERROR =
  /\b402\b|budget[_ -]?exhausted|insufficient[_ -]?quota|out of credits?|credit is used up|free allowance is used up|per-request spending limit/i;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Per-class rates in USD per million tokens, mirroring vinci-chat/config/classes.yaml. They differ
 * by roughly 5x between classes, so sharing one cost block would have reported Fortissimo usage at
 * Forte's prices. These are display/estimate metadata only — the account is billed server-side from
 * provider-reported cost plus markup — but an estimate that is wrong by 5x is worse than none.
 *
 * `auto` has no single true price, because the class it resolves to varies per account. It carries
 * the default class's rates as an indicative figure.
 */
const CLASS_COSTS: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  auto: { input: 0.93, output: 3, cacheRead: 0.18, cacheWrite: 0.93 },
  forte: { input: 0.93, output: 3, cacheRead: 0.18, cacheWrite: 0.93 },
  fortissimo: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
};

function vinciClassModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "none", high: "high", xhigh: "xhigh" },
    input: ["text", "image"] as Array<"text" | "image">,
    contextWindow: 900_000,
    maxTokens: 32_768,
    cost: CLASS_COSTS[id] ?? CLASS_COSTS.auto,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      sendSessionAffinityHeaders: true,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
      thinkingFormat: "openai" as const,
    },
  };
}

/**
 * Compose a terminal message for a Vinci billing refusal.
 * Accepts either a full error body (for structured codes) or just the error message text (for backward compat).
 * 
 * @param errorBodyOrMessage - Either the full error body (string) or raw error message
 * @param taskId - Session/task ID for resume command
 * @returns A terminal-appropriate message if this is a budget/billing error, or undefined if not
 */
export function vinciBudgetBlockedMessage(errorBodyOrMessage: string | undefined, taskId: string): string | undefined {
  if (!errorBodyOrMessage) return undefined;

  // Try to parse as JSON and extract structured code
  let code: string | undefined;
  try {
    const parsed = JSON.parse(errorBodyOrMessage);
    code = parsed.error?.code || parsed.code;
  } catch {
    // Not JSON, continue with text matching
  }

  // Route based on structured code if present
  if (code) {
    const resume = SAFE_TASK_ID.test(taskId) ? `, then run \`vinci resume ${taskId}\`` : "";
    switch (code) {
      case "balance_exhausted":
        return `BLOCKED: budget — Vinci credits are exhausted. Review or restore credits at ${VINCI_BILLING_URL}.`;
      case "payment_failed":
        return `BLOCKED: payment — Update your payment method at ${VINCI_BILLING_URL} to restore access.`;
      case "free_daily_cap":
        return `BLOCKED: daily limit — Your daily free allowance is exhausted. Try again after midnight UTC, or add credits or a plan at ${VINCI_BILLING_URL}.`;
      case "request_too_large":
        return "This request exceeds the per-request cost ceiling. Try a smaller request.";
      case "capacity":
        return "Vinci is at capacity right now. Your checkpoint is saved. Try again in a moment.";
    }
  }

  // Fallback to legacy text-based detection for older gateways / non-structured paths
  if (!VINCI_BUDGET_ERROR.test(errorBodyOrMessage)) return undefined;
  const resume = SAFE_TASK_ID.test(taskId) ? `, then run \`vinci resume ${taskId}\`` : "";
  return (
    "BLOCKED: budget — Vinci usage credits are unavailable for this request. Your checkpoint is saved. " +
    `Review or restore credits at ${VINCI_BILLING_URL}${resume}.`
  );
}

/**
 * The device-authorization login. Starts a pairing, shows the user the code + URL (Pi
 * renders this natively via onDeviceCode), then polls until they authorize in the browser.
 * Returns the minted vinci_live_ key as the credential (getApiKey → cred.access).
 */
async function loginVinci(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const start = await fetch(`${PLATFORM_URL}/api/device/code`, { method: "POST" });
  if (!start.ok) throw new Error(`Couldn't start pairing (${start.status}). Try again in a moment.`);
  const d = (await start.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  };

  // Native device-code prompt: "Go to <uri> and enter <code>". The user typing the code on
  // the page (which also warns + requires an explicit confirm) is the anti-phishing control.
  callbacks.onDeviceCode({
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    intervalSeconds: d.interval,
    expiresInSeconds: d.expires_in,
  });

  let intervalMs = Math.max(1, d.interval ?? 5) * 1000;
  const deadline = Date.now() + (d.expires_in ?? 600) * 1000;

  while (Date.now() < deadline) {
    if (callbacks.signal?.aborted) throw new Error("Sign-in cancelled.");
    await sleep(intervalMs);

    const res = await fetch(`${PLATFORM_URL}/api/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: d.device_code }),
    });

    if (res.status === 429) {
      // Rate-limited — honor Retry-After and keep polling.
      intervalMs = Math.max(intervalMs, (Number(res.headers.get("retry-after")) || 5) * 1000);
      continue;
    }

    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (res.ok && body.access_token) {
			setVinciConnection("signed-in");
      return { access: body.access_token, refresh: "", expires: FAR_FUTURE };
    }
    if (body.error === "authorization_pending") {
      callbacks.onProgress?.("Waiting for you to authorize in the browser…");
      continue;
    }
    if (body.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (body.error === "expired_token") throw new Error("The pairing expired — run /login vinci again.");
    throw new Error(body.error_description || body.error || "Pairing failed. Run /login vinci again.");
  }
  throw new Error("Pairing timed out — run /login vinci again.");
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("vinci", {
    name: "Vinci (SimpleDirect)",
    baseUrl: BASE_URL,
    apiKey: "$VINCI_API_KEY", // fallback / CI escape hatch — OAuth creds take precedence
    api: "openai-completions",
    models: [
      // `auto` lets the gateway resolve the account's class without persisting an explicit override.
      vinciClassModel("auto", "Vinci"),
      // Stable product classes. Their occupants and providers are configured server-side in
      // vinci-chat/config/classes.yaml, so future frontier swaps do not require a CLI release.
      vinciClassModel("forte", "Vinci Forte"),
      vinciClassModel("fortissimo", "Vinci Fortissimo"),
    ],
    oauth: {
      name: "Vinci",
      login: loginVinci,
      // The minted key doesn't expire or refresh; return creds unchanged if Pi ever asks.
      refreshToken: async (cred: OAuthCredentials) => cred,
      getApiKey: (cred: OAuthCredentials) => cred.access,
    },
  });

  // Internal qualification only. Production users continue through the managed Vinci gateway, so
  // no provider credential becomes a CLI setting or ships with the app. This direct lane exists to
  // prove Forte behavior without exposing a direct-provider route in the managed product.
  if (process.env.VINCI_DEEPINFRA_QUALIFICATION === "1") {
    pi.registerProvider("deepinfra", {
      name: "DeepInfra (Vinci internal qualification)",
      baseUrl: DEEPINFRA_BASE_URL,
      apiKey: "$VINCI_INTERNAL_DEEPINFRA_API_KEY",
      api: "openai-completions",
      models: [
        {
          id: FORT_MODEL_ID,
          name: "Vinci Forte (GLM 5.2 qualification)",
          reasoning: true,
          thinkingLevelMap: { off: null, minimal: null, low: null, medium: "none", high: "high", xhigh: "xhigh" },
          input: ["text"],
          contextWindow: 1_000_000,
          // Keep the client cap conservative until the production route's long-output behavior is
          // qualified end to end; this is not a claim about the model's architectural maximum.
          maxTokens: 32_768,
          cost: { input: 0.93, output: 3, cacheRead: 0.18, cacheWrite: 0.93 },
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: true,
            maxTokensField: "max_tokens",
            supportsStrictMode: false,
            supportsLongCacheRetention: false,
            thinkingFormat: "openai" as const,
          },
        },
      ],
    });
  }

  // Normalize managed-gateway terminal errors into actionable CLI states. Budget failures never
  // route around the account ledger: the durable Pi session is the checkpoint and resume target.
  const VINCI_OVERFLOW = /maximum context length|context window|too long/i;
  pi.on("message_end", (event, ctx) => {
    const m = event.message;
    if (m.role !== "assistant" || m.stopReason !== "error") return;
    if (m.provider !== "vinci" && ctx.model?.provider !== "vinci") return;
    const em = m.errorMessage ?? "";
    const budgetMessage = vinciBudgetBlockedMessage(em, ctx.sessionManager.getSessionId());
    if (budgetMessage) return { message: { ...m, errorMessage: budgetMessage } };

    // Make Pi's auto-compaction recognize vLLM's context-window errors so `/compact` can recover.
    if (em.includes("context_length_exceeded")) return;
    if (!VINCI_OVERFLOW.test(em)) return;
    return { message: { ...m, errorMessage: `context_length_exceeded: ${em}` } };
  });
}
