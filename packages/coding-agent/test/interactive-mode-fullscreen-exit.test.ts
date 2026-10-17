import { type ChildProcess, execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

// Keep the assertion/cleanup deadlines authoritative when a host mutation prevents resume.
vi.setConfig({ testTimeout: 35_000 });

const fixture = fileURLToPath(new URL("./interactive-mode-fullscreen-exit-fixture.ts", import.meta.url));
// This switch belongs only to the test runner; production has no environment mode selector.
const hostRun = process.env.VINCI_FULLSCREEN_HOST_RUN === "1";
const taskOut = fileURLToPath(new URL("../../../../out/", import.meta.url));
const childLog =
	process.env.VINCI_FULLSCREEN_CHILD_LOG ?? join(existsSync(taskOut) ? taskOut : tmpdir(), "child-pids.log");
const transcriptMarker = "fullscreen-exit-transcript-marker";
const enter = "\x1b[?1049h";
const leave = "\x1b[?1049l";
const mouseEnables = ["\x1b[?1000h", "\x1b[?1002h", "\x1b[?1006h"];
const forbiddenMouseEnables = [...mouseEnables, "\x1b[?1003h", "\x1b[?1004h"];
const reset = [
	"\x1b[?1006l",
	"\x1b[?1004l",
	"\x1b[?1003l",
	"\x1b[?1002l",
	"\x1b[?1000l",
	"\x1b[?7h",
	"\x1b[?25h",
	leave,
];
type Mode = "regular" | "fullscreen";
type Outcome = { code: number | null; signal: NodeJS.Signals | null };

async function bounded<T>(promise: Promise<T>, label: string, timeout = 6000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeout);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

class ExitChild {
	readonly mode: Mode;
	readonly process: ChildProcess;
	readonly exited: Promise<Outcome>;
	output = "";
	errors = "";
	suspended = false;
	private messages: string[] = [];
	private outcome: Outcome | undefined;
	private readonly tempDir: string;
	private readonly path: string;

	constructor(mode: Mode, path: string, ownGroup = false, startError = false) {
		if (ownGroup && !hostRun) throw new Error("Process groups require VINCI_FULLSCREEN_HOST_RUN=1 on the host");
		this.mode = mode;
		this.path = `${mode}: ${path}`;
		this.tempDir = mkdtempSync(join(tmpdir(), "vinci-fullscreen-exit-"));
		const args = ["--experimental-strip-types", fixture, mode, ...(startError ? ["start-error"] : [])];
		// setpgid, rather than setsid/detached, keeps this group non-orphaned so
		// the kernel can actually stop it on SIGTSTP. Only this child joins it.
		this.process = spawn(
			ownGroup ? "perl" : process.execPath,
			ownGroup
				? [
						"-e",
						'setpgrp(0, 0) or die "setpgrp failed: $!"; exec @ARGV; die "exec failed: $!";',
						process.execPath,
						...args,
					]
				: args,
			{
				env: childEnv(this.tempDir, this.path),
				stdio: ["pipe", "pipe", "pipe", "ipc"],
			},
		);
		appendFileSync(childLog, `${new Date().toISOString()} START pid=${this.process.pid} case=${this.path}\n`);
		this.process.stdout?.on("data", (chunk: Buffer) => {
			this.output += chunk.toString();
		});
		this.process.stderr?.on("data", (chunk: Buffer) => {
			this.errors += chunk.toString();
		});
		this.process.on("message", (message: unknown) => {
			if (typeof message === "object" && message !== null && "event" in message) {
				this.messages.push(String(message.event));
			}
		});
		this.exited = new Promise((resolve, reject) => {
			this.process.once("error", reject);
			this.process.once("close", (code, signal) => {
				this.outcome = { code, signal };
				appendFileSync(
					childLog,
					`${new Date().toISOString()} CLOSE pid=${this.process.pid} case=${this.path} code=${code} signal=${signal}\n`,
				);
				const homes = readFileSync(childLog, "utf8")
					.split("\n")
					.filter((line) => line.includes(` HOME pid=${this.process.pid} `));
				const home = homes.at(-1)?.split(" home=")[1];
				if (!home || !home.startsWith(this.tempDir)) {
					reject(
						new Error(
							`child HOME must be inside the case temp dir "${this.tempDir}", got "${home ?? "<not recorded>"}"; fix the child env before any host run`,
						),
					);
					return;
				}
				resolve(this.outcome);
			});
		});
	}

	async until(predicate: () => boolean, label: string): Promise<void> {
		const deadline = Date.now() + 6000;
		while (!predicate()) {
			if (this.outcome) throw new Error(`${label}: child exited ${JSON.stringify(this.outcome)}; ${this.errors}`);
			if (Date.now() >= deadline) {
				throw new Error(
					`Timed out waiting for ${label}; stderr=${this.errors}; output=${JSON.stringify(this.output.slice(-4000))}`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	async ready(): Promise<void> {
		await this.until(
			() =>
				this.messages.includes("ready") &&
				this.output.includes("\x1b[?2004h") &&
				(this.mode === "regular" || [enter, ...mouseEnables].every((bytes) => this.output.includes(bytes))),
			`${this.mode} real terminal ready bytes`,
		);
	}

	keys(bytes: string): void {
		this.process.stdin?.write(bytes);
	}

	command(command: string): void {
		this.process.send({ command });
	}

	signal(signal: NodeJS.Signals): void {
		if (!hostRun) throw new Error(`Signal ${signal} requires VINCI_FULLSCREEN_HOST_RUN=1 on the host`);
		this.process.kill(signal);
	}

	async alive(): Promise<void> {
		const count = this.messages.filter((event) => event === "alive").length;
		this.command("probe");
		await this.until(() => this.messages.filter((event) => event === "alive").length > count, "live child IPC reply");
	}

	async stopped(): Promise<void> {
		if (!hostRun) throw new Error("Stopped-state inspection requires VINCI_FULLSCREEN_HOST_RUN=1 on the host");
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline) {
			const state = await new Promise<string>((resolve, reject) => {
				execFile("ps", ["-o", "state=", "-p", String(this.process.pid)], { timeout: 1000 }, (error, stdout) => {
					if (error) reject(error);
					else resolve(stdout.trim());
				});
			});
			if (state.startsWith("T")) return;
			if (this.outcome) throw new Error(`Child exited before stopped state: ${this.errors}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`Timed out waiting for ps stopped state for exact child pid ${this.process.pid}`);
	}

	async close(): Promise<void> {
		const failures: unknown[] = [];
		try {
			if (this.outcome) return;
			if (hostRun) {
				// A stopped child cannot service IPC or timers. Resume its exact PID first.
				if (this.suspended) {
					try {
						this.signal("SIGCONT");
					} catch (error) {
						failures.push(error);
					}
				}
				try {
					this.signal("SIGTERM");
				} catch (error) {
					failures.push(error);
				}
			} else {
				// Sandbox cleanup uses only the child's own code path and bounded watchdog.
				try {
					if (this.process.connected) this.command("cleanup");
				} catch (error) {
					failures.push(error);
				}
			}
			try {
				await bounded(this.exited, "fixture cleanup and collected close status", hostRun ? 6000 : 22_000);
			} catch (error) {
				failures.push(error);
			}
		} finally {
			if (this.outcome) rmSync(this.tempDir, { recursive: true, force: true });
		}
		if (failures.length > 0) throw new AggregateError(failures, `${this.path}: fixture cleanup failed`);
	}
}

function assertRegular(bytes: string, path: string): void {
	for (const sequence of [enter, leave, ...forbiddenMouseEnables, ...reset.slice(0, 5)]) {
		expect(bytes, `${path}: regular emits no fullscreen mode bytes`).not.toContain(sequence);
	}
}

function assertReset(bytes: string, path: string): void {
	let offset = 0;
	for (const sequence of reset) {
		const at = bytes.indexOf(sequence, offset);
		expect(at, `${path}: complete fullscreen reset bytes ${JSON.stringify(sequence)}`).toBeGreaterThanOrEqual(offset);
		offset = at + sequence.length;
	}
	for (const sequence of [enter, ...forbiddenMouseEnables]) {
		expect(bytes.slice(offset), `${path}: no enable after final reset`).not.toContain(sequence);
	}
}

async function journey(
	mode: Mode,
	path: string,
	run: (child: ExitChild, begin: number) => Promise<void>,
	ownGroup = false,
	startError = false,
): Promise<void> {
	const child = new ExitChild(mode, path, ownGroup, startError);
	let failure: unknown;
	let cleanupFailure: unknown;
	try {
		if (!startError) await child.ready();
		await run(child, child.output.length);
	} catch (error) {
		failure = error;
	} finally {
		try {
			await child.close();
		} catch (cleanupError) {
			cleanupFailure = cleanupError;
		}
	}
	if (failure && cleanupFailure) {
		throw new AggregateError([failure, cleanupFailure], `${path}: case failed, then cleanup failed`);
	}
	if (failure) throw failure;
	if (cleanupFailure) throw cleanupFailure;
}

// One builder for every child's environment (also used by the no-op isolation check below).
function childEnv(tempDir: string, caseName: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		PI_OFFLINE: "1",
		VINCI_TOOL_BOOTSTRAP: "0",
		VINCI_CODE: "1",
		TMUX: "",
		// The child is a real InteractiveMode with Vinci extensions: give it its own home so no
		// state, cache or update file can be written under the caller's real HOME.
		HOME: tempDir,
		XDG_CONFIG_HOME: join(tempDir, ".config"),
		XDG_DATA_HOME: join(tempDir, ".local", "share"),
		XDG_STATE_HOME: join(tempDir, ".local", "state"),
		XDG_CACHE_HOME: join(tempDir, ".cache"),
		[ENV_AGENT_DIR]: tempDir,
		TMPDIR: tempDir,
		GIT_CEILING_DIRECTORIES: tempDir,
		VINCI_FULLSCREEN_CHILD_LOG: childLog,
		VINCI_FULLSCREEN_CHILD_CASE: caseName,
	};
}

test("a child's HOME and XDG dirs sit inside its temp dir (no-op child, safe on any host)", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "vinci-fullscreen-env-"));
	try {
		const script =
			'const os=require("node:os");process.stdout.write(JSON.stringify({home:os.homedir(),xdg:["XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_STATE_HOME","XDG_CACHE_HOME"].map((k)=>process.env[k])}))';
		const reported = await new Promise<{ home: string; xdg: string[] }>((resolve, reject) => {
			execFile(process.execPath, ["-e", script], { env: childEnv(tempDir, "env-check") }, (error, stdout) =>
				error ? reject(error) : resolve(JSON.parse(stdout)),
			);
		});
		for (const value of [reported.home, ...reported.xdg]) {
			expect(
				value?.startsWith(tempDir),
				`child home/XDG "${value}" must be inside the case temp dir "${tempDir}"`,
			).toBe(true);
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

describe.each(["fullscreen", "regular"] as const)("InteractiveMode %s real child exits", (mode) => {
	for (const [path, key] of [
		["N /quit", "/quit\r"],
		["N Ctrl+D", "\x04"],
	] as const) {
		test(path, async () => {
			await journey(mode, path, async (child, begin) => {
				child.keys(key);
				const outcome = await bounded(child.exited, path);
				if (mode === "fullscreen") assertReset(child.output.slice(begin), path);
				else assertRegular(child.output, path);
				expect(outcome).toEqual({ code: 0, signal: null });
			});
		});
	}

	for (const [path, signal] of [
		["I external SIGINT", "SIGINT"],
		["T SIGTERM", "SIGTERM"],
		["H SIGHUP", "SIGHUP"],
	] as const) {
		test.skipIf(!hostRun || (process.platform === "win32" && signal === "SIGHUP"))(path, async () => {
			await journey(mode, path, async (child, begin) => {
				child.signal(signal);
				const outcome = await bounded(child.exited, path);
				const bytes = child.output.slice(begin);
				if (mode === "fullscreen") assertReset(bytes, path);
				else assertRegular(child.output, path);
				if (signal !== "SIGINT") expect(outcome).toEqual({ code: 0, signal: null });
				else if (mode === "regular") expect(outcome).toEqual({ code: null, signal: "SIGINT" });
				if (signal === "SIGINT" && mode === "fullscreen") expect(outcome).toEqual({ code: 0, signal: null });
				if (signal !== "SIGINT") {
					expect(bytes, `${path}: session_shutdown emitted`).toContain("SESSION_SHUTDOWN");
					expect(bytes.indexOf("SESSION_SHUTDOWN"), `${path}: extension cleanup precedes restore`).toBeLessThan(
						bytes.indexOf(mode === "fullscreen" ? reset[0] : "\x1b[?2004l"),
					);
				}
			});
		});
	}

	test.skipIf(!hostRun)("I first Ctrl+C stays active; second exits", async () => {
		await journey(mode, "I double Ctrl+C", async (child, begin) => {
			child.keys("\x03");
			await child.until(() => child.output.includes("Press Ctrl+C again to exit"), "first Ctrl+C visible nudge");
			await child.alive();
			expect(child.output.slice(begin), "I first Ctrl+C: no alternate screen reset").not.toContain(leave);
			child.keys("\x03");
			const outcome = await bounded(child.exited, "I double Ctrl+C");
			if (mode === "fullscreen") assertReset(child.output.slice(begin), "I double Ctrl+C");
			else assertRegular(child.output, "I double Ctrl+C");
			expect(outcome).toEqual({ code: 0, signal: null });
		});
	});

	for (const trigger of ["Ctrl+Z", "SIGTSTP"] as const) {
		for (const resume of [false, true]) {
			const path = `${resume ? "C" : "Z"} ${trigger}${resume ? " SIGCONT" : ""}`;
			test.skipIf(!hostRun || process.platform === "win32")(path, async () => {
				await journey(
					mode,
					path,
					async (child, begin) => {
						child.suspended = true;
						if (trigger === "Ctrl+Z") child.keys("\x1a");
						else child.signal("SIGTSTP");
						await child.stopped();
						const beforeContinue = child.output.slice(begin);
						if (mode === "fullscreen") assertReset(beforeContinue, `${path}: before stopped state`);
						if (resume) {
							const resumeBegin = child.output.length;
							child.signal("SIGCONT");
							child.suspended = false;
							if (mode === "fullscreen") {
								await child.until(
									() => [enter, ...mouseEnables].every((seq) => child.output.slice(resumeBegin).includes(seq)),
									`${path}: fullscreen re-enable bytes`,
								);
							} else if (trigger === "Ctrl+Z") {
								await child.until(
									() => child.output.slice(resumeBegin).includes("\x1b[?2004h"),
									`${path}: regular terminal restarted`,
								);
							} else {
								await child.alive();
							}
						}
						if (mode === "regular") assertRegular(child.output, path);
					},
					true,
				);
			});
		}
	}

	for (const [path, command] of [
		["U async throw", "throw"],
		["R unhandled rejection", "reject"],
		["X process.exit", "exit"],
		["X ordinary stop throws", "stop-throws"],
	] as const) {
		test(path, async () => {
			await journey(mode, path, async (child, begin) => {
				child.command(command);
				const outcome = await bounded(child.exited, path);
				if (mode === "fullscreen") assertReset(child.output.slice(begin), path);
				else assertRegular(child.output, path);
				expect(outcome).toEqual({ code: 1, signal: null });
				if (command === "throw" || command === "reject") {
					expect(child.errors, `${path}: actual Node uncaught route`).toContain(
						`UNCAUGHT_EXCEPTION_MONITOR:${command === "reject" ? "unhandledRejection" : "uncaughtException"}`,
					);
					expect(child.errors, `${path}: production crash handler`).toContain(
						"pi exiting due to uncaughtException:",
					);
					if (mode === "fullscreen") {
						expect(child.output.slice(begin), `${path}: no crash transcript replay`).not.toContain(
							transcriptMarker,
						);
					}
				}
			});
		});
	}

	test("duplicate stop and exit preserve one transcript", async () => {
		await journey(mode, "duplicate stop", async (child, begin) => {
			child.command("duplicate");
			expect(await bounded(child.exited, "duplicate stop")).toEqual({ code: 0, signal: null });
			const bytes = child.output.slice(begin);
			if (mode === "fullscreen") {
				assertReset(bytes, "duplicate stop");
				expect(bytes.split(leave).length - 1, "duplicate stop: one alternate reset").toBe(1);
				expect(bytes.split(transcriptMarker).length - 1, "duplicate stop: one transcript replay").toBe(1);
			} else assertRegular(child.output, "duplicate stop");
		});
	});

	test("external editor preserves transcript and resumes terminal", async () => {
		await journey(mode, "external editor", async (child, begin) => {
			child.command("editor");
			await child.until(() => child.output.includes("EXTERNAL_EDITOR\n"), "real external editor child");
			const editorAt = child.output.indexOf("EXTERNAL_EDITOR\n", begin);
			const beforeEditor = child.output.slice(begin, editorAt);
			if (mode === "fullscreen") {
				assertReset(beforeEditor, "external editor");
				expect(beforeEditor, "external editor: no transcript replay").not.toContain(transcriptMarker);
				await child.until(
					() => [enter, ...mouseEnables].every((seq) => child.output.slice(editorAt).includes(seq)),
					"external editor fullscreen resume bytes",
				);
			} else {
				await child.until(
					() => child.output.slice(editorAt).includes("\x1b[?2004h"),
					"external editor regular resume bytes",
				);
				assertRegular(child.output, "external editor");
			}
			child.command("cleanup");
			expect(await bounded(child.exited, "external editor self-exit")).toEqual({ code: 0, signal: null });
		});
	});

	for (const code of ["EIO", "EPIPE", "ENOTCONN"] as const) {
		test(`dead terminal ${code} makes no recursive restore write`, async () => {
			await journey(mode, `dead terminal ${code}`, async (child, begin) => {
				child.command(`dead-${code}`);
				expect(await bounded(child.exited, `dead terminal ${code}`)).toEqual({ code: 129, signal: null });
				expect(child.errors, "dead terminal: no recursive terminal write").not.toContain(
					"WRITE_AFTER_DEAD_TERMINAL",
				);
				expect(child.output.slice(begin), "dead terminal: no restore bytes after terminal loss").toBe("");
				if (mode === "regular") assertRegular(child.output, `dead terminal ${code}`);
			});
		});
	}

	test("terminal start failure after alternate entry resets", async () => {
		await journey(
			mode,
			"terminal start error",
			async (child) => {
				const outcome = await bounded(child.exited, "terminal-start failure");
				if (mode === "fullscreen") {
					for (const sequence of [enter, ...mouseEnables]) {
						expect(child.output, "terminal start failure: entered fullscreen before failure").toContain(sequence);
					}
					assertReset(child.output.slice(child.output.indexOf(enter) + enter.length), "terminal start failure");
				} else assertRegular(child.output, "terminal start failure");
				expect(outcome).toEqual({ code: 1, signal: null });
				expect(child.errors).toContain("fixture terminal start failed after entry");
			},
			false,
			true,
		);
	});
});
