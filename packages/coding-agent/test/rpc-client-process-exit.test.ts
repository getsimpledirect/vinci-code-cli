import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});

	// The 10-minute wait below is the whole point. waitForIdle/collectEvents settle only on an
	// `agent_end` event, so a child that dies without emitting one used to leave the promise pending
	// AND its timeout timer armed and refed for the full duration — on its own enough to keep a
	// finished Node process resident at 0% CPU (this is what stopped `vinci/test/run.sh` from ever
	// exiting). A regression here does not fail fast: it hangs until vitest's per-test timeout.
	test("settles a wait for idle when the child exits without agent_end", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.on("data", () => {
	process.stdout.write(JSON.stringify({ type: "response", id: "req_1", success: true, data: {} }) + "\\n");
	setTimeout(() => process.exit(17), 20);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.promptAndWait("go", undefined, 600_000)).rejects.toThrow(/Agent process exited/);
	}, 20_000);

	test("settles a wait for idle when the client is stopped mid-run", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.on("data", () => {
	process.stdout.write(JSON.stringify({ type: "response", id: "req_1", success: true, data: {} }) + "\\n");
	process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
});
process.stdin.resume();
// Stay alive and streaming: only stop() may end this wait.
setInterval(() => {}, 60_000);
`),
		});

		await client.start();

		// Wait for `agent_start` before stopping. Without it the test is vacuous: stop() would race the
		// prompt's own response, promptAndWait would reject on the failed SEND, and the assertion would
		// pass even with the event-waiter teardown removed. The child emits agent_start strictly after
		// the response, so reaching here proves the wait is parked on the event stream, not on the send.
		const streaming = new Promise<void>((resolve) => {
			const off = client.onEvent((event) => {
				if (event.type === "agent_start") {
					off();
					resolve();
				}
			});
		});
		const waiting = client.promptAndWait("go", undefined, 600_000);
		await streaming;

		const rejected = expect(waiting).rejects.toThrow();
		await client.stop();
		await rejected;
	}, 20_000);
});
