import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const preload = new URL("./fullscreen-main-preload.ts", import.meta.url).href;
const faux = fileURLToPath(new URL("./fixtures/vinci-mode-faux-provider.ts", import.meta.url));
const enter = "\x1b[?1049h";
const tempRoot = process.env.TMPDIR ?? tmpdir();
vi.setConfig({ testTimeout: 20_000 });

// Equivalent to the lifecycle suite's childEnv, with explicit startup/multiplexer scrubbing.
function childEnv(caseDir: string, vinciCode: string | undefined): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("PI_") || key.startsWith("XDG_")) delete env[key];
	}
	for (const key of ["VINCI_COPY_ON_SELECT", "VINCI_CODE", "TMUX", "ZELLIJ", "STY"]) delete env[key];
	Object.assign(env, {
		HOME: caseDir,
		XDG_CONFIG_HOME: join(caseDir, "config"),
		XDG_DATA_HOME: join(caseDir, "data"),
		XDG_STATE_HOME: join(caseDir, "state"),
		XDG_CACHE_HOME: join(caseDir, "cache"),
		XDG_RUNTIME_DIR: join(caseDir, "runtime"),
		[ENV_AGENT_DIR]: join(caseDir, "agent"),
		TMPDIR: caseDir,
		TERM: "xterm-256color",
		GIT_CEILING_DIRECTORIES: caseDir,
		PI_STARTUP_BENCHMARK: "1",
		VINCI_TOOL_BOOTSTRAP: "0",
		VINCI_MODE_TEST_EVENTS: join(caseDir, "events"),
	});
	if (vinciCode !== undefined) env.VINCI_CODE = vinciCode;
	return env;
}

async function runCli(
	args: string[],
	settings: Record<string, unknown> = {},
	identity: { vinciCode: string | undefined } = { vinciCode: "1" },
	copyOnSelectEnv?: string,
): Promise<{ code: number; stdout: string; stderr: string; events: string }> {
	const caseDir = mkdtempSync(join(tempRoot, "fullscreen-cli-handoff-"));
	try {
		const agentDir = join(caseDir, "agent");
		mkdirSync(agentDir);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ quietStartup: true, theme: "dark", enableInstallTelemetry: false, ...settings }),
		);
		const env = childEnv(caseDir, identity.vinciCode);
		if (copyOnSelectEnv !== undefined) env.VINCI_COPY_ON_SELECT = copyOnSelectEnv;
		return await new Promise((resolve, reject) => {
			execFile(
				process.execPath,
				[
					"--experimental-strip-types",
					"--import",
					preload,
					cli,
					"--offline",
					"--no-session",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-context-files",
					"--extension",
					faux,
					"--provider",
					"faux",
					"--model",
					"faux-1",
					...args,
				],
				{ cwd: caseDir, env, maxBuffer: 2_000_000 },
				(error, stdout, stderr) => {
					if (error && typeof error.code !== "number") return reject(error);
					const eventsPath = join(caseDir, "events");
					resolve({
						code: typeof error?.code === "number" ? error.code : 0,
						stdout,
						stderr,
						events: existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "",
					});
				},
			);
		});
	} finally {
		rmSync(caseDir, { recursive: true, force: true });
	}
}

test("CLI child isolation includes HOME, XDG, cwd and explicitly scrubbed environment", async () => {
	const caseDir = mkdtempSync(join(tempRoot, "fullscreen-cli-isolation-"));
	try {
		const env = childEnv(caseDir, undefined);
		delete env.PI_STARTUP_BENCHMARK;
		delete env[ENV_AGENT_DIR];
		const output = await new Promise<string>((resolve, reject) => {
			execFile(
				process.execPath,
				[
					"-e",
					'process.stdout.write(JSON.stringify({cwd:process.cwd(),home:require("node:os").homedir(),env:process.env}))',
				],
				{ cwd: caseDir, env },
				(error, stdout) => (error ? reject(error) : resolve(stdout)),
			);
		});
		const reported = JSON.parse(output) as { cwd: string; home: string; env: NodeJS.ProcessEnv };
		expect(reported.cwd).toBe(realpathSync(caseDir));
		for (const value of [
			reported.home,
			...Object.entries(reported.env)
				.filter(([key]) => key.startsWith("XDG_"))
				.map(([, value]) => value),
		]) {
			expect(value?.startsWith(caseDir), `isolated child path ${value}`).toBe(true);
		}
		for (const key of ["VINCI_CODE", "VINCI_COPY_ON_SELECT", "TMUX", "ZELLIJ", "STY"]) {
			expect(reported.env[key], `${key} is deleted before deliberate per-case overrides`).toBeUndefined();
		}
		expect(Object.keys(reported.env).filter((key) => key.startsWith("PI_"))).toEqual([]);
		expect(reported.env.TERM).toBe("xterm-256color");
	} finally {
		rmSync(caseDir, { recursive: true, force: true });
	}
});

test("source check: main forwards startup copy policy through the shared resolver", () => {
	const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
	expect(source).toContain(
		"copyOnSelect: resolveCopyOnSelect(tuiMode, settingsManager.getCopyOnSelect(), copyOnSelectEnv)",
	);
});

describe("real CLI hands mode to real InteractiveMode with the offline faux provider", () => {
	test.each([
		{ name: "absent stays regular", args: [], settings: {}, fullscreen: false },
		{ name: "flag enters fullscreen", args: ["--tui-mode", "fullscreen"], settings: {}, fullscreen: true },
		{
			name: "explicit regular overrides stored fullscreen",
			args: ["--tui-mode", "regular"],
			settings: { tuiMode: "fullscreen" },
			fullscreen: false,
		},
		{ name: "stored fullscreen enters", args: [], settings: { tuiMode: "fullscreen" }, fullscreen: true },
	])("$name", async ({ args, settings, fullscreen }) => {
		const result = await runCli(args, settings);
		expect(result.stdout.includes(enter), "real alternate-screen entry matches the effective CLI mode").toBe(
			fullscreen,
		);
		expect(result.code, result.stderr).toBe(0);
		expect(result.events, "real runtime loaded the faux-provider extension").toContain("extension\n");
		expect(result.stdout, "real InteractiveMode terminal startup occurred").toContain("\x1b[?2004h");
		if (!fullscreen) {
			for (const sequence of ["\x1b[?1000h", "\x1b[?1002h", "\x1b[?1003h", "\x1b[?1006h"]) {
				expect(result.stdout, "regular mode never enables fullscreen mouse").not.toContain(sequence);
			}
		}
		expect(result.stdout, "CLI children never exercise any clipboard route").not.toContain("\x1b]52;");
	});

	test.each([
		{ vinciCode: "1", env: "0", setting: true, enabled: false },
		{ vinciCode: undefined, env: "0", setting: true, enabled: true },
		{ vinciCode: "1", env: "1", setting: false, enabled: false },
		{ vinciCode: "1", env: "", setting: false, enabled: false },
		{ vinciCode: "1", env: "garbage", setting: false, enabled: false },
		{ vinciCode: "1", env: undefined, setting: true, enabled: true },
	])(
		"passes actual startup policy: VINCI_CODE=$vinciCode, env=$env, setting=$setting",
		async ({ vinciCode, env, setting, enabled }) => {
			const result = await runCli(["--tui-mode", "fullscreen"], { copyOnSelect: setting }, { vinciCode }, env);
			expect(result.code, result.stderr).toBe(0);
			expect(result.events, "startup identity is deliberately set or absent in the actual child").toContain(
				`identity:${vinciCode ?? "unset"}\n`,
			);
			expect(result.stdout, "policy observation reaches the real alternate-screen renderer").toContain(enter);
			expect(result.events, "main forwards the identity-gated policy to the actual renderer").toContain(
				`copyOnSelect:${enabled}\n`,
			);
			expect(result.stdout, "policy observation never exercises a clipboard route").not.toContain("\x1b]52;");
		},
	);

	test.each([
		{ name: "missing", args: ["--tui-mode"] },
		{ name: "invalid", args: ["--tui-mode", "bad"] },
		{ name: "following flag", args: ["--tui-mode", "--print"] },
		{ name: "following attachment", args: ["--tui-mode", "@absent.md"] },
	])("rejects $name before terminal or provider startup", async ({ args }) => {
		const result = await runCli(args);
		expect(result.stderr, "malformed mode is diagnosed before startup").toMatch(/--tui-mode.*regular.*fullscreen/);
		expect(result.code).toBe(1);
		expect(result.events, "malformed args never load a provider extension").toBe("");
		expect(result.stdout, "malformed args never start a terminal").not.toContain("\x1b[?2004h");
		expect(result.stdout).not.toContain(enter);
	});
});
