import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createJiti } from "jiti/static";
import { afterEach, describe, expect, test, vi } from "vitest";
import type * as AuthGuidance from "../src/core/auth-guidance.ts";
import type * as AssistantComponent from "../src/modes/interactive/components/assistant-message.ts";
import type * as Theme from "../src/modes/interactive/theme/theme.ts";

const cases = [
	{ error: "401 Unauthorized: expired token", kind: "authentication", next: "/login" },
	{ error: "401 Unauthorized for sandbox-account", kind: "authentication", next: "/login" },
	{ error: "403 Forbidden: this account lacks permission", kind: "access", next: "Check access" },
	{ error: '402 {"error":{"code":"balance_exhausted"}}', kind: "credits", next: "balance" },
	{ error: "No credits available for this request", kind: "credits", next: "balance" },
	{ error: '402 {"error":{"code":"payment_failed"}}', kind: "credits", next: "payment method" },
	{ error: '402 {"error":{"code":"request_too_large"}}', kind: "credits", next: "Reduce" },
	{ error: "402 You requested up to 4096 tokens, but can only afford 1024 tokens", kind: "credits", next: "Reduce" },
	{ error: '402 {"error":{"code":"capacity"}}', kind: "provider-unavailable", next: "Wait" },
	{ error: "402 in_flight_budget_exhausted", kind: "provider-unavailable", next: "Wait" },
	{ error: "503 Service Unavailable", kind: "provider-unavailable", next: "Wait" },
	{ error: "503 Service Unavailable for sandbox-account", kind: "provider-unavailable", next: "Wait" },
	{ error: "The selected model is unavailable", kind: "provider-unavailable", next: "Wait" },
	{
		error: "Vinci could not write inside its scoped sandbox: permission denied",
		kind: "sandbox",
		next: "Keep confinement enabled",
	},
	{ error: "Bubblewrap cannot protect the absent sensitive path", kind: "sandbox", next: "Keep confinement enabled" },
	{ error: "An unknown provider failure: fixture-detail-184", kind: "unknown", next: "Review this error" },
] as const;

afterEach(() => vi.unstubAllEnvs());

async function source(vinci: string | undefined) {
	vi.stubEnv("VINCI_CODE", vinci);
	const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
	const theme = await loader.import<typeof Theme>(
		fileURLToPath(new URL("../src/modes/interactive/theme/theme.ts", import.meta.url)),
	);
	theme.initTheme("dark", false);
	return {
		guidance: await loader.import<typeof AuthGuidance>(
			fileURLToPath(new URL("../src/core/auth-guidance.ts", import.meta.url)),
		),
		component: await loader.import<typeof AssistantComponent>(
			fileURLToPath(new URL("../src/modes/interactive/components/assistant-message.ts", import.meta.url)),
		),
	};
}

describe("Vinci recovery source consumer", () => {
	test.each(cases)("keeps $kind failure data and its separate next step", async ({ error, kind, next }) => {
		const { guidance } = await source("1");
		expect(guidance.getVinciRecoveryGuidance(error).kind).toBe(kind);
		const message = guidance.formatVinciRecoveryMessage(error);
		expect(message.startsWith(`${error}\n\nVero: `)).toBe(true);
		expect(message).toContain(next);
		expect(message).not.toMatch(/progress is saved|completed successfully|retrying automatically|VINCI_NO_SANDBOX/);
		if (kind !== "authentication") expect(message).not.toContain("/login");
		if (/capacity|in_flight|request_too_large|can only afford/.test(error))
			expect(message).not.toContain("Add funds");
	});

	test("actual assistant component retains known failures and Vero recovery at every requested width", async () => {
		const { component } = await source("1");
		for (const fixture of cases.filter((entry) => entry.kind !== "unknown")) {
			const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: fixture.error });
			const view = new component.AssistantMessageComponent(message);
			for (const width of [20, 39, 40, 60, 80, 120]) {
				const rendered = stripVTControlCharacters(view.render(width).join(" ")).replace(/\s+/g, " ");
				expect(rendered.replace(/\s/g, ""), `${fixture.kind} at ${width}`).toContain(
					fixture.error.replace(/\s/g, ""),
				);
				expect(rendered).toContain("Vero:");
				expect(rendered).not.toContain("progress is saved");
			}
			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toBe(fixture.error);
		}
	});

	test("actual error rendering masks an inert credential without removing status or remediation", async () => {
		const { component } = await source("1");
		const inertCredential = "C4-inert-credential-value-184901";
		const message = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: `401 Unauthorized api_key=${inertCredential}`,
		});
		const rendered = stripVTControlCharacters(
			new component.AssistantMessageComponent(message).render(120).join("\n"),
		);
		expect(rendered).toContain("401 Unauthorized");
		expect(rendered).toContain("‹redacted›");
		expect(rendered).not.toContain(inertCredential);
		expect(rendered).toContain("/login");
		expect(message.errorMessage).toContain(inertCredential);
	});

	test("raw error data cannot inject terminal image or clipboard controls into its visible recovery", async () => {
		const { component } = await source("1");
		const error = "401 Unauthorized\x1b_Ga=T,f=100;inert\x1b\\\x1b]52;c;aW5lcnQ=\x07";
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: error });
		const rendered = new component.AssistantMessageComponent(message).render(120).join("\n");
		expect(rendered).not.toContain("\x1b_G");
		expect(rendered).not.toContain("\x1b]52;");
		expect(rendered).toContain("401 Unauthorized");
		expect(rendered).toContain("/login");
		expect(message.errorMessage).toBe(error);
	});

	test("missing model and missing credential remain different while plain Pi behavior is retained", async () => {
		const { guidance } = await source("1");
		expect(guidance.formatNoApiKeyFoundMessage("vinci")).toContain("can't connect to Vinci");
		expect(guidance.formatNoApiKeyFoundMessage("vinci")).not.toContain("seconds");
		expect(guidance.formatNoModelSelectedMessage()).toContain("no model is selected");
		expect(guidance.formatNoModelSelectedMessage()).toContain("/model");
		expect(guidance.formatNoModelsAvailableMessage()).toContain("no models are available");
		const plain = await source(undefined);
		expect(plain.guidance.formatNoModelSelectedMessage()).toMatch(/^No model selected\./);
		expect(plain.component.vinciFriendlyError("401 Unauthorized", false)).toBeNull();
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" });
		const rendered = stripVTControlCharacters(
			new plain.component.AssistantMessageComponent(message).render(80).join("\n"),
		);
		expect(rendered).toContain("Error: 401 Unauthorized");
		expect(rendered).not.toContain("Vero:");
	});
});
