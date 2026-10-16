import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import {
	findExactModelReferenceMatch,
	findInitialModel,
	resolveCliModel,
	resolveModelScopeWithDiagnostics,
	restoreModelFromSession,
} from "../src/core/model-resolver.ts";
import { assertNoManagedVinciDowngrade, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { assistantMsg, createTestResourceLoader, userMsg } from "./utilities.ts";

describe("Vinci Fortissimo compatibility alias", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "vinci-fortissimo-alias-"));
	});

	beforeEach(() => {
		authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("vinci", "offline-test-key");
		modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider("vinci", {
			api: "openai-completions",
			baseUrl: "https://offline.invalid/v1",
			models: [
				{
					id: "forte",
					name: "Vinci Forte",
					reasoning: true,
					input: ["text"],
					cost: { input: 0.93, output: 3, cacheRead: 0.18, cacheWrite: 0.93 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	});

	afterEach(() => {
		modelRegistry.unregisterProvider("vinci");
		vi.restoreAllMocks();
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("SDK response downgrade guard", () => {
		it.each(["forte", "vinci/forte", "FORTE"])(
			"accepts requested fortissimo served as %s",
			(served) => {
				expect(() =>
					assertNoManagedVinciDowngrade(
						{ provider: "vinci", id: "fortissimo" },
						{ "x-vinci-resolved-model": served },
					),
				).not.toThrow();
			},
		);

		it.each(["forte", "fortissimo"])("refuses requested %s served as mezzo", (requested) => {
			expect(() =>
				assertNoManagedVinciDowngrade(
					{ provider: "vinci", id: requested },
					{ "x-vinci-resolved-model": "mezzo" },
				),
			).toThrow(/Vinci refused cheaper class mezzo before consuming the response/);
		});

		it.each(["forte-occupant-display-name", "unrecognized-class"])(
			"preserves acceptance of an unranked served value %s",
			(served) => {
				expect(() =>
					assertNoManagedVinciDowngrade(
						{ provider: "vinci", id: "fortissimo" },
						{ "x-vinci-resolved-model": served },
					),
				).not.toThrow();
			},
		);

		it("canonicalizes provider prefixes, case and whitespace on both classes", () => {
			expect(() =>
				assertNoManagedVinciDowngrade(
					{ provider: "vinci", id: " VINCI/FORTISSIMO " },
					{ "X-Vinci-Resolved-Model": " VINCI/MEZZO " },
				),
			).toThrow(/Vinci refused cheaper class mezzo/);
		});

		it("does not apply managed Vinci class protection to another provider", () => {
			expect(() =>
				assertNoManagedVinciDowngrade(
					{ provider: "other", id: "forte" },
					{ "x-vinci-resolved-model": "mezzo" },
				),
			).not.toThrow();
		});
	});

	describe("legacy CLI and saved model patterns", () => {
		it.each(["fortissimo", "vinci/fortissimo", " VINCI/FORTISSIMO "])(
			"resolves --model %s to forte without an error or prompt warning",
			(cliModel) => {
				const result = resolveCliModel({ cliModel, modelRegistry });
				expect(result.model, "legacy CLI alias resolves to the registered Forte model").toMatchObject({
					provider: "vinci",
					id: "forte",
					name: "Vinci Forte",
				});
				expect(result.error).toBeUndefined();
				expect(result.warning).toBeUndefined();
			},
		);

		it("resolves an explicit Vinci provider and legacy model", () => {
			const result = resolveCliModel({ cliProvider: "vinci", cliModel: "fortissimo", modelRegistry });
			expect(result.model?.id).toBe("forte");
			expect(result.error).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		it.each(["fortissimo", "vinci/fortissimo"])("resolves saved enabledModels pattern %s", async (pattern) => {
			const settings = SettingsManager.inMemory({ enabledModels: [pattern] });
			const result = await resolveModelScopeWithDiagnostics(settings.getEnabledModels()!, modelRegistry);
			expect(result.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)).toEqual(["vinci/forte"]);
			expect(result.diagnostics).toEqual([]);
		});

		it("resolves scoped aliases with thinking levels and deduplicates Forte", async () => {
			const result = await resolveModelScopeWithDiagnostics(
				["vinci/fortissimo:high", "fortissimo", "vinci/forte"],
				modelRegistry,
			);
			expect(result.scopedModels.map(({ model, thinkingLevel }) => [model.id, thinkingLevel])).toEqual([
				["forte", "high"],
			]);
			expect(result.diagnostics).toEqual([]);
		});

		it.each(["fortissimo", "vinci/fortissimo"])("matches exact saved model reference %s", (reference) => {
			expect(findExactModelReferenceMatch(reference, modelRegistry.getAll())?.id).toBe("forte");
		});
	});

	describe("saved defaults and resumed sessions", () => {
		it("restores a historical Fortissimo session as Forte without substitution", async () => {
			await expect(
				restoreModelFromSession("vinci", "fortissimo", undefined, false, modelRegistry),
				"legacy session alias resolves to Forte before the managed-model guard",
			).resolves.toMatchObject({ model: { provider: "vinci", id: "forte" }, fallbackMessage: undefined });
		});

		it("uses a saved Fortissimo default as Forte without substitution", async () => {
			const settings = SettingsManager.inMemory({ defaultProvider: "vinci", defaultModel: "fortissimo" });
			await expect(
				findInitialModel({
					scopedModels: [],
					isContinuing: false,
					defaultProvider: settings.getDefaultProvider(),
					defaultModelId: settings.getDefaultModel(),
					modelRegistry,
				}),
				"legacy default alias resolves to Forte before the managed-model guard",
			).resolves.toMatchObject({ model: { provider: "vinci", id: "forte" }, fallbackMessage: undefined });
		});

		it("still refuses a genuinely unavailable managed session model with the existing message", async () => {
			await expect(restoreModelFromSession("vinci", "doesnotexist", undefined, false, modelRegistry)).rejects.toThrow(
				"Managed Vinci model vinci/doesnotexist is unavailable (model no longer exists). Vinci will not substitute a different model for this session.",
			);
		});

		it("still refuses a genuinely unavailable managed default with the existing message", async () => {
			await expect(
				findInitialModel({
					scopedModels: [],
					isContinuing: false,
					defaultProvider: "vinci",
					defaultModelId: "doesnotexist",
					modelRegistry,
				}),
			).rejects.toThrow(
				"Managed Vinci model vinci/doesnotexist is unavailable. Vinci will not substitute a provider default or another model.",
			);
		});

		it("resumes through createAgentSession as Forte without rewriting historical session bytes", async () => {
			const cwd = join(tempDir, "project");
			const agentDir = join(tempDir, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			const historical = SessionManager.create(cwd, join(tempDir, "sessions"));
			historical.appendModelChange("vinci", "fortissimo");
			historical.appendThinkingLevelChange("off");
			historical.appendMessage(userMsg("Historical offline message"));
			historical.appendMessage({ ...assistantMsg("Historical offline response"), provider: "vinci", model: "fortissimo" });
			const sessionFile = historical.getSessionFile()!;
			const originalBytes = readFileSync(sessionFile);
			const resume = createAgentSession({
				cwd,
				agentDir,
				authStorage,
				modelRegistry,
				settingsManager: SettingsManager.inMemory(),
				sessionManager: SessionManager.open(sessionFile),
				resourceLoader: createTestResourceLoader(),
				noTools: "all",
			});
			await expect(resume, "SDK resume resolves the historical alias before looking up the model").resolves.toHaveProperty(
				"session.model.id",
				"forte",
			);
			const resumed = await resume;
			try {
				expect(resumed.session.model, "SDK resume uses the effective Forte model").toMatchObject({
					provider: "vinci",
					id: "forte",
				});
				expect(resumed.modelFallbackMessage).toBeUndefined();
				expect(readFileSync(sessionFile), "historical Fortissimo session bytes are immutable on resume").toEqual(
					originalBytes,
				);
				expect(resumed.session.sessionManager.buildSessionContext().model?.modelId).toBe("fortissimo");
			} finally {
				resumed.session.dispose();
			}
		});
	});
});
