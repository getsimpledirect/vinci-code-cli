import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient, type RpcClientOptions } from "../src/modes/rpc/rpc-client.ts";

const clients: RpcClient[] = [];
const dirs: string[] = [];
const handshake = `if (c.type === "get_protocol") {
  out({ type: "response", command: c.type, id: c.id, success: true, data: { version: 1 } }); return;
}`;

function client(body: string, options: RpcClientOptions = {}): RpcClient {
	const dir = mkdtempSync(join(tmpdir(), "rpc-contract-"));
	dirs.push(dir);
	const cliPath = join(dir, "child.mjs");
	writeFileSync(
		cliPath,
		`import { createInterface } from "node:readline";
const out = x => process.stdout.write(JSON.stringify(x) + "\\n");
createInterface({ input: process.stdin }).on("line", line => { const c = JSON.parse(line); ${body} });
`,
	);
	const result = new RpcClient({ cliPath, boundedTransport: { startupTimeoutMs: 500 }, ...options });
	clients.push(result);
	return result;
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((c) => c.stop()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bounded RPC contract (synthetic child only)", () => {
	test("cancelled fork may omit text without killing a compatible transport", async () => {
		const c = client(
			`${handshake} out({type:"response",id:c.id,command:c.type,success:true,data:c.type === "fork" ? {cancelled:true} : {commands:[]}});`,
		);
		await c.start();
		expect(await c.fork("synthetic-entry")).toEqual({ cancelled: true });
		expect(await c.getCommands()).toEqual([]);
	});
	test("expired dialogs are no longer answerable and do not consume the pending cap", async () => {
		const c = client(
			`${handshake}
out({type:"extension_ui_request",id:c.id,method:"confirm",title:"Confirm",message:"Synthetic?",timeout:10});
out({type:"response",id:c.id,command:c.type,success:true,data:{commands:[]}});`,
			{ boundedTransport: { maxPendingRequests: 1 } },
		);
		await c.start();
		let id = "";
		c.onUIRequest((request) => {
			id = request.id;
		});
		for (let i = 0; i < 3; i++) {
			expect(await c.getCommands()).toEqual([]);
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(() => c.respondToUI({ type: "extension_ui_response", id, confirmed: true })).toThrow(/outstanding/);
		}
	});
	test("a dialog batched with handshake can be answered synchronously", async () => {
		const c = client(`if(c.type === "get_protocol") {
process.stdout.write(JSON.stringify({type:"response",id:c.id,command:c.type,success:true,data:{version:1}})+"\\n"+JSON.stringify({type:"extension_ui_request",id:"early",method:"confirm",title:"Confirm",message:"Synthetic?"})+"\\n"); return; }
if(c.type === "extension_ui_response") return;
out({type:"response",id:c.id,command:c.type,success:true,data:{commands:[]}});`);
		let answered = false;
		c.onUIRequest((request) => {
			c.respondToUI({ type: "extension_ui_response", id: request.id, confirmed: false });
			answered = true;
		});
		await c.start();
		expect(answered).toBe(true);
		expect(await c.getCommands()).toEqual([]);
	});
	test("event cap before delayed prompt acknowledgement rejects without an unhandled promise", async () => {
		const c = client(
			`${handshake}
for(let i=0;i<4;i++) out({type:"turn_start"});
setTimeout(() => out({type:"response",id:c.id,command:c.type,success:true}), 100);`,
			{ boundedTransport: { maxCollectedEvents: 2 } },
		);
		await c.start();
		await expect(c.promptAndWait("synthetic")).rejects.toThrow(/event limit/);
		await new Promise((resolve) => setTimeout(resolve, 150));
	});
	test.each([
		"export_html",
		"get_state",
		"bash",
		"compact",
		"set_model",
		"cycle_model",
		"cycle_thinking_level",
		"get_session_stats",
	])("refuses missing mandatory data fields for %s", async (command) => {
		const c = client(`${handshake} out({type:"response",id:c.id,command:c.type,success:true,data:{}});`);
		await c.start();
		const operations: Record<string, () => Promise<unknown>> = {
			export_html: () => c.exportHtml(),
			get_state: () => c.getState(),
			bash: () => c.bash("synthetic"),
			compact: () => c.compact(),
			set_model: () => c.setModel("synthetic", "synthetic"),
			cycle_model: () => c.cycleModel(),
			cycle_thinking_level: () => c.cycleThinkingLevel(),
			get_session_stats: () => c.getSessionStats(),
		};
		await expect(operations[command]()).rejects.toThrow(/RPC protocol/);
	});
	test.each([{ type: "queue_update" }, { type: "message_start", message: [] }])(
		"refuses incomplete event %j",
		async (event) => {
			const c = client(`${handshake} out(${JSON.stringify(event)});`);
			await c.start();
			await expect(c.getCommands()).rejects.toThrow(/RPC protocol/);
		},
		2000,
	);
	test("real built server dispatcher negotiates with both bounded and legacy clients", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-real-server-"));
		dirs.push(dir);
		const cliPath = join(dir, "server.mjs");
		const server = pathToFileURL(fileURLToPath(new URL("../dist/modes/rpc/rpc-mode.js", import.meta.url))).href;
		// Real production dispatcher and wire; only the session/provider layer is synthetic.
		writeFileSync(
			cliPath,
			`import { runRpcMode } from ${JSON.stringify(server)};
await runRpcMode({
 session: { bindExtensions: async () => {}, subscribe: () => () => {},
  agent: { subscribe: () => () => {} }, extensionRunner: { getRegisteredCommands: () => [] },
  promptTemplates: [], resourceLoader: {getSkills: () => ({skills:[]})}},
 setRebindSession: () => {}, dispose: async () => {}
});`,
		);
		for (const boundedTransport of [{}, undefined]) {
			const c = new RpcClient({ cliPath, cwd: dir, completeEnv: true, env: { HOME: dir }, boundedTransport });
			clients.push(c);
			await c.start();
			expect(await c.getCommands()).toEqual([]);
			await c.stop();
		}
	});
	test("legacy clients remain compatible with peers without negotiation", async () => {
		const c = client('out({type:"response", id:c.id, command:c.type, success:true, data:{commands:[]}});', {
			boundedTransport: undefined,
		});
		await c.start();
		expect(await c.getCommands()).toEqual([]);
	});
	test("wrong-shaped successful payload refuses rather than returning undefined", async () => {
		const c = client(`${handshake} out({type:"response",id:c.id,command:c.type,success:true,data:{}});`);
		await c.start();
		await expect(c.getCommands()).rejects.toThrow(/RPC protocol/);
	});

	test("mismatched response command refuses", async () => {
		const c = client(`${handshake} out({type:"response", id:c.id, command:"prompt", success:true});`);
		await c.start();
		await expect(c.getCommands()).rejects.toThrow(/RPC protocol/);
	});
	test("SIGTERM-resistant child is killed, pending waits settle, and stop is idempotent", async () => {
		const c = client(`${handshake} process.on("SIGTERM", () => {}); out({type:"agent_start"});`, {
			boundedTransport: { shutdownTimeoutMs: 100 },
		});
		await c.start();
		const started = new Promise<void>((resolve) =>
			c.onEvent((e) => {
				if (e.type === "agent_start") resolve();
			}),
		);
		const request = c.getCommands().catch((error) => error);
		const idle = c.waitForIdle(600000).catch((error) => error);
		await started;
		await Promise.all([c.stop(), c.stop()]);
		expect(await request).toBeInstanceOf(Error);
		expect(await idle).toBeInstanceOf(Error);
		await c.stop();
	}, 2000);
	test("UI dialog waits for an explicit correlated reply, never auto-approves", async () => {
		const c = client(`${handshake}
if(c.type === "extension_ui_response") { out({type:"agent_end",messages:[]}); return; }
out({type:"extension_ui_request",id:"dialog-1",method:"confirm",title:"Confirm",message:"Synthetic action?"});
out({type:"response",id:c.id,command:c.type,success:true,data:{commands:[]}});`);
		await c.start();
		const requests: string[] = [];
		c.onUIRequest((r) => requests.push(r.id));
		await c.getCommands();
		expect(requests).toEqual(["dialog-1"]);
		expect(() => c.respondToUI({ type: "extension_ui_response", id: "unknown", confirmed: true })).toThrow();
		const idle = c.waitForIdle();
		c.respondToUI({ type: "extension_ui_response", id: "dialog-1", confirmed: false });
		await idle;
		expect(() => c.respondToUI({ type: "extension_ui_response", id: "dialog-1", confirmed: true })).toThrow();
	});
	test("bounds event collection while preserving streaming subscribers", async () => {
		const c = client(
			`${handshake} out({type:"response",id:c.id,command:c.type,success:true}); for(let i=0;i<4;i++)out({type:"turn_start"});`,
			{ boundedTransport: { maxCollectedEvents: 2 } },
		);
		await c.start();
		await expect(c.promptAndWait("synthetic")).rejects.toThrow(/event limit/);
	});
	test("negotiates a compatible peer and preserves normal requests", async () => {
		const c = client(
			`${handshake} out({type:"response", id:c.id, command:c.type, success:true, data:{commands:[]}});`,
		);
		await c.start();
		expect(await c.getCommands()).toEqual([]);
	});
	test("refuses incompatible schema before startup succeeds", async () => {
		const c = client('out({type:"response", id:c.id, command:c.type, success:true, data:{version:99}});');
		await expect(c.start()).rejects.toThrow(/protocol/i);
	});
	test("bounds an unresponsive old peer at startup", async () => {
		const c = client("", { boundedTransport: { startupTimeoutMs: 150 } });
		await expect(c.start()).rejects.toThrow(/Timeout/);
	}, 2500);
	test.each(["not JSON", "null", "[]", '{"type":"response","success":"yes"}', '{"type":"invented"}'])(
		"refuses malformed or wrong-shaped frame: %s",
		async (frame) => {
			const c = client(`${handshake} process.stdout.write(${JSON.stringify(`${frame}\n`)});`);
			await c.start();
			await expect(c.getCommands()).rejects.toThrow(/RPC protocol/);
		},
		2000,
	);
	test("rejects oversized unterminated frame without waiting for LF", async () => {
		const c = client(`${handshake} process.stdout.write("x".repeat(513));`, {
			boundedTransport: { maxFrameBytes: 512 },
		});
		await c.start();
		await expect(c.getCommands()).rejects.toThrow(/frame/i);
	}, 2000);
	test("bounds stderr and rejects all pending requests", async () => {
		const c = client(`${handshake} process.stderr.write("x".repeat(513));`, {
			boundedTransport: { maxStderrBytes: 512 },
		});
		await c.start();
		await expect(c.getCommands()).rejects.toThrow(/stderr/i);
		expect(Buffer.byteLength(c.getStderr())).toBeLessThanOrEqual(512);
	}, 2000);
	test("caps pending requests and settles the first on stop", async () => {
		const c = client(handshake, { boundedTransport: { maxPendingRequests: 1 } });
		await c.start();
		const first = c.getCommands().catch((error) => error);
		await expect(c.getCommands()).rejects.toThrow(/pending/i);
		await c.stop();
		expect(await first).toBeInstanceOf(Error);
	}, 2000);
	test("unknown and duplicate responses never become events", async () => {
		const c = client(`${handshake}
out({type:"response", id:"unknown", command:c.type, success:true, data:{commands:[]}});
out({type:"response", id:c.id, command:c.type, success:true, data:{commands:[]}});
out({type:"response", id:c.id, command:c.type, success:true, data:{commands:[]}});`);
		await c.start();
		const events: unknown[] = [];
		c.onEvent((e) => events.push(e));
		expect(await c.getCommands()).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(events).toEqual([]);
	});
	test("complete environment omits a parent-only synthetic sentinel", async () => {
		process.env.VINCI_RPC_TEST_SENTINEL = "synthetic-only";
		try {
			const c = client(
				`${handshake} out({type:"response", id:c.id, command:c.type, success:true, data:{text:process.env.VINCI_RPC_TEST_SENTINEL ?? null}});`,
				{ completeEnv: true, env: {} },
			);
			await c.start();
			expect(await c.getLastAssistantText()).toBeNull();
		} finally {
			delete process.env.VINCI_RPC_TEST_SENTINEL;
		}
	});
});
