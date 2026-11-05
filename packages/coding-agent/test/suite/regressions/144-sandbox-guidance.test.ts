import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createJiti } from "jiti/static";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type * as Guidance from "../../../src/core/auth-guidance.ts";
import type * as Sandbox from "../../../src/core/vinci-sandbox.ts";
import type * as Assistant from "../../../src/modes/interactive/components/assistant-message.ts";

const fixture = vi.hoisted(() => ({
	diagnostic: "",
	exitCode: 1 as number | null,
	spawnError: undefined as Error | undefined,
	home: "",
	temp: "",
	backend: true,
	timeout: false,
	close: undefined as (() => void) | undefined,
	spawnCalls: 0,
	emittedDiagnostic: undefined as string | undefined,
	spawnedCommand: "",
}));

const require = createRequire(import.meta.url);
const builtinFs = require("node:fs") as typeof import("node:fs");
const builtinOs = require("node:os") as typeof import("node:os");
const builtinChildProcess = require("node:child_process") as typeof import("node:child_process");
const originals = {
	existsSync: builtinFs.existsSync,
	homedir: builtinOs.homedir,
	tmpdir: builtinOs.tmpdir,
	spawn: builtinChildProcess.spawn,
};

function spawnWriter(command: string, args: readonly string[]) {
	fixture.spawnCalls++;
	fixture.spawnedCommand = [command, ...args].join(" ");
	const child = Object.assign(new EventEmitter(), {
		pid: undefined,
		stdout: null,
		stderr: new PassThrough(),
		stdin: Object.assign(new EventEmitter(), {
			end: () => {
				queueMicrotask(() => {
					if (fixture.spawnError) child.emit("error", fixture.spawnError);
					else if (!fixture.timeout) {
						fixture.emittedDiagnostic = fixture.diagnostic;
						child.stderr.write(fixture.diagnostic);
						child.emit("close", fixture.exitCode);
					}
				});
			},
		}),
	});
	fixture.close = () => child.emit("close", null);
	return child;
}

const root = realpathSync(
	process.env.VINCI_SANDBOX_GUIDANCE_ROOT || fileURLToPath(new URL("../../../../..", import.meta.url)),
);
const built = process.env.VINCI_SANDBOX_GUIDANCE_BUILT === "1";
let sandbox: typeof Sandbox;
let guidance: typeof Guidance;
let assistant: typeof Assistant;
let loader: ReturnType<typeof createJiti>;
let project: string;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
function setPlatform(value: string): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}
function modulePath(path: string): string {
	return resolve(root, "packages/coding-agent", built ? `dist/${path}.js` : `src/${path}.ts`);
}
async function loadModule<T>(path: string): Promise<T> {
	const selected = modulePath(path);
	process.stdout.write(
		`Sandbox guidance fixture imported ${built ? "built" : "source"} module ${realpathSync(selected)}.\n`,
	);
	return loader.import<T>(selected);
}

beforeAll(async () => {
	fixture.temp = mkdtempSync(join(process.env.VINCI_SANDBOX_GUIDANCE_TMP || tmpdir(), "sandbox-guidance-"));
	fixture.home = join(fixture.temp, "home");
	project = join(fixture.temp, "project");
	mkdirSync(fixture.home);
	mkdirSync(project);
	builtinFs.existsSync = (path) =>
		["/usr/bin/sandbox-exec", "/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].includes(String(path))
			? fixture.backend
			: originals.existsSync(path);
	builtinOs.homedir = () => fixture.home;
	builtinOs.tmpdir = () => fixture.temp;
	builtinChildProcess.spawn = spawnWriter as unknown as typeof builtinChildProcess.spawn;
	syncBuiltinESMExports();
	expect(require("node:child_process").spawn).toBe(spawnWriter);
	expect(require("node:fs").existsSync("/usr/bin/bwrap")).toBe(true);
	loader = createJiti(import.meta.url, { fsCache: false, moduleCache: false, tryNative: false });
	vi.stubEnv("VINCI_CODE", "1");
	vi.stubEnv("VINCI_NO_SANDBOX", undefined);
	vi.stubEnv("VINCI_SANDBOX_WRITE_ROOTS", undefined);
	vi.stubEnv("VINCI_SANDBOX_WRITE_FILES", undefined);
	sandbox = await loadModule<typeof Sandbox>("core/vinci-sandbox");
	guidance = await loadModule<typeof Guidance>("core/auth-guidance");
	const theme = await loadModule<typeof import("../../../src/modes/interactive/theme/theme.ts")>(
		"modes/interactive/theme/theme",
	);
	theme.initTheme("dark", false);
	assistant = await loadModule<typeof Assistant>("modes/interactive/components/assistant-message");
});
beforeEach(() => {
	fixture.diagnostic = "";
	fixture.exitCode = 1;
	fixture.spawnError = undefined;
	fixture.backend = true;
	fixture.timeout = false;
	fixture.emittedDiagnostic = undefined;
	sandbox.vinciResetSandboxPermissions();
	setPlatform("linux");
});
afterAll(() => {
	Object.defineProperty(process, "platform", platform);
	vi.unstubAllEnvs();
	builtinFs.existsSync = originals.existsSync;
	builtinOs.homedir = originals.homedir;
	builtinOs.tmpdir = originals.tmpdir;
	builtinChildProcess.spawn = originals.spawn;
	syncBuiltinESMExports();
	if (fixture.temp) rmSync(fixture.temp, { recursive: true, force: true });
});

function assertNoWidening(text: string): void {
	expect(text).not.toMatch(
		/\/allow-directory|\/allow-file|extra scope|grant an unprotected parent directory|VINCI_NO_SANDBOX|disable (?:the )?sandbox/i,
	);
}
function assertStartup(text: string): void {
	assertNoWidening(text);
	expect(text).toContain("sandbox could not start on this host");
	expect(text).toContain("prerequisites");
	expect(text).toContain("widening file access will not help");
}
async function writerFailure(
	diagnostic: string,
	path = join(fixture.temp, "sibling", "target.txt"),
	expectSpawn = true,
): Promise<string> {
	fixture.diagnostic = diagnostic;
	const spawnCalls = fixture.spawnCalls;
	try {
		await sandbox.vinciSandboxWriteFile(path, "fixture", project, false);
		throw new Error("The failing writer unexpectedly succeeded");
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		expect(fixture.spawnCalls, "The selected writer must reach the fake child process").toBe(
			spawnCalls + Number(expectSpawn),
		);
		if (expectSpawn) {
			expect(fixture.spawnedCommand).toContain(process.platform === "darwin" ? "sandbox-exec" : "/usr/bin/bwrap");
			if (!fixture.spawnError && !fixture.timeout) {
				expect(fixture.emittedDiagnostic, "The fake writer must emit the exact supplied diagnostic").toBe(
					diagnostic,
				);
				process.stdout.write(
					"Sandbox writer fixture reached one fake child process and emitted the supplied diagnostic exactly.\n",
				);
			}
		}
		return (error as Error).message;
	}
}
function renderedRecovery(diagnostic: string): string {
	const message = {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "vinci",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: diagnostic,
		timestamp: 0,
	} as ConstructorParameters<typeof assistant.AssistantMessageComponent>[0];
	return stripVTControlCharacters(new assistant.AssistantMessageComponent(message).render(120).join(" ")).replace(
		/\s+/g,
		" ",
	);
}

const startup = [
	"bwrap: Failed to create NETLINK_ROUTE socket: Operation not permitted",
	"bwrap: Creating new namespace failed: Operation not permitted",
	"bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces",
	"bwrap: setting up uid map: Permission denied",
	"bwrap: Failed to make / slave: Permission denied",
	"bwrap: Can't mount tmpfs on /newroot: Operation not permitted",
	"bwrap: Can't read /proc/1/ns/user: Permission denied",
	"sandbox-exec: sandbox_apply: Operation not permitted",
	"sandbox-exec: execvp() of '/bin/bash' failed: No such file or directory",
	"Sandbox backend unavailable on this host",
	"Unsupported platform for sandbox backend",
	'Bubblewrap cannot bind a new explicit file grant "target.txt" because the file does not exist',
] as const;

describe("sandbox writer final errors", () => {
	test.each(startup)("writer startup: %s", async (diagnostic) => {
		const output = await writerFailure(diagnostic);
		expect(output).toContain(diagnostic);
		assertStartup(output);
	});
	test("writer startup on macOS reaches the fake backend", async () => {
		setPlatform("darwin");
		const diagnostic = "sandbox-exec: sandbox_apply: Operation not permitted";
		const output = await writerFailure(diagnostic);
		expect(output).toContain(diagnostic);
		assertStartup(output);
	});
	test("writer spawn failure reports prerequisites", async () => {
		fixture.spawnError = new Error("spawn /bin/bash ENOENT");
		assertStartup(await writerFailure(""));
	});
	test("writer confirmed path-scope refusal retains scope advice", async () => {
		const path = join(fixture.temp, "sibling", "target.txt");
		const output = await writerFailure(`/bin/bash: ${path}: Permission denied`, path);
		expect(output).toContain("Permission denied");
		expect(output).toContain("/allow-directory");
		expect(output).toContain("/allow-file");
		expect(output).not.toContain("could not start");
	});
	test("writer protected refusal does not widen scope", async () => {
		const output = await writerFailure(
			"/bin/bash: protected target: Permission denied",
			join(fixture.home, ".bashrc"),
		);
		assertNoWidening(output);
		expect(output).toContain("Permission denied");
	});
	test.each(["unrelated writer failure", "", "Operation not permitted"])(
		"writer unknown diagnostics stay neutral: %s",
		async (diagnostic) => {
			const output = await writerFailure(diagnostic, join(project, "target.txt"));
			assertNoWidening(output);
			expect(output).toContain(diagnostic || "writer did not complete");
			expect(output).not.toContain("could not start");
		},
	);
	test.each(["some subsystem: Permission denied", "bwrap: denied resource", "sandbox-exec: unknown failure"])(
		"writer unknown outside-target failure does not widen scope: %s",
		async (diagnostic) => {
			const output = await writerFailure(diagnostic);
			assertNoWidening(output);
			expect(output).toContain(diagnostic);
			expect(output).not.toContain("could not start");
		},
	);
	test.each(["linux", "darwin", "win32"])("writer missing backend on %s remains confined", async (os) => {
		setPlatform(os);
		fixture.backend = false;
		const output = await writerFailure("", undefined, false);
		expect(output).toContain("no enforceable OS sandbox");
		assertStartup(output);
	});
	test("writer abort preserves cancellation without scope advice", async () => {
		const spawnCalls = fixture.spawnCalls;
		const controller = new AbortController();
		controller.abort();
		await expect(
			sandbox.vinciSandboxWriteFile(join(project, "target.txt"), "fixture", project, false, controller.signal),
		).rejects.toThrow("Operation aborted");
		expect(fixture.spawnCalls).toBe(spawnCalls);
	});
	test("writer missing-file prerequisite does not widen scope", async () => {
		const path = join(project, "new-file.txt");
		sandbox.vinciGrantWriteFile(project, path);
		const output = await writerFailure("", path, false);
		expect(output).toContain("new explicit file grant");
		assertStartup(output);
	});
	test("writer in-flight abort preserves cancellation without scope advice", async () => {
		const spawnCalls = fixture.spawnCalls;
		fixture.timeout = true;
		const controller = new AbortController();
		const pending = sandbox.vinciSandboxWriteFile(
			join(project, "target.txt"),
			"fixture",
			project,
			false,
			controller.signal,
		);
		queueMicrotask(() => {
			controller.abort();
			fixture.close?.();
		});
		await expect(pending).rejects.toThrow("Operation aborted");
		expect(fixture.spawnCalls).toBe(spawnCalls + 1);
	});
	test("writer timeout has neutral guidance", async () => {
		fixture.timeout = true;
		const original = globalThis.setTimeout;
		const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
			if (delay === 30_000) {
				queueMicrotask(() => {
					(callback as () => void)();
					fixture.close?.();
				});
				return original(() => {}, 60_000);
			}
			return original(callback, delay, ...args);
		});
		try {
			const output = await writerFailure("");
			assertNoWidening(output);
			expect(output).toContain("timed out");
		} finally {
			timer.mockRestore();
		}
	});
	test("writer successful exit remains successful", async () => {
		const spawnCalls = fixture.spawnCalls;
		fixture.exitCode = 0;
		await expect(
			sandbox.vinciSandboxWriteFile(join(project, "target.txt"), "fixture", project, false),
		).resolves.toBeUndefined();
		expect(fixture.spawnCalls).toBe(spawnCalls + 1);
		expect(fixture.emittedDiagnostic).toBe("");
	});
	test("the existing explicit developer bypass behavior is retained", () => {
		vi.stubEnv("VINCI_NO_SANDBOX", "1");
		try {
			expect(sandbox.vinciSandboxWrap("printf fixture", project)).toBe("printf fixture");
		} finally {
			vi.stubEnv("VINCI_NO_SANDBOX", undefined);
		}
	});
});

describe("sandbox recovery final callers", () => {
	test("recovery legacy missing-backend diagnostics do not repeat bypass advice", () => {
		const diagnostic =
			"Vinci disabled bash because no enforceable OS sandbox is available. Install bubblewrap or set VINCI_NO_SANDBOX=1 as an explicit developer bypass.";
		assertStartup(guidance.formatVinciRecoveryMessage(diagnostic));
		assertStartup(renderedRecovery(diagnostic));
	});
	test.each(startup)("recovery startup: %s", (diagnostic) => {
		const output = guidance.formatVinciRecoveryMessage(diagnostic);
		expect(output).toContain(diagnostic);
		assertStartup(output);
		expect(guidance.getVinciRecoveryGuidance(diagnostic).kind).toBe("sandbox");
		assertStartup(renderedRecovery(diagnostic));
	});
	test("recovery confirmed path-scope refusal retains scope advice", () => {
		const diagnostic = 'Sandbox denied write: path "target.txt" is outside approved scope';
		for (const output of [guidance.formatVinciRecoveryMessage(diagnostic), renderedRecovery(diagnostic)]) {
			expect(output).toMatch(/\/allow-directory|authorize extra scope/);
			expect(output).toContain(diagnostic);
		}
	});
	test.each([
		"Vinci could not write inside its scoped sandbox: permission denied",
		"Bubblewrap cannot protect the absent sensitive path",
		"Sandbox denied write: protected path outside approved scope",
		"Sandbox writer timed out after 30 seconds",
	])("recovery unknown or protected diagnostics stay neutral: %s", (diagnostic) => {
		const result = guidance.getVinciRecoveryGuidance(diagnostic);
		expect(result.kind).toBe("sandbox");
		assertNoWidening(result.nextStep);
		expect(result.nextStep).not.toContain("could not start");
		const output = guidance.formatVinciRecoveryMessage(diagnostic);
		expect(output).toContain(diagnostic);
		assertNoWidening(output);
		assertNoWidening(renderedRecovery(diagnostic));
	});
	test.each(["", "Unrelated failure", "Operation aborted", "Operation timed out"])(
		"string-only unrelated errors retain diagnostics: %s",
		(diagnostic) => {
			assertNoWidening(guidance.getVinciRecoveryGuidance(diagnostic).nextStep);
			expect(guidance.formatVinciRecoveryMessage(diagnostic)).toContain(diagnostic);
		},
	);
	test.each(["The account resource is outside approved scope", "The provider request has a path-scope refusal"])(
		"unrelated resource scope errors do not advise file access: %s",
		(diagnostic) => {
			const result = guidance.getVinciRecoveryGuidance(diagnostic);
			assertNoWidening(result.nextStep);
			expect(result.kind).toBe("unknown");
			for (const output of [guidance.formatVinciRecoveryMessage(diagnostic), renderedRecovery(diagnostic)]) {
				expect(output).toContain(diagnostic);
				assertNoWidening(output);
			}
		},
	);
});

test.skipIf(!fs.existsSync(modulePath("core/sandbox-guidance")))(
	"optional sandbox context requires boolean scope evidence and respects protected paths",
	async () => {
		const { getSandboxRecoveryGuidance } =
			await loadModule<typeof import("../../../src/core/sandbox-guidance.ts")>("core/sandbox-guidance");
		for (const context of [
			undefined,
			null,
			false,
			"scope",
			{},
			{ pathScopeRefused: "true" },
			{ pathScopeRefused: 1 },
			{ pathScopeRefused: true, protectedPath: true },
		]) {
			const result = getSandboxRecoveryGuidance("scoped sandbox: unknown failure", context as never);
			expect(result?.classification).toBe("unknown");
			assertNoWidening(result!.nextStep);
		}
		for (const diagnostic of [undefined, null, false, 0, {}]) {
			const result = getSandboxRecoveryGuidance(diagnostic as never, { sandbox: true });
			expect(result?.classification).toBe("unknown");
			assertNoWidening(result!.nextStep);
		}
		expect(getSandboxRecoveryGuidance("The account resource is outside approved scope")).toBeUndefined();
		expect(
			getSandboxRecoveryGuidance("The account resource is outside approved scope", {
				sandbox: false,
				pathScopeRefused: "true",
			} as never),
		).toBeUndefined();
	},
);
