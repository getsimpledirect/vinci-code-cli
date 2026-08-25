/**
 * Canonical Vinci ecosystem links — Phase 0 module of the ecosystem-discovery plan.
 *
 * This module is the single source of truth for every outbound link the CLI points at the rest
 * of the Vinci ecosystem (Chat, Mobile, Desktop, Platform). Phase 0 ships the constants ONLY:
 * no user-facing message changes yet — the billing-refusal copy, /help, and installer copy are
 * test-pinned and become consumers of this module in a later phase.
 *
 * Env-override behavior mirrors vinci-provider.ts exactly: VINCI_BASE_URL (default
 * https://vinci.getsimpledirect.com/api/v1) supplies the vinci.getsimpledirect.com web origin,
 * and VINCI_PLATFORM_URL (default https://platform.getsimpledirect.com) supplies the platform
 * origin — so pointing the provider at a staging gateway redirects every ecosystem link
 * consistently, with no second set of env vars to keep in sync.
 *
 * Outbound links from this CLI carry `?source=code` (existing convention: vinci-support.ts
 * sends /support?source=code), so cross-surface acquisition attribution can tell code-driven
 * visits apart.
 */

/** Strip a URL down to its origin; fall back to the canonical origin if the env value is malformed. */
function originOf(url: string, fallbackOrigin: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return fallbackOrigin;
  }
}

/** Append the `source=code` attribution parameter, preserving any query the URL already carries. */
function withSourceCode(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("source", "code");
  return parsed.toString();
}

// The canonical PRODUCTION endpoints. Exported so consumers (the header's environment badge,
// docs/diagnostics) can tell "prod default" apart from an override without restating the literals.
export const VINCI_PROD_GATEWAY_URL = "https://vinci.getsimpledirect.com/api/v1";
export const VINCI_PROD_PLATFORM_URL = "https://platform.getsimpledirect.com";

/**
 * The EFFECTIVE gateway base URL (includes the /api/v1 path) — env override or the prod default.
 * This is the single shared value every extension that talks to (or derives an origin from) the
 * gateway must consume; re-reading process.env.VINCI_BASE_URL elsewhere re-creates the drift this
 * module exists to prevent. Same resolution as vinci-provider.ts.
 */
export const VINCI_GATEWAY_BASE_URL = process.env.VINCI_BASE_URL ?? VINCI_PROD_GATEWAY_URL;

/** The EFFECTIVE platform base URL — env override or the prod default (mirror of the gateway above). */
export const VINCI_PLATFORM_BASE_URL = process.env.VINCI_PLATFORM_URL ?? VINCI_PROD_PLATFORM_URL;

// One resolution of each env var (above) feeds every consumer. BASE_URL includes the /api/v1
// gateway path; the web destinations below hang off its ORIGIN.
const VINCI_WEB_ORIGIN = originOf(VINCI_GATEWAY_BASE_URL, "https://vinci.getsimpledirect.com");
const PLATFORM_ORIGIN = originOf(VINCI_PLATFORM_BASE_URL, "https://platform.getsimpledirect.com");

/** Vinci Chat (the web app). */
export const VINCI_CHAT_URL = withSourceCode(`${VINCI_WEB_ORIGIN}/chat`);

/** Vinci Mobile get-page — the web app's QR/store chooser. */
export const VINCI_MOBILE_GET_URL = withSourceCode(`${VINCI_WEB_ORIGIN}/get`);

/** Vinci support page (used by /support) — follows the gateway origin like every web link here. */
export const VINCI_SUPPORT_URL = withSourceCode(`${VINCI_WEB_ORIGIN}/support`);

/**
 * Vinci Desktop download (macOS). Lives on the marketing site, not the gateway/platform
 * origins, so it is deliberately NOT env-derived. Still Vinci-owned, so it carries the
 * same attribution parameter (the endpoint ignores unknown query params).
 */
export const VINCI_DESKTOP_DOWNLOAD_URL = withSourceCode(
  "https://www.getsimpledirect.com/api/download/mac",
);

/** Vinci Platform (account, API keys, usage). */
export const VINCI_PLATFORM_URL = withSourceCode(PLATFORM_ORIGIN);

/** Vinci Platform billing page — where credits/plan issues get fixed. */
export const VINCI_BILLING_URL = withSourceCode(`${PLATFORM_ORIGIN}/billing`);
