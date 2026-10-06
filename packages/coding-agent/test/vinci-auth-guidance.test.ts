import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR, getDocsPath } from "../src/config.ts";
import type * as AuthGuidance from "../src/core/auth-guidance.ts";

const managedMessage =
	"You're not connected to Vinci yet. Type /login and authorize in your browser — it takes a few seconds, no key to paste.";
const providers = [
	{ id: "anthropic", name: "Anthropic", method: "Use an API key", env: "ANTHROPIC_API_KEY" },
	{ id: "openai", name: "OpenAI", method: "Use an API key", env: "OPENAI_API_KEY" },
	{ id: "openai-codex", name: "ChatGPT Plus/Pro (Codex Subscription)", method: "Use a subscription" },
] as const;
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("./fixtures/vinci-auth-faux-provider.ts", import.meta.url));
const noNetwork = fileURLToPath(new URL("./fixtures/vinci-auth-no-network.cjs", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function loadGuidance(vinci: string | undefined) {
	vi.stubEnv("VINCI_CODE", vinci);
	// VINCI_CODE is read at module load. Isolate that load without changing production semantics.
	return createJiti(import.meta.url, { moduleCache: false, tryNative: false }).import<typeof AuthGuidance>(
		fileURLToPath(new URL("../src/core/auth-guidance.ts", import.meta.url)),
	);
}

describe("Vinci selected-provider auth guidance", () => {
	test.each(providers)("offers the supported $id route", async (provider) => {
		const guidance = await loadGuidance("1");
		const message = guidance.formatNoApiKeyFoundMessage(provider.id);
		expect(message).toContain(provider.name);
		expect(message).toContain(provider.method);
		expect(message).toContain("/login");
		if ("env" in provider) expect(message).toContain(provider.env);
		else expect(message).not.toContain("API key");
		expect(message).not.toContain("not connected to Vinci");
		expect(message).not.toContain("no key to paste");
		expect(message).not.toContain(`/login ${provider.id}`);
	});

	test("preserves managed and no-selection copy", async () => {
		const guidance = await loadGuidance("1");
		expect(guidance.formatNoApiKeyFoundMessage("vinci")).toBe(managedMessage);
		expect(guidance.getProviderLoginHelp()).toBe(managedMessage);
		expect(guidance.formatNoModelsAvailableMessage()).toBe(managedMessage);
		expect(guidance.formatNoModelSelectedMessage()).toBe(managedMessage);
	});

	test.each(["custom-provider", "unknown", ""])("does not invent authentication for %j", async (provider) => {
		const guidance = await loadGuidance("1");
		const message = guidance.formatNoApiKeyFoundMessage(provider);
		expect(message).toContain("selected provider");
		expect(message).toContain("setup instructions");
		expect(message).not.toMatch(/Vinci|API key|subscription|browser|\/login/);
	});

	test.each([undefined, "0"])("preserves plain Pi copy with VINCI_CODE=%j", async (vinci) => {
		const guidance = await loadGuidance(vinci);
		const help = [
			"Use /login to log into a provider via OAuth or API key. See:",
			`  ${join(getDocsPath(), "providers.md")}`,
			`  ${join(getDocsPath(), "models.md")}`,
		].join("\n");
		expect(guidance.getProviderLoginHelp()).toBe(help);
		expect(guidance.formatNoModelsAvailableMessage()).toBe(`No models available. ${help}`);
		expect(guidance.formatNoModelSelectedMessage()).toBe(
			`No model selected.\n\n${help}\n\nThen use /model to select a model.`,
		);
		for (const provider of ["vinci", "anthropic", "openai", "openai-codex", "custom-provider", "unknown"]) {
			const display = provider === "unknown" ? "the selected model" : provider;
			expect(guidance.formatNoApiKeyFoundMessage(provider)).toBe(`No API key found for ${display}.\n\n${help}`);
		}
	});
});

function run(provider: string, mode: string, configured = false, builtinModel?: string) {
	const home = mkdtempSync(join(tmpdir(), "vinci-auth-guidance-"));
	tempDirs.push(home);
	const cwd = join(home, "project");
	mkdirSync(cwd);
	const events = join(home, "events");
	const result = spawnSync(
		process.execPath,
		[
			"--require",
			noNetwork,
			cli,
			"--offline",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-tools",
			...(builtinModel ? [] : ["--extension", extension]),
			"--provider",
			provider,
			"--model",
			builtinModel ?? "faux-1",
			"--mode",
			mode,
			"-p",
			"Hello",
		],
		{
			cwd,
			// No inherited credential, proxy, NODE_OPTIONS, or user configuration can enter this process.
			env: {
				PATH: process.env.PATH,
				HOME: home,
				[ENV_AGENT_DIR]: join(home, "agent"),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				VINCI_CODE: "1",
				VINCI_AUTH_TEST_EVENTS: events,
				VINCI_AUTH_TEST_PROVIDER: provider,
				VINCI_AUTH_TEST_CONFIGURED: configured ? "1" : "0",
				NO_COLOR: "1",
			},
			input: "",
			encoding: "utf8",
			timeout: 15_000,
		},
	);
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	return { ...result, events: existsSync(events) ? readFileSync(events, "utf8") : "" };
}

describe("Vinci missing-auth executable contract (requires the offline build)", () => {
	for (const mode of ["text", "json"]) {
		test.each([...providers, { id: "vinci", name: "Vinci" }, { id: "custom-provider", name: "selected provider" }])(
			`rejects missing $id credentials before inference in ${mode} mode`,
			(provider) => {
				const result = run(provider.id, mode);
				expect(result.status).toBe(1);
				expect(result.stderr).toContain(provider.name);
				if (provider.id !== "vinci") expect(result.stderr).not.toContain("not connected to Vinci");
				expect(result.events).toBe("extension\n");
				expect(result.stdout).not.toContain('"role":"assistant"');
			},
		);
	}

	test.each([
		{ id: "anthropic", model: "claude-haiku-4-5", expected: "ANTHROPIC_API_KEY" },
		{ id: "openai", model: "gpt-5.5", expected: "OPENAI_API_KEY" },
		{ id: "openai-codex", model: "gpt-5.5", expected: "Use a subscription" },
	])("rejects built-in $id selection without a credential or request", (provider) => {
		const result = run(provider.id, "text", false, provider.model);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(provider.expected);
		expect(result.events).toBe("");
	});

	test("proves the faux-provider execution marker works without network access", () => {
		const result = run("custom-provider", "text", true);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("AUTH_FIXTURE_OK");
		expect(result.events).toBe("extension\nprovider\n");
	});
});
