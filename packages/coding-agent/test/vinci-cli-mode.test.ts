import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("./fixtures/vinci-mode-faux-provider.ts", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], input = "", tty = false) {
	const home = mkdtempSync(join(tmpdir(), "vinci-cli-mode-"));
	tempDirs.push(home);
	const cwd = join(home, "project");
	mkdirSync(cwd);
	const events = join(home, "events");
	const cliArgs = [
		cli,
		"--offline",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-tools",
		"--extension",
		extension,
		"--provider",
		"faux",
		"--model",
		"faux-1",
		...args,
	];
	const command = [process.execPath, ...cliArgs].map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
	const result = spawnSync(
		tty ? "script" : process.execPath,
		tty ? ["--quiet", "--return", "--command", command, "/dev/null"] : cliArgs,
		{
			cwd,
			// An allowlist keeps the test independent of real provider credentials and user settings.
			env: {
				PATH: process.env.PATH,
				HOME: home,
				[ENV_AGENT_DIR]: join(home, "agent"),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				VINCI_CODE: "1",
				VINCI_MODE_TEST_EVENTS: events,
				NO_COLOR: "1",
			},
			input,
			encoding: "utf8",
			timeout: 15_000,
		},
	);
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	return { ...result, events: existsSync(events) ? readFileSync(events, "utf8") : "" };
}

describe("Vinci executable --mode contract (requires the offline build)", () => {
	test.each([
		["invalid with prompt", ["--mode", "wrong", "-p", "hello"]],
		["invalid without prompt", ["--mode", "wrong"]],
		["empty", ["--mode", "", "-p", "hello"]],
		["missing", ["--mode"]],
		["followed by a flag", ["--mode", "--print", "hello"]],
		["invalid before a valid mode", ["--mode", "wrong", "--mode", "json", "-p", "hello"]],
	] as const)("rejects %s before loading extensions or invoking a provider", (_name, args) => {
		const result = run([...args]);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/Error: .*--mode.*text, json, rpc/);
		expect(result.stdout).toBe("");
		expect(result.events).toBe("");
	});

	test.each([["wrong"], [""], []])("rejects mode value %j with a piped prompt", (...value) => {
		const result = run(["--mode", ...value], "hello\n");
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/Error: .*--mode.*text, json, rpc/);
		expect(result.stdout).toBe("");
		expect(result.events).toBe("");
	});

	test.skipIf(process.platform !== "linux").each([["wrong"], [""], []])(
		"rejects mode value %j in a real TTY",
		(...value) => {
			const result = run(["--mode", ...value], "", true);
			expect(result.status).toBe(1);
			expect(result.stdout).toMatch(/Error: .*--mode.*text, json, rpc/);
			expect(result.events).toBe("");
		},
	);

	test.each(["text", "json"])("preserves valid %s output with the faux provider", (mode) => {
		const result = run(["--mode", mode, "-p", "hello"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("MODE_OK");
		expect(result.events).toBe("extension\nprovider\n");
		if (mode === "json") {
			const events = result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(events.some((event) => event.type === "message_end")).toBe(true);
		} else {
			expect(result.stdout.trim()).toBe("MODE_OK");
		}
	});

	test("preserves the RPC state-query contract without inference", () => {
		const result = run(["--mode", "rpc"], '{"id":"mode-test","type":"get_state"}\n');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"command":"get_state","success":true');
		expect(result.events).toBe("extension\n");
	});
});
