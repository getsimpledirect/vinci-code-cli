import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_AGENT_DIR } from "../../../packages/coding-agent/src/config.ts";
import { AgentSessionRuntime } from "../../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import {
	createHarnessWithExtensions,
	fauxModel,
} from "../../../packages/coding-agent/test/test-harness.ts";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import vinciCharacter from "../../extensions/vinci-character.ts";
import vinciHeader from "../../extensions/vinci-header.ts";
import vinciPlan from "../../extensions/vinci-plan.ts";
import vinciProvider from "../../extensions/vinci-provider.ts";
import vinciReceipt from "../../extensions/vinci-receipt.ts";
import vinciRender from "../../extensions/vinci-render.ts";
import vinciShell from "../../extensions/vinci-shell.ts";
import vinciVerification from "../../extensions/vinci-verification.ts";

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(UI_DIR, "../../..");
const SNAPSHOT_DIR = join(UI_DIR, "snapshots");
const DEFAULT_TIMEOUT_MS = 2_000;

function normalizeScreen(lines, tempDir) {
	const repoRelativeTempDir = relative(REPO_ROOT, tempDir);
	const normalized = lines.map((line) =>
		line
			.replaceAll(tempDir, "<workspace>")
			.replaceAll(repoRelativeTempDir, "<workspace>")
			.replaceAll(REPO_ROOT, "<repo>")
			.replace(/\/\S*\/pi-[^\s]*/g, "<workspace>")
			.replace(/\bpi-harness-[\w.-]+/g, "<workspace>")
			.replace(/^(\s*Vinci(?: Forte| Fortissimo)?\s+·\s+).+$/, "$1<repo>")
			.replace(/\b\d+(?:\.\d+)?s\b/g, "<time>")
			.replace(/(^|\s)[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?= Working\.\.\.)/g, "$1•")
			.replace(
				/(^|\s)[·•●](?=\s+(?:Contemplating|Considering|Looking|Making|Checking|Reviewing|Organizing|Coordinating|Adjusting|Running|Updating|Working))/g,
				"$1•",
			)
			.replace(/[ \t]+$/g, ""),
	);

	while (normalized.length > 0 && normalized[0] === "") normalized.shift();
	while (normalized.length > 0 && normalized[normalized.length - 1] === "") normalized.pop();
	return normalized.join("\n");
}

async function withTimeout(promise, description, timeoutMs = DEFAULT_TIMEOUT_MS) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export class VinciUiHarness {
	constructor(core, mode, terminal, previousAgentDir) {
		this.core = core;
		this.mode = mode;
		this.terminal = terminal;
		this.previousAgentDir = previousAgentDir;
	}

	get session() {
		return this.core.session;
	}

	sendKeys(...keys) {
		for (const key of keys) this.terminal.sendInput(key);
	}

	async settle() {
		await Promise.resolve();
		await this.terminal.waitForRender();
	}

	async screen() {
		await this.settle();
		return normalizeScreen(this.terminal.getViewport(), this.core.tempDir);
	}

	async waitForText(text, timeoutMs = DEFAULT_TIMEOUT_MS) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const screen = await this.screen();
			if (screen.includes(text)) return screen;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		}
		throw new Error(`Timed out waiting for screen text: ${text}\n\n${await this.screen()}`);
	}

	async startPrompt(text) {
		const input = this.mode.getUserInput();
		this.sendKeys(text, "\r");
		const submitted = await withTimeout(input, `submission of ${JSON.stringify(text)}`);
		return { completion: this.session.prompt(submitted) };
	}

	async prompt(text) {
		const { completion } = await this.startPrompt(text);
		await withTimeout(completion, `completion of ${JSON.stringify(text)}`);
		await this.settle();
	}

	async resize(columns, rows) {
		this.terminal.resize(columns, rows);
		await this.settle();
	}

	async close() {
		try {
			this.mode.stop();
			this.core.cleanup();
			await this.terminal.flush();
		} finally {
			if (this.previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = this.previousAgentDir;
		}
	}
}

export async function createVinciUiHarness(options = {}) {
	const columns = options.columns ?? 80;
	const rows = options.rows ?? 24;
	const terminal = new VirtualTerminal(columns, rows);
	const extensions = [
		{ factory: vinciProvider, path: "vinci/extensions/vinci-provider.ts" },
		{ factory: vinciShell, path: "vinci/extensions/vinci-shell.ts" },
		{ factory: vinciVerification, path: "vinci/extensions/vinci-verification.ts" },
		{ factory: vinciPlan, path: "vinci/extensions/vinci-plan.ts" },
		{ factory: vinciCharacter, path: "vinci/extensions/vinci-character.ts" },
		{ factory: vinciHeader, path: "vinci/extensions/vinci-header.ts" },
		{ factory: vinciReceipt, path: "vinci/extensions/vinci-receipt.ts" },
		{ factory: vinciRender, path: "vinci/extensions/vinci-render.ts" },
		...(options.extensions ?? []),
	];
	const baseToolsOverride = options.tools
		? Object.fromEntries(options.tools.map((tool) => [tool.name, tool]))
		: undefined;
	const core = await createHarnessWithExtensions({
		model: {
			...fauxModel,
			// Mirrors the shipped default: the account-resolved sentinel, labelled by class only.
			id: "auto",
			name: "Vinci",
			contextWindow: 900_000,
			maxTokens: 32_768,
		},
		responses: options.responses,
		settings: {
			theme: "dark",
			quietStartup: false,
			doubleEscapeAction: "none",
			retry: { enabled: false },
			terminal: { showImages: false, showTerminalProgress: false },
		},
		tools: options.tools,
		baseToolsOverride,
		extensionFactories: extensions,
	});

	// ENV_AGENT_DIR from the core config, never a literal: this override is what keeps the scenarios
	// off the developer's real ~/.pi/agent (reading their auth.json, creating the hint marker there).
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = core.tempDir;
	// Pre-claim the one-time thinking hint so every scenario renders the steady-state UI the
	// reviewed snapshots capture (a fresh agent dir would otherwise fire the hint on each boot).
	writeFileSync(join(core.tempDir, ".vinci-thinking-hint-v1"), "");
	writeFileSync(
		join(core.tempDir, "auth.json"),
		JSON.stringify(options.connected ? { vinci: { type: "api_key", key: "test" } } : {}),
	);
	if (options.connected) core.authStorage.setRuntimeApiKey("vinci", "test");

	const services = {
		cwd: core.tempDir,
		agentDir: core.tempDir,
		authStorage: core.authStorage,
		settingsManager: core.settingsManager,
		modelRegistry: core.modelRegistry,
		resourceLoader: core.resourceLoader,
		diagnostics: [],
	};
	const runtime = new AgentSessionRuntime(core.session, services, async () => {
		throw new Error("Session replacement is not supported by the UI scenario harness");
	});
	const mode = new InteractiveMode(runtime, { terminal, verbose: true, manageProcessSignals: false });

	try {
		await mode.init();
		await terminal.waitForRender();
	} catch (error) {
		mode.stop();
		core.cleanup();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		throw error;
	}

	return new VinciUiHarness(core, mode, terminal, previousAgentDir);
}

export async function expectSnapshot(name, ui) {
	const actual = `${await ui.screen()}\n`;
	const snapshotPath = join(SNAPSHOT_DIR, `${name}.txt`);
	if (process.env.PRINT_VINCI_UI_SNAPSHOTS === "1") {
		process.stdout.write(`\n--- ${name} ---\n${actual}`);
		return;
	}
	if (process.env.UPDATE_VINCI_UI_SNAPSHOTS === "1") {
		writeFileSync(snapshotPath, actual);
		return;
	}
	assert.ok(existsSync(snapshotPath), `Missing snapshot ${snapshotPath}`);
	assert.equal(actual, readFileSync(snapshotPath, "utf8"), `Snapshot changed: ${name}`);
}
