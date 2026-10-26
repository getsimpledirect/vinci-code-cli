import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createVinciModelCatalogue } from "../../../vinci/extensions/lib/model-catalogue.ts";
import { vinciHelpText } from "../../../vinci/extensions/vinci-help.ts";
import registerVinci, { vinciClassModel } from "../../../vinci/extensions/vinci-provider.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const payload = {
	auto: true,
	default: "mezzo",
	models: [
		{ id: "mezzo", label: "Vinci Mezzo", occupant: "GLM 5.3 Flash" },
		{ id: "forte", label: "Vinci Forte", occupant: "GLM 5.3" },
		{ id: "fortissimo", label: "Vinci Fortissimo", occupant: null },
		{ id: "unknown", label: "Unknown", occupant: "Unreleased" },
	],
};

function registeredModels(): Model<Api>[] {
	let config: ProviderConfig | undefined;
	registerVinci({
		registerProvider: (id: string, value: ProviderConfig) => {
			if (id === "vinci") config = value;
		},
		on: () => {},
	} as unknown as ExtensionAPI);
	return (config?.models ?? []).map((model) => ({
		...model,
		api: "openai-completions",
		provider: "vinci",
		baseUrl: "https://example.invalid",
	})) as Model<Api>[];
}

function external(): Model<Api> {
	return {
		...vinciClassModel("forte", "External"),
		id: "alpha",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://example.invalid",
	};
}

function registry(models: Model<Api>[]): ModelRegistry {
	return {
		refresh: () => {},
		getError: () => undefined,
		getAvailable: () => models,
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
	} as unknown as ModelRegistry;
}

type Selector = {
	loadModels(): Promise<void>;
	updateList(): void;
	allModels: Array<{ provider: string; id: string }>;
	render(width: number): string[];
};

async function picker(settings: SettingsManager, fetcher: typeof fetch, scoped = false) {
	const models = [external(), ...registeredModels()];
	// The final optional argument is the injected catalogue fetch; upstream constructors ignore it.
	const selector = Reflect.construct(ModelSelectorComponent, [
		{ requestRender: () => {} } as unknown as TUI,
		external(),
		settings,
		registry(models),
		scoped ? models.map((model) => ({ model })) : [],
		() => {},
		() => {},
		undefined,
		fetcher,
	]) as unknown as Selector;
	await selector.loadModels();
	selector.updateList();
	return { selector, text: stripAnsi(selector.render(160).join("\n")) };
}

type CandidateContext = {
	session: { scopedModels: Array<{ model: Model<Api> }>; modelRegistry: ModelRegistry };
	settingsManager: SettingsManager;
};
const candidates = (
	InteractiveMode.prototype as unknown as {
		getModelCandidates(this: CandidateContext): Promise<Model<Api>[]>;
	}
).getModelCandidates;
const login = (
	InteractiveMode.prototype as unknown as {
		showOAuthSelector(this: object, mode: "login"): Promise<void>;
	}
).showOAuthSelector;
const submit = (
	InteractiveMode.prototype as unknown as {
		setupEditorSubmitHandler(this: object): void;
	}
).setupEditorSubmitHandler;

function commandContext(settingsManager: SettingsManager) {
	const editor = { setText: vi.fn(), onSubmit: undefined as undefined | ((text: string) => Promise<void>) };
	const context = Object.create(InteractiveMode.prototype);
	Object.defineProperties(context, {
		settingsManager: { value: settingsManager },
		session: { value: { isCompacting: false, isStreaming: false } },
	});
	Object.assign(context, {
		defaultEditor: editor,
		editor,
		onInputCallback: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		showStatus: vi.fn(),
		updateAvailableProviderCount: vi.fn(async () => {}),
		showSelector: (
			factory: (done: () => void) => {
				component: { handleInput(input: string): void; render(width: number): string[] };
			},
		) => {
			const { component } = factory(() => {});
			context.confirmation = stripAnsi(component.render(160).join("\n"));
			component.handleInput("\r");
		},
	});
	submit.call(context);
	return { context, editor };
}

describe.sequential("Vinci-first default T0 regressions", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		vi.stubEnv("VINCI_CODE", "1");
		vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", undefined);
		setKeybindings(new KeybindingsManager());
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("Offline test boundary");
			}),
		);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	test("T1 default candidates contain only Vinci despite a faux external credential", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", ["faux", "only"].join("-"));
		const settingsManager = SettingsManager.inMemory();
		const models = [external(), ...registeredModels()];
		const result = await candidates.call({
			session: { scopedModels: [], modelRegistry: registry(models) },
			settingsManager,
		});
		expect(result.every((model) => model.provider === "vinci")).toBe(true);
		const { text } = await picker(settingsManager, fetch);
		expect(text).toContain("Showing Vinci models. Use /providers to add other providers.");
	});

	test("T2 default login opens Vinci sign-in directly", async () => {
		const context = {
			settingsManager: SettingsManager.inMemory(),
			showLoginDialog: vi.fn(),
			showLoginAuthTypeSelector: vi.fn(),
		};
		await login.call(context, "login");
		expect(context.showLoginDialog).toHaveBeenCalledWith("vinci", "Vinci");
		expect(context.showLoginAuthTypeSelector).not.toHaveBeenCalled();
	});

	test.each(["setting", "environment", "command"])(
		"T3 opt-in through %s groups every Vinci entry first",
		async (route) => {
			const settingsManager = SettingsManager.inMemory({ showOtherProviders: route === "setting" });
			if (route === "environment") vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "1");
			if (route === "command") {
				const { context, editor } = commandContext(settingsManager);
				await editor.onSubmit?.("/providers");
				expect(settingsManager.getShowOtherProviders()).toBe(true);
				expect(context.confirmation).toContain("Other providers are off");
				expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("/login"));
				await settingsManager.flush();
				await settingsManager.reload();
				expect(settingsManager.getShowOtherProviders()).toBe(true);
			}
			const models = [external(), ...registeredModels()];
			for (const scoped of [false, true]) {
				const result = await candidates.call({
					session: {
						scopedModels: scoped ? models.map((model) => ({ model })) : [],
						modelRegistry: registry(models),
					},
					settingsManager,
				});
				expect(result.map((model) => model.provider)).toEqual([
					...registeredModels().map(() => "vinci"),
					"openrouter",
				]);
				const { text } = await picker(settingsManager, fetch, scoped);
				expect(text.indexOf("Vinci models")).toBeLessThan(text.indexOf("Other providers"));
				expect(text.indexOf("Vinci Forte")).toBeLessThan(text.indexOf("alpha [openrouter]"));
			}
		},
	);

	test("T3 command is discoverable in autocomplete and help", () => {
		expect(BUILTIN_SLASH_COMMANDS.filter((command) => command.name === "providers")).toHaveLength(1);
		expect(vinciHelpText()).toContain("/providers");
	});

	test("T4 catalogue lineup has plain names and live occupants, excludes reserved and unknown ids", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload));
		const { text } = await picker(SettingsManager.inMemory(), fetcher);
		expect(registeredModels().map((model) => [model.id, model.name])).toEqual([
			["auto", "Vinci Auto"],
			["mezzo", "Vinci Mezzo"],
			["forte", "Vinci Forte"],
		]);
		expect(text).toContain("Vinci Auto  your plan's default");
		expect(text).toContain("Vinci Mezzo  GLM 5.3 Flash");
		expect(text).toContain("Vinci Forte  GLM 5.3");
		expect(text).not.toMatch(/Fortissimo|Unknown|Unreleased/);
		expect(text.indexOf("Vinci Auto")).toBeLessThan(text.indexOf("Vinci Mezzo"));
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]?.[0]).toMatch(/\/api\/models$/);
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
	});

	test("T4 auto uses server-default Mezzo prices and Forte uses current DeepInfra prices", () => {
		const mezzo = { input: 0.15, cacheRead: 0.03, output: 0.5, cacheWrite: 0.15 };
		expect(vinciClassModel("auto", "Vinci Auto").cost).toEqual(mezzo);
		expect(vinciClassModel("mezzo", "Vinci Mezzo").cost).toEqual(mezzo);
		expect(vinciClassModel("forte", "Vinci Forte").cost).toEqual({
			input: 0.9,
			cacheRead: 0.2,
			output: 4,
			cacheWrite: 0.9,
		});
	});

	test("T4 catalogue ignores reserved and unknown details and fetches once per loader", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload));
		const load = createVinciModelCatalogue(fetcher);
		const first = await load();
		expect([...(first?.keys() ?? [])]).toEqual(["mezzo", "forte"]);
		expect(await load()).toBe(first);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	test.each(["failure", "timeout", "malformed JSON", "malformed payload"])(
		"T5 %s falls back to plain names and an offline note",
		async (failure) => {
			if (failure === "timeout") vi.useFakeTimers();
			const fetcher = vi.fn<typeof fetch>(async () => {
				if (failure === "failure") throw new Error("Offline");
				if (failure === "timeout") return new Promise<Response>(() => {});
				if (failure === "malformed JSON") return new Response("{");
				return Response.json({ models: [{ id: "mezzo", label: 7, occupant: "Untrusted" }] });
			});
			const pending = picker(SettingsManager.inMemory(), fetcher);
			if (failure === "timeout") await vi.advanceTimersByTimeAsync(1500);
			const { text } = await pending;
			expect(text).toContain("model details unavailable offline");
			expect(text).toContain("Vinci Auto  your plan's default");
			expect(text).toContain("Vinci Mezzo");
			expect(text).toContain("Vinci Forte");
			expect(text).not.toMatch(/GLM|Flash|Untrusted|Fortissimo/);
		},
	);

	test("T6 upstream candidates, hint and login retain their behavior", async () => {
		vi.stubEnv("VINCI_CODE", undefined);
		const settingsManager = SettingsManager.inMemory();
		const models = [external(), ...registeredModels()];
		expect(
			await candidates.call({ session: { scopedModels: [], modelRegistry: registry(models) }, settingsManager }),
		).toEqual(models);
		const { text } = await picker(settingsManager, fetch);
		expect(text).toContain("Only showing models from configured providers. Use /login to add providers.");
		expect(fetch).not.toHaveBeenCalled();
		const context = { settingsManager, showLoginDialog: vi.fn(), showLoginAuthTypeSelector: vi.fn() };
		await login.call(context, "login");
		expect(context.showLoginAuthTypeSelector).toHaveBeenCalledOnce();
		expect(context.showLoginDialog).not.toHaveBeenCalled();
	});

	test("T7 environment overrides settings in both directions", () => {
		vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "0");
		expect(SettingsManager.inMemory({ showOtherProviders: true }).getShowOtherProviders()).toBe(false);
		vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "1");
		expect(SettingsManager.inMemory({ showOtherProviders: false }).getShowOtherProviders()).toBe(true);
	});
});
