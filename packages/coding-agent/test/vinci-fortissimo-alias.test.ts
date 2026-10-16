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
import { assistantMsg, createTestExtensionsResult, createTestResourceLoader, userMsg } from "./utilities.ts";

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
			apiKey: "offline-test-key",
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
		it.each(["forte", "vinci/forte", "FORTE"])("accepts requested fortissimo served as %s", (served) => {
			expect(() =>
				assertNoManagedVinciDowngrade(
					{ provider: "vinci", id: "fortissimo" },
					{ "x-vinci-resolved-model": served },
				),
			).not.toThrow();
		});

		it.each(["forte", "fortissimo"])("refuses requested %s served as mezzo", (requested) => {
			expect(() =>
				assertNoManagedVinciDowngrade({ provider: "vinci", id: requested }, { "x-vinci-resolved-model": "mezzo" }),
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
				assertNoManagedVinciDowngrade({ provider: "other", id: "forte" }, { "x-vinci-resolved-model": "mezzo" }),
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
					vinciRequestedClass: "fortissimo",
				});
				expect(result.error).toBeUndefined();
				expect(result.warning).toBeUndefined();
			},
		);

		it("resolves an explicit Vinci provider and legacy model", () => {
			const result = resolveCliModel({ cliProvider: "vinci", cliModel: "fortissimo", modelRegistry });
			expect(result.model).toMatchObject({ id: "forte", vinciRequestedClass: "fortissimo" });
			expect(result.error).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		it.each(["fortissimo", "vinci/fortissimo"])("resolves saved enabledModels pattern %s", async (pattern) => {
			const settings = SettingsManager.inMemory({ enabledModels: [pattern] });
			const result = await resolveModelScopeWithDiagnostics(settings.getEnabledModels()!, modelRegistry);
			expect(result.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)).toEqual(["vinci/forte"]);
			expect(result.scopedModels[0]?.model).toHaveProperty("vinciRequestedClass", "fortissimo");
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
			expect(result.scopedModels[0]?.model).toHaveProperty("vinciRequestedClass", "fortissimo");
			expect(result.diagnostics).toEqual([]);
		});

		it.each(["fortissimo", "vinci/fortissimo"])("matches exact saved model reference %s", (reference) => {
			expect(findExactModelReferenceMatch(reference, modelRegistry.getAll())).toMatchObject({
				id: "forte",
				vinciRequestedClass: "fortissimo",
			});
		});
		it("keeps alias metadata off genuine Forte selections and the shared registry model", () => {
			resolveCliModel({ cliModel: "fortissimo", modelRegistry });
			const result = resolveCliModel({ cliModel: "forte", modelRegistry });
			expect(result.model?.id).toBe("forte");
			expect(result.model).not.toHaveProperty("vinciRequestedClass");
			expect(modelRegistry.find("vinci", "forte")).not.toHaveProperty("vinciRequestedClass");
		});

		it("does not reinterpret another provider's Fortissimo model as Vinci", () => {
			const other = { ...modelRegistry.find("vinci", "forte")!, provider: "other", id: "fortissimo" };
			expect(findExactModelReferenceMatch("other/fortissimo", [other])).toBe(other);
		});
	});

	describe("saved defaults and resumed sessions", () => {
		it("restores a historical Fortissimo session as Forte without substitution", async () => {
			await expect(
				restoreModelFromSession("vinci", "fortissimo", undefined, false, modelRegistry),
				"legacy session alias resolves to Forte before the managed-model guard",
			).resolves.toMatchObject({
				model: { provider: "vinci", id: "forte", vinciRequestedClass: "fortissimo" },
				fallbackMessage: undefined,
			});
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
			).resolves.toMatchObject({
				model: { provider: "vinci", id: "forte", vinciRequestedClass: "fortissimo" },
				fallbackMessage: undefined,
			});
		});

		it("still refuses a genuinely unavailable managed session model with the existing message", async () => {
			await expect(
				restoreModelFromSession("vinci", "doesnotexist", undefined, false, modelRegistry),
			).rejects.toThrow(
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

		it("canonicalizes an explicit legacy SDK model before use", async () => {
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				model: { ...modelRegistry.find("vinci", "forte")!, id: "fortissimo", name: "Vinci Fortissimo" },
				authStorage,
				modelRegistry,
				settingsManager: SettingsManager.inMemory(),
				sessionManager: SessionManager.inMemory(),
				resourceLoader: createTestResourceLoader(),
				noTools: "all",
			});
			try {
				expect(session.model, "explicit SDK legacy model resolves to effective Forte").toMatchObject({
					id: "forte",
					name: "Vinci Forte",
					vinciRequestedClass: "fortissimo",
				});
			} finally {
				session.dispose();
			}
		});

		it("normalizes a model set from legacy SDK metadata while preserving its saved selection", async () => {
			const forte = modelRegistry.find("vinci", "forte")!;
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				model: forte,
				authStorage,
				modelRegistry,
				settingsManager: SettingsManager.inMemory(),
				sessionManager: SessionManager.inMemory(),
				resourceLoader: createTestResourceLoader(),
				noTools: "all",
			});
			try {
				await session.setModel({
					...forte,
					id: "fortissimo",
					name: "Vinci Fortissimo",
					cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
				});
				expect(session.model, "setModel uses effective Forte with Forte pricing").toMatchObject({
					id: "forte",
					name: "Vinci Forte",
					cost: forte.cost,
					vinciRequestedClass: "fortissimo",
				});
				expect(
					session.sessionManager.buildSessionContext().model?.modelId,
					"new model-change entries retain the user's requested alias",
				).toBe("fortissimo");
			} finally {
				session.dispose();
			}
		});

		it("retains the requested alias when a newly saved session is resumed", async () => {
			const cwd = join(tempDir, "roundtrip-project");
			mkdirSync(cwd, { recursive: true });
			const saved = SessionManager.create(cwd, join(tempDir, "roundtrip-sessions"));
			const options = {
				cwd,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settingsManager: SettingsManager.inMemory(),
				resourceLoader: createTestResourceLoader(),
				noTools: "all" as const,
			};
			const selected = { ...modelRegistry.find("vinci", "forte")!, vinciRequestedClass: "fortissimo" };
			const first = await createAgentSession({ ...options, sessionManager: saved, model: selected });
			try {
				expect(
					saved.buildSessionContext().model?.modelId,
					"new sessions persist the original alias alongside the effective runtime model",
				).toBe("fortissimo");
				saved.appendMessage(userMsg("Roundtrip offline message"));
				saved.appendMessage({ ...assistantMsg("Roundtrip offline response"), provider: "vinci", model: "forte" });
				const sessionFile = saved.getSessionFile()!;
				const originalBytes = readFileSync(sessionFile);
				const resumed = await createAgentSession({ ...options, sessionManager: SessionManager.open(sessionFile) });
				try {
					expect(resumed.session.model).toMatchObject({ id: "forte", vinciRequestedClass: "fortissimo" });
					expect(readFileSync(sessionFile)).toEqual(originalBytes);
				} finally {
					resumed.session.dispose();
				}
			} finally {
				first.session.dispose();
			}
		});

		it("preserves alias identity when extension registration refreshes the effective model", async () => {
			const selected = { ...modelRegistry.find("vinci", "forte")!, vinciRequestedClass: "fortissimo" };
			const extensionsResult = await createTestExtensionsResult([
				(pi) => {
					pi.on("session_start", () => {
						pi.registerProvider("vinci", { baseUrl: "https://offline.invalid/refreshed" });
					});
				},
			]);
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				model: selected,
				authStorage,
				modelRegistry,
				settingsManager: SettingsManager.inMemory(),
				sessionManager: SessionManager.inMemory(),
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				noTools: "all",
			});
			try {
				await session.bindExtensions({});
				expect(
					session.model,
					"registry refresh preserves the requested alias on the effective model",
				).toMatchObject({
					id: "forte",
					name: "Vinci Forte",
					vinciRequestedClass: "fortissimo",
					baseUrl: "https://offline.invalid/refreshed",
				});
				await session.setModel(modelRegistry.find("vinci", "forte")!);
				expect(session.model, "a later genuine Forte selection has no requested alias").not.toHaveProperty(
					"vinciRequestedClass",
				);
			} finally {
				session.dispose();
			}
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
			historical.appendMessage({
				...assistantMsg("Historical offline response"),
				provider: "vinci",
				model: "fortissimo",
			});
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
			await expect(
				resume,
				"SDK resume resolves the historical alias before looking up the model",
			).resolves.toHaveProperty("session.model.id", "forte");
			const resumed = await resume;
			try {
				expect(resumed.session.model, "SDK resume uses the effective Forte model").toMatchObject({
					provider: "vinci",
					id: "forte",
					vinciRequestedClass: "fortissimo",
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
