import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import { viewportSvg, viewportText } from "./terminal-render.mjs";

const XtermTerminal = xterm.Terminal;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ACTIVITY = /(?:·|•|●|✦|✹)\s+(Contemplating|Considering|Looking|Making|Checking|Reviewing|Organizing|Coordinating|Adjusting|Running|Updating|Working)/;
const USER_DECISION = /Vinci wants to|confirm a risky command|↑↓ navigate\s+enter select/i;

function readOption(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index === -1) return fallback;
	const value = process.argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
	return value;
}

function shellQuote(value) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

const outputDir = resolve(readOption("--output"));
const projectDir = resolve(readOption("--project"));
const prompt = readOption("--prompt");
const name = readOption("--name", "live");
const columns = Number.parseInt(readOption("--columns", "100"), 10);
const rows = Number.parseInt(readOption("--rows", "32"), 10);
const timeoutSeconds = Number.parseInt(readOption("--timeout-seconds", "600"), 10);
assert.equal(process.platform, "linux", "Live EC2 terminal capture requires Linux script(1)");
assert.match(name, /^[a-z0-9][a-z0-9-]{1,60}$/, "name must be a stable slug");
assert.ok(existsSync(projectDir), `Project directory does not exist: ${projectDir}`);
assert.ok(prompt.length >= 40 && prompt.length <= 4_000, "prompt must contain 40-4000 characters");
assert.ok(Number.isInteger(columns) && columns >= 60 && columns <= 180, "columns must be 60-180");
assert.ok(Number.isInteger(rows) && rows >= 20 && rows <= 60, "rows must be 20-60");
assert.ok(Number.isInteger(timeoutSeconds) && timeoutSeconds >= 60 && timeoutSeconds <= 900, "timeout must be 60-900 seconds");
mkdirSync(outputDir, { recursive: true });
const sessionDir = join(outputDir, "session");
mkdirSync(sessionDir, { recursive: true });

// VINCI_CODING_AGENT_DIR, not PI_…: the override name is DERIVED in packages/coding-agent/src/config.ts
// from piConfig.name ("vinci"), while configDir deliberately stays ".pi". This script runs under plain
// node against a built CLI on the EC2 box, so it cannot import that module; keep it in step by hand.
const agentDir = process.env.VINCI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
assert.ok(existsSync(join(agentDir, "auth.json")), "Live terminal capture requires the isolated Vinci auth bundle");
const trustPath = join(agentDir, "trust.json");
let trust = {};
if (existsSync(trustPath)) {
	trust = JSON.parse(readFileSync(trustPath, "utf8"));
}
writeFileSync(trustPath, `${JSON.stringify({ ...trust, [projectDir]: true }, null, 2)}\n`, { mode: 0o600 });

const wait = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const terminal = new XtermTerminal({ cols: columns, rows, scrollback: 8_000, allowProposedApi: true });
const rawChunks = [];
const stderrChunks = [];
const castEvents = [];
const frames = [];
const activityStates = new Set();
const startedAt = process.hrtime.bigint();
let lastOutputAt = startedAt;
let maxOutputGapSeconds = 0;
let writeQueue = Promise.resolve();
let child;
let childResult = null;
let captureError = null;
let completedScreen = "";

const elapsedSeconds = () => Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
const command =
	`stty cols ${columns} rows ${rows}; exec bash ${shellQuote(join(ROOT, "vinci", "bin", "vinci"))}` +
	` --session-dir ${shellQuote(sessionDir)}`;
const environment = {
	...process.env,
	COLUMNS: String(columns),
	LINES: String(rows),
	VINCI_CODING_AGENT_DIR: agentDir,
	TERM: "xterm-256color",
	VINCI_ASCII_WORDMARK: "1",
	VINCI_NO_RESUME: "1",
};

const flush = async () => {
	await writeQueue;
	await new Promise((resolvePromise) => terminal.write("", resolvePromise));
};

const screen = async () => {
	await flush();
	return viewportText(terminal);
};

const saveFrame = async (label) => {
	await flush();
	const sequence = String(frames.length + 1).padStart(2, "0");
	const prefix = `${name}-${columns}x${rows}-${sequence}-${label}`;
	const visible = viewportText(terminal);
	writeFileSync(join(outputDir, `${prefix}.txt`), `${visible}\n`);
	writeFileSync(join(outputDir, `${prefix}.svg`), viewportSvg(terminal, `Vinci ${label} at ${columns}x${rows}`));
	frames.push({ file: prefix, label, elapsedSeconds: Number(elapsedSeconds().toFixed(3)) });
	return visible;
};

const waitForScreen = async (predicate, timeoutMs, description) => {
	const deadline = Date.now() + timeoutMs;
	let latest = "";
	while (Date.now() < deadline) {
		latest = await screen();
		if (predicate(latest)) return latest;
		if (childResult) throw new Error(`Terminal exited before ${description}: ${JSON.stringify(childResult)}`);
		await wait(100);
	}
	throw new Error(`Timed out waiting for ${description}\n\n${latest}`);
};

try {
	child = spawn(
		"script",
		["--quiet", "--flush", "--return", "--command", command, "/dev/null"],
		{ cwd: projectDir, env: environment, stdio: ["pipe", "pipe", "pipe"] },
	);
	child.stdout.on("data", (chunk) => {
		const now = process.hrtime.bigint();
		const gapSeconds = Number(now - lastOutputAt) / 1_000_000_000;
		maxOutputGapSeconds = Math.max(maxOutputGapSeconds, gapSeconds);
		lastOutputAt = now;
		const bytes = Buffer.from(chunk);
		rawChunks.push(bytes);
		castEvents.push([Number(elapsedSeconds().toFixed(6)), "o", bytes.toString("utf8")]);
		writeQueue = writeQueue.then(() => new Promise((resolvePromise) => terminal.write(bytes.toString("utf8"), resolvePromise)));
	});
	child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
	const exit = new Promise((resolvePromise, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			childResult = { code, signal };
			resolvePromise(childResult);
		});
	});

	await waitForScreen((visible) => /Ask Vinci/.test(visible), 20_000, "the Vinci composer");
	await saveFrame("startup");
	child.stdin.write(`${prompt}\r`);
	await waitForScreen((visible) => !/Ask Vinci/.test(visible), 20_000, "the active work surface");
	await saveFrame("submitted");

	const deadline = Date.now() + timeoutSeconds * 1_000;
	let nextFrameAt = Date.now() + 2_500;
	let previousFrame = "";
	while (Date.now() < deadline) {
		const visible = await screen();
		const activity = visible.match(ACTIVITY)?.[1];
		if (activity) activityStates.add(activity);
		if (USER_DECISION.test(visible)) {
			await saveFrame("decision-required");
			throw new Error("Unexpected user decision blocked autonomous live UI capture");
		}
		if (/Ask Vinci/.test(visible)) {
			completedScreen = visible;
			break;
		}
		if (childResult) throw new Error(`Terminal exited during live work: ${JSON.stringify(childResult)}`);
		if (Date.now() >= nextFrameAt && frames.length < 24 && visible !== previousFrame) {
			previousFrame = await saveFrame(activity ? `working-${activity.toLowerCase()}` : "working");
			nextFrameAt = Date.now() + 2_500;
		}
		await wait(150);
	}
	if (!completedScreen) throw new Error(`Live Vinci session exceeded ${timeoutSeconds} seconds`);
	await wait(500);
	completedScreen = await saveFrame("complete");
	child.stdin.end("/quit\r");
	const result = await Promise.race([
		exit,
		wait(12_000).then(() => {
			child.kill("SIGTERM");
			throw new Error("Live terminal capture did not exit after /quit");
		}),
	]);
	assert.equal(result.signal, null, `script exited from signal ${result.signal}`);
	assert.equal(result.code, 0, `script exited with code ${result.code}`);
} catch (error) {
	captureError = error instanceof Error ? error.message : String(error);
	throw error;
} finally {
	if (child?.stdin && !child.stdin.destroyed) child.stdin.end();
	if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	await flush();
	const finalVisible = completedScreen || viewportText(terminal);
	const finalGapSeconds = Number(process.hrtime.bigint() - lastOutputAt) / 1_000_000_000;
	maxOutputGapSeconds = Math.max(maxOutputGapSeconds, finalGapSeconds);
	const castHeader = {
		version: 2,
		width: columns,
		height: rows,
		timestamp: Math.floor(Date.now() / 1000),
		env: { SHELL: "/bin/bash", TERM: "xterm-256color" },
	};
	writeFileSync(join(outputDir, `${name}-${columns}x${rows}.ansi`), Buffer.concat(rawChunks));
	writeFileSync(
		join(outputDir, `${name}-${columns}x${rows}.cast`),
		`${[JSON.stringify(castHeader), ...castEvents.map((event) => JSON.stringify(event))].join("\n")}\n`,
	);
	writeFileSync(join(outputDir, `${name}-${columns}x${rows}-stderr.log`), Buffer.concat(stderrChunks));
	writeFileSync(join(outputDir, `${name}-${columns}x${rows}-final.txt`), `${finalVisible}\n`);
	writeFileSync(
		join(outputDir, `${name}-${columns}x${rows}-metrics.json`),
		`${JSON.stringify({
			status: captureError ? "failed" : "passed",
			error: captureError,
			columns,
			rows,
			elapsedSeconds: Number(elapsedSeconds().toFixed(3)),
			maxOutputGapSeconds: Number(maxOutputGapSeconds.toFixed(3)),
			activityStates: [...activityStates],
			frames,
			finalScreen: {
				hasComposer: /Ask Vinci/.test(finalVisible),
				hasConnectionState: /connected|reconnect|checking/.test(finalVisible),
				hasChangesReceipt: /(?:DONE(?:-UNVERIFIED)?|Done(?: — please check it)?).*·\s+\d+\s+files?/.test(finalVisible),
				hasChecksReceipt: /check:/.test(finalVisible),
				hasInlineDiff: /^\s*[+-]\s*\d+/m.test(finalVisible),
			},
		}, null, 2)}\n`,
	);
	terminal.dispose();
}

console.log(`live terminal capture: ${name} at ${columns}x${rows} written to ${outputDir}`);
