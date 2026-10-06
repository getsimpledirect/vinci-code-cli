import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

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

function registry(models: Model<Api>[], configuredProviders = models.map((m) => m.provider)): ModelRegistry {
	return {
		getError: () => undefined,
		getAll: () => models,
		getAvailable: () => models.filter((m) => configuredProviders.includes(m.provider)),
		hasConfiguredAuth: (m: Model<Api>) => configuredProviders.includes(m.provider),
	} as unknown as ModelRegistry;
}

describe("listModels", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	test("reports expired OAuth presence without resolving credentials or printing their values", async () => {
		vi.stubEnv("VINCI_CODE", "1");
		vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "1");
		const auth = AuthStorage.inMemory({
			"openai-codex": {
				type: "oauth",
				access: "catalog-test-access",
				refresh: "catalog-test-refresh",
				expires: 0,
			},
		});
		const catalog = ModelRegistry.inMemory(auth);
		const resolveAuth = vi
			.spyOn(catalog, "getApiKeyAndHeaders")
			.mockRejectedValue(new Error("Unexpected credential resolution"));
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await listModels(catalog, "openai-codex", SettingsManager.inMemory());
		const lines = log.mock.calls.map(([value]) => String(value));
		const codexRows = lines.slice(1).filter((line) => /^openai-codex\s/.test(line));
		expect(codexRows.length).toBeGreaterThan(0);
		expect(codexRows.every((line) => /\sconfigured$/.test(line))).toBe(true);
		expect(lines.join("\n")).not.toContain("catalog-test-access");
		expect(lines.join("\n")).not.toContain("catalog-test-refresh");
		expect(resolveAuth).not.toHaveBeenCalled();
	});

	test("shows the Vinci catalog without credentials and labels every row unconfigured", async () => {
		vi.stubEnv("VINCI_CODE", "1");
		vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "1");
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const catalog = registry([model("openai", "gpt-test"), model("vinci", "auto")], []);
		await listModels(catalog, undefined, SettingsManager.inMemory());
		const lines = log.mock.calls.map(([value]) => String(value));
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(/images\s+auth$/);
		expect(lines[1]).toMatch(/^vinci\s+auto\s+128K\s+8\.2K\s+yes\s+no\s+unconfigured$/);
		expect(lines[2]).toMatch(/^openai\s+gpt-test\s+128K\s+8\.2K\s+yes\s+no\s+unconfigured$/);
	});

	test("keeps configured and unconfigured models aligned and does not reorder the registry", async () => {
		vi.stubEnv("VINCI_CODE", "1");
		vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "1");
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const models = [model("openai", "gpt-test-with-a-long-name"), model("vinci", "auto")];
		await listModels(registry(models, ["openai"]), undefined, SettingsManager.inMemory());
		const lines = log.mock.calls.map(([value]) => String(value));
		expect(lines[1]).toMatch(/unconfigured$/);
		expect(lines[2]).toMatch(/configured\s*$/);
		expect(lines[1].indexOf("128K")).toBe(lines[2].indexOf("128K"));
		expect(lines[1].indexOf("unconfigured")).toBe(lines[2].indexOf("configured"));
		expect(models.map((m) => m.provider)).toEqual(["openai", "vinci"]);
	});

	test("searches unconfigured models and distinguishes no matches from an empty catalog", async () => {
		vi.stubEnv("VINCI_CODE", "1");
		vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "1");
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const catalog = registry([model("openai", "gpt-test"), model("vinci", "auto")], []);
		await listModels(catalog, "gpt-test", SettingsManager.inMemory());
		expect(log.mock.calls).toHaveLength(2);
		expect(String(log.mock.calls[1][0])).toMatch(/^openai\s+gpt-test.*unconfigured$/);
		log.mockClear();
		await listModels(catalog, "nonexistent-model-zzzz", SettingsManager.inMemory());
		expect(log).toHaveBeenCalledExactlyOnceWith('No models matching "nonexistent-model-zzzz"');
		log.mockClear();
		await listModels(registry([], []), undefined, SettingsManager.inMemory());
		expect(log).toHaveBeenCalledExactlyOnceWith("No models in the visible catalog.");
	});

	test("does not reveal hidden unconfigured providers even when searched", async () => {
		vi.stubEnv("VINCI_CODE", "1");
		vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "0");
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await listModels(
			registry([model("openai", "gpt-test"), model("vinci", "auto")], []),
			"gpt-test",
			SettingsManager.inMemory(),
		);
		expect(log).toHaveBeenCalledExactlyOnceWith('No models matching "gpt-test"');
	});

	test("preserves upstream Pi credential filtering and columns", async () => {
		vi.stubEnv("VINCI_CODE", "0");
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await listModels(registry([model("openai", "gpt-test"), model("vinci", "auto")], ["openai"]));
		const lines = log.mock.calls.map(([value]) => String(value));
		expect(lines).toHaveLength(2);
		expect(lines[0]).not.toContain("auth");
		expect(lines[1]).toMatch(/^openai\s+gpt-test/);
		expect(lines.join("\n")).not.toContain("auto");
	});

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
