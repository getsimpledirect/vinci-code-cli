import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type ToolCall,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { vinciMaskSecrets } from "../src/core/vinci-mask-secrets.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createTestResourceLoader } from "./utilities.ts";

// Synthetic, unusable provider-shaped text follows the existing mask-integration test pattern.
const SECRET = "sk-ant-" + "TESTONLY-" + "c".repeat(40);
const MALFORMED_ARGUMENTS = `{"path":"a.txt","content":"${SECRET}`;
const ARGUMENTS_ERROR = `Unexpected end of JSON input\nReceived arguments:\n${MALFORMED_ARGUMENTS}`;
type DiagnosticToolCall = ToolCall & { argumentsError?: string };

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "offline-masking-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("Vinci malformed tool argument diagnostics", () => {
	const sessions: AgentSession[] = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	function createSession(malformed: boolean) {
		const tmpRoot = process.env.TMPDIR;
		if (!tmpRoot) throw new Error("Set TMPDIR to the task's tmp directory before running this test.");
		const directory = mkdtempSync(join(tmpRoot, "tool-arguments-mask-"));
		const model = getModel("openai", "gpt-4o-mini")!;
		const execute = vi.fn(async (_id: string, _args: unknown) => ({
			content: [{ type: "text" as const, text: "accepted" }],
			details: undefined,
		}));
		const tool: AgentTool = {
			name: "write",
			label: "Write",
			description: "Write a complete text file",
			parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			execute,
		};
		const call: DiagnosticToolCall = {
			type: "toolCall",
			id: "offline-call",
			name: "write",
			arguments: malformed ? {} : { path: "a.txt", content: SECRET },
			...(malformed ? { argumentsError: ARGUMENTS_ERROR } : {}),
		};
		const responses = [
			assistantMessage([call], "toolUse"),
			assistantMessage([{ type: "text", text: "ready" }], "stop"),
		];
		const modelRequests: string[] = [];
		const agent = new Agent({
			initialState: { model, systemPrompt: "Offline diagnostic test", tools: [tool] },
			getApiKey: () => "offline-test-key",
			streamFn: (_model, context: Context) => {
				modelRequests.push(JSON.stringify(context.messages));
				const stream = createAssistantMessageEventStream();
				const message = responses.shift();
				if (!message) throw new Error("Unexpected extra offline model request.");
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
				});
				return stream;
			},
		});
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "offline-test-key");
		const sessionManager = SessionManager.create(directory, join(directory, "sessions"));
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			cwd: directory,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { write: tool },
		});
		sessions.push(session);
		const emitted: string[] = [];
		session.subscribe((event) => emitted.push(JSON.stringify(event)));
		return { session, sessionManager, execute, call, directory, emitted, modelRequests };
	}

	it("masks diagnostics in real persisted sessions, emitted events, exports and the tool-error echo", async () => {
		vi.stubEnv("VINCI_CODE", "1");
		const { session, sessionManager, execute, directory, emitted, modelRequests } = createSession(true);

		await session.prompt("Inspect this offline tool diagnostic");

		const persisted = readFileSync(sessionManager.getSessionFile()!, "utf8");
		expect(persisted).not.toContain(SECRET);
		const restored = SessionManager.open(sessionManager.getSessionFile()!, join(directory, "sessions"));
		const assistantEntry = restored.getEntries().find((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(assistantEntry?.type).toBe("message");
		if (assistantEntry?.type !== "message" || assistantEntry.message.role !== "assistant") return;
		const restoredCall = assistantEntry.message.content.find((content) => content.type === "toolCall") as DiagnosticToolCall;
		expect(restoredCall.argumentsError).toBe(vinciMaskSecrets(ARGUMENTS_ERROR));
		expect(restoredCall.arguments).toEqual({});
		expect(emitted.join("\n")).not.toContain(SECRET);
		const exported = readFileSync(session.exportToJsonl(join(directory, "export.jsonl")), "utf8");
		expect(exported).not.toContain(SECRET);
		expect(modelRequests).toHaveLength(2);
		expect(modelRequests[1]).not.toContain(SECRET);
		expect(modelRequests[1]).toContain("Invalid arguments");
		expect(modelRequests[1]).toContain("redacted");
		expect(execute).toHaveBeenCalledTimes(0);
	});

	it("keeps valid outer-object values unchanged for execution and session persistence", async () => {
		vi.stubEnv("VINCI_CODE", "1");
		const { session, sessionManager, execute, call } = createSession(false);

		await session.prompt("Inspect the valid offline control");

		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0][1]).toEqual({ path: "a.txt", content: SECRET });
		expect(call.arguments).toEqual({ path: "a.txt", content: SECRET });
		expect(readFileSync(sessionManager.getSessionFile()!, "utf8")).toContain(SECRET);
	});

	it("preserves plain Pi diagnostic persistence when VINCI_CODE is unset", async () => {
		vi.stubEnv("VINCI_CODE", undefined);
		const { session, sessionManager, call } = createSession(true);

		await session.prompt("Inspect the plain Pi control");

		expect(call.argumentsError).toBe(ARGUMENTS_ERROR);
		expect(readFileSync(sessionManager.getSessionFile()!, "utf8")).toContain(SECRET);
	});

	it("prints parseable masked JSON using the real print-mode event path", async () => {
		vi.stubEnv("VINCI_CODE", "1");
		const { session } = createSession(true);
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk, encodingOrCallback, callback) => {
			writes.push(String(chunk));
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.();
			return true;
		});
		const runtime = {
			session,
			setRebindSession: () => {},
			dispose: async () => session.dispose(),
		} as unknown as AgentSessionRuntime;

		expect(await runPrintMode(runtime, { mode: "json", messages: ["Inspect this offline print diagnostic"] })).toBe(0);

		const output = writes.join("");
		const records = output.trim().split("\n").map((line) => JSON.parse(line));
		const ended = records.find((record) => record.type === "message_end" && record.message.role === "assistant");
		expect(ended.message.content[0].argumentsError).toBe(vinciMaskSecrets(ARGUMENTS_ERROR));
		expect(ended.message.usage.totalTokens).toBe(2);
		expect(output).not.toContain(SECRET);
	});
});
