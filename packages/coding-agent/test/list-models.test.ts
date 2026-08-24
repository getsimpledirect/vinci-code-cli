import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function registry(models: Model<Api>[]): ModelRegistry {
	return {
		getError: () => undefined,
		getAvailable: () => models,
	} as unknown as ModelRegistry;
}

describe("listModels", () => {
	test("lists only Vinci models when other providers are explicitly disabled", async () => {
		const previous = process.env.VINCI_CODE;
		const previousShow = process.env.VINCI_SHOW_OTHER_PROVIDERS;
		process.env.VINCI_CODE = "1";
		// Explicit opt-out. The DEFAULT is open — see provider-visibility.test.ts, which pins that
		// a fresh install offers other providers so no account is required.
		process.env.VINCI_SHOW_OTHER_PROVIDERS = "0";
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		try {
			await listModels(
				registry([
					model("openai", "gpt-test"),
					model("vinci", "auto"),
					model("vinci", "forte"),
					model("vinci", "fortissimo"),
				]),
			);
			const output = log.mock.calls.map(([value]) => String(value)).join("\n");
			expect(output).toContain("auto");
			expect(output).toContain("forte");
			expect(output).toContain("fortissimo");
			expect(output).not.toContain("gpt-test");
			expect(output).not.toContain("openai");
		} finally {
			if (previous === undefined) delete process.env.VINCI_CODE;
			else process.env.VINCI_CODE = previous;
			if (previousShow === undefined) delete process.env.VINCI_SHOW_OTHER_PROVIDERS;
			else process.env.VINCI_SHOW_OTHER_PROVIDERS = previousShow;
			log.mockRestore();
		}
	});

	test("keeps the complete provider catalog in upstream Pi", async () => {
		const previous = process.env.VINCI_CODE;
		delete process.env.VINCI_CODE;
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		try {
			await listModels(registry([model("openai", "gpt-test"), model("vinci", "forte")]));
			const output = log.mock.calls.map(([value]) => String(value)).join("\n");
			expect(output).toContain("gpt-test");
			expect(output).toContain("forte");
		} finally {
			if (previous === undefined) delete process.env.VINCI_CODE;
			else process.env.VINCI_CODE = previous;
			log.mockRestore();
		}
	});
});
