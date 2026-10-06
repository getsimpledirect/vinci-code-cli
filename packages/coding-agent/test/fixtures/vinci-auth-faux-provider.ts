import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

export default function (pi: ExtensionAPI) {
	const events = process.env.VINCI_AUTH_TEST_EVENTS;
	const provider = process.env.VINCI_AUTH_TEST_PROVIDER;
	if (!events || !provider) throw new Error("Auth guidance fixture configuration is required");
	appendFileSync(events, "extension\n");
	const registration = registerFauxProvider();
	registration.setResponses([
		() => {
			appendFileSync(events, "provider\n");
			return fauxAssistantMessage("AUTH_FIXTURE_OK");
		},
	]);
	pi.registerProvider(provider, {
		baseUrl: "https://example.invalid",
		api: registration.api,
		models: registration.models,
		// Only the fixture's positive control gets a synthetic key, never a real credential.
		apiKey: process.env.VINCI_AUTH_TEST_CONFIGURED === "1" ? "faux-test-key" : "$VINCI_AUTH_TEST_MISSING",
	});
	pi.on("session_shutdown", () => registration.unregister());
}
