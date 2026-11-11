import type * as childProcess from "node:child_process";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type * as fileSystem from "node:fs";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	listMailboxes,
	newMailbox,
	readMailboxEvents,
	sendMailboxEvent,
	validateMailboxEvent,
	waitMailboxEvent,
} from "../src/mailbox.ts";
import { type MailboxAdapter, startMailboxAdapter } from "../src/mailbox-app-server.ts";
import { runMailboxCommand } from "../src/mailbox-cli.ts";

const audit = vi.hoisted(() => ({
	forbidden: [] as string[],
	observe: undefined as (() => void) | undefined,
	stubPath: "",
	workerPath: "",
	cliPaths: [] as string[],
	ownedPid: undefined as number | undefined,
}));
vi.mock("node:fs", async (original) => {
	const actual = await original<typeof fileSystem>();
	return {
		...actual,
		openSync: (...args: Parameters<typeof fileSystem.openSync>) => {
			const fd = actual.openSync(...args);
			if (args[1] === "wx") audit.observe?.();
			return fd;
		},
		renameSync: (...args: Parameters<typeof fileSystem.renameSync>) => {
			actual.renameSync(...args);
			audit.observe?.();
		},
	};
});
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof childProcess>();
	function refuse(entry: string, command: unknown): void {
		audit.forbidden.push(`${entry}:${String(command)}`);
	}
	return {
		...actual,
		spawn: (...args: Parameters<typeof childProcess.spawn>) => {
			const command = args[0];
			const argv = Array.isArray(args[1]) ? args[1] : [];
			if (command === audit.stubPath && argv.length === 1 && argv[0] === "app-server" && !args[2]?.shell) {
				const child = actual.spawn(...args);
				audit.ownedPid = child.pid;
				return child;
			}
			if (
				command === process.execPath &&
				!args[2]?.shell &&
				((argv.length === 2 && argv[0] === audit.stubPath && argv[1] === "decoy") ||
					(argv.length === 6 && argv[0] === "--import" && argv[1] === "tsx" && argv[2] === audit.workerPath))
			)
				return actual.spawn(...args);
			refuse("spawn", command);
			return new actual.ChildProcess();
		},
		spawnSync: (...args: Parameters<typeof childProcess.spawnSync>) => {
			const [command, argv] = args;
			if (
				command === process.execPath &&
				!args[2]?.shell &&
				argv !== undefined &&
				argv[0] === "--import" &&
				argv[1] === "tsx" &&
				audit.cliPaths.includes(argv[2])
			)
				return actual.spawnSync(...args);
			refuse("spawnSync", command);
			return {
				pid: 0,
				output: [null, Buffer.alloc(0), Buffer.alloc(0)],
				stdout: Buffer.alloc(0),
				stderr: Buffer.alloc(0),
				status: 0,
				signal: null,
			};
		},
		exec: (...args: Parameters<typeof childProcess.exec>) => {
			refuse("exec", args[0]);
			return new actual.ChildProcess();
		},
		execSync: (...args: Parameters<typeof childProcess.execSync>) => {
			refuse("execSync", args[0]);
			return Buffer.alloc(0);
		},
		execFile: (...args: Parameters<typeof childProcess.execFile>) => {
			refuse("execFile", args[0]);
			return new actual.ChildProcess();
		},
		execFileSync: (...args: Parameters<typeof childProcess.execFileSync>) => {
			refuse("execFileSync", args[0]);
			return Buffer.alloc(0);
		},
		fork: (...args: Parameters<typeof childProcess.fork>) => {
			refuse("fork", args[0]);
			return new actual.ChildProcess();
		},
	};
});

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const originalCliPath = join(packageRoot, "src/cli.ts");
const cliPath = process.env.MAILBOX_TEST_CLI ?? originalCliPath;
const workerPath = process.env.MAILBOX_TEST_WORKER ?? join(packageRoot, "test/mailbox-worker.ts");
let scratch: string;
let directory: string;
let home: string;
let codexPath: string;
let tracePath: string;
let run = 0;
const adapters: MailboxAdapter[] = [];
const children: ChildProcess[] = [];

async function eventually(check: () => boolean, timeout = 5000): Promise<void> {
	const deadline = performance.now() + timeout;
	while (!check()) {
		if (performance.now() >= deadline) throw new Error("Expected local test condition within five seconds");
		await delay(10);
	}
}

function trace(): Record<string, unknown>[] {
	if (!existsSync(tracePath)) return [];
	return readFileSync(tracePath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function adapter(): Promise<MailboxAdapter> {
	const instance = await startMailboxAdapter({
		directory,
		codexHome: home,
		cwd: packageRoot,
		codexPath,
		pollMs: 5,
		requestTimeoutMs: 500,
		resultPath: "RESULT.md",
	});
	adapters.push(instance);
	return instance;
}

function writer(count: number, size = 0): Promise<void> {
	const child = spawn(process.execPath, ["--import", "tsx", workerPath, directory, String(count), String(size)], {
		stdio: ["ignore", "ignore", "pipe"],
		env: process.env,
	});
	children.push(child);
	let stderr = "";
	child.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString();
	});
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Writer exited ${code}: ${stderr}`));
		});
	});
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "mailbox-"));
});
beforeEach(() => {
	const root = join(scratch, String(++run));
	mkdirSync(root);
	vi.stubEnv("VINCI_INTERNAL_MAILBOX", "1");
	vi.stubEnv("MAILBOX_ROOT", join(root, "mailboxes"));
	tracePath = join(root, "trace.jsonl");
	vi.stubEnv("MAILBOX_STUB_TRACE", tracePath);
	vi.stubEnv("MAILBOX_STUB_MODE", "normal");
	home = join(root, "home");
	mkdirSync(home);
	codexPath = join(root, "codex.ts");
	writeFileSync(codexPath, readFileSync(join(packageRoot, "test/mailbox-stub.ts")), { mode: 0o700 });
	directory = newMailbox("example", "compatibility");
	audit.forbidden.length = 0;
	audit.stubPath = codexPath;
	audit.workerPath = workerPath;
	audit.cliPaths = [];
	audit.ownedPid = undefined;
});
afterEach(async () => {
	audit.observe = undefined;
	for (const instance of adapters.splice(0)) await instance.stop().catch(() => {});
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			const closed = new Promise<void>((resolve) => {
				child.once("close", () => resolve());
			});
			child.kill("SIGKILL");
			await closed;
		}
	}
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
afterAll(() => {
	rmSync(scratch, { recursive: true });
});

describe("internal mailbox", () => {
	it("T1 preserves main command list, help and startup bytes without opt-in", () => {
		const source = readFileSync(cliPath, "utf8");
		expect(source.match(/await main\(\);/g), "the internal registration seam is exercised once").toHaveLength(1);
		// Use the current CLI with registration disabled, relocating only its imports and metadata.
		const baseline = join(dirname(home), "without-mailbox.mts");
		writeFileSync(
			baseline,
			source
				.replace("await main();", "await main(false);")
				.replaceAll(
					/from "(\.\/[^"]+)"/g,
					(_match, path: string) =>
						`from ${JSON.stringify(pathToFileURL(join(dirname(originalCliPath), path)).href)}`,
				)
				.replace("fileURLToPath(import.meta.url)", JSON.stringify(originalCliPath)),
		);
		audit.cliPaths = [baseline, cliPath];
		const defaultHelpTemplate = readFileSync(join(packageRoot, "test/mailbox-default-help.txt"), "utf8");
		const versionTokens = defaultHelpTemplate.match(/\{\{VERSION\}\}/g) ?? [];
		expect(versionTokens, "default help snapshot contains one version token").toHaveLength(1);
		const packageContents = readFileSync(join(packageRoot, "package.json"), "utf8");
		const metadata = JSON.parse(packageContents) as { version?: unknown } | null;
		const version = metadata?.version;
		const hasVersion = typeof version === "string" && version.trim().length > 0;
		expect(hasVersion, "package version is a non-empty string").toBe(true);
		const defaultHelp = Buffer.from(defaultHelpTemplate.replace("{{VERSION}}", String(version)));
		const env = { ...process.env };
		delete env.VINCI_INTERNAL_MAILBOX;
		for (const args of [[], ["--help"], ["-h"], ["--version"], ["mailbox", "list", "example"]]) {
			const original = spawnSync(process.execPath, ["--import", "tsx", baseline, ...args], { env });
			const current = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], { env });
			expect(original.error).toBeUndefined();
			expect(current.error).toBeUndefined();
			expect(current.status, "default command exit code equals main").toBe(original.status);
			expect
				.soft(current.stdout, "default command list, help and startup equal current CLI byte for byte")
				.toEqual(original.stdout);
			if (args.length === 0 || args[0] === "--help" || args[0] === "-h")
				expect
					.soft(current.stdout, "default help equals the checked-in main snapshot byte for byte")
					.toEqual(defaultHelp);
			expect(current.stderr, "default command diagnostics equal main byte for byte").toEqual(original.stderr);
		}
		const enabled = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--help"], { env: process.env });
		expect(enabled.status).toBe(0);
		expect(enabled.stdout.toString()).toContain("orchestrator mailbox");
	}, 60_000);

	it("rejects direct entry points for absent, empty and non-exact opt-in", async () => {
		for (const value of [undefined, "", "0", "true", " 1", "1 "]) {
			vi.stubEnv("VINCI_INTERNAL_MAILBOX", value);
			expect(() => newMailbox("example")).toThrow("disabled");
			expect(() => readMailboxEvents(directory, "in")).toThrow("disabled");
			expect(() => listMailboxes("example")).toThrow("disabled");
			expect(() => validateMailboxEvent({})).toThrow("disabled");
			await expect(
				sendMailboxEvent(directory, "in", { from: "client", status: "running", text: "", result: null }),
			).rejects.toThrow("disabled");
			await expect(waitMailboxEvent(directory, "in", 0)).rejects.toThrow("disabled");
			await expect(startMailboxAdapter({ directory, codexHome: home, cwd: packageRoot, codexPath })).rejects.toThrow(
				"disabled",
			);
			await expect(runMailboxCommand(["list", "example"])).rejects.toThrow("disabled");
		}
		expect(existsSync(tracePath)).toBe(false);
	});

	it("T2 controls only its own child and leaves a live decoy untouched", async () => {
		const decoy = spawn(process.execPath, [codexPath, "decoy"], { stdio: "ignore", env: process.env });
		children.push(decoy);
		await eventually(() => trace().some((row) => row.pid === decoy.pid));
		const signals: (number | undefined)[] = [];
		const kill = ChildProcess.prototype.kill;
		const killProcess = process.kill;
		const childControl = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (
			this: ChildProcess,
			signal,
		) {
			if (audit.ownedPid === undefined || this.pid !== audit.ownedPid) {
				audit.forbidden.push(`ChildProcess.kill:${this.pid}`);
				return true;
			}
			signals.push(this.pid);
			return kill.call(this, signal);
		});
		const processControl = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (audit.ownedPid === undefined || pid !== audit.ownedPid) {
				audit.forbidden.push(`process.kill:${pid}`);
				return true;
			}
			signals.push(pid);
			return killProcess(pid, signal);
		});
		try {
			const instance = await adapter();
			expect(instance.pid).not.toBe(decoy.pid);
			const started = trace().filter((row) => row.pid === instance.pid && row.event === "started");
			expect(started).toEqual([{ event: "started", pid: instance.pid, home, args: ["app-server"] }]);
			await instance.stop();
			await delay(50);
			expect(audit.forbidden, "only the owned child may be controlled; no by-name process command").toEqual([]);
			expect(signals, "signals target exactly the owned app-server pid").toEqual([instance.pid]);
			expect(trace().filter((row) => row.event === "decoy-signalled")).toEqual([]);
			expect(() => killProcess(decoy.pid!, 0)).not.toThrow();
			expect(trace().filter((row) => row.event === "started")).toHaveLength(2);
		} finally {
			processControl.mockRestore();
			childControl.mockRestore();
		}
	});

	it("allows one adapter owner per mailbox and releases ownership after stop", async () => {
		const instance = await adapter();
		await expect(adapter()).rejects.toThrow("existing owner");
		expect(trace().filter((row) => row.event === "started")).toHaveLength(1);
		await instance.stop();
		expect(existsSync(join(directory, "adapter.lock"))).toBe(false);
		await adapter();
		expect(trace().filter((row) => row.event === "started")).toHaveLength(2);
	});

	it("dispatches new, send, wait and list and reports command refusals", async () => {
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitCode = process.exitCode;
		try {
			await runMailboxCommand(["new", "example", "--job", "commands"]);
			const target = output.mock.calls.at(-1)![0] as string;
			await runMailboxCommand(["send", target, "out", "--status", "done", "--from", "client", "--text", "complete"]);
			expect(output.mock.calls.at(-1)![0]).toBe(1);
			await runMailboxCommand(["wait", target, "out", "--timeout", "0"]);
			expect(JSON.parse(output.mock.calls.at(-1)![0] as string)).toMatchObject({ seq: 1, text: "complete" });
			await runMailboxCommand(["list", "example"]);
			expect(output.mock.calls.some((row) => row[0] === `${target}\tdone\t1`)).toBe(true);
			await runMailboxCommand(["wait", target, "out", "--timeout", "0", "--after", "1"]);
			expect(process.exitCode).toBe(2);
			for (const args of [
				["send", target, "out"],
				["wait", target, "out"],
				["run", target],
				["unknown"],
				["list", "example", "--other", "value"],
			]) {
				await runMailboxCommand(args);
				expect(process.exitCode).toBe(64);
			}
			expect(errors).toHaveBeenCalledTimes(5);
		} finally {
			process.exitCode = exitCode;
		}
	});

	it("T3 accepts the version 1 producer event and refuses each missing or invalid field", () => {
		const event = JSON.parse(readFileSync(join(packageRoot, "test/mailbox-v1.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(validateMailboxEvent(event)).toBe(true);
		for (const field of Object.keys(event)) {
			const missing = { ...event };
			delete missing[field];
			expect(validateMailboxEvent(missing), `missing ${field} is refused`).toBe(false);
		}
		for (const [field, value] of [
			["v", 2],
			["v", true],
			["seq", 0],
			["seq", 1.5],
			["seq", "1"],
			["job", null],
			["from", 3],
			["status", "unknown"],
			["text", "two\nlines"],
			["text", null],
			["result", {}],
			["ts", "2025-02-30T00:00:00.000000Z"],
			["ts", "2025-01-01T00:00:00Z"],
		]) {
			expect(
				validateMailboxEvent({ ...event, [field as string]: value }),
				`${field} ${JSON.stringify(value)} is refused`,
			).toBe(false);
		}
		for (const value of [null, undefined, "", [], {}, { ...event, extra: 1 }])
			expect(validateMailboxEvent(value)).toBe(false);
		const path = join(directory, "in", `0000000001-${randomUUID()}.json`);
		writeFileSync(path, JSON.stringify(event));
		expect(readMailboxEvents(directory, "in")).toEqual([event]);
	});

	it("skips and reports malformed, foreign, mismatched and symlink events without partial contents", () => {
		const event = JSON.parse(readFileSync(join(packageRoot, "test/mailbox-v1.json"), "utf8")) as Record<
			string,
			unknown
		>;
		const privateText = "do-not-print-partial-event";
		const invalid = [
			"{",
			JSON.stringify({ ...event, text: privateText, result: undefined }),
			JSON.stringify({ ...event, job: "other" }),
			JSON.stringify({ ...event, seq: 99 }),
		];
		for (let i = 0; i < invalid.length; i++)
			writeFileSync(join(directory, "in", `${String(i + 1).padStart(10, "0")}-${randomUUID()}.json`), invalid[i]);
		writeFileSync(join(directory, "tmp", `0000000005-${randomUUID()}.json`), "partial");
		symlinkSync(join(packageRoot, "test/mailbox-v1.json"), join(directory, "in", `0000000005-${randomUUID()}.json`));
		const invalidUtf8 = Buffer.from(JSON.stringify({ ...event, seq: 6, text: "X" }));
		invalidUtf8[invalidUtf8.indexOf(Buffer.from('"text":"X"')) + 8] = 0xff;
		writeFileSync(join(directory, "in", `0000000006-${randomUUID()}.json`), invalidUtf8);
		const reports: string[] = [];
		expect(readMailboxEvents(directory, "in", (message) => reports.push(message))).toEqual([]);
		expect(reports).toHaveLength(6);
		expect(reports.join("\n")).not.toContain(privateText);
	});

	it("T4 maps input to start and steer, and completes each turn exactly once", async () => {
		await sendMailboxEvent(directory, "in", { from: "client", status: "running", text: "hold", result: null });
		await adapter();
		await eventually(() => trace().some((row) => row.method === "turn/start"));
		await sendMailboxEvent(directory, "in", {
			from: "client",
			status: "running",
			text: "finish",
			result: "updated-result.md",
		});
		await eventually(() => readMailboxEvents(directory, "out").length === 1);
		await delay(50);
		expect(trace().filter((row) => row.method === "turn/start")).toHaveLength(1);
		const steer = trace().filter((row) => row.method === "turn/steer");
		expect(steer).toHaveLength(1);
		expect(steer[0].params).toEqual({
			threadId: "thread-example",
			expectedTurnId: "turn-1",
			input: [{ type: "text", text: "finish", text_elements: [] }],
		});
		expect(readMailboxEvents(directory, "out")).toEqual([
			expect.objectContaining({ status: "done", text: "final first line", result: "updated-result.md", seq: 1 }),
		]);
		await sendMailboxEvent(directory, "in", { from: "client", status: "running", text: "finish", result: null });
		await eventually(() => readMailboxEvents(directory, "out").length === 2);
		expect(trace().filter((row) => row.method === "turn/start")).toHaveLength(2);
		expect(readMailboxEvents(directory, "out")[1].result).toBe("RESULT.md");
	});

	it("T5 allocates 200 unique sequential events across two writers", async () => {
		await Promise.all([writer(100), writer(100)]);
		const events = readMailboxEvents(directory, "in");
		expect(
			events.map((event) => event.seq),
			"two writers publish exactly sequence 1 through 200 without duplicates",
		).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
		expect(readdirSync(join(directory, "in"))).toHaveLength(200);
	}, 20_000);

	it("T5 reads complete events at every publication boundary", async () => {
		const reports: string[] = [];
		const observed: number[] = [];
		// Observe the consumer-visible directory immediately after creation or rename.
		// No filesystem result is changed and no reader waits for a writer to finish.
		audit.observe = () => {
			for (const event of readMailboxEvents(directory, "in", (message) => reports.push(message)))
				observed.push(event.seq);
		};
		await sendMailboxEvent(directory, "in", { from: "client", status: "running", text: "complete", result: null });
		audit.observe = undefined;
		expect(reports, "readers never observe a partially published JSON event at the visibility boundary").toEqual([]);
		expect(observed, "the published event remains reachable to the same reader").toEqual([1]);
	});

	it("T5 reads 100 complete events once and in order while a writer publishes", async () => {
		const publication = writer(100, 65536);
		const received: number[] = [];
		const reports: string[] = [];
		const deadline = performance.now() + 10_000;
		while (received.length < 100 && performance.now() < deadline) {
			for (const event of readMailboxEvents(directory, "in", (message) => reports.push(message))) {
				if (event.seq > (received.at(-1) ?? 0)) {
					expect(validateMailboxEvent(event)).toBe(true);
					received.push(event.seq);
				}
			}
			await delay(1);
		}
		await publication;
		expect(reports, "readers never observe a partially published JSON event").toEqual([]);
		expect(received).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
		expect(readdirSync(join(directory, "tmp"))).toEqual([]);
	}, 20_000);

	it("creates private distinct directories, lists and waits with bounded timeout", async () => {
		const second = newMailbox("example", "compatibility");
		expect(second).not.toBe(directory);
		for (const path of [directory, ...["in", "out", "tmp"].map((box) => join(directory, box))])
			expect(lstatSync(path).mode & 0o777).toBe(0o700);
		await sendMailboxEvent(directory, "out", { from: "client", status: "done", text: "", result: null });
		expect(
			listMailboxes("example")
				.map(({ status, seq }) => [status, seq])
				.sort(),
		).toEqual([
			["-", 0],
			["done", 1],
		]);
		expect(listMailboxes("absent")).toEqual([]);
		expect((await waitMailboxEvent(directory, "out", 0))?.seq).toBe(1);
		const start = performance.now();
		expect(await waitMailboxEvent(directory, "out", 0.05, 1)).toBeUndefined();
		expect(performance.now() - start).toBeGreaterThanOrEqual(40);
		for (const timeout of [-1, Number.NaN, Number.POSITIVE_INFINITY])
			await expect(waitMailboxEvent(directory, "in", timeout)).rejects.toThrow("bounds");
	});

	it("refuses unsafe identifiers, event fields, boxes and paths without writes", async () => {
		for (const owner of ["../other", ".", "..", ""]) expect(() => newMailbox(owner)).toThrow("identifier");
		for (const fields of [
			{ status: "unknown", text: "" },
			{ status: "running", text: "a\nb" },
		])
			await expect(
				sendMailboxEvent(directory, "in", { ...fields, from: "client", result: null } as Parameters<
					typeof sendMailboxEvent
				>[2]),
			).rejects.toThrow("event");
		await expect(
			sendMailboxEvent(directory, "other", { from: "client", status: "running", text: "", result: null }),
		).rejects.toThrow("box");
		await expect(
			sendMailboxEvent(home, "in", { from: "client", status: "running", text: "", result: null }),
		).rejects.toThrow("root");
		expect(readdirSync(join(directory, "in"))).toEqual([]);
		expect(readdirSync(join(directory, "tmp"))).toEqual([]);
		const link = `${directory}-link`;
		symlinkSync(directory, link);
		expect(() => readMailboxEvents(link, "in")).toThrow("directory");
		await expect(startMailboxAdapter({ directory, codexHome: "", cwd: packageRoot, codexPath })).rejects.toThrow(
			"directory",
		);
		expect(existsSync(tracePath)).toBe(false);
	});

	it("stops its own child when mailbox identity changes", async () => {
		const instance = await adapter();
		const moved = `${directory}-moved`;
		renameSync(directory, moved);
		mkdirSync(directory);
		for (const box of ["in", "out", "tmp"]) mkdirSync(join(directory, box));
		await expect(instance.finished).rejects.toThrow("identity");
		expect(readMailboxEvents(directory, "out")).toEqual([]);
	});

	it("stops its own child when an input directory is replaced", async () => {
		const instance = await adapter();
		renameSync(join(directory, "in"), join(directory, "old-in"));
		mkdirSync(join(directory, "in"));
		await expect(instance.finished).rejects.toThrow("identity");
		expect(readMailboxEvents(directory, "out")).toEqual([]);
	});

	it("refuses server requests and reports failed turns without a done event", async () => {
		vi.stubEnv("MAILBOX_STUB_MODE", "approval");
		await adapter();
		await sendMailboxEvent(directory, "in", { from: "client", status: "running", text: "finish", result: null });
		await eventually(() => trace().some((row) => row.id === "approval-example" && row.error !== undefined));
		await eventually(() => readMailboxEvents(directory, "out").length === 1);
		await adapters.pop()!.stop();
		vi.stubEnv("MAILBOX_STUB_MODE", "failed");
		await adapter();
		await eventually(() => readMailboxEvents(directory, "out").length === 2);
		expect(readMailboxEvents(directory, "out").at(-1)?.status).toBe("failed");
	});

	it("closes owned children after timeout, malformed output and unexpected exit", async () => {
		for (const mode of ["silent", "exit"]) {
			vi.stubEnv("MAILBOX_STUB_MODE", mode);
			await expect(adapter()).rejects.toThrow(mode === "silent" ? "timed out" : "exited");
		}
		vi.stubEnv("MAILBOX_STUB_MODE", "malformed");
		const instance = await adapter();
		await expect(instance.finished).rejects.toThrow();
		for (const row of trace().filter((row) => row.event === "started"))
			expect(() => process.kill(row.pid as number, 0)).toThrow();
	});
});
