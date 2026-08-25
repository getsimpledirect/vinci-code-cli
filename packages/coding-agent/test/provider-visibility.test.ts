import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const models = [createModel("openai", "gpt-test"), createModel("vinci", "auto")];

function createModel(provider: string, id: string): Model<Api> {
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

function createRegistry(): ModelRegistry {
	return {
		refresh: () => {},
		getError: () => undefined,
		getAvailable: () => models,
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
	} as unknown as ModelRegistry;
}

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

async function renderSelector(
	settingsManager: SettingsManager,
	availableModels: Model<Api>[],
	currentModel: Model<Api>,
): Promise<string[]> {
	const registry = {
		refresh: () => {},
		getError: () => undefined,
		getAvailable: () => availableModels,
		find: (provider: string, id: string) =>
			availableModels.find((model) => model.provider === provider && model.id === id),
	} as unknown as ModelRegistry;
	const selector = new ModelSelectorComponent(
		createFakeTui(),
		currentModel,
		settingsManager,
		registry,
		[],
		() => {},
		() => {},
	);
	await (
		selector as unknown as {
			loadModels(): Promise<void>;
		}
	).loadModels();
	(
		selector as unknown as {
			updateList(): void;
		}
	).updateList();
	return selector.render(120).map((line) => stripAnsi(line).trimEnd());
}

function selectModel(settingsManager: SettingsManager, model: Model<Api>): void {
	const selector = new ModelSelectorComponent(
		createFakeTui(),
		undefined,
		settingsManager,
		createRegistry(),
		[],
		() => {},
		() => {},
	);
	(
		selector as unknown as {
			handleSelect(selected: Model<Api>): void;
		}
	).handleSelect(model);
}

async function getSelectorProviders(settingsManager: SettingsManager): Promise<string[]> {
	const selector = new ModelSelectorComponent(
		createFakeTui(),
		undefined,
		settingsManager,
		createRegistry(),
		[],
		() => {},
		() => {},
	);
	await (
		selector as unknown as {
			loadModels(): Promise<void>;
		}
	).loadModels();
	return (
		selector as unknown as {
			allModels: Array<{ provider: string }>;
		}
	).allModels.map((model) => model.provider);
}

async function getInteractiveProviders(settingsManager: SettingsManager): Promise<string[]> {
	type GetModelCandidates = (this: {
		session: { scopedModels: []; modelRegistry: ModelRegistry };
		settingsManager: SettingsManager;
	}) => Promise<Model<Api>[]>;
	const getModelCandidates = (InteractiveMode.prototype as unknown as { getModelCandidates: GetModelCandidates })
		.getModelCandidates;
	const candidates = await getModelCandidates.call({
		session: { scopedModels: [], modelRegistry: createRegistry() },
		settingsManager,
	});
	return candidates.map((model) => model.provider);
}

async function getListProviders(settingsManager: SettingsManager): Promise<string[]> {
	const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
	try {
		await listModels(createRegistry(), undefined, settingsManager);
		return log.mock.calls.slice(1).map(([line]) => String(line).trim().split(/\s+/)[0]);
	} finally {
		log.mockRestore();
	}
}

describe.sequential("Vinci provider visibility", () => {
	let previousVinciCode: string | undefined;
	let previousShowOtherProviders: string | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		previousVinciCode = process.env.VINCI_CODE;
		previousShowOtherProviders = process.env.VINCI_SHOW_OTHER_PROVIDERS;
		delete process.env.VINCI_CODE;
		delete process.env.VINCI_SHOW_OTHER_PROVIDERS;
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		if (previousVinciCode === undefined) delete process.env.VINCI_CODE;
		else process.env.VINCI_CODE = previousVinciCode;
		if (previousShowOtherProviders === undefined) delete process.env.VINCI_SHOW_OTHER_PROVIDERS;
		else process.env.VINCI_SHOW_OTHER_PROVIDERS = previousShowOtherProviders;
	});

	test("persists the control and lets the environment override it", async () => {
		const settingsManager = SettingsManager.inMemory({ showOtherProviders: false });

		settingsManager.setShowOtherProviders(true);
		await settingsManager.flush();
		await settingsManager.reload();
		expect(settingsManager.getShowOtherProviders()).toBe(true);
		process.env.VINCI_SHOW_OTHER_PROVIDERS = "0";
		expect(settingsManager.getShowOtherProviders()).toBe(false);
		process.env.VINCI_SHOW_OTHER_PROVIDERS = "1";
		expect(settingsManager.getShowOtherProviders()).toBe(true);
	});

	// Foreign models render by ID, Vinci models by friendly name. A BYOK user needs the exact id —
	// it is what they configured and what the provider will accept — while the managed catalog keeps
	// the readable label. Both carry a provider badge so a mixed list is never ambiguous.
	test("renders Vinci names and foreign ids, both badged, in each selection branch", async () => {
		process.env.VINCI_CODE = "1";
		const openai = { ...createModel("openai", "gpt-test"), name: "GPT Test" };
		const vinci = { ...createModel("vinci", "auto"), name: "Vinci" };

		const lines = await renderSelector(
			SettingsManager.inMemory({ showOtherProviders: true }),
			[openai, vinci],
			openai,
		);

		expect(lines).toContain("→ gpt-test [openai] ✓");
		expect(lines).toContain("  Vinci [vinci]");
	});

	test("renders friendly names without provider badges in both selection branches when other providers are disabled", async () => {
		process.env.VINCI_CODE = "1";
		const forte = { ...createModel("vinci", "forte"), name: "Vinci Forte" };
		const fortissimo = { ...createModel("vinci", "fortissimo"), name: "Vinci Fortissimo" };

		const lines = await renderSelector(
			SettingsManager.inMemory({ showOtherProviders: false }),
			[forte, fortissimo],
			forte,
		);

		expect(lines).toContain("→ Vinci Forte ✓");
		expect(lines).toContain("  Vinci Fortissimo");
	});

	test("persists selections when other providers are enabled in Vinci mode", () => {
		process.env.VINCI_CODE = "1";
		const settingsManager = SettingsManager.inMemory({ showOtherProviders: true });
		const persist = vi.spyOn(settingsManager, "setDefaultModelAndProvider");
		const openai = createModel("openai", "gpt-test");

		selectModel(settingsManager, openai);

		expect(persist).toHaveBeenCalledWith("openai", "gpt-test");
	});

	test("does not persist selections when other providers are disabled in Vinci mode", () => {
		process.env.VINCI_CODE = "1";
		const settingsManager = SettingsManager.inMemory({ showOtherProviders: false });
		const persist = vi.spyOn(settingsManager, "setDefaultModelAndProvider");

		selectModel(settingsManager, createModel("vinci", "auto"));

		expect(persist).not.toHaveBeenCalled();
	});

	describe.each([
		["model selector", getSelectorProviders],
		["interactive model candidates", getInteractiveProviders],
		["list models", getListProviders],
	] as const)("%s", (_site, getProviders) => {
		// 🔴 The default is OPEN. Vinci Code is an open-source client and must work the moment you
		// have it, with your own key and no account. Runs at all three sites, so a re-default to
		// false goes red everywhere it would actually be felt.
		test("offers other providers BY DEFAULT — no account required", async () => {
			process.env.VINCI_CODE = "1";
			delete process.env.VINCI_SHOW_OTHER_PROVIDERS;

			const fresh = SettingsManager.inMemory();
			expect(fresh.getShowOtherProviders()).toBe(true);
			const providers = await getProviders(fresh);
			expect(providers).toContain("openai");
			// Vinci still sorts first, so the managed path stays the obvious choice.
			expect(providers[0]).toBe("vinci");
		});

		test("shows only Vinci models when other providers are disabled in Vinci mode", async () => {
			process.env.VINCI_CODE = "1";

			expect(await getProviders(SettingsManager.inMemory({ showOtherProviders: false }))).toEqual(["vinci"]);
		});

		test("shows Vinci first alongside other providers when the persisted control is enabled", async () => {
			process.env.VINCI_CODE = "1";

			expect(await getProviders(SettingsManager.inMemory({ showOtherProviders: true }))).toEqual([
				"vinci",
				"openai",
			]);
		});

		test("shows all providers when Vinci mode is unset", async () => {
			expect(await getProviders(SettingsManager.inMemory({ showOtherProviders: true }))).toEqual([
				"openai",
				"vinci",
			]);
		});
	});
});
