#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const trace = process.env.MAILBOX_STUB_TRACE!;
const mode = process.env.MAILBOX_STUB_MODE;
function log(value: unknown): void {
	appendFileSync(trace, `${JSON.stringify(value)}\n`);
}
function emit(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
log({ event: "started", pid: process.pid, home: process.env.CODEX_HOME, args: process.argv.slice(2) });
if (process.argv[2] === "decoy") {
	process.on("SIGTERM", () => {
		log({ event: "decoy-signalled", pid: process.pid });
	});
	setInterval(() => {}, 1000);
} else {
	let turnNumber = 0;
	const lines = createInterface({ input: process.stdin });
	lines.on("line", (line) => {
		const message = JSON.parse(line) as {
			id?: number | string;
			method?: string;
			params?: { input?: { text: string }[] };
			error?: unknown;
		};
		log(message);
		if (mode === "exit") {
			process.exit(42);
		}
		if (mode === "silent") return;
		if (message.method === "initialize") emit({ id: message.id, result: { userAgent: "local-test" } });
		if (message.method === "thread/start") {
			emit({ id: message.id, result: { thread: { id: "thread-example" } } });
			if (mode === "malformed")
				setTimeout(() => {
					process.stdout.write("{invalid\n");
				}, 20);
		}
		if (message.method === "turn/start" || message.method === "turn/steer") {
			if (message.method === "turn/start") turnNumber++;
			const id = `turn-${turnNumber}`;
			const turn = { id, status: "inProgress", items: [], itemsView: "notLoaded" };
			emit({ id: message.id, result: message.method === "turn/start" ? { turn } : { turnId: id } });
			if (mode === "approval")
				emit({ id: "approval-example", method: "item/commandExecution/requestApproval", params: {} });
			if (message.params?.input?.[0]?.text === "finish")
				setTimeout(() => {
					for (const text of ["earlier answer", "final first line\nsecond line"]) {
						emit({
							method: "item/completed",
							params: {
								threadId: "thread-example",
								turnId: id,
								item: { type: "agentMessage", id: text, text },
								completedAtMs: 0,
							},
						});
					}
					emit({
						method: "item/completed",
						params: {
							threadId: "another-thread",
							turnId: id,
							item: { type: "agentMessage", id: "foreign", text: "wrong thread" },
						},
					});
					emit({
						method: "item/completed",
						params: {
							threadId: "thread-example",
							turnId: "another-turn",
							item: { type: "agentMessage", id: "foreign", text: "wrong turn" },
						},
					});
					const completed = {
						method: "turn/completed",
						params: {
							threadId: "thread-example",
							turn: { ...turn, status: mode === "failed" ? "failed" : "completed", itemsView: "summary" },
						},
					};
					emit(completed);
					emit(completed);
				}, 20);
		}
	});
}
