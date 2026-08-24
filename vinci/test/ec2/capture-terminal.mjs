import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmodSync, createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import { viewportSvg, viewportText } from "./terminal-render.mjs";

const XtermTerminal = xterm.Terminal;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ACTIVITY = /(·|•|●)\s+(Contemplating|Considering|Looking|Making|Checking|Reviewing|Organizing|Coordinating|Adjusting|Running|Updating|Working)/;

function readOption(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index === -1) return fallback;
	const value = process.argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
	return value;
}

const outputDir = resolve(readOption("--output", join(ROOT, "vinci-test-artifacts", "terminal")));
const columns = Number.parseInt(readOption("--columns", "80"), 10);
const rows = Number.parseInt(readOption("--rows", "24"), 10);
assert.ok(Number.isInteger(columns) && columns >= 40 && columns <= 240, "columns must be between 40 and 240");
assert.ok(Number.isInteger(rows) && rows >= 16 && rows <= 80, "rows must be between 16 and 80");
mkdirSync(outputDir, { recursive: true });

const wait = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function shellQuote(value) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function startFakeVinci() {
	let requests = 0;
	const server = createServer(async (request, response) => {
		if (!request.url?.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		for await (const _chunk of request) {
			// Drain the trusted local request before responding.
		}
		requests++;
		if (requests === 1) await wait(1_800);
		if (requests === 2) await wait(2_500);
		response.writeHead(200, {
			"cache-control": "no-cache",
			"content-type": "text/event-stream",
			connection: "keep-alive",
		});
		const created = Math.floor(Date.now() / 1000);
		const base = { id: `visual-${requests}`, object: "chat.completion.chunk", created, model: "forte" };
		response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
		if (requests === 1) {
			response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "What's left is the demo edit. A quick check will finish it." }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
		} else if (requests === 2) {
			const argumentsJson = JSON.stringify({
				path: "demo.ts",
				edits: [{ oldText: 'const mood = "quiet";', newText: 'const mood = "lively";' }],
			});
			response.write(`data: ${JSON.stringify({
				...base,
				choices: [{
					index: 0,
					delta: {
						tool_calls: [{
							index: 0,
							id: "visual-edit-1",
							type: "function",
							function: { name: "edit", arguments: argumentsJson },
						}],
					},
					finish_reason: "tool_calls",
				}],
			})}\n\n`);
		} else {
			response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "Visual test complete." }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
		}
		response.end("data: [DONE]\n\n");
	});
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requestCount: () => requests };
}

async function closeServer(server) {
	server.closeAllConnections();
	await new Promise((resolvePromise, reject) => {
		server.close((error) => (error ? reject(error) : resolvePromise()));
	});
}

async function capture() {
	const prefix = `${columns}x${rows}`;
	const home = mkdtempSync(join(tmpdir(), "vinci-visual-"));
	const agentDir = join(home, ".pi", "agent");
	const projectDir = join(home, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, "demo.ts"), 'const mood = "quiet";\n');
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ vinci: { type: "api_key", key: "visual-test" } }));
	writeFileSync(join(agentDir, "trust.json"), `${JSON.stringify({ [projectDir]: true }, null, 2)}\n`);
	const visualBinDir = join(agentDir, "bin");
	mkdirSync(visualBinDir, { recursive: true });
	for (const tool of ["fd", "rg"]) {
		const toolPath = join(visualBinDir, tool);
		writeFileSync(toolPath, `#!/usr/bin/env bash\nprintf '${tool} visual-capture stub\\n'\n`);
		chmodSync(toolPath, 0o755);
	}

	const fake = await startFakeVinci();
	const terminal = new XtermTerminal({ cols: columns, rows, scrollback: 5_000, allowProposedApi: true });
	const rawChunks = [];
	const stderrChunks = [];
	const castEvents = [];
	const startedAt = process.hrtime.bigint();
	let writeQueue = Promise.resolve();
	let child;
	let childInput;

	const command = `stty cols ${columns} rows ${rows}; exec bash ${shellQuote(join(ROOT, "vinci", "bin", "vinci"))}`;
	const environment = {
		...process.env,
		COLUMNS: String(columns),
		// No agent-dir override: HOME above already points at the throwaway home, and agentDir is that
		// home's default location. The old `PI_CODING_AGENT_DIR` line was a stale no-op — the override
		// name is derived from piConfig.name (now VINCI_CODING_AGENT_DIR), so it set nothing.
		HOME: home,
		LINES: String(rows),
		PI_OFFLINE: "1",
		TERM: "xterm-256color",
		VINCI_API_KEY: "visual-test",
		VINCI_ASCII_WORDMARK: "1",
		VINCI_BASE_URL: fake.baseUrl,
		VINCI_NO_RESUME: "1",
		VINCI_NO_SANDBOX: "1",
		VINCI_NO_VERIFY: "1",
	};

	const flush = async () => {
		await writeQueue;
		await new Promise((resolvePromise) => terminal.write("", resolvePromise));
	};
	const screen = async () => {
		await flush();
		return viewportText(terminal);
	};
	const saveFrame = async (name) => {
		await flush();
		const label = `Vinci ${name} at ${columns}x${rows}`;
		writeFileSync(join(outputDir, `${prefix}-${name}.txt`), `${viewportText(terminal)}\n`);
		writeFileSync(join(outputDir, `${prefix}-${name}.svg`), viewportSvg(terminal, label));
	};
	const waitForScreen = async (pattern, timeoutMs, description) => {
		const deadline = Date.now() + timeoutMs;
		let latest = "";
		while (Date.now() < deadline) {
			latest = await screen();
			if (pattern.test(latest)) return latest;
			await wait(50);
		}
		throw new Error(`Timed out waiting for ${description}\n\n${latest}`);
	};

	try {
		if (process.platform === "darwin") {
			// Node implements child stdio with a socketpair on macOS, while BSD script(1) accepts a real
			// pipe. A named pipe keeps the capture native and lets this parent send timed input.
			const inputFifo = join(home, "terminal-input.fifo");
			execFileSync("mkfifo", [inputFifo]);
			const pipeline = `cat ${shellQuote(inputFifo)} | /usr/bin/script -q /dev/null /bin/bash -c ${shellQuote(command)}`;
			child = spawn("/bin/bash", ["-c", pipeline], { cwd: projectDir, env: environment, stdio: ["ignore", "pipe", "pipe"] });
			childInput = createWriteStream(inputFifo);
			await once(childInput, "open");
		} else {
			child = spawn(
				"script",
				["--quiet", "--flush", "--return", "--command", command, "/dev/null"],
				{ cwd: projectDir, env: environment, stdio: ["pipe", "pipe", "pipe"] },
			);
			childInput = child.stdin;
		}
		child.stdout.on("data", (chunk) => {
			const bytes = Buffer.from(chunk);
			rawChunks.push(bytes);
			const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
			castEvents.push([Number(elapsed.toFixed(6)), "o", bytes.toString("utf8")]);
			writeQueue = writeQueue.then(() => new Promise((resolvePromise) => terminal.write(bytes.toString("utf8"), resolvePromise)));
		});
		child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
		const exit = new Promise((resolvePromise, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolvePromise({ code, signal }));
		});

		await waitForScreen(/Ask Vinci|Vinci Forte/, 10_000, "the Vinci composer");
		await saveFrame("startup");
		childInput.write("Reply with exactly: Visual test complete.\r");
		await waitForScreen(ACTIVITY, 6_000, "an animated activity phase");

		const seenPulses = new Set();
		for (let attempt = 0; attempt < 12 && seenPulses.size < 3; attempt++) {
			const activeScreen = await screen();
			const match = activeScreen.match(ACTIVITY);
			if (match && !seenPulses.has(match[1])) {
				seenPulses.add(match[1]);
				await saveFrame(`working-${seenPulses.size}`);
			}
			await wait(140);
		}
		assert.ok(seenPulses.size >= 2, `Expected at least two native pulse frames, saw ${[...seenPulses].join(", ")}`);
		await waitForScreen(/Continuing the ta/, 8_000, "the automatic continuation handoff");
		await saveFrame("continuing");

		const completedScreen = await waitForScreen(/Ask Vinci/, 12_000, "the completed Vinci composer");
		assert.match(completedScreen, /Visual test complete\./);
		assert.match(completedScreen, /changed · \+1 −1/);
		assert.match(completedScreen, /quiet/);
		assert.match(completedScreen, /lively/);
		assert.doesNotMatch(completedScreen, ACTIVITY);
		await saveFrame("complete");
		await wait(250);
		childInput.end("/quit\r");
		const result = await Promise.race([
			exit,
			wait(12_000).then(() => {
				child.kill("SIGTERM");
				throw new Error("Native terminal capture did not exit after /quit");
			}),
		]);
		assert.equal(result.signal, null, `script exited from signal ${result.signal}`);
		assert.equal(result.code, 0, `script exited with code ${result.code}`);
		assert.ok(fake.requestCount() >= 3, "The local faux Vinci endpoint did not complete the continuation and tool follow-up");
	} finally {
		if (childInput && !childInput.destroyed) childInput.end();
		if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		await flush();
		const castHeader = {
			version: 2,
			width: columns,
			height: rows,
			timestamp: Math.floor(Date.now() / 1000),
			env: { SHELL: "/bin/bash", TERM: "xterm-256color" },
		};
		writeFileSync(join(outputDir, `${prefix}.ansi`), Buffer.concat(rawChunks));
		writeFileSync(
			join(outputDir, `${prefix}.cast`),
			`${[JSON.stringify(castHeader), ...castEvents.map((event) => JSON.stringify(event))].join("\n")}\n`,
		);
		writeFileSync(join(outputDir, `${prefix}-stderr.log`), Buffer.concat(stderrChunks));
		terminal.dispose();
		await closeServer(fake.server);
		rmSync(home, { recursive: true, force: true });
	}
}

await capture();
console.log(`terminal capture: ${columns}x${rows} ANSI, cast, text, and SVG artifacts written to ${outputDir}`);
