import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { launcherDiagnostics, launcherEnvironment, launcherStatus } from "./launcher-diagnostics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const canary = "TESTONLY_SYNTHETIC_CREDENTIAL_MUST_NEVER_APPEAR";
const path = `${dirname(process.execPath)}:/usr/bin:/bin`;

function execute(file, args, options = {}) {
	const started = performance.now();
	const timeout = options.timeout ?? 5_000;
	return new Promise((resolveRun) => {
		execFile(file, args, { encoding: "utf8", env: { PATH: path }, timeout, ...options }, (error, stdout, stderr) => {
			resolveRun({
				status: launcherStatus(error),
				stdout, stderr,
				diagnostic: JSON.parse(launcherDiagnostics(error, stdout, stderr, performance.now() - started, timeout)),
			});
		});
	});
}

function fixture(t, childSource) {
	const root = mkdtempSync(join(tmpdir(), "vinci-launcher-diagnostic-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const directory of ["vinci/bin", "vinci/test", "packages/coding-agent/src", "node_modules/.bin"])
		mkdirSync(join(root, directory), { recursive: true });
	copyFileSync(resolve(here, "../bin/vinci"), join(root, "vinci/bin/vinci"));
	for (const name of ["byok-launcher-integration.mjs", "launcher-diagnostics.mjs"])
		copyFileSync(join(here, name), join(root, "vinci/test", name));
	writeFileSync(join(root, "vinci/identity.json"), '{"version":"0.0.58"}\n');
	writeFileSync(join(root, "packages/coding-agent/src/cli.ts"), "// Inert fixture, never imported.\n");
	writeFileSync(join(root, "node_modules/.bin/tsx"), `#!/usr/bin/env node\n${childSource}\n`, { mode: 0o755 });
	return root;
}

test("diagnostics omit arbitrary secrets, arguments, error messages and terminal controls", () => {
	const output = `${canary} https://example.invalid/?token=${canary}\u001b]52;c;inert\u0007`;
	const diagnostic = launcherDiagnostics({ code: canary, signal: canary, message: output, cmd: output }, output, output, 9, 60_000);
	assert.equal(diagnostic.includes(canary), false, "unknown credential shape must be omitted");
	assert.equal(diagnostic.includes("example.invalid"), false, "URLs and arguments must be omitted");
	assert.equal(/[\u0000-\u001f]/.test(diagnostic), false, "terminal controls must be omitted");
	assert.equal(diagnostic.length < 512, true, "diagnostics stay bounded");
	const parsed = JSON.parse(diagnostic);
	assert.equal(parsed.stdout.kind, "omitted");
	assert.equal(parsed.stderr.kind, "omitted");
	assert.equal(parsed.status, 1);
	assert.equal(parsed.signal, null);
});

test("empty and version output are classified without echoing bytes", () => {
	const d = JSON.parse(launcherDiagnostics(null, "0.0.58\n", "", 2, 60_000));
	assert.equal(d.stdout.kind, "version");
	assert.equal(d.stdout.bytes, 7);
	assert.equal(d.stderr.kind, "empty");
	assert.equal(JSON.stringify(d).includes("0.0.58"), false);
});

test("output-limit termination is never mislabelled a timeout", () => {
	const d = JSON.parse(launcherDiagnostics({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, "", "", 60_010, 60_000));
	assert.equal(d.timeoutOutcome, "output-limit");
});

test("termination before deadline and SIGTERM without a requested kill stay distinct", () => {
	const early = JSON.parse(launcherDiagnostics({ code: 143, killed: true }, "", "", 3, 60_000));
	const signal = JSON.parse(launcherDiagnostics({ code: null, signal: "SIGTERM", killed: false }, "", "", 3, 60_000));
	assert.equal(early.timeoutOutcome, "termination-before-deadline");
	assert.equal(signal.timeoutOutcome, "not-observed");
	assert.equal(signal.signal, "SIGTERM");
});

test("launcher environment allowlist does not accept inherited credentials or configuration", () => {
	const env = launcherEnvironment(path, "/synthetic-home");
	assert.equal(Object.keys(env).length, 13);
	assert.equal(Object.keys(env).some(key => /KEY|TOKEN|SECRET|PROVIDER|MODEL|NODE_OPTIONS|VINCI_ENV/.test(key)), false);
	assert.equal(env.HOME, "/synthetic-home");
	assert.equal(env.PI_CODING_AGENT_DIR, "/synthetic-home/agent");
	assert.equal(env.VINCI_UPDATE_DISABLED, "1");
	assert.equal(env.PI_OFFLINE, "1");
});

test("normal socket-free Node child reports success", async () => {
	const r = await execute(process.execPath, ["-e", 'process.stdout.write("0.0.58\\n")']);
	assert.equal(r.status, 0);
	assert.equal(r.diagnostic.terminationRequested, false);
	assert.equal(r.diagnostic.timeoutOutcome, "not-observed");
});

test("external/self SIGTERM is different from execFile timeout", async () => {
	const r = await execute(process.execPath, ["-e", 'process.kill(process.pid,"SIGTERM")']);
	assert.equal(r.diagnostic.signal, "SIGTERM");
	assert.equal(r.diagnostic.terminationRequested, false);
	assert.equal(r.diagnostic.timeoutOutcome, "not-observed");
});

test("maxBuffer failure is bounded and secret-safe with an actual child", async () => {
	const r = await execute(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(canary)}.repeat(100))`], { maxBuffer: 128 });
	assert.equal(r.diagnostic.timeoutOutcome, "output-limit");
	assert.equal(JSON.stringify(r.diagnostic).includes(canary), false);
});

test("real launcher with inert child: natural exit143 is not timeout evidence", async t => {
	const root = fixture(t, "process.exit(143)");
	const r = await execute("bash", [join(root, "vinci/bin/vinci"), "--model", "forte", "--version"], {
		env: launcherEnvironment(path, root),
	});
	assert.equal(r.status, 143, "wrapper must preserve natural child status");
	assert.equal(r.diagnostic.signal, null);
	assert.equal(r.diagnostic.terminationRequested, false);
	assert.equal(r.diagnostic.timeoutOutcome, "not-observed");
	t.diagnostic(JSON.stringify(r.diagnostic));
});

test("real launcher with inert child: execFile timeout can produce the exact CI exit143", async t => {
	const root = fixture(t, 'process.on("SIGTERM",()=>process.exit(143));process.stdout.write("READY\\n");setInterval(()=>{},1000)');
	const r = await execute("bash", [join(root, "vinci/bin/vinci"), "--model", "forte", "--version"], {
		env: launcherEnvironment(path, root), timeout: 800,
	});
	assert.equal(r.stdout.includes("READY"), true, "inert child installed handler before timer");
	assert.equal(r.status, 143, "wrapper plus timeout reproduces the observed status");
	assert.equal(r.diagnostic.signal, null);
	assert.equal(r.diagnostic.terminationRequested, true);
	assert.equal(r.diagnostic.timeoutOutcome, "deadline-consistent");
	t.diagnostic(JSON.stringify(r.diagnostic));
});

test("full 102-case launcher matrix uses real shell and inert child without inherited keys", async t => {
	const root = fixture(t, 'if(process.env.OPENROUTER_API_KEY){process.stderr.write(process.env.OPENROUTER_API_KEY);process.exit(7)}process.stdout.write("0.0.58\\n")');
	writeFileSync(join(root, ".vinci-code.env"), `printf '%s' '${canary}' >&2\nexit 78\n`);
	const r = await execute(process.execPath, [join(root, "vinci/test/byok-launcher-integration.mjs")], {
		env: { PATH: path, HOME: root, TMPDIR: root, OPENROUTER_API_KEY: canary }, timeout: 30_000,
	});
	assert.equal(r.status, 0, `inert matrix: ${JSON.stringify(r.diagnostic)}`);
	assert.equal(r.stdout.includes("102 managed flag cases accepted"), true);
	assert.equal((r.stdout + r.stderr).includes(canary), false);
	assert.equal(readFileSync(join(root, ".vinci-code.env"), "utf8").includes(canary), true, "caller profile stays untouched");
	assert.equal(readFileSync(join(root, "vinci/test/byok-launcher-integration.mjs"), "utf8").includes("timeoutMs = 60_000"), true);
	assert.equal(readFileSync(join(root, "vinci/bin/vinci")).equals(readFileSync(resolve(here, "../bin/vinci"))), true);
});

for (const [name, childSource] of [
	["nonzero exit", `process.stdout.write(${JSON.stringify(canary)});process.stderr.write(${JSON.stringify(canary)});process.exit(7)`],
	["malformed version", `process.stdout.write(${JSON.stringify(canary)})`],
]) {
	test(`actual assertion for ${name} preserves failure without leaking child output`, async t => {
		const root = fixture(t, childSource);
		const r = await execute(process.execPath, [join(root, "vinci/test/byok-launcher-integration.mjs"), "--forte-only"], {
			env: { PATH: path, HOME: root, TMPDIR: root },
		});
		assert.equal(r.status, 1, "invalid launch must still fail");
		assert.equal((r.stdout + r.stderr).includes(canary), false, "failure output must omit synthetic secret");
		assert.equal(r.stderr.includes('"stdout":{"bytes":'), true, "sanitized metadata must be retained");
		assert.equal(r.stderr.includes('"stderr":{"bytes":'), true);
		assert.equal(r.stderr.includes('"timeoutMs":60000'), true, "original timeout must remain unchanged");
		assert.equal(r.stderr.includes('"kind":"omitted"'), true);
	});
}
