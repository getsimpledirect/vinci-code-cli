import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TuiMode } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs, printHelp } from "../src/cli/args.ts";
import { resolveCopyOnSelect, SettingsManager } from "../src/core/settings-manager.ts";

let caseDir: string;
const tempRoot = process.env.TMPDIR ?? dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
	caseDir = mkdtempSync(join(tempRoot, "fullscreen-controls-settings-"));
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PI_")) vi.stubEnv(key, undefined);
	}
	for (const key of ["VINCI_COPY_ON_SELECT", "TMUX", "ZELLIJ", "STY"]) vi.stubEnv(key, undefined);
	vi.stubEnv("VINCI_CODE", "1");
	vi.stubEnv("HOME", caseDir);
	for (const key of ["CONFIG", "DATA", "STATE", "CACHE"]) vi.stubEnv(`XDG_${key}_HOME`, join(caseDir, key));
	vi.stubEnv("TERM", "xterm-256color");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(caseDir, { recursive: true, force: true });
});

describe("fullscreen mode arguments", () => {
	test.each(["regular", "fullscreen"] as const)("accepts --tui-mode %s", (mode) => {
		const parsed = parseArgs(["--tui-mode", mode]);
		expect(parsed.tuiMode, "valid TUI mode is parsed").toBe(mode);
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.unknownFlags.size).toBe(0);
	});

	test("leaves absent mode undefined for settings resolution", () => {
		expect(parseArgs([]).tuiMode).toBeUndefined();
	});

	test.each([undefined, "bad", "Fullscreen", "", " "])("rejects malformed value %j", (value) => {
		const parsed = parseArgs(value === undefined ? ["--tui-mode"] : ["--tui-mode", value]);
		expect(parsed.tuiMode).toBeUndefined();
		expect(parsed.diagnostics, "malformed TUI mode has one startup error").toEqual([
			{ type: "error", message: expect.stringMatching(/--tui-mode.*regular.*fullscreen/) },
		]);
		expect(parsed.unknownFlags.size).toBe(0);
	});

	test.each(["--print", "-p"])("preserves following %s flag", (flag) => {
		const parsed = parseArgs(["--tui-mode", flag, "hello"]);
		expect(parsed.diagnostics, "missing mode must be rejected before startup").toHaveLength(1);
		expect(parsed.print).toBe(true);
		expect(parsed.messages).toEqual(["hello"]);
	});

	test("preserves following attachment", () => {
		const parsed = parseArgs(["--tui-mode", "@prompt.md"]);
		expect(parsed.diagnostics, "attachment is not a mode value").toHaveLength(1);
		expect(parsed.fileArgs).toEqual(["prompt.md"]);
	});

	test("cannot erase an earlier error with a later valid mode", () => {
		const parsed = parseArgs(["--tui-mode", "bad", "--tui-mode", "fullscreen"]);
		expect(parsed.diagnostics).toHaveLength(1);
		expect(parsed.tuiMode).toBe("fullscreen");
	});

	test.each(["1", undefined])("keeps the ported flag with VINCI_CODE=%j", (vinciCode) => {
		vi.stubEnv("VINCI_CODE", vinciCode);
		expect(parseArgs(["--tui-mode", "fullscreen"]).tuiMode).toBe("fullscreen");
	});
});

describe("fullscreen copy policy", () => {
	const modes: TuiMode[] = ["regular", "fullscreen"];
	const settings = [undefined, true, false] as const;
	const envs = [undefined, "0", "1", "", "garbage", "false", " 0 "] as const;
	for (const mode of modes) {
		for (const setting of settings) {
			for (const env of envs) {
				for (const order of ["env-first", "setting-first"] as const) {
					test(`${mode}, setting=${setting}, env=${JSON.stringify(env)}, ${order}`, () => {
						let settingValue: boolean | undefined;
						let envValue: string | undefined;
						const readEnv = () => {
							vi.stubEnv("VINCI_COPY_ON_SELECT", env);
							envValue = process.env.VINCI_COPY_ON_SELECT;
						};
						const readSetting = () => {
							settingValue = SettingsManager.inMemory({ copyOnSelect: setting }).getGlobalSettings()
								.copyOnSelect;
						};
						if (order === "env-first") {
							readEnv();
							readSetting();
						} else {
							readSetting();
							readEnv();
						}
						const enabled = mode === "fullscreen" && setting !== false && env !== "0";
						expect(resolveCopyOnSelect(mode, settingValue, envValue), "only exact env 0 overrides setting").toBe(
							enabled,
						);
					});
				}
			}
		}
	}
});

describe("fullscreen settings persistence", () => {
	test("defaults to regular with auto-copy enabled only in fullscreen", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.getTuiMode()).toBe("regular");
		expect(manager.getCopyOnSelect()).toBe(true);
		expect(resolveCopyOnSelect(manager.getTuiMode(), manager.getCopyOnSelect(), undefined)).toBe(false);
		expect(resolveCopyOnSelect("fullscreen", manager.getCopyOnSelect(), undefined)).toBe(true);
	});

	test("round-trips fullscreen and false through disk and reload", async () => {
		const agentDir = join(caseDir, "agent");
		const manager = SettingsManager.create(caseDir, agentDir);
		manager.setTuiMode("fullscreen");
		manager.setCopyOnSelect(false);
		await manager.flush();
		expect(manager.getTuiMode(), "mode setter updates effective settings").toBe("fullscreen");
		expect(manager.getCopyOnSelect(), "false must not default to true").toBe(false);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
			tuiMode: "fullscreen",
			copyOnSelect: false,
		});
		await manager.reload();
		const rebound = SettingsManager.create(caseDir, agentDir);
		for (const current of [manager, rebound]) {
			expect(current.getTuiMode()).toBe("fullscreen");
			expect(current.getCopyOnSelect()).toBe(false);
		}
	});

	test("project settings take precedence and refresh after disk changes", async () => {
		const agentDir = join(caseDir, "agent");
		mkdirSync(agentDir);
		mkdirSync(join(caseDir, ".pi"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "regular", copyOnSelect: true }));
		const projectPath = join(caseDir, ".pi", "settings.json");
		writeFileSync(projectPath, JSON.stringify({ tuiMode: "fullscreen", copyOnSelect: false }));
		const manager = SettingsManager.create(caseDir, agentDir);
		expect(manager.getTuiMode(), "project mode overrides global mode").toBe("fullscreen");
		expect(manager.getCopyOnSelect(), "project false overrides global true").toBe(false);
		writeFileSync(projectPath, JSON.stringify({ tuiMode: "regular", copyOnSelect: true }));
		await manager.reload();
		expect(manager.getTuiMode()).toBe("regular");
		expect(manager.getCopyOnSelect()).toBe(true);
	});

	test.each([undefined, "garbage", false])("invalid stored mode %j resolves regular", (tuiMode) => {
		const agentDir = join(caseDir, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode }));
		expect(SettingsManager.create(caseDir, agentDir).getTuiMode()).toBe("regular");
	});
});

test.each(["1", undefined])("fullscreen help disclosure follows Vinci identity %j", (vinciCode) => {
	vi.stubEnv("VINCI_CODE", vinciCode);
	const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
	printHelp();
	const help = log.mock.calls.map(([value]) => String(value)).join("\n");
	expect(help, "ported fullscreen option remains in help").toContain("--tui-mode <mode>");
	const disclosure =
		"Selecting text copies it to your clipboard. Use Shift+drag (Option+drag in iTerm2 and Terminal.app) to select without copying.";
	expect(help.includes(disclosure), "decision 6 help line is Vinci-only").toBe(vinciCode === "1");
});
