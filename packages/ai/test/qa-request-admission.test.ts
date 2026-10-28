import { afterEach, expect, test, vi } from "vitest";
import { getApiProvider, registerApiProvider, stream, streamSimple, unregisterApiProviders } from "../src/compat.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { Model } from "../src/types.ts";
import { assertQaModelAllowed } from "../src/utils/qa-request-guard.ts";

const model: Model<"qa-synthetic"> = {
	id: "forte",
	provider: "vinci",
	name: "Synthetic",
	api: "qa-synthetic",
	baseUrl: "https://qa.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	unregisterApiProviders("qa-admission-test");
});

test("both compatibility APIs, registry callbacks and Models dispatch refuse before provider execution", async () => {
	const assertModel = vi.fn(() => {
		throw new Error("BLOCKED: synthetic exhausted allowance");
	});
	vi.stubGlobal("__vinciQaRequestGuard", { assertModel });
	const providerCall = vi.fn(() => {
		throw new Error("Provider must never execute");
	});
	const api = { stream: providerCall, streamSimple: providerCall };
	registerApiProvider({ api: model.api, ...api }, "qa-admission-test");
	const provider = createProvider({
		id: "vinci",
		models: [model],
		auth: { apiKey: { name: "synthetic", resolve: async () => undefined } },
		api,
	});
	const models = createModels();
	models.setProvider(provider);
	const context = { messages: [] };
	const registered = getApiProvider(model.api)!;
	for (const run of [
		() => stream(model, context),
		() => streamSimple(model, context),
		() => registered.stream(model, context),
		() => registered.streamSimple(model, context),
		() => provider.stream(model, context),
		() => provider.streamSimple(model, context),
	])
		expect(run).toThrow(/BLOCKED/);
	for (const output of [models.stream(model, context), models.streamSimple(model, context)]) {
		const result = await output.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("BLOCKED");
	}
	expect(providerCall).not.toHaveBeenCalled();
	expect(assertModel).toHaveBeenCalledTimes(8);
});

test("an environment allowance without a CLI transport bridge fails closed", () => {
	vi.stubEnv("VINCI_QA_ALLOWANCE_FILE", "/synthetic/not-read.json");
	expect(() => assertQaModelAllowed(model)).toThrow(/not armed/);
});
