import { join } from "node:path";
import { getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

// [vinci] Keep managed/default sign-in copy warm; selected external providers need their own route.
// Upstream copy is unchanged when VINCI_CODE is unset.
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
	if (VINCI) {
		switch (provider) {
			case "vinci":
				return VINCI_CONNECT;
			case "anthropic":
				return 'No Anthropic API credentials found. Set ANTHROPIC_API_KEY in your environment, or start Vinci with VINCI_SHOW_OTHER_PROVIDERS=1 and use /login, then "Use an API key" and Anthropic.';
			case "openai":
				return 'No OpenAI API credentials found. Set OPENAI_API_KEY in your environment, or start Vinci with VINCI_SHOW_OTHER_PROVIDERS=1 and use /login, then "Use an API key" and OpenAI.';
			case "openai-codex":
				return 'You\'re not connected to Codex yet. Start Vinci with VINCI_SHOW_OTHER_PROVIDERS=1 and use /login, then "Use a subscription" and "ChatGPT Plus/Pro (Codex Subscription)".';
			default:
				return "No credentials found for the selected provider. Check its authentication settings and setup instructions.";
		}
	}
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
