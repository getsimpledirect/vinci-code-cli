import * as fs from "node:fs";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, parse } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionImportFileNotFoundError,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { MissingSessionCwdError } from "../../src/core/session-cwd.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../src/core/session-manager.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/index.ts";
import { createHarness } from "./harness.ts";

vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }));

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: { cwd?: string; bootstrapModel?: boolean; bootstrapThinkingLevel?: boolean },
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `pi-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
			thinkingLevel: options?.bootstrapThinkingLevel === false ? undefined : undefined,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
					thinkingLevel: runtimeOptions.thinkingLevel,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux, tempDir };
	}

	it("persists message_end assistant replacements to the session manager", async () => {
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;

				return {
					message: {
						...event.message,
						usage: {
							...event.message.usage,
							cost: {
								...event.message.usage.cost,
								total: 0.123,
							},
						},
					},
				};
			});
		});

		await runtime.session.prompt("hello");

		const sessionAssistant = runtime.session.messages.find((message) => message.role === "assistant");
		expect(sessionAssistant?.role).toBe("assistant");
		if (sessionAssistant?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(sessionAssistant.usage.cost.total).toBe(0.123);

		const persistedAssistant = runtime.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.find((message) => message.role === "assistant");
		expect(persistedAssistant?.role).toBe("assistant");
		if (persistedAssistant?.role !== "assistant") {
			throw new Error("missing persisted assistant message");
		}
		expect(persistedAssistant.usage.cost.total).toBe(0.123);
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;
		const originalSession = runtime.session;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.messages).toEqual([]);
		const secondSessionFile = runtime.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;

		const switchResult = await runtime.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation for new and resume", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelReason: "new" | "resume" | undefined;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				if (event.reason === cancelReason) {
					return { cancel: true };
				}
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const otherDir = join(tmpdir(), `pi-runtime-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(otherDir, { recursive: true });
		const otherSession = SessionManager.create(otherDir);
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherSessionFile = otherSession.getSessionFile();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionFile!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		events.length = 0;
		await runtime.session.prompt("hello");
		const userMessage = runtime.session.getUserMessagesForForking()[0]!;
		const previousSessionFile = runtime.session.sessionFile;

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtime.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);
		const sessionFileName = parse(runtime.session.sessionFile!).name;
		expect(sessionFileName.endsWith(`_${runtime.session.sessionId}`)).toBe(true);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtime.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtime.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("duplicates the current active branch when forking at the current position", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const previousSessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).not.toBe(previousSessionFile);
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("duplicates the current active branch in-memory when forking at the current position", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-suite-in-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();
		expect(runtime.session.sessionFile).toBeUndefined();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).toBeUndefined();
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("throws when forking with an invalid entry id", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
	});

	it("updates the runtime session cwd on cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `pi-runtime-cwd-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `pi-runtime-cwd-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, { cwd: firstDir });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: secondDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(secondDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.prompt("other");
		const otherSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(otherSessionFile);

		expect(realpathSync(runtime.session.sessionManager.getCwd())).toBe(realpathSync(secondDir));
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(secondDir));
	});

	it("restores model and thinking state from the destination session", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, {
			bootstrapModel: false,
			bootstrapThinkingLevel: false,
		});
		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: otherDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(otherDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.setModel(faux.getModel("faux-2")!);
		otherRuntime.session.setThinkingLevel("off");
		await otherRuntime.session.prompt("hello");
		const targetSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(targetSessionFile);

		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
	});
});

describe("session import preservation", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function fixture(options: { extension?: ExtensionFactory; sessionDir?: string } = {}) {
		const harness = await createHarness();
		const root = harness.tempDir;
		const sessionDir = options.sessionDir ?? join(root, "sessions");
		const manager = SessionManager.create(root, sessionDir);
		manager.appendMessage(fauxAssistantMessage("current session"));
		let replacementFailure: Error | undefined;
		const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			if (replacementFailure) throw replacementFailure;
			const services = await createAgentSessionServices({
				cwd,
				agentDir: join(root, "agent"),
				authStorage: harness.authStorage,
				resourceLoaderOptions: {
					extensionFactories: options.extension ? [options.extension] : [],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: harness.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir: root, sessionManager: manager });
		runtime.setRebindSession(async (session) => session.bindExtensions({}));
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			runtime.setBeforeSessionInvalidate(undefined);
			try {
				await runtime.dispose();
			} finally {
				harness.cleanup();
			}
		});
		const incoming = (name = "incoming.jsonl", cwd = root, id = "imported") => {
			const dir = join(root, "incoming");
			mkdirSync(dir, { recursive: true });
			const path = join(dir, name);
			writeFileSync(
				path,
				`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: "2026-10-29T00:00:00Z", cwd })}\n`,
			);
			return path;
		};
		return {
			runtime,
			root,
			sessionDir,
			incoming,
			failReplacement(error: Error) {
				replacementFailure = error;
			},
		};
	}

	it("uses a free basename and preserves the incoming bytes", async () => {
		const { runtime, incoming, sessionDir } = await fixture();
		const source = incoming();
		const bytes = readFileSync(source);
		expect(await runtime.importFromJsonl(source)).toEqual({ cancelled: false });
		expect(runtime.session.sessionFile).toBe(join(sessionDir, basename(source)));
		expect(readFileSync(source)).toEqual(bytes);
		expect(readFileSync(runtime.session.sessionFile!).subarray(0, bytes.length)).toEqual(bytes);
		expect(runtime.session.sessionId).toBe("imported");
	});

	it("retains an existing same-named session and chooses a noncolliding name", async () => {
		const { runtime, incoming, sessionDir } = await fixture();
		const source = incoming();
		const existing = join(sessionDir, basename(source));
		writeFileSync(existing, "retained existing session\n");
		await runtime.importFromJsonl(source);
		expect(runtime.session.sessionFile === existing).toBe(false);
		expect(readFileSync(existing, "utf8")).toBe("retained existing session\n");
		expect(readFileSync(runtime.session.sessionFile!, "utf8").startsWith(readFileSync(source, "utf8"))).toBe(true);
	});

	it("uses a bounded fallback name when a colliding basename is already near the filename limit", async () => {
		const { runtime, incoming, sessionDir } = await fixture();
		const source = incoming(`${"x".repeat(240)}.jsonl`);
		const existing = join(sessionDir, basename(source));
		writeFileSync(existing, "retained long-name session\n");
		await runtime.importFromJsonl(source);
		expect(readFileSync(existing, "utf8")).toBe("retained long-name session\n");
		expect(Buffer.byteLength(basename(runtime.session.sessionFile!))).toBeLessThanOrEqual(255);
		expect(runtime.session.sessionId).toBe("imported");
	});

	it.each(["invalid JSON\n", '{"type":"message"}\n'])(
		"rejects invalid input before touching a destination or the current runtime: %s",
		async (invalid) => {
			const { runtime, incoming, sessionDir } = await fixture();
			const source = incoming();
			writeFileSync(source, invalid);
			const destination = join(sessionDir, basename(source));
			writeFileSync(destination, "retained evidence\n");
			const session = runtime.session;
			const before = readdirSync(sessionDir).sort();
			await expect(runtime.importFromJsonl(source)).rejects.toThrow(/valid.*session/i);
			expect(runtime.session === session).toBe(true);
			expect(readdirSync(sessionDir).sort()).toEqual(before);
			expect(readFileSync(destination, "utf8")).toBe("retained evidence\n");
			expect(readFileSync(source, "utf8")).toBe(invalid);
		},
	);

	it("reports a missing source without changing the current session", async () => {
		const { runtime, root } = await fixture();
		const session = runtime.session;
		await expect(runtime.importFromJsonl(join(root, "absent.jsonl"))).rejects.toBeInstanceOf(
			SessionImportFileNotFoundError,
		);
		expect(runtime.session === session).toBe(true);
	});

	it("keeps empty-file initialization on the imported copy without modifying the source", async () => {
		const { runtime, incoming } = await fixture();
		const source = incoming();
		writeFileSync(source, "");
		await runtime.importFromJsonl(source);
		expect(readFileSync(source, "utf8")).toBe("");
		expect(JSON.parse(readFileSync(runtime.session.sessionFile!, "utf8").split("\n")[0]).type).toBe("session");
	});

	it("keeps recoverable records and parsing diagnostics without rewriting the source", async () => {
		const { runtime, incoming } = await fixture();
		const source = incoming();
		const entry = (id: string, parentId: string | null, text: string) =>
			JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp: "2026-10-29T00:00:00Z",
				message: { role: "user", content: text, timestamp: 0 },
			});
		const bytes = `${readFileSync(source, "utf8")}${entry("one", null, "first")}\nbroken record\n${entry("two", "one", "second")}\n{"__vinci_record_start":`;
		writeFileSync(source, bytes);
		await runtime.importFromJsonl(source);
		expect(runtime.session.sessionManager.getParsingErrors()).toHaveLength(2);
		expect(
			runtime.session.messages.filter((message) => message.role === "user").map((message) => message.content),
		).toEqual(["first", "second"]);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		expect(readFileSync(runtime.session.sessionFile!, "utf8").startsWith(bytes)).toBe(true);
	});

	it("leaves no imported file when a switch hook cancels", async () => {
		const { runtime, incoming, sessionDir } = await fixture({
			extension: (pi) => pi.on("session_before_switch", () => ({ cancel: true })),
		});
		const before = readdirSync(sessionDir).sort();
		const session = runtime.session;
		expect(await runtime.importFromJsonl(incoming())).toEqual({ cancelled: true });
		expect(runtime.session === session).toBe(true);
		expect(readdirSync(sessionDir).sort()).toEqual(before);
	});

	it("validates a missing cwd before copying and supports an explicit retry override", async () => {
		const { runtime, incoming, root, sessionDir } = await fixture();
		const source = incoming("incoming.jsonl", join(root, "missing-cwd"));
		const destination = join(sessionDir, basename(source));
		writeFileSync(destination, "retained session\n");
		const session = runtime.session;
		const before = readdirSync(sessionDir).sort();
		await expect(runtime.importFromJsonl(source)).rejects.toBeInstanceOf(MissingSessionCwdError);
		expect(runtime.session === session).toBe(true);
		expect(readdirSync(sessionDir).sort()).toEqual(before);
		expect(readFileSync(destination, "utf8")).toBe("retained session\n");
		await runtime.importFromJsonl(source, root);
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(root));
		expect(readFileSync(destination, "utf8")).toBe("retained session\n");
	});

	it.each(["direct", "symlink", "hardlink"])("resumes a same-file %s without copying", async (kind) => {
		const { runtime, root, sessionDir } = await fixture();
		const source = runtime.session.sessionFile!;
		const bytes = readFileSync(source);
		const before = readdirSync(sessionDir).sort();
		const aliasDir = join(root, "aliases");
		mkdirSync(aliasDir);
		const alias = join(aliasDir, basename(source));
		if (kind === "symlink") symlinkSync(source, alias);
		if (kind === "hardlink") linkSync(source, alias);
		await runtime.importFromJsonl(kind === "direct" ? source : alias);
		expect(runtime.session.sessionFile).toBe(source);
		expect(readdirSync(sessionDir).sort()).toEqual(before);
		expect(readFileSync(source)).toEqual(bytes);
	});

	it("retries an exclusive-creation race and gives hooks the actual destination", async () => {
		const targets: string[] = [];
		const { runtime, incoming } = await fixture({
			extension: (pi) => {
				pi.on("session_before_switch", (event) => {
					targets.push(event.targetSessionFile!);
					if (targets.length === 1) writeFileSync(event.targetSessionFile!, "another import won\n");
				});
			},
		});
		await runtime.importFromJsonl(incoming());
		expect(targets).toHaveLength(2);
		expect(runtime.session.sessionFile).toBe(targets[1]);
		expect(readFileSync(targets[0], "utf8")).toBe("another import won\n");
	});

	it("imports concurrently into distinct files when two runtimes choose the same basename", async () => {
		let arrivals = 0;
		let release: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const extension: ExtensionFactory = (pi) => {
			pi.on("session_before_switch", async () => {
				if (++arrivals === 2) release();
				await barrier;
			});
		};
		const first = await fixture({ extension });
		const second = await fixture({ extension, sessionDir: first.sessionDir });
		const sourceA = first.incoming("incoming.jsonl", first.root, "first-import");
		const sourceB = second.incoming("incoming.jsonl", second.root, "second-import");
		await Promise.all([first.runtime.importFromJsonl(sourceA), second.runtime.importFromJsonl(sourceB)]);
		expect(first.runtime.session.sessionFile === second.runtime.session.sessionFile).toBe(false);
		expect(readFileSync(first.runtime.session.sessionFile!, "utf8").startsWith(readFileSync(sourceA, "utf8"))).toBe(
			true,
		);
		expect(readFileSync(second.runtime.session.sessionFile!, "utf8").startsWith(readFileSync(sourceB, "utf8"))).toBe(
			true,
		);
	});

	it("bounds collision retries and never removes another creator's files", async () => {
		const { runtime, incoming, sessionDir } = await fixture();
		const source = incoming();
		const session = runtime.session;
		const actualOpen = fs.openSync;
		const collisions: string[] = [];
		vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
			if (typeof path === "string" && path.startsWith(sessionDir) && flags === "wx") {
				collisions.push(path);
				writeFileSync(path, "foreign evidence\n");
				throw Object.assign(new Error("collision"), { code: "EEXIST" });
			}
			return actualOpen(path, flags, mode);
		});
		await expect(runtime.importFromJsonl(source)).rejects.toThrow(/collision|noncolliding/i);
		expect(collisions).toHaveLength(16);
		expect(runtime.session === session).toBe(true);
		for (const path of collisions) expect(readFileSync(path, "utf8")).toBe("foreign evidence\n");
	});

	it("copies all bytes even when a write is short", async () => {
		const { runtime, incoming } = await fixture();
		const source = incoming();
		const actualWrite = fs.writeSync;
		vi.spyOn(fs, "writeSync").mockImplementation((fd, buffer, offset, length) => {
			if (typeof buffer === "string") throw new Error("expected a byte copy");
			return actualWrite(fd, buffer, offset, Math.min(typeof length === "number" ? length : 0, 7));
		});
		await runtime.importFromJsonl(source);
		expect(readFileSync(runtime.session.sessionFile!, "utf8").startsWith(readFileSync(source, "utf8"))).toBe(true);
	});

	it("cleans only its owned partial copy after a write failure", async () => {
		const { runtime, incoming, sessionDir } = await fixture();
		const source = incoming();
		const sourceBytes = readFileSync(source);
		const session = runtime.session;
		const before = readdirSync(sessionDir).sort();
		const actualWrite = fs.writeSync;
		vi.spyOn(fs, "writeSync").mockImplementation((fd, buffer, offset) => {
			if (typeof buffer === "string") throw new Error("expected a byte copy");
			actualWrite(fd, buffer, offset, 8);
			throw new Error("synthetic disk failure");
		});
		await expect(runtime.importFromJsonl(source)).rejects.toThrow("synthetic disk failure");
		expect(runtime.session === session).toBe(true);
		expect(readdirSync(sessionDir).sort()).toEqual(before);
		expect(readFileSync(source)).toEqual(sourceBytes);
	});

	it.each(["invalid", "missing cwd"])("removes an owned copy after the switch hook introduces %s", async (kind) => {
		let source = "";
		let replacement = "";
		const { runtime, incoming, sessionDir } = await fixture({
			extension: (pi) => pi.on("session_before_switch", () => writeFileSync(source, replacement)),
		});
		source = incoming();
		replacement =
			kind === "invalid"
				? "invalid replacement\n"
				: `${JSON.stringify({
						type: "session",
						id: "changed",
						timestamp: "2026-10-29T00:00:00Z",
						cwd: join(sessionDir, "absent-cwd"),
					})}\n`;
		const before = readdirSync(sessionDir).sort();
		const session = runtime.session;
		await expect(runtime.importFromJsonl(source)).rejects.toThrow();
		expect(runtime.session === session).toBe(true);
		expect(readdirSync(sessionDir).sort()).toEqual(before);
	});

	it("refuses a same-file path replaced during the switch hook without initializing it", async () => {
		const { runtime } = await fixture({
			extension: (pi) =>
				pi.on("session_before_switch", (event) => {
					const path = event.targetSessionFile!;
					renameSync(path, `${path}.retained`);
					writeFileSync(path, "");
				}),
		});
		const source = runtime.session.sessionFile!;
		const session = runtime.session;
		await expect(runtime.importFromJsonl(source)).rejects.toThrow(/changed/i);
		expect(runtime.session === session).toBe(true);
		expect(readFileSync(source, "utf8")).toBe("");
	});

	it("refuses a foreign path replacing the copy before resume without initializing it", async () => {
		let target = "";
		const { runtime, incoming } = await fixture({
			extension: (pi) =>
				pi.on("session_before_switch", (event) => {
					target = event.targetSessionFile!;
				}),
		});
		const source = incoming();
		const session = runtime.session;
		const actualWrite = fs.writeSync;
		vi.spyOn(fs, "writeSync").mockImplementation((fd, buffer, offset, length) => {
			if (typeof buffer === "string") throw new Error("expected a byte copy");
			const written = actualWrite(fd, buffer, offset, length);
			renameSync(target, `${target}.retained`);
			writeFileSync(target, "");
			return written;
		});
		await expect(runtime.importFromJsonl(source)).rejects.toThrow(/changed/i);
		expect(runtime.session === session).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("");
	});

	it("stops a zero-progress write and cleans the owned destination", async () => {
		const { runtime, incoming, sessionDir } = await fixture();
		const source = incoming();
		const before = readdirSync(sessionDir).sort();
		vi.spyOn(fs, "writeSync").mockReturnValue(0);
		await expect(runtime.importFromJsonl(source)).rejects.toThrow(/no progress/i);
		expect(readdirSync(sessionDir).sort()).toEqual(before);
	});

	it("cleans its owned destination when the source disappears after preflight", async () => {
		let source = "";
		const { runtime, incoming, sessionDir } = await fixture({
			extension: (pi) => pi.on("session_before_switch", () => unlinkSync(source)),
		});
		source = incoming();
		const before = readdirSync(sessionDir).sort();
		await expect(runtime.importFromJsonl(source)).rejects.toThrow(/ENOENT/);
		expect(readdirSync(sessionDir).sort()).toEqual(before);
	});

	it("does not unlink a foreign replacement when its own copy fails", async () => {
		let target = "";
		const { runtime, incoming } = await fixture({
			extension: (pi) =>
				pi.on("session_before_switch", (event) => {
					target = event.targetSessionFile!;
				}),
		});
		vi.spyOn(fs, "writeSync").mockImplementation(() => {
			unlinkSync(target);
			writeFileSync(target, "foreign replacement\n");
			throw new Error("synthetic interrupted copy");
		});
		await expect(runtime.importFromJsonl(incoming())).rejects.toThrow("synthetic interrupted copy");
		expect(readFileSync(target, "utf8")).toBe("foreign replacement\n");
	});

	it("reports an owned copy retained after cleanup fails", async () => {
		const { runtime, incoming, sessionDir } = await fixture();
		const source = incoming();
		const destination = join(sessionDir, basename(source));
		vi.spyOn(fs, "writeSync").mockImplementation(() => {
			throw new Error("synthetic copy failure");
		});
		const actualUnlink = fs.unlinkSync;
		vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
			if (path === destination) throw new Error("synthetic cleanup failure");
			actualUnlink(path);
		});
		await expect(runtime.importFromJsonl(source)).rejects.toThrow(destination);
		expect(existsSync(destination)).toBe(true);
	});

	it.each(["factory", "teardown", "rebind"])(
		"retains the imported copy after %s replacement begins",
		async (phase) => {
			const f = await fixture();
			const source = f.incoming();
			const destination = join(f.sessionDir, basename(source));
			if (phase === "factory") f.failReplacement(new Error("synthetic factory failure"));
			if (phase === "teardown")
				f.runtime.setBeforeSessionInvalidate(() => {
					throw new Error("synthetic teardown failure");
				});
			if (phase === "rebind")
				f.runtime.setRebindSession(async () => {
					throw new Error("synthetic rebind failure");
				});
			await expect(f.runtime.importFromJsonl(source)).rejects.toThrow(destination);
			expect(readFileSync(destination, "utf8").startsWith(readFileSync(source, "utf8"))).toBe(true);
		},
	);
});
