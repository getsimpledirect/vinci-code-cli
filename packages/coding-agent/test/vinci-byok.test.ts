import type { Model } from "@earendil-works/pi-ai/compat";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createModel(provider: string, id: string): Model<string> {
	return {
		id,
		name: `${provider} ${id}`,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

async function waitForAsyncRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

type ModelCandidateContext = {
	session: {
		scopedModels: Array<{ model: Model<string> }>;
		modelRegistry: {
			refresh(): void;
			getAvailable(): Promise<Model<string>[]>;
		};
	};
	settingsManager: SettingsManager;
};

type LoginContext = {
	settingsManager: SettingsManager;
	showLoginDialog(providerId: string, providerName: string): Promise<void>;
	showLoginAuthTypeSelector(): void;
};

const getModelCandidates = (
	InteractiveMode.prototype as unknown as {
		getModelCandidates(this: ModelCandidateContext): Promise<Model<string>[]>;
	}
).getModelCandidates;

const showOAuthSelector = (
	InteractiveMode.prototype as unknown as {
		showOAuthSelector(this: LoginContext, mode: "login" | "logout"): Promise<void>;
	}
).showOAuthSelector;

describe("Vinci BYOK provider visibility", () => {
	const originalVinciCode = process.env.VINCI_CODE;
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		process.env.VINCI_CODE = "1";
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		if (originalVinciCode === undefined) delete process.env.VINCI_CODE;
		else process.env.VINCI_CODE = originalVinciCode;
	});

	it.each([
		{ showOtherProviders: false, expectedProviders: ["vinci"] },
		{ showOtherProviders: true, expectedProviders: ["anthropic", "vinci"] },
	])(
		"returns registry candidates for showOtherProviders=$showOtherProviders",
		async ({ showOtherProviders, expectedProviders }) => {
			const models = [createModel("vinci", "forte"), createModel("anthropic", "claude")];
			const context: ModelCandidateContext = {
				session: {
					scopedModels: [],
					modelRegistry: {
						refresh: vi.fn(),
						getAvailable: vi.fn(async () => models),
					},
				},
				settingsManager: SettingsManager.inMemory({ showOtherProviders }),
			};

			const candidates = await getModelCandidates.call(context);

			expect(candidates.map((model) => model.provider).sort()).toEqual(expectedProviders);
		},
	);

	it.each([
		{ showOtherProviders: false, expectedProviders: ["vinci"] },
		{ showOtherProviders: true, expectedProviders: ["anthropic", "vinci"] },
	])(
		"filters scoped candidates for showOtherProviders=$showOtherProviders",
		async ({ showOtherProviders, expectedProviders }) => {
			const scopedModels = [createModel("vinci", "forte"), createModel("anthropic", "claude")].map((model) => ({
				model,
			}));
			const context: ModelCandidateContext = {
				session: {
					scopedModels,
					modelRegistry: {
						refresh: vi.fn(),
						getAvailable: vi.fn(async () => []),
					},
				},
				settingsManager: SettingsManager.inMemory({ showOtherProviders }),
			};

			const candidates = await getModelCandidates.call(context);

			expect(candidates.map((model) => model.provider).sort()).toEqual(expectedProviders);
		},
	);

	it("keeps upstream candidates visible outside Vinci", async () => {
		delete process.env.VINCI_CODE;
		const models = [createModel("vinci", "forte"), createModel("anthropic", "claude")];
		const context: ModelCandidateContext = {
			session: {
				scopedModels: [],
				modelRegistry: {
					refresh: vi.fn(),
					getAvailable: vi.fn(async () => models),
				},
			},
			settingsManager: SettingsManager.inMemory(),
		};

		expect(await getModelCandidates.call(context)).toEqual(models);
	});

	it.each([
		{ showOtherProviders: false, directVinciLogin: true },
		{ showOtherProviders: true, directVinciLogin: false },
	])("routes /login for showOtherProviders=$showOtherProviders", async ({ showOtherProviders, directVinciLogin }) => {
		const context: LoginContext = {
			settingsManager: SettingsManager.inMemory({ showOtherProviders }),
			showLoginDialog: vi.fn(async () => {}),
			showLoginAuthTypeSelector: vi.fn(),
		};

		await showOAuthSelector.call(context, "login");

		if (directVinciLogin) {
			expect(context.showLoginDialog).toHaveBeenCalledWith("vinci", "Vinci");
			expect(context.showLoginAuthTypeSelector).not.toHaveBeenCalled();
		} else {
			expect(context.showLoginDialog).not.toHaveBeenCalled();
			expect(context.showLoginAuthTypeSelector).toHaveBeenCalledOnce();
		}
	});

	it.each([
		{ showOtherProviders: false, includesFaux: false },
		{ showOtherProviders: true, includesFaux: true },
	])(
		"filters the model picker for showOtherProviders=$showOtherProviders",
		async ({ showOtherProviders, includesFaux }) => {
			const harness = await createHarness({ settings: { showOtherProviders } });
			harnesses.push(harness);
			harness.authStorage.setRuntimeApiKey("vinci", "vinci-key");
			harness.session.modelRegistry.registerProvider("vinci", {
				baseUrl: "https://example.invalid",
				apiKey: "vinci-key",
				api: "openai-completions",
				models: [
					{
						id: "forte",
						name: "Vinci Forte",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
					},
				],
			});
			const selector = new ModelSelectorComponent(
				createFakeTui(),
				harness.session.modelRegistry.find("vinci", "forte"),
				harness.settingsManager,
				harness.session.modelRegistry,
				[],
				() => {},
				() => {},
			);

			await waitForAsyncRender();

			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Vinci Forte");
			expect(rendered.includes(harness.getModel().id)).toBe(includesFaux);
			if (includesFaux) {
				expect(rendered).toContain("[faux]");
				expect(rendered).toContain("[vinci]");
			}
		},
	);
});
