import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const { runCouncil } = await loader.import(resolve(here, "../extensions/vinci-council.ts"), { default: false });

const councilFaux = registerFauxProvider({
	api: "faux:council-empty-chair",
	provider: "faux-council-empty-chair",
	models: [{ id: "fortissimo" }],
});
try {
	councilFaux.setResponses([
		fauxAssistantMessage("optimist lens take"),
		fauxAssistantMessage("skeptic lens take"),
		fauxAssistantMessage("realist lens take"),
		fauxAssistantMessage("strategist lens take"),
		fauxAssistantMessage("  \n"),
	]);
	const result = await runCouncil(
		councilFaux.getModel("fortissimo"),
		{ apiKey: "faux-key" },
		"Which option should we choose?",
		{ find: () => undefined },
		"council-empty-chair-test",
		() => {},
	);
	assert.match(result, /Chair synthesis unavailable/);
	assert.match(result, /optimist lens take/);
	assert.match(result, /skeptic lens take/);
	assert.match(result, /realist lens take/);
	assert.match(result, /strategist lens take/);
} finally {
	councilFaux.unregister();
}

console.log("council-integration: empty chair preserves lens takes");
