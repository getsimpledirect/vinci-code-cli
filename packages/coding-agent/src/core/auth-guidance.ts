import { join } from "node:path";
import { getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

// [vinci] Keep managed/default sign-in copy warm; selected external providers need their own route.
// Upstream copy is unchanged when VINCI_CODE is unset.
const VINCI = process.env.VINCI_CODE === "1";
const VINCI_CONNECT =
	"Vero can't connect to Vinci yet. Type /login, choose Vinci, and complete sign-in in your browser.";

export type VinciRecoveryGuidance = {
	kind: "authentication" | "access" | "credits" | "provider-unavailable" | "sandbox" | "unknown";
	nextStep: string;
};

/** Observed error categories only; this guidance never starts a retry or changes provider/account. */
export function getVinciRecoveryGuidance(errorMessage: string, provider?: string): VinciRecoveryGuidance {
	if (
		/scoped sandbox|no enforceable OS sandbox|sandbox(?:-| )(?:backend|startup|refus|deni|disabled)|bubblewrap cannot|\bbwrap\b.*(?:failed|error|not permitted)/i.test(
			errorMessage,
		)
	) {
		return {
			kind: "sandbox",
			nextStep:
				"Check the sandbox backend and denied path. Keep confinement enabled; authorize extra scope only for an intended change.",
		};
	}
	if (
		/\b403\b|forbidden|access denied|permission denied|operation not permitted|\b(?:EACCES|EPERM)\b/i.test(
			errorMessage,
		)
	) {
		return { kind: "access", nextStep: "Check access to the requested account or resource before retrying." };
	}
	if (
		/\b401\b|unauthori[sz]ed|invalid[_ -].*(?:key|token|credential)|(?:expired|invalid)[_ -](?:access[_ -])?token|not signed in|authentication/i.test(
			errorMessage,
		)
	) {
		const account = provider === "vinci" ? "Vinci" : provider === "openai-codex" ? "Codex" : "the selected provider";
		return {
			kind: "authentication",
			nextStep: `Use /login to check ${account}'s account and credentials before retrying.`,
		};
	}
	// A 402 can be a temporary hold or a request-size ceiling, not an empty balance.
	if (
		/in_flight_budget_exhausted|in-flight request limit|"code"\s*:\s*"capacity"|\bat capacity\b|BLOCKED: provider/i.test(
			errorMessage,
		)
	) {
		return {
			kind: "provider-unavailable",
			nextStep: "Wait for provider capacity, then retry manually on the same selected model.",
		};
	}
	if (
		/request_too_large|per-request (?:cost ceiling|spending limit)|can (?:only )?afford [0-9][0-9,]* tokens|with the reduced limit/i.test(
			errorMessage,
		)
	) {
		return {
			kind: "credits",
			nextStep: "Reduce the request or output limit, then retry manually; a top-up may not resolve this ceiling.",
		};
	}
	if (/payment_failed|payment failed|payment method|card declined/i.test(errorMessage)) {
		return { kind: "credits", nextStep: "Review the selected account's payment method before choosing to retry." };
	}
	if (/free_daily_cap|daily free allowance/i.test(errorMessage)) {
		return {
			kind: "credits",
			nextStep: "Check the stated allowance reset and your balance before choosing whether to wait or add credits.",
		};
	}
	if (
		/\b402\b|balance_exhausted|budget[_ -]exhausted|insufficient[_ -](?:credits?|funds?|quota)|out of credits?|no credits?|credits? (?:are |is )?(?:exhausted|used up)|free allowance is used up/i.test(
			errorMessage,
		)
	) {
		return {
			kind: "credits",
			nextStep:
				"Check the selected account's balance and spending limit. Add funds only if you choose to, then retry manually.",
		};
	}
	if (
		/\b503\b|(?:provider|model|service).{0,40}(?:unavailable|not available)|temporarily unavailable|overloaded/i.test(
			errorMessage,
		)
	) {
		return {
			kind: "provider-unavailable",
			nextStep: "Wait for the selected provider or model to become available, then retry manually.",
		};
	}
	return { kind: "unknown", nextStep: "Review this error before deciding whether to retry." };
}

/** Preserve the failure as data and append one Vero next step; no saved-progress or success claim. */
export function formatVinciRecoveryMessage(errorMessage: string, provider?: string): string {
	return `${errorMessage}\n\nVero: ${getVinciRecoveryGuidance(errorMessage, provider).nextStep}`;
}

export function getProviderLoginHelp(): string {
	if (VINCI) return VINCI_CONNECT;
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	if (VINCI)
		return "Vero can't start yet: no models are available. Use /login to check the account or provider, then /model to check its available models.";
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	if (VINCI)
		return "Vero can't start yet: no model is selected. Use /model to choose one; if sign-in is needed, use /login.";
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	if (VINCI) {
		switch (provider) {
			case "vinci":
				return VINCI_CONNECT;
			case "anthropic":
				return 'No Anthropic API credentials found. Use /other (or start Vinci with VINCI_SHOW_OTHER_PROVIDERS=1) to enable other providers, then set ANTHROPIC_API_KEY or use /login, "API key" and Anthropic.';
			case "openai":
				return 'No OpenAI API credentials found. Use /other (or start Vinci with VINCI_SHOW_OTHER_PROVIDERS=1) to enable other providers, then set OPENAI_API_KEY or use /login, "API key" and OpenAI.';
			case "openai-codex":
				return 'You\'re not connected to Codex yet. Use /other to enable other providers, then /login, "Provider account" and "ChatGPT Plus/Pro (Codex Subscription)".';
			default:
				return "No credentials found for the selected provider. Check its authentication settings and setup instructions.";
		}
	}
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
