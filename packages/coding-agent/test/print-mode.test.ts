import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionBindings } from "../src/core/agent-session.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { currentStartupPhase, markStartupPhase, runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
	getHeadlessExitHint: () => number | undefined;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn<(bindings: ExtensionBindings) => Promise<void>>>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
		getHeadlessExitHint: () => undefined,
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {} },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("keeps masked Vinci JSON events parseable", async () => {
		const previousVinciCode = process.env.VINCI_CODE;
		process.env.VINCI_CODE = "1";
		const secret = "sk-ant-TESTONLY-cccccccccccccccccccccccccccccccccccccccc";
		const assistantMessage = createAssistantMessage({ text: `AUTH_TOKEN=${secret}` });
		assistantMessage.usage = { ...assistantMessage.usage, input: 11_950, output: 75, totalTokens: 12_025 };
		const runtimeHost = createRuntimeHost(assistantMessage);
		const writes: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk, encodingOrCallback, callback) => {
			writes.push(String(chunk));
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.();
			return true;
		});
		runtimeHost.session.subscribe.mockImplementation((listener: (event: object) => void) => {
			listener({ type: "message_end", message: assistantMessage });
			return () => {};
		});

		try {
			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "json",
			});
			expect(exitCode).toBe(0);
			const output = writes.join("").trim();
			const event = JSON.parse(output) as { message: AssistantMessage };
			expect(event.message.usage.totalTokens).toBe(12_025);
			expect(output).not.toContain(secret);
			expect(output).toContain("redacted");
		} finally {
			stdoutSpy.mockRestore();
			if (previousVinciCode === undefined) delete process.env.VINCI_CODE;
			else process.env.VINCI_CODE = previousVinciCode;
		}
	});

	it("routes masked headless extension notifications to stderr without changing stdout", async () => {
		const previousVinciCode = process.env.VINCI_CODE;
		process.env.VINCI_CODE = "1";
		const secret = "sk-ant-TESTONLY-dddddddddddddddddddddddddddddddddddddddd";
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const stdoutWrites: string[] = [];
		const stderrWrites: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk, encodingOrCallback, callback) => {
			stdoutWrites.push(String(chunk));
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.();
			return true;
		});
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderrWrites.push(String(chunk));
			return true;
		});
		runtimeHost.session.bindExtensions.mockImplementation(async (bindings) => {
			bindings.headlessNotify?.(`AUTH_TOKEN=${secret}`);
		});

		try {
			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "text",
			});
			expect(exitCode).toBe(0);
			expect(stdoutWrites.join("")).toBe("done\n");
			expect(stderrWrites.join("")).toMatch(/^\[info\] AUTH_TOKEN=.*redacted.*\n$/);
			expect(stderrWrites.join("")).not.toContain(secret);
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			if (previousVinciCode === undefined) delete process.env.VINCI_CODE;
			else process.env.VINCI_CODE = previousVinciCode;
		}
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
});

// [vinci #180] The startup watchdog used to print one opaque sentence for every wedge, which is why
// a recurring pre-stream hang stayed undiagnosed. The phase breadcrumb is what makes the next
// occurrence a bug report instead of a shrug.
describe("startup phase breadcrumb", () => {
	it("defaults to a phase before anything marks one", () => {
		expect(currentStartupPhase()).toBeTruthy();
	});

	it("records the most recent phase entered", () => {
		markStartupPhase("loading settings");
		expect(currentStartupPhase()).toBe("loading settings");
		markStartupPhase("opening session");
		expect(currentStartupPhase()).toBe("opening session");
	});
});
