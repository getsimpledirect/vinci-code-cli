import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { ScopedModelsSelectorComponent } from "../../../src/modes/interactive/components/scoped-models-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

async function waitForAsyncRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("issue #3217 scoped model ordering", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("propagates reordered scoped models back to the session state", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const orderedIds = harness.models.map((model) => `${model.provider}/${model.id}`);
		const changes: Array<string[] | null> = [];
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: [...harness.models],
				enabledModelIds: orderedIds,
			},
			{
				onChange: (enabledModelIds) => {
					changes.push(enabledModelIds);
				},
				onPersist: () => {},
				onCancel: () => {},
			},
		);

		selector.handleInput("\x1b[1;3B");

		expect(changes).toEqual([[orderedIds[1], orderedIds[0], orderedIds[2]]]);
	});

	it("preserves scoped model order in the /model scoped tab", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const modelOne = harness.getModel("faux-1")!;
		const modelTwo = harness.getModel("faux-2")!;
		const modelThree = harness.getModel("faux-3")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			modelOne,
			harness.settingsManager,
			harness.session.modelRegistry,
			[{ model: modelTwo }, { model: modelOne }, { model: modelThree }],
			() => {},
			() => {},
		);

		await waitForAsyncRender();

		const renderedLines = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.filter((line) => line.includes(`[${modelOne.provider}]`));
		const orderedIds = renderedLines.slice(0, 3).map((line) => {
			const [modelId] = line.trim().replace(/^→\s*/, "").split(" [");
			return modelId?.trim() ?? "";
		});

		expect(orderedIds).toEqual([modelTwo.id, modelOne.id, modelThree.id]);
	});

	it("shows every registered Vinci model and keeps /model selection session-local", async () => {
		const previous = process.env.VINCI_CODE;
		const previousShow = process.env.VINCI_SHOW_OTHER_PROVIDERS;
		process.env.VINCI_CODE = "1";
		// This regression is about scoped-model ORDER and session-local selection, not provider
		// visibility. Pin the managed-only view explicitly: providers are open by DEFAULT now, so
		// relying on the default would make this assert on a mixed catalogue it was never about.
		process.env.VINCI_SHOW_OTHER_PROVIDERS = "0";
		const harness = await createHarness();
		harnesses.push(harness);
		harness.authStorage.setRuntimeApiKey("vinci", "vinci-key");
		harness.session.modelRegistry.registerProvider("vinci", {
			baseUrl: "https://example.invalid",
			apiKey: "vinci-key",
			api: "openai-completions",
			models: [
				{
					id: "auto",
					name: "Vinci",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
				{
					id: "forte",
					name: "Vinci Forte",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
				{
					id: "fortissimo",
					name: "Vinci Fortissimo",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
			],
		});

		try {
			const auto = harness.session.modelRegistry.find("vinci", "auto")!;
			const fortissimo = harness.session.modelRegistry.find("vinci", "fortissimo")!;
			const persist = vi.spyOn(harness.settingsManager, "setDefaultModelAndProvider");
			const selected: string[] = [];
			const selector = new ModelSelectorComponent(
				createFakeTui(),
				auto,
				harness.settingsManager,
				harness.session.modelRegistry,
				[],
				(model) => selected.push(model.id),
				() => {},
			);

			await waitForAsyncRender();

			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Vinci");
			expect(rendered).toContain("Vinci Forte");
			expect(rendered).toContain("Vinci Fortissimo");
			expect(rendered).not.toContain(harness.getModel().id);

			(
				selector as unknown as {
					handleSelect(model: typeof fortissimo): void;
				}
			).handleSelect(fortissimo);
			expect(selected).toEqual(["fortissimo"]);
			expect(persist).not.toHaveBeenCalled();

			await harness.session.setModel(fortissimo);
			expect(harness.session.model?.id).toBe("fortissimo");
			expect(persist).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete process.env.VINCI_CODE;
			else process.env.VINCI_CODE = previous;
			if (previousShow === undefined) delete process.env.VINCI_SHOW_OTHER_PROVIDERS;
			else process.env.VINCI_SHOW_OTHER_PROVIDERS = previousShow;
		}
	});
});
