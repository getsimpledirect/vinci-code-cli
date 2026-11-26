import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { detectCapabilities, Loader, TUI } from "@earendil-works/pi-tui";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	createVinciLook,
	getVinciLook,
	runVinciWelcome,
	type VinciWelcomeChoice,
	vinciLookColor,
	vinciLookSgr,
} from "../../../vinci/extensions/lib/cli-look.ts";
import { stripVinciColor, vinciAscii } from "../../../vinci/extensions/lib/cli-presentation.ts";
import {
	getVinciUiState,
	notifyVinciUiState,
	resetVinciUiState,
	setVinciConnection,
} from "../../../vinci/extensions/lib/ui-state.ts";
import { vinciPlainPresentation, vinciReducedMotion } from "../../../vinci/extensions/lib/vero-state.ts";
import vinciHeader from "../../../vinci/extensions/vinci-header.ts";
import vinciShell from "../../../vinci/extensions/vinci-shell.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { parseArgs } from "../src/cli/args.ts";
import { VinciLines } from "../src/cli/vinci-lines.ts";
import { filterVinciOutput } from "../src/cli/vinci-output.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { defaultModelPerProvider } from "../src/core/model-resolver.ts";
import { isStdoutTakenOver, restoreStdout } from "../src/core/output-guard.ts";
import { main } from "../src/main.ts";
import { getLoginProviderOptions, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { detectTerminalBackgroundFromEnv, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { runVinciPlainMode } from "../src/modes/vinci-plain-mode.ts";
import { createHarness, createHarnessWithExtensions, fauxModel, type Harness } from "./test-harness.ts";

const streams = [process.stdin, process.stdout] as const;
const tty = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));

afterEach(() => {
	vi.unstubAllEnvs();
	for (const [index, stream] of streams.entries()) {
		const property = tty[index];
		if (property) Object.defineProperty(stream, "isTTY", property);
		else Reflect.deleteProperty(stream, "isTTY");
	}
});

function createLookRuntime(harness: Harness): AgentSessionRuntime {
	return new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
			modelRegistry: harness.modelRegistry,
			resourceLoader: harness.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("Unexpected session replacement");
		},
	);
}

it("runs plain welcome, retries sign-in, and appends observed work without a TUI", async () => {
	vi.stubEnv("VINCI_CODE", "1");
	vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "0");
	vi.stubEnv("TERM", "dumb");
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("FORCE_COLOR", "3");
	initTheme("dark");
	const harness = await createHarnessWithExtensions({
		responses: ["Faux reply."],
		extensionFactories: [
			{ factory: vinciHeader, path: "vinci-header.ts" },
			{ factory: vinciShell, path: "vinci-shell.ts" },
		],
	});
	vi.stubEnv(ENV_AGENT_DIR, harness.tempDir);
	vi.spyOn(harness.modelRegistry, "getAvailable").mockReturnValue([]);
	const login = vi.spyOn(harness.authStorage, "login").mockImplementation(async (_provider, callbacks) => {
		callbacks.onDeviceCode({ userCode: "OFFLINE-CODE", verificationUri: "https://example.invalid/device" });
		throw new Error("Offline sign-in fixture");
	});
	const runtime = createLookRuntime(harness);
	const inputs = ["2", "/login", "/login", "Check the fixture", "/quit"];
	const output: string[] = [];
	const ask = vi.spyOn(VinciLines.prototype, "ask").mockImplementation(async () => inputs.shift());
	const write = vi.spyOn(VinciLines.prototype, "write").mockImplementation((text) => {
		output.push(text);
	});
	try {
		await runVinciPlainMode(runtime, { agentDir: harness.tempDir, messages: [] });
		const transcript = output.join("\n");
		expect(transcript).toContain("1. Connect to Vinci");
		expect(transcript).toContain("2. Not now");
		expect(transcript).not.toContain("Use my own API key");
		expect(transcript).toContain("https://example.invalid/device");
		expect(transcript).toContain("Run /login to start again");
		expect(transcript).toContain("Thinking");
		expect(transcript).toContain("Faux reply.");
		expect(transcript).not.toContain("\x1b");
		expect(login).toHaveBeenCalledTimes(2);
	} finally {
		ask.mockRestore();
		write.mockRestore();
		harness.cleanup();
	}
});

describe("Vinci plain interaction", () => {
	async function capturePlainSession(
		harness: Harness,
		input: (prompt: string) => string | undefined,
		firstRun = false,
	): Promise<string[]> {
		vi.stubEnv("VINCI_CODE", "1");
		vi.stubEnv("TERM", "dumb");
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv(ENV_AGENT_DIR, harness.tempDir);
		if (!firstRun) writeFileSync(join(harness.tempDir, ".vinci-welcome-v1"), "later\n");
		resetVinciUiState();
		const output: string[] = [];
		const ask = vi.spyOn(VinciLines.prototype, "ask").mockImplementation(async (prompt) => input(prompt));
		const write = vi.spyOn(VinciLines.prototype, "write").mockImplementation((line) => {
			output.push(line);
		});
		try {
			await runVinciPlainMode(createLookRuntime(harness), { agentDir: harness.tempDir, messages: [] });
			return output;
		} finally {
			ask.mockRestore();
			write.mockRestore();
			resetVinciUiState();
		}
	}

	it("shows the signed-out welcome and header with only an environment provider key", async () => {
		vi.stubEnv("OPENAI_API_KEY", "fixture-key");
		vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "0");
		const harness = createHarness();
		try {
			harness.authStorage.removeRuntimeApiKey(fauxModel.provider);
			expect(harness.authStorage.list()).toEqual([]);
			expect(harness.modelRegistry.getAvailable().some((model) => model.provider === "openai")).toBe(true);
			const inputs = ["2", "/quit"];
			const output = await capturePlainSession(harness, () => inputs.shift(), true);
			expect(output[0]).toContain("How do you want to connect?");
			expect(output[1]).toContain("/login to connect");
			expect(output.join("\n")).not.toContain("Signed in");
		} finally {
			harness.cleanup();
		}
	});

	it("shows a saved Vinci sign-in and clears it on logout with an environment key still available", async () => {
		vi.stubEnv("OPENAI_API_KEY", "fixture-key");
		const harness = createHarness();
		try {
			harness.authStorage.set("vinci", { type: "api_key", key: "fixture-key" });
			const inputs = ["/logout", "1"];
			const output = await capturePlainSession(
				harness,
				() => {
					if (inputs.length > 0) return inputs.shift();
					expect(getVinciUiState().connection).toBe("signed-out");
					return "/quit";
				},
				true,
			);
			expect(output[0]).toContain("Signed in");
			expect(output.join("\n")).not.toContain("How do you want to connect?");
			expect(output.at(-1)).toBe("  /login to connect");
			expect(harness.authStorage.list()).toEqual([]);
			expect(harness.modelRegistry.getAvailable().some((model) => model.provider === "openai")).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it.each([
		{ showOther: "0", scoped: false, choices: ["Vinci Auto", "Vinci Forte"] },
		{ showOther: "1", scoped: false, choices: ["Vinci Auto", "Vinci Forte", "OpenAI Fixture"] },
		{ showOther: "0", scoped: true, choices: ["Vinci Forte"] },
		{ showOther: "1", scoped: true, choices: ["Vinci Forte", "OpenAI Fixture"] },
		{ showOther: "0", scoped: "hidden-only", choices: ["Vinci Auto", "Vinci Forte"] },
	])(
		"lists plain /model choices with show-other=$showOther and scoped=$scoped",
		async ({ showOther, scoped, choices }) => {
			vi.stubEnv("OPENAI_API_KEY", "fixture-key");
			vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", showOther);
			const harness = createHarness();
			const other = { ...fauxModel, provider: "openai", id: "fixture", name: "OpenAI Fixture" };
			const auto = { ...fauxModel, provider: "vinci", id: "auto", name: "Vinci Auto" };
			const forte = { ...fauxModel, provider: "vinci", id: "forte", name: "Vinci Forte" };
			const available = vi
				.spyOn(harness.modelRegistry, "getAvailable")
				.mockImplementation(() =>
					[other, auto, forte].filter((model) => harness.modelRegistry.hasConfiguredAuth(model)),
				);
			try {
				harness.authStorage.set("vinci", { type: "api_key", key: "fixture-key" });
				if (scoped === "hidden-only") harness.session.setScopedModels([{ model: other }]);
				else if (scoped) harness.session.setScopedModels([{ model: other }, { model: forte }]);
				const inputs = ["/model", "", "/quit"];
				const output = await capturePlainSession(harness, () => inputs.shift());
				expect(output).toContain(choices.map((choice, index) => `  ${index + 1}. ${choice}`).join("\n"));
			} finally {
				available.mockRestore();
				harness.cleanup();
			}
		},
	);

	it("appends exactly one plain line per connection change without reprinting the header", async () => {
		const harness = createHarness();
		try {
			const output = await capturePlainSession(harness, () => {
				setVinciConnection("connected");
				setVinciConnection("connected");
				notifyVinciUiState();
				setVinciConnection("reconnect");
				return "/quit";
			});
			expect(output.filter((line) => line.includes("Vinci Code"))).toHaveLength(1);
			expect(output.slice(2)).toEqual(["  Connected", "  Reconnect - /login"]);
		} finally {
			harness.cleanup();
		}
	});

	it.each([
		{
			name: "forwards an empty OAuth reply to the provider and stores offline credentials",
			replies: [""],
			expected: "",
		},
		{
			name: "cancels on EOF at the OAuth prompt and keeps /login usable",
			replies: [undefined, " retry code "],
			expected: " retry code ",
		},
	])("$name", async ({ replies, expected }) => {
		vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "0");
		const harness = createHarness();
		const received: string[] = [];
		registerOAuthProvider({
			id: "vinci",
			name: "Vinci",
			async login({ onPrompt }) {
				received.push(await onPrompt({ message: "Offline OAuth prompt:", allowEmpty: true }));
				return { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 60_000 };
			},
			refreshToken: async (credentials) => credentials,
			getApiKey: (credentials) => credentials.access,
		});
		try {
			const inputs = [...replies.flatMap((reply) => ["/login", reply]), "/quit"];
			let connection: string | undefined;
			const output = await capturePlainSession(harness, () => {
				const input = inputs.shift();
				if (input === "/quit") connection = getVinciUiState().connection;
				return input;
			});
			expect(connection).toBe("signed-in");
			expect(received, "plain OAuth must forward the provider's reply unchanged, including an empty string").toEqual(
				[expected],
			);
			expect(output.filter((line) => line.includes("Login cancelled. Run /login to start again."))).toHaveLength(
				replies.length - 1,
			);
			expect(harness.authStorage.get("vinci")).toMatchObject({ type: "oauth", access: "fixture-access" });
		} finally {
			unregisterOAuthProvider("vinci");
			harness.cleanup();
		}
	});

	it.each([
		{ authType: "api_key", provider: "anthropic" },
		{ authType: "oauth", provider: "github-copilot" },
	] as const)(
		"selects the provider default after plain $authType login from the unknown model",
		async ({ authType, provider }) => {
			vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "1");
			const providerModel = { ...fauxModel, provider, id: defaultModelPerProvider[provider] };
			const harness = createHarness({ model: { ...fauxModel, api: "unknown", provider: "unknown", id: "unknown" } });
			const all = vi.spyOn(harness.modelRegistry, "getAll").mockReturnValue([providerModel]);
			const available = vi
				.spyOn(harness.modelRegistry, "getAvailable")
				.mockImplementation(() => (harness.authStorage.get(provider) ? [providerModel] : []));
			if (authType === "oauth") {
				registerOAuthProvider({
					id: provider,
					name: "Offline Copilot",
					async login() {
						return { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 60_000 };
					},
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				});
			}
			try {
				const index = getLoginProviderOptions(harness.modelRegistry).findIndex(
					(option) => option.id === provider && option.authType === authType,
				);
				expect(index).toBeGreaterThanOrEqual(0);
				const inputs = [
					"/login",
					String(index + 1),
					...(authType === "api_key" ? ["  fixture-key  "] : []),
					"/quit",
				];
				let connection: string | undefined;
				await capturePlainSession(harness, () => {
					const input = inputs.shift();
					if (input === "/quit") connection = getVinciUiState().connection;
					return input;
				});
				expect(connection).toBe("signed-out");
				expect(harness.authStorage.get(provider)).toMatchObject(
					authType === "api_key"
						? { type: authType, key: "fixture-key" }
						: { type: authType, access: "fixture-access" },
				);
				expect(
					harness.session.model,
					"plain login must replace the unknown model with the authenticated provider's default",
				).toMatchObject({
					id: providerModel.id,
					provider,
				});
			} finally {
				if (authType === "oauth") unregisterOAuthProvider(provider);
				all.mockRestore();
				available.mockRestore();
				harness.cleanup();
			}
		},
	);
});

describe("Vinci first-run choices", () => {
	const twoChoices = ["Connect to Vinci", "Not now"];
	const threeChoices = ["Connect to Vinci", "Use my own API key", "Not now"];
	const welcomeCases = [
		{ name: "fresh profile", saved: undefined, override: undefined, choices: threeChoices },
		{ name: "env=0", saved: true, override: "0", choices: twoChoices },
		{ name: "persisted false", saved: false, override: undefined, choices: twoChoices },
		{ name: "env=1", saved: undefined, override: "1", choices: threeChoices },
		{ name: "env=1 with persisted false", saved: false, override: "1", choices: threeChoices },
	];

	function welcomeChoiceLabels(text: string): string[] {
		return text.match(/(?:Connect to Vinci|Use my own API key|Not now)(?= {2})/g) ?? [];
	}

	async function createRichWelcomeFixture(savedOtherProviders?: boolean, override?: string, profile?: string) {
		vi.stubEnv("VINCI_CODE", "1");
		vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", override);
		vi.stubEnv("VINCI_PLAIN", undefined);
		vi.stubEnv("VINCI_SCREEN_READER", undefined);
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("PI_OFFLINE", "1");
		const harness = await createHarnessWithExtensions({
			settings: { theme: "dark", quietStartup: true },
			extensionFactories: [
				{ factory: vinciHeader, path: "vinci-header.ts" },
				{ factory: vinciShell, path: "vinci-shell.ts" },
			],
		});
		if (savedOtherProviders !== undefined) {
			harness.settingsManager.setShowOtherProviders(savedOtherProviders);
			await harness.settingsManager.flush();
		}
		vi.stubEnv(ENV_AGENT_DIR, profile ?? harness.tempDir);
		vi.spyOn(harness.modelRegistry, "getAvailable").mockReturnValue([]);
		const login = vi.spyOn(harness.authStorage, "login").mockImplementation(async (_provider, callbacks) => {
			callbacks.onDeviceCode({ userCode: "FIXTURE-CODE", verificationUri: "https://example.invalid/device" });
			await new Promise<void>((resolve) =>
				callbacks.signal?.addEventListener("abort", () => resolve(), { once: true }),
			);
			throw new Error("Login cancelled");
		});
		const runtime = createLookRuntime(harness);
		const terminal = new VirtualTerminal(80, 24);
		const mode = new InteractiveMode(runtime, { terminal, vinciWelcome: true, manageProcessSignals: false });
		const screen = () => terminal.getViewport().join("\n");
		const waitFor = (text: string) => vi.waitFor(() => expect(screen()).toContain(text), { timeout: 2000 });
		const cleanup = async () => {
			mode.stop();
			await runtime.dispose();
			harness.cleanup();
		};
		return { harness, terminal, mode, screen, waitFor, login, cleanup };
	}

	it.each(welcomeCases)(
		"shows the expected choices in the rich welcome for $name",
		async ({ saved, override, choices }) => {
			const { terminal, mode, screen, waitFor, cleanup } = await createRichWelcomeFixture(saved, override);
			try {
				const starting = mode.init();
				await waitFor("How do you want to connect?");
				const displayed = welcomeChoiceLabels(screen());
				terminal.sendInput("\x1b[A");
				terminal.sendInput("\r");
				await starting;
				await waitFor("Ready");
				expect(displayed).toEqual(choices);
			} finally {
				await cleanup();
			}
		},
	);

	it.each(welcomeCases)(
		"shows the expected choices in the plain welcome for $name",
		async ({ saved, override, choices }) => {
			vi.stubEnv("VINCI_CODE", "1");
			vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", override);
			vi.stubEnv("TERM", "dumb");
			vi.stubEnv("PI_OFFLINE", "1");
			const harness = createHarness();
			vi.stubEnv(ENV_AGENT_DIR, harness.tempDir);
			vi.spyOn(harness.modelRegistry, "getAvailable").mockReturnValue([]);
			const output: string[] = [];
			const ask = vi.spyOn(VinciLines.prototype, "ask").mockResolvedValue(undefined);
			const write = vi.spyOn(VinciLines.prototype, "write").mockImplementation((text) => {
				output.push(text);
			});
			try {
				if (saved !== undefined) {
					harness.settingsManager.setShowOtherProviders(saved);
					await harness.settingsManager.flush();
				}
				await runVinciPlainMode(createLookRuntime(harness), { agentDir: harness.tempDir, messages: [] });
				const welcome = output.join("\n");
				expect(welcome).toContain("How do you want to connect?");
				expect(welcomeChoiceLabels(welcome)).toEqual(choices);
			} finally {
				ask.mockRestore();
				write.mockRestore();
				harness.cleanup();
			}
		},
	);

	it.each(["vinci", "key", "later"] as const)("records an explicit %s choice before routing it", async (choice) => {
		const profile = mkdtempSync(join(tmpdir(), "vinci-welcome-"));
		try {
			const select = vi.fn(async () => choice);
			const pair = vi.fn(async () => {});
			const key = vi.fn(async () => {});
			expect(await runVinciWelcome({ profile, signedIn: false, showOtherProviders: true, select, pair, key })).toBe(
				"continue",
			);
			expect(select).toHaveBeenCalledOnce();
			expect(pair).toHaveBeenCalledTimes(choice === "vinci" ? 1 : 0);
			expect(key).toHaveBeenCalledTimes(choice === "key" ? 1 : 0);
			expect(await runVinciWelcome({ profile, signedIn: false, showOtherProviders: true, select, pair, key })).toBe(
				"continue",
			);
			expect(select).toHaveBeenCalledOnce();
		} finally {
			rmSync(profile, { recursive: true });
		}
	});

	it("skips authenticated profiles and leaves a fresh choice after cancellation", async () => {
		const profile = mkdtempSync(join(tmpdir(), "vinci-welcome-"));
		try {
			vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "0");
			const select = vi.fn(async (_choices: readonly VinciWelcomeChoice[]) => undefined);
			const pair = vi.fn(async () => {});
			const key = vi.fn(async () => {});
			const options = { profile, showOtherProviders: false, select, pair, key };
			expect(await runVinciWelcome({ ...options, signedIn: true })).toBe("continue");
			expect(select).not.toHaveBeenCalled();
			expect(await runVinciWelcome({ ...options, signedIn: false })).toBe("quit");
			expect(await runVinciWelcome({ ...options, signedIn: false })).toBe("quit");
			expect(select).toHaveBeenCalledTimes(2);
			expect(select.mock.calls[0]?.[0].map(({ id }) => id)).toEqual(["vinci", "later"]);
		} finally {
			rmSync(profile, { recursive: true });
		}
	});

	it.each(["vinci", "key", "later"] as const)("routes %s from the real rich startup offline", async (choice) => {
		const { harness, terminal, mode, screen, waitFor, login, cleanup } = await createRichWelcomeFixture();
		try {
			const starting = mode.init();
			await waitFor("How do you want to connect?");
			expect(screen()).not.toContain("Try: fix a bug");
			for (let move = 0; move < ["vinci", "key", "later"].indexOf(choice); move++) terminal.sendInput("\x1b[B");
			terminal.sendInput("\r");
			if (choice === "key") {
				await waitFor("Vero - Connect");
				await waitFor("API key");
				await harness.settingsManager.flush();
				const settings = JSON.parse(readFileSync(join(harness.tempDir, "settings.json"), "utf8"));
				expect(settings).toMatchObject({ showOtherProviders: true });
				terminal.sendInput("\x1b");
				terminal.sendInput("\x1b");
			}
			if (choice === "vinci") {
				await waitFor("FIXTURE-CODE");
				expect(login).toHaveBeenCalledWith("vinci", expect.anything());
				terminal.sendInput("\x1b");
			}
			await starting;
			await waitFor("Ready");
			expect(readFileSync(join(harness.tempDir, ".vinci-welcome-v1"), "utf8").trim()).toBe(choice);
			if (choice === "later") {
				expect(login).not.toHaveBeenCalled();
				vi.stubEnv("VINCI_SHOW_OTHER_PROVIDERS", "0");
				terminal.sendInput("/login");
				terminal.sendInput("\r");
				await waitFor("FIXTURE-CODE");
				expect(login).toHaveBeenCalledOnce();
				terminal.sendInput("\x1b");
				await waitFor("Run /login to start again");
			}
		} finally {
			await cleanup();
		}
	});

	it.each([
		{ restriction: "env-disabled", saved: true, override: "0" },
		{ restriction: "persisted-disabled", saved: false, override: undefined },
	])("hides the API key row and limits /login to Vinci at rich $restriction startup", async ({ saved, override }) => {
		const { terminal, mode, screen, waitFor, login, cleanup } = await createRichWelcomeFixture(saved, override);
		try {
			const starting = mode.init();
			await waitFor("How do you want to connect?");
			expect(screen()).not.toContain("Use my own API key");
			terminal.sendInput("\x1b[B");
			terminal.sendInput("\r");
			await starting;
			await waitFor("Ready");
			expect(login).not.toHaveBeenCalled();
			terminal.sendInput("/login");
			terminal.sendInput("\r");
			await waitFor("FIXTURE-CODE");
			expect(login).toHaveBeenCalledExactlyOnceWith("vinci", expect.anything());
			terminal.sendInput("\x1b");
			await waitFor("Run /login to start again");
		} finally {
			await cleanup();
		}
	});

	it("Esc at the welcome records nothing and leaves /login usable after restart", async () => {
		const first = await createRichWelcomeFixture(false, "0");
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("Welcome exit fixture");
		});
		try {
			const finished = expect(first.mode.init()).rejects.toThrow("Welcome exit fixture");
			await first.waitFor("How do you want to connect?");
			first.terminal.sendInput("\x1b");
			await finished;
			expect(exit).toHaveBeenCalledExactlyOnceWith(0);
			expect(existsSync(join(first.harness.tempDir, ".vinci-welcome-v1"))).toBe(false);
			expect(first.login).not.toHaveBeenCalled();
			exit.mockRestore();
			const next = await createRichWelcomeFixture(false, "0", first.harness.tempDir);
			try {
				const starting = next.mode.init();
				await next.waitFor("How do you want to connect?");
				next.terminal.sendInput("\x1b[B");
				next.terminal.sendInput("\r");
				await starting;
				await next.waitFor("Ready");
				next.terminal.sendInput("/login");
				next.terminal.sendInput("\r");
				await next.waitFor("FIXTURE-CODE");
				expect(next.login).toHaveBeenCalledExactlyOnceWith("vinci", expect.anything());
				next.terminal.sendInput("\x1b");
				await next.waitFor("Run /login to start again");
			} finally {
				await next.cleanup();
			}
		} finally {
			exit.mockRestore();
			await first.cleanup();
		}
	});
});

describe("Vinci CLI presentation boundaries", () => {
	it("keeps the dev badge visible before fitting optional header hints", () => {
		const guidance = (width: number, environment = "▲ dev", ascii = false) =>
			createVinciLook({ width, theme: "dark", color: "none", ascii, plain: false }).header({
				version: "v1.0",
				project: "project",
				connection: "signed-out",
				environment,
			})[2];
		for (let width = 39; width <= 44; width++) {
			const line = guidance(width);
			expect(line, `header at ${width} columns`).toMatch(/^ {2}▲ dev · \/login to connect/);
			expect(line).not.toContain("/undo to undo · /help");
		}
		expect(guidance(39, "▲ development.example.invalid")).toMatch(/^ {2}▲ development.*… · \/login to connect$/);
		expect(guidance(80)).toBe("  ▲ dev · /login to connect · /undo to undo · /help");
		expect(guidance(80, `▲ ${"x".repeat(60)}`), "long signed-out badge at 80 columns").toBe(
			`  ▲ ${"x".repeat(30)}… · /login to connect · /undo to undo · /help`,
		);
		expect(guidance(80, `! ${"x".repeat(60)}`, true), "long ASCII signed-out badge at 80 columns").toBe(
			`  ! ${"x".repeat(28)}... - /login to connect - /undo to undo - /help`,
		);
	});

	it("switches a long badge to the connection-only width below the hint floor", () => {
		const guidance = (width: number, environment: string, ascii = false) =>
			createVinciLook({ width, theme: "dark", color: "none", ascii, plain: false }).header({
				version: "v1.0",
				project: "project",
				connection: "signed-out",
				environment,
			})[2];
		const utf8Badge = `▲ ${"x".repeat(60)}`;
		const asciiBadge = `! ${"x".repeat(60)}`;

		expect(guidance(63, utf8Badge), "UTF-8 header at 63 columns").toBe(
			`  ▲ ${"x".repeat(13)}… · /login to connect · /undo to undo · /help`,
		);
		expect(guidance(62, utf8Badge), "UTF-8 header at 62 columns").toBe(`  ▲ ${"x".repeat(36)}… · /login to connect`);
		expect(guidance(63, asciiBadge, true), "ASCII header at 63 columns").toBe(
			`  ! ${"x".repeat(11)}... - /login to connect - /undo to undo - /help`,
		);
		expect(guidance(62, asciiBadge, true), "ASCII header at 62 columns").toBe(
			`  ! ${"x".repeat(34)}... - /login to connect`,
		);
	});

	it("recognizes --no-color before parsing an initial prompt", () => {
		vi.stubEnv("VINCI_CODE", "1");
		const args = parseArgs(["--no-color", "hello"]);
		expect(args.messages).toEqual(["hello"]);
		expect(args.unknownFlags.has("--no-color")).toBe(false);
	});

	it.each(["", "1"])("keeps rich presentation with NO_COLOR=%j", (value) => {
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("VINCI_PLAIN", undefined);
		vi.stubEnv("VINCI_SCREEN_READER", undefined);
		vi.stubEnv("NO_COLOR", value);
		vi.stubEnv("FORCE_COLOR", "3");
		expect(vinciPlainPresentation()).toBe(false);
		const look = getVinciLook(80, "vinci-light");
		expect(look.fg("accent", "Ready")).toBe("Ready");
		expect(look.bold("Vinci Code")).toBe("\x1b[1mVinci Code\x1b[22m");
	});

	it.each([
		["TERM", "dumb"],
		["VINCI_PLAIN", "1"],
		["VINCI_SCREEN_READER", "1"],
	])("gives %s the zero-escape presentation ahead of FORCE_COLOR", (key, setting) => {
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("VINCI_PLAIN", undefined);
		vi.stubEnv("VINCI_SCREEN_READER", undefined);
		vi.stubEnv("NO_COLOR", undefined);
		vi.stubEnv("FORCE_COLOR", "3");
		vi.stubEnv(key, setting);
		const look = getVinciLook(80);
		expect(vinciPlainPresentation()).toBe(true);
		expect(look.bold(look.fg("accent", "Ready"))).toBe("Ready");
		expect(look.marker).toBe(">");
	});

	it("preserves non-colour styles, cursor control and OSC links when filtering SGR", () => {
		const link = "\x1b]8;;https://example.invalid\x07";
		const cursor = "\x1b[2;1H";
		const input = `${cursor}${link}\x1b[1;31;38;2;0;95;255;48;5;21;4mtext\x1b[39;49;22m\x1b[48:2::255:0:0m`;
		expect(stripVinciColor(input)).toBe(`${cursor}${link}\x1b[1;4mtext\x1b[22m`);
		const bright = [90, 97, 100, 107].map((code) => `\x1b[1;${code}mB\x1b[${code}m`).join("");
		expect(stripVinciColor(bright)).toBe("\x1b[1mB".repeat(4));
	});

	it.each([
		["--no-color", ["--no-color", "--version"], undefined, ""],
		["NO_COLOR=1", ["--version"], "1", "1"],
		["colour control", ["--version"], undefined, undefined],
	] as const)("main() applies the rich colour filter for %s", async (_name, args, env, seen) => {
		const agentDir = mkdtempSync(join(tmpdir(), "vinci-main-color-"));
		vi.stubEnv("VINCI_CODE", "1");
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("VINCI_PLAIN", undefined);
		vi.stubEnv("VINCI_SCREEN_READER", undefined);
		vi.stubEnv("NO_COLOR", env);
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		for (const stream of streams) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
		const written: string[] = [];
		const capture = (chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		};
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(capture);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(capture);
		let noColorAtExit: string | undefined = "unset";
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			noColorAtExit = process.env.NO_COLOR;
			process.stdout.write("\x1b[1;31;38;5;151mout\x1b[39;22m");
			process.stderr.write("\x1b[91;48;2;1;2;3merr\x1b[0m");
			throw new Error("exit fixture");
		});
		try {
			await expect(main([...args])).rejects.toThrow("exit fixture");
			expect(noColorAtExit).toBe(seen);
			expect(written.slice(-2)).toEqual(
				seen === undefined
					? ["\x1b[1;31;38;5;151mout\x1b[39;22m", "\x1b[91;48;2;1;2;3merr\x1b[0m"]
					: ["\x1b[1mout\x1b[22m", "err\x1b[0m"],
			);
			expect(process.env.NO_COLOR).toBe(env);
		} finally {
			exit.mockRestore();
			stdout.mockRestore();
			stderr.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it.each([
		{ mode: "text", args: ["-p"], expected: "headless output" },
		{ mode: "json", args: ["--mode", "json"], expected: "\x1b[31mheadless output\x1b[0m" },
		{ mode: "rpc", args: ["--mode", "rpc"], expected: "\x1b[31mheadless output\x1b[0m" },
	])("main() preserves $mode output semantics and releases the stdout takeover", async ({ args, expected }) => {
		const agentDir = mkdtempSync(join(tmpdir(), "vinci-main-takeover-"));
		vi.stubEnv("VINCI_CODE", "1");
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("VINCI_PLAIN", undefined);
		vi.stubEnv("VINCI_SCREEN_READER", undefined);
		vi.stubEnv("NO_COLOR", undefined);
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		for (const stream of streams) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
		const written: string[] = [];
		const capture = (chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		};
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(capture);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(capture);
		const spiedStdoutWrite = process.stdout.write;
		let takenOverAtExit = false;
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			takenOverAtExit = isStdoutTakenOver();
			process.stdout.write("\x1b[31mheadless output\x1b[0m");
			throw new Error("exit fixture");
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			// The invalid session ID stops startup after headless stdout takeover.
			await expect(main([...args, "--no-color", "--session-id", "invalid session id"])).rejects.toThrow(
				"exit fixture",
			);
			expect(takenOverAtExit).toBe(true);
			expect(written.at(-1)).toBe(expected);
			expect(isStdoutTakenOver()).toBe(false);
			expect(process.stdout.write).toBe(spiedStdoutWrite);
			restoreStdout();
			expect(process.stdout.write).toBe(spiedStdoutWrite);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
			restoreStdout();
			exit.mockRestore();
			stdout.mockRestore();
			stderr.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it.each([
		{ mode: "text", args: ["-p"], filtered: true },
		{ mode: "json", args: ["--mode", "json"], filtered: false },
		{ mode: "rpc", args: ["--mode", "rpc"], filtered: false },
	])("main() installs the stream filter only for text output ($mode)", async ({ args, filtered }) => {
		const agentDir = mkdtempSync(join(tmpdir(), "vinci-main-filter-"));
		vi.stubEnv("VINCI_CODE", "1");
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			expect(process.stdout.write === originalStdoutWrite).toBe(!filtered);
			expect(process.stderr.write === originalStderrWrite).toBe(!filtered);
			throw new Error("exit fixture");
		});
		try {
			// --version exits before headless startup takes over stdout.
			await expect(main([...args, "--no-color", "--version"])).rejects.toThrow("exit fixture");
			expect(process.stdout.write).toBe(originalStdoutWrite);
			expect(process.stderr.write).toBe(originalStderrWrite);
		} finally {
			exit.mockRestore();
			stdout.mockRestore();
			stderr.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("carries split UTF-8 across empty writes and flushes pending bytes before text or on restore", () => {
		const out: string[] = [];
		const err: string[] = [];
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			out.push(String(chunk));
			return true;
		});
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			err.push(String(chunk));
			return true;
		});
		const restore = filterVinciOutput(true);
		const accented = Buffer.from("é");
		const emoji = Buffer.from("\u{1F680}");
		try {
			process.stdout.write(accented.subarray(0, 1));
			process.stderr.write(emoji.subarray(0, 2));
			process.stdout.write("");
			process.stdout.write(accented.subarray(1));
			process.stderr.write(emoji.subarray(2));
			process.stdout.write(new Uint8Array(accented.subarray(0, 1)));
			expect(out.join("")).toBe("é");
			expect(err.join("")).toBe("\u{1F680}");
			process.stdout.write("!", "utf-8");
			expect(out.join("")).toBe("é\uFFFD!");
			process.stdout.write(accented.subarray(0, 1));
			restore();
			expect(out.join("")).toBe("é\uFFFD!\uFFFD");
		} finally {
			restore();
			stdout.mockRestore();
			stderr.mockRestore();
		}
	});

	it("decodes a base64 string write and forwards its callback without an encoding", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const restore = filterVinciOutput(true);
		const done = vi.fn();
		try {
			process.stdout.write("w6k=", "base64", done);
			expect(stdout).toHaveBeenCalledExactlyOnceWith("é", undefined, done);
		} finally {
			restore();
			stdout.mockRestore();
		}
	});

	it.each([
		["rich", false, "X\x1b[22m"],
		["plain", true, "X"],
	] as const)("%s filter carries an SGR split across writes", (_name, plain, expected) => {
		const written: string[] = [];
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		});
		const restore = filterVinciOutput(plain);
		try {
			process.stdout.write("\x1b[3");
			process.stdout.write("1mX\x1b[");
			process.stdout.write("22m");
			restore();
			const output = written.join("");
			expect(output).toBe(expected);
			expect(output).not.toMatch(/\x1b\[[0-9;:]*(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])m/);
			expect(output).not.toContain("1m");
		} finally {
			restore();
			stdout.mockRestore();
		}
	});

	it("flushes a held partial escape on restore and keeps the stream callback", () => {
		const written: string[] = [];
		const stdout = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown) => {
				written.push(String(chunk));
				const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
				if (typeof done === "function") done();
				return true;
			});
		const restore = filterVinciOutput(false);
		const done = vi.fn();
		try {
			process.stdout.write("A\x1b]8;;https://example.invalid", done);
			expect(done).toHaveBeenCalledOnce();
			expect(written.join("")).toBe("A");
			restore();
			expect(written.join("")).toBe("A\x1b]8;;https://example.invalid");
		} finally {
			restore();
			stdout.mockRestore();
		}
	});

	it("flushes a held partial escape from the exit hook and removes the hook on restore", () => {
		const written: string[] = [];
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		});
		// The hook is called directly: emitting "exit" would also run the test runner's own exit handlers.
		const before = new Set(process.listeners("exit"));
		const restore = filterVinciOutput(false);
		const added = process.listeners("exit").filter((listener) => !before.has(listener));
		try {
			expect(added).toHaveLength(1);
			process.stdout.write("A\x1b]8;;https://example.invalid");
			expect(written.join("")).toBe("A");
			(added[0] as () => void)();
			expect(written.join("")).toBe("A\x1b]8;;https://example.invalid");
			restore();
			expect(written.join("")).toBe("A\x1b]8;;https://example.invalid");
			expect(process.listeners("exit")).not.toContain(added[0]);
		} finally {
			restore();
			stdout.mockRestore();
		}
	});

	it.each([
		["held at the 4096-char cap", 4096, false],
		["written at once past the cap", 4097, true],
	] as const)("unfinished escape %s", (_name, heldLength, writtenAtOnce) => {
		const written: string[] = [];
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		});
		const restore = filterVinciOutput(false);
		const sequence = `\x1b]8;;${"x".repeat(heldLength - 5)}`;
		try {
			expect(sequence).toHaveLength(heldLength);
			process.stdout.write(`A${sequence}`);
			const beforeRestore = written.join("");
			expect(beforeRestore).toBe(writtenAtOnce ? `A${sequence}` : "A");
			restore();
			expect(written.join("")).toBe(`A${sequence}`);
		} finally {
			restore();
			stdout.mockRestore();
		}
	});

	it.each([
		["xterm", "en_US.UTF-8", undefined, false],
		["linux", "en_US.UTF-8", undefined, true],
		["xterm", "C", undefined, true],
		["xterm", "en_US.UTF-8", "1", true],
	])("chooses ASCII for TERM=%s, LC_ALL=%s, VINCI_ASCII=%s when required", (term, locale, flag, expected) => {
		vi.stubEnv("TERM", term);
		vi.stubEnv("LC_ALL", locale);
		vi.stubEnv("VINCI_ASCII", flag);
		vi.stubEnv("VINCI_PLAIN", undefined);
		vi.stubEnv("VINCI_SCREEN_READER", undefined);
		expect(vinciAscii()).toBe(expected);
	});

	it.each([
		["", false],
		[" 0 ", false],
		["FALSE", false],
		["No", false],
		["Off", false],
		["true", true],
		[" GitHub ", true],
	])("interprets CI=%j for motion with a PTY", (value, reduced) => {
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("VINCI_PLAIN", undefined);
		vi.stubEnv("VINCI_SCREEN_READER", undefined);
		vi.stubEnv("VINCI_REDUCED_MOTION", undefined);
		vi.stubEnv("NO_COLOR", undefined);
		vi.stubEnv("CI", value);
		for (const stream of streams) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
		expect(vinciReducedMotion()).toBe(reduced);
	});

	it("disables motion for either non-TTY stream and the explicit reduced-motion switch", () => {
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("VINCI_PLAIN", undefined);
		vi.stubEnv("VINCI_SCREEN_READER", undefined);
		vi.stubEnv("VINCI_REDUCED_MOTION", undefined);
		vi.stubEnv("CI", "");
		for (const [stdin, stdout] of [
			[false, true],
			[true, false],
			[true, true],
		]) {
			Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
			expect(vinciReducedMotion()).toBe(!stdin || !stdout);
		}
		vi.stubEnv("VINCI_REDUCED_MOTION", "1");
		expect(vinciReducedMotion()).toBe(true);
	});

	it("keeps Vinci loaders static only under the motion gate", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const identity = (text: string) => text;
		const interval = vi.spyOn(globalThis, "setInterval");
		try {
			vi.stubEnv("TERM", "xterm-256color");
			vi.stubEnv("VINCI_PLAIN", undefined);
			vi.stubEnv("VINCI_SCREEN_READER", undefined);
			vi.stubEnv("VINCI_REDUCED_MOTION", undefined);
			vi.stubEnv("CI", "");
			for (const stream of streams) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
			vi.stubEnv("VINCI_CODE", undefined);
			const upstream = new Loader(tui, identity, identity, "Loading");
			expect(interval).toHaveBeenCalledOnce();
			upstream.stop();
			interval.mockClear();

			// Motion allowed: a Vinci session leaves a caller-supplied indicator untouched.
			vi.stubEnv("VINCI_CODE", "1");
			const moving = new Loader(tui, identity, identity, "Working", { frames: ["a", "b"], intervalMs: 50 });
			expect(moving.render(80).join("\n")).toContain("a Working");
			expect(interval).toHaveBeenCalledOnce();
			moving.stop();
			interval.mockClear();

			// Motion gated: the reduced-motion switch empties every frame set, message kept.
			vi.stubEnv("VINCI_REDUCED_MOTION", "1");
			const loader = new Loader(tui, identity, identity, "Loading");
			expect(loader.render(80).join("\n")).toContain("Loading");
			expect(interval).not.toHaveBeenCalled();
			loader.stop();
			const custom = new Loader(tui, identity, identity, "Working", { frames: ["a", "b"], intervalMs: 50 });
			expect(custom.render(80).join("\n")).not.toMatch(/\b[ab] Working/);
			expect(interval).not.toHaveBeenCalled();
			custom.stop();
		} finally {
			interval.mockRestore();
		}
	});

	it.each([
		["motion allowed", {}, [true, true], true],
		["VINCI_REDUCED_MOTION=1", { VINCI_REDUCED_MOTION: "1" }, [true, true], false],
		["TERM=dumb", { TERM: "dumb" }, [true, true], false],
		["VINCI_PLAIN=1", { VINCI_PLAIN: "1" }, [true, true], false],
		["VINCI_SCREEN_READER=1", { VINCI_SCREEN_READER: "1" }, [true, true], false],
		["non-TTY stdout", {}, [true, false], false],
		["non-TTY stdin", {}, [false, true], false],
		["CI=true", { CI: "true" }, [true, true], false],
		["CI= GitHub ", { CI: " GitHub " }, [true, true], false],
		["CI= Off ", { CI: " Off " }, [true, true], true],
		["CI=0", { CI: "0" }, [true, true], true],
		["VINCI_REDUCED_MOTION=0", { VINCI_REDUCED_MOTION: "0" }, [true, true], true],
	] as const)("Vinci loader motion matches the section 3 gate for %s", (_name, env, [stdin, stdout], moves) => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const identity = (text: string) => text;
		const interval = vi.spyOn(globalThis, "setInterval");
		try {
			vi.stubEnv("VINCI_CODE", "1");
			vi.stubEnv("TERM", "xterm-256color");
			vi.stubEnv("VINCI_PLAIN", undefined);
			vi.stubEnv("VINCI_SCREEN_READER", undefined);
			vi.stubEnv("VINCI_REDUCED_MOTION", undefined);
			vi.stubEnv("CI", "");
			for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
			Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
			const loader = new Loader(tui, identity, identity, "Working", { frames: ["a", "b"], intervalMs: 50 });
			const animated = interval.mock.calls.length > 0;
			loader.stop();
			expect(animated).toBe(moves);
			expect(vinciReducedMotion()).toBe(!moves);
		} finally {
			interval.mockRestore();
		}
	});
});

describe("launcher exit bookend colours", () => {
	const temp = mkdtempSync(join(tmpdir(), "vinci-bookend-"));
	const launcherDir = join(temp, "root", "vinci", "bin");
	const launcher = join(launcherDir, "vinci");
	mkdirSync(launcherDir, { recursive: true });
	copyFileSync(fileURLToPath(new URL("../../../vinci/bin/vinci", import.meta.url)), launcher);
	const bin = join(temp, "bin");
	mkdirSync(bin);
	mkdirSync(join(temp, "home"));
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(bin, "pi"), 0o755);
	const base = {
		PATH: `${bin}:/usr/bin:/bin`,
		HOME: join(temp, "home"),
		TMPDIR: tmpdir(),
		LANG: "en_US.UTF-8",
		VINCI_INTERNAL_PROVIDER_TEST: "1",
		VINCI_INTERNAL_ASSUME_TTY: "1",
		VINCI_PROVIDER: "faux",
		VINCI_MODEL: "faux-1",
		VINCI_NO_BOOTSTRAP_HEAL: "1",
	};
	const bookend = (text: string, muted: string) => {
		const paint = (sgr: string, text: string) => (sgr ? `${sgr}${text}\x1b[39m` : text);
		return `\n  ${paint(text, "\x1b[1mVinci Code\x1b[22m")} · ${paint(muted, "Made, not generated.")}\n\n`;
	};
	const terminals: Record<string, string>[] = [
		{ TERM: "xterm-256color", FORCE_COLOR: "3" },
		{ TERM: "xterm", COLORTERM: "24bit" },
		{ TERM: "xterm", COLORTERM: "TrueColor" },
		{ TERM: "tmux-256color", TERM_PROGRAM: "iTerm.app" },
		{ TERM: "xterm-256color", TMUX: "/tmp/tmux-1/default", ITERM_SESSION_ID: "w0" },
		{ TERM: "xterm-256color", TMUX: "/tmp/tmux-1/default", COLORTERM: "truecolor" },
		{ TERM: "screen", TERM_PROGRAM: "vscode" },
		{ TERM: "screen-256color", COLORTERM: "truecolor" },
		{ TERM: "xterm", KITTY_WINDOW_ID: "1" },
		{ TERM: "xterm", KITTY_WINDOW_ID: "" },
		{ TERM: "xterm", TERM_PROGRAM: "kitty" },
		{ TERM: "xterm-ghostty" },
		{ TERM: "xterm", TERM_PROGRAM: "ghostty" },
		{ TERM: "xterm", GHOSTTY_RESOURCES_DIR: "/opt/ghostty" },
		{ TERM: "xterm", WEZTERM_PANE: "0" },
		{ TERM: "xterm", TERM_PROGRAM: "WezTerm" },
		{ TERM: "xterm", TERM_PROGRAM: "WarpTerminal" },
		{ TERM: "xterm", WARP_SESSION_ID: "1" },
		{ TERM: "xterm", WARP_TERMINAL_SESSION_UUID: "u" },
		{ TERM: "xterm", ITERM_SESSION_ID: "w0" },
		{ TERM: "xterm", WT_SESSION: "1" },
		{ TERM: "xterm", TERM_PROGRAM: "vscode" },
		{ TERM: "xterm", TERM_PROGRAM: "Alacritty" },
		{ TERM: "xterm", TERMINAL_EMULATOR: "JetBrains-JediTerm" },
		{ TERM: "XTERM-256COLOR" },
		{ TERM: "xterm", FORCE_COLOR: "2" },
		{ TERM: "xterm", FORCE_COLOR: "1" },
		{ TERM: "xterm" },
		{ TERM: "xterm-256color", FORCE_COLOR: "3", NO_COLOR: "" },
		{ TERM: "xterm", NO_COLOR: "1" },
	];
	const backgrounds = [
		"",
		"0",
		"7",
		"8",
		"15",
		"15;0",
		"0;15",
		"12;7;0",
		"15;300",
		" 15 ",
		"0;15x",
		"0;-0",
		"7;+15",
		"0;0015",
		"15;99999999999999999999",
		"15;",
		"default;default",
		"0;16",
		"0;57",
		"0;58",
		"0;231",
		"0;232",
		"0;243",
		"0;244",
		"0;255",
	];
	const cases: Record<string, string>[] = [
		...terminals.map((terminal) => ({ ...terminal })),
		...backgrounds.flatMap((COLORFGBG): Record<string, string>[] => [
			{ TERM: "xterm-256color", FORCE_COLOR: "3", COLORFGBG },
			{ TERM: "xterm-256color", COLORFGBG },
			{ TERM: "xterm", COLORFGBG },
		]),
	];

	// The look's own colour decision for this environment (capabilities detected fresh, no tmux probe).
	const lookColorFor = (env: Record<string, string>) => {
		const saved = process.env;
		try {
			process.env = { ...env };
			return vinciLookColor(() => detectCapabilities(() => false).trueColor);
		} finally {
			process.env = saved;
		}
	};

	afterAll(() => rmSync(temp, { recursive: true, force: true }));

	it.each(cases)("matches the look table and colour path for %o", (terminal) => {
		const env: Record<string, string> = { ...base, ...terminal };
		const result = spawnSync("bash", [launcher, "hello"], { env, encoding: "utf8", timeout: 20_000 });
		expect(result.status).toBe(0);
		const color = lookColorFor(env);
		const theme = detectTerminalBackgroundFromEnv({ env }).theme;
		const expected = bookend(vinciLookSgr(theme, color, "text"), vinciLookSgr(theme, color, "muted"));
		expect(result.stdout).toBe(`\x1b[H\x1b[2J${expected}`);
		expect(result.stdout).not.toContain("\x1b[2m");
	});

	it("uses the spec r4 section 2 tokens, not the old literals", () => {
		expect(vinciLookSgr("dark", "truecolor", "accent")).toBe("\x1b[38;2;184;197;176m");
		expect(vinciLookSgr("dark", "truecolor", "dim")).toBe("\x1b[38;2;138;138;130m");
		expect(vinciLookSgr("light", "truecolor", "dim")).toBe("\x1b[38;2;114;112;106m");
		expect(vinciLookSgr("dark", "256", "accent")).toBe("\x1b[38;5;151m");
		expect(vinciLookSgr("dark", "256", "dim")).toBe("\x1b[38;5;102m");
		expect(vinciLookSgr("light", "256", "accent")).toBe("\x1b[38;5;22m");
		expect(vinciLookSgr("light", "256", "dim")).toBe("\x1b[38;5;242m");
		expect(vinciLookSgr("dark", "16", "accent")).toBe("\x1b[32m");
		expect(vinciLookSgr("dark", "16", "dim")).toBe("");
		expect(vinciLookSgr("dark", "none", "accent")).toBe("");
		// Positive control: the theme detector and capability probe really vary across the matrix.
		const themes = new Set(cases.map((terminal) => detectTerminalBackgroundFromEnv({ env: terminal }).theme));
		expect([...themes].sort()).toEqual(["dark", "light"]);
		const colors = new Set(cases.map((terminal) => lookColorFor({ ...base, ...terminal })));
		expect([...colors].sort()).toEqual(["16", "256", "none", "truecolor"]);
	});
});
