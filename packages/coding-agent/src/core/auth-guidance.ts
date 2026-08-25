import { join } from "node:path";
import { getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

// [vinci] Warm, brand-consistent auth copy — no provider IDs, no "OAuth or API key", no doc paths.
// Sign-in is the first thing a consumer does, so this is a high-traffic path. Upstream copy when unset.
const VINCI = process.env.VINCI_CODE === "1";
const VINCI_CONNECT =
	"You're not connected to Vinci yet. Type /login and authorize in your browser — it takes a few seconds, no key to paste.";

export function getProviderLoginHelp(): string {
	if (VINCI) return VINCI_CONNECT;
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	if (VINCI) return VINCI_CONNECT;
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	if (VINCI) return VINCI_CONNECT;
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	if (VINCI) return VINCI_CONNECT;
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
