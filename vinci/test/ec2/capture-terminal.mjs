import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import { ENV_AGENT_DIR } from "../../../packages/coding-agent/dist/config.js";
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
const resizeOption = readOption("--resize-to", "");
const resizeColumns = resizeOption ? Number.parseInt(resizeOption, 10) : undefined;
assert.ok(Number.isInteger(columns) && columns >= 40 && columns <= 240, "columns must be between 40 and 240");
assert.ok(Number.isInteger(rows) && rows >= 16 && rows <= 80, "rows must be between 16 and 80");
assert.ok(resizeColumns === undefined || (Number.isInteger(resizeColumns) && resizeColumns >= 40 && resizeColumns <= 240), "resize columns must be between 40 and 240");
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
	const resizeMarker = join(home, "resize-observation.json");
	const resizeExtension = join(home, "capture-resize.mjs");
	if (resizeColumns !== undefined) {
		writeFileSync(resizeExtension, [
			'import { execFileSync } from "node:child_process";',
			'import { writeFileSync } from "node:fs";',
			`const marker = ${JSON.stringify(resizeMarker)};`,
			"export default function (pi) {",
			'  pi.registerCommand("capture-resize", {',
			'    description: "Resize this owned test PTY and record the actual CLI terminal dimensions",',
			"    async handler() {",
			"      let timer;",
			"      let observe;",
			"      const observed = new Promise((resolve, reject) => {",
			"        observe = () => {",
			"          clearTimeout(timer);",
			"          writeFileSync(marker, JSON.stringify({ columns: process.stdout.columns, rows: process.stdout.rows }));",
			"          resolve();",
			"        };",
			'        process.stdout.once("resize", observe);',
			'        timer = setTimeout(() => reject(new Error("CLI received no native terminal resize event. Inspect the owned PTY before retrying.")), 5000);',
			"      });",
			"      try {",
			`        execFileSync("stty", [process.platform === "darwin" ? "-f" : "-F", "/dev/tty", "cols", ${JSON.stringify(String(resizeColumns))}, "rows", ${JSON.stringify(String(rows))}], { timeout: 5000 });`,
			"        await observed;",
			"      } finally {",
			"        clearTimeout(timer);",
			'        process.stdout.off("resize", observe);',
			"      }",
			"    },",
			"  });",
			"}",
		].join("\n"));
	}

	const command = `stty cols ${columns} rows ${rows}; exec bash ${shellQuote(join(ROOT, "vinci", "bin", "vinci"))}${resizeColumns === undefined ? "" : ` --extension ${shellQuote(resizeExtension)}`}`;
	const environment = {
		...process.env,
		COLUMNS: String(columns),
		// Bind the derived agent-dir override to this fresh profile even when the invoking shell has
		// an existing override. Changing HOME alone would otherwise leave that inherited path active.
		[ENV_AGENT_DIR]: agentDir,
		HOME: home,
		LINES: String(rows),
		PI_OFFLINE: "1",
		TERM: "xterm-256color",
		// This PTY/headless capture measures the text fallback. It cannot decode native image
		// graphics, so an inherited terminal-family hint would make row measurements inadmissible.
		TERM_PROGRAM: undefined,
		TERMINAL_EMULATOR: undefined,
		KITTY_WINDOW_ID: undefined,
		GHOSTTY_RESOURCES_DIR: undefined,
		WEZTERM_PANE: undefined,
		WARP_SESSION_ID: undefined,
		WARP_TERMINAL_SESSION_UUID: undefined,
		ITERM_SESSION_ID: undefined,
		TMUX: undefined,
		WT_SESSION: undefined,
		VINCI_SOURCE_CLI: "0",
		VINCI_HOME: join(home, ".vinci-code"),
		VINCI_NO_BOOTSTRAP_HEAL: "1",
		VINCI_API_KEY: "visual-test",
		// This is the animation positive control. Plain/accessibility/reduced-motion negatives have
		// separate registered-renderer coverage and must not disable the pulse this run measures.
		VINCI_ASCII_WORDMARK: undefined,
		VINCI_REDUCED_MOTION: undefined,
		VINCI_PLAIN: undefined,
		VINCI_SCREEN_READER: undefined,
		NO_COLOR: undefined,
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
		const label = `Vinci ${name} at ${terminal.cols}x${terminal.rows}`;
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
			await Promise.race([once(childInput, "open"), wait(10_000).then(() => {
				throw new Error("Native terminal input pipe did not open. Inspect the owned capture process before retrying.");
			})]);
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
		await waitForScreen(/Continuing the/, 8_000, "the automatic continuation handoff");
		await saveFrame("continuing");

		const completedScreen = await waitForScreen(/Ask Vinci/, 12_000, "the completed Vinci composer");
		assert.match(completedScreen, /Visual test complete\./);
		assert.match(completedScreen, /changed · \+1 −1/);
		assert.match(completedScreen, /quiet/);
		assert.match(completedScreen, /lively/);
		assert.doesNotMatch(completedScreen, ACTIVITY);
		await saveFrame("complete");
		if (resizeColumns !== undefined) {
			const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
			castEvents.push([Number(elapsed.toFixed(6)), "r", `${resizeColumns}x${rows}`]);
			terminal.resize(resizeColumns, rows);
			childInput.write("/capture-resize\r");
			const deadline = Date.now() + 7_000;
			while (!existsSync(resizeMarker) && Date.now() < deadline) await wait(50);
			assert.ok(existsSync(resizeMarker), "The built CLI did not observe the native PTY resize. Inspect the resize command before retrying.");
			const observation = JSON.parse(readFileSync(resizeMarker, "utf8"));
			assert.equal(observation.columns, resizeColumns, "The CLI must observe the actual resized PTY columns");
			assert.equal(observation.rows, rows, "The CLI must observe the actual resized PTY rows");
			await waitForScreen(/Ask Vinci/, 5_000, "the resized Vinci composer");
			await wait(100);
			await saveFrame(`resized-${resizeColumns}`);
			writeFileSync(join(outputDir, `${prefix}-resize-observation.json`), `${JSON.stringify(observation)}\n`);
		}
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
console.log(`terminal capture: ${columns}x${rows}${resizeColumns === undefined ? "" : ` resized natively to ${resizeColumns}x${rows}`} ANSI, cast, text, and SVG artifacts written to ${outputDir}`);
