import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

export default function (pi: ExtensionAPI) {
	const events = process.env.VINCI_MODE_TEST_EVENTS;
	if (!events) throw new Error("VINCI_MODE_TEST_EVENTS is required");
	appendFileSync(events, "extension\n");
	const registration = registerFauxProvider();
	registration.setResponses([
		() => {
			appendFileSync(events, "provider\n");
			return fauxAssistantMessage("MODE_OK");
		},
	]);
	pi.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux-test-key",
		api: registration.api,
		models: registration.models,
	});
	pi.on("session_shutdown", () => registration.unregister());
}
