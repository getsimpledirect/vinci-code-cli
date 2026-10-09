#!/usr/bin/env node
// Prove a Vinci tree actually LAUNCHES: run its real launcher in print mode, against a local faux
// gateway, and require the agent loop to answer. No network, no credentials, no TTY.
//
// This exists because `vinci --version` proved nothing. 0.0.51 shipped a payload that died on EVERY
// launch (`ERR_MODULE_NOT_FOUND: Cannot find package '@getsimpledirect/vinci-contracts'`), behind a
// green harness and a green "Verify the PACKAGED artifact loads" step — because that step only ran
// `vinci --version`, which the launcher answers itself before Pi, the extensions, or the core
// grader ever load. packaged-artifact-check.mjs resolves only RELATIVE specifiers, and the missing
// module was a BARE one, so it passed too. Nothing on the release path loaded the code users load.
//
// The command below is the cheapest thing that does: `vinci -p` boots Pi, loads every
// `--extension` the launcher passes, constructs the agent session (which imports the core grader
// and, through it, vinci/extensions/lib/*.js), sends one prompt to the provider, and prints the
// reply. The faux gateway answers `/chat/completions` with a fixed token; everything else is 404.
//
// Usage:  node vinci/test/packaged-launch-check.mjs <tree-root>
//   <tree-root> is either an UNPACKED tarball or a repo checkout. Against a repo checkout the
//   private scope is installed and resolvable, so only an unpacked tarball can show the 0.0.51
//   failure; run.sh packages and unpacks for exactly that reason.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TOKEN = "PACKAGED-LOAD-OK";
const LAUNCH_TIMEOUT_MS = Number.parseInt(process.env.VINCI_LAUNCH_CHECK_TIMEOUT_MS ?? "90000", 10);
// Any of these in the CLI's output means a module failed to load — the exact 0.0.51 signature and
// the 0.0.31 one before it. Checked in addition to the exit code so a launcher that swallows the
// failure and exits 0 still fails here.
const LOAD_FAILURE_SIGNATURES = [
	"ERR_MODULE_NOT_FOUND",
	"Cannot find package",
	"Cannot find module",
	"Failed to load extension",
	"MODULE_NOT_FOUND",
];

const root = process.argv[2] ? resolve(process.argv[2]) : undefined;
const launcher = root ? join(root, "vinci", "bin", "vinci") : undefined;
if (!root || !existsSync(launcher)) {
	console.error("usage: packaged-launch-check.mjs <tree-root>   (tree-root must contain vinci/bin/vinci)");
	process.exit(2);
}

async function startFauxGateway() {
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
		response.writeHead(200, {
			"cache-control": "no-cache",
			"content-type": "text/event-stream",
			connection: "keep-alive",
		});
		const base = {
			id: `launch-check-${requests}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "forte",
		};
		response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
		response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: TOKEN }, finish_reason: null }] })}\n\n`);
		response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requestCount: () => requests };
}

function runLauncher(environment, cwd) {
	return new Promise((resolvePromise) => {
		const child = spawn("bash", [launcher, "-p", `Reply with exactly: ${TOKEN}`], {
			cwd,
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, LAUNCH_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolvePromise({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolvePromise({ code, signal, stdout, stderr, timedOut });
		});
	});
}

const home = mkdtempSync(join(tmpdir(), "vinci-launch-check-"));
const agentDir = join(home, ".pi", "agent");
const projectDir = join(home, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ vinci: { type: "api_key", key: "launch-check" } }));
writeFileSync(join(agentDir, "trust.json"), `${JSON.stringify({ [projectDir]: true }, null, 2)}\n`);

const gateway = await startFauxGateway();
let failures = [];
try {
	// Explicit allowlist, not an inherited environment: a developer shell can carry
	// VINCI_CODING_AGENT_DIR / VINCI_HOME / PI_* / NODE_OPTIONS / NODE_PATH and similar overrides that
	// would point the packaged CLI at a repo checkout or another install, and the check would then
	// prove the wrong tree loads. Only what the launcher needs to run from <tree-root> gets through.
	const inherited = {};
	for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL"]) {
		if (process.env[name] !== undefined) inherited[name] = process.env[name];
	}
	const result = await runLauncher(
		{
			...inherited,
			HOME: home,
			PI_OFFLINE: "1",
			TERM: "dumb",
			VINCI_API_KEY: "launch-check",
			VINCI_ASCII_WORDMARK: "1",
			VINCI_BASE_URL: gateway.baseUrl,
			// The payload's bootstrap self-heal only acts inside a real install; keep it inert here.
			VINCI_NO_BOOTSTRAP_HEAL: "1",
			VINCI_NO_RESUME: "1",
			VINCI_NO_SANDBOX: "1",
			VINCI_NO_VERIFY: "1",
		},
		projectDir,
	);
	const combined = `${result.stdout}\n${result.stderr}`;
	if (result.timedOut) failures.push(`launcher did not exit within ${LAUNCH_TIMEOUT_MS}ms`);
	if (result.code !== 0) failures.push(`launcher exited ${result.code ?? `signal ${result.signal}`}, expected 0`);
	for (const signature of LOAD_FAILURE_SIGNATURES) {
		if (combined.includes(signature)) failures.push(`output contains a module-load failure: ${signature}`);
	}
	if (!result.stdout.includes(TOKEN)) failures.push(`stdout does not contain the faux reply ${TOKEN}`);
	if (gateway.requestCount() < 1) failures.push("the agent loop never reached the provider (0 gateway requests)");

	if (failures.length > 0) {
		console.error(`✗ packaged launch check FAILED for ${root}`);
		for (const failure of failures) console.error(`    ${failure}`);
		const tail = combined.trim().split("\n").slice(-12).join("\n");
		console.error("  last output lines:");
		for (const line of tail.split("\n")) console.error(`      ${line}`);
	} else {
		console.log(
			`  ✓ packaged launch check: \`vinci -p\` from ${root} loaded every extension and the agent loop, reached the faux gateway (${gateway.requestCount()} request), and replied ${TOKEN}`,
		);
	}
} finally {
	gateway.server.closeAllConnections();
	await new Promise((resolvePromise) => gateway.server.close(() => resolvePromise()));
	rmSync(home, { recursive: true, force: true });
}
process.exit(failures.length > 0 ? 1 : 0);
