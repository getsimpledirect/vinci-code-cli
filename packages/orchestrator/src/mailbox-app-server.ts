// [vinci] A client-owned stdio process; never connects to an existing server.
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, rmdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { inspectMailbox, MailboxError, readMailboxEvents, requireMailbox, sendMailboxEvent } from "./mailbox.ts";

// Minimal client shapes from the locally generated app-server protocol.
type TextInput = { type: "text"; text: string; text_elements: [] };
type Requests = {
	initialize: { clientInfo: { name: string; title: null; version: string }; capabilities: null };
	"thread/start": { cwd: string };
	"turn/start": { threadId: string; input: TextInput[] };
	"turn/steer": { threadId: string; input: TextInput[]; expectedTurnId: string };
};
type AssistantItem = { type: "agentMessage"; id: string; text: string };
type Turn = {
	id: string;
	status: "completed" | "failed" | "interrupted" | "inProgress";
	items: unknown[];
	itemsView: "full" | "summary" | "notLoaded";
};
type TurnCompleted = { threadId: string; turn: Turn };
type ItemCompleted = { threadId: string; turnId: string; item: unknown };

export interface MailboxAdapterOptions {
	directory: string;
	codexHome: string;
	cwd: string;
	codexPath?: string;
	resultPath?: string;
	pollMs?: number;
	requestTimeoutMs?: number;
	report?: (message: string) => void;
}

export interface MailboxAdapter {
	pid: number;
	finished: Promise<void>;
	stop: () => Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantItem(value: unknown): value is AssistantItem {
	return (
		record(value) && value.type === "agentMessage" && typeof value.id === "string" && typeof value.text === "string"
	);
}

export async function startMailboxAdapter(options: MailboxAdapterOptions): Promise<MailboxAdapter> {
	requireMailbox();
	const mailbox = inspectMailbox(options.directory);
	for (const path of [options.codexHome, options.cwd]) {
		if (typeof path !== "string" || !isAbsolute(path) || !lstatSync(path).isDirectory()) {
			throw new MailboxError(
				`Invalid process directory ${JSON.stringify(path)}; supply an absolute real directory.`,
			);
		}
	}
	const pollMs = options.pollMs ?? 100;
	const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
	if (!Number.isFinite(pollMs) || pollMs < 1 || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1) {
		throw new MailboxError(
			`Invalid adapter bounds ${JSON.stringify([pollMs, requestTimeoutMs])}; use positive finite milliseconds.`,
		);
	}
	const report = options.report ?? console.error;
	if (options.codexPath !== undefined && (typeof options.codexPath !== "string" || !options.codexPath)) {
		throw new MailboxError(`Invalid executable ${JSON.stringify(options.codexPath)}; supply an executable path.`);
	}
	if (options.resultPath !== undefined && typeof options.resultPath !== "string") {
		throw new MailboxError(`Invalid result path ${JSON.stringify(options.resultPath)}; supply a string path.`);
	}
	const lock = join(mailbox.directory, "adapter.lock");
	try {
		mkdirSync(lock, { mode: 0o700 });
	} catch (error) {
		throw new MailboxError(
			`Cannot own adapter lock ${JSON.stringify(lock)}: ${JSON.stringify(String(error))}; check the existing owner before restarting.`,
		);
	}
	const lockStat = lstatSync(lock);
	const child = spawn(options.codexPath ?? "codex", ["app-server"], {
		cwd: options.cwd,
		env: { ...process.env, CODEX_HOME: options.codexHome },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stopped = false;
	let exited = false;
	let failed: Error | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let nextId = 1;
	let after = 0;
	let threadId = "";
	let activeTurn: string | undefined;
	let starting: Promise<void> | undefined;
	let lastAssistant: AssistantItem | undefined;
	let resultPath = options.resultPath ?? null;
	let notifications = Promise.resolve();
	let polling = Promise.resolve();
	const completed = new Set<string>();
	const pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	let finish: () => void = () => {};
	let rejectFinished: (error: Error) => void = () => {};
	const finished = new Promise<void>((resolve, reject) => {
		finish = resolve;
		rejectFinished = reject;
	});
	// A failure during initialization is also returned by this function.
	void finished.catch(() => {});
	let close: () => void = () => {};
	const closed = new Promise<void>((resolve) => {
		close = resolve;
	});

	function rejectPending(error: Error): void {
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		pending.clear();
	}

	function stopChild(): void {
		if (stopped) return;
		stopped = true;
		clearTimeout(timer);
		rejectPending(failed ?? new Error('App-server request cancelled by "stop"; start a new adapter before sending.'));
		if (!exited) {
			child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (!exited) child.kill("SIGKILL");
			}, 1000);
		}
	}

	function fail(error: unknown): void {
		if (failed || stopped) return;
		failed = error instanceof Error ? error : new Error(String(error));
		report(
			`ERROR: app-server adapter refused ${JSON.stringify(failed.message)}; check the job configuration before restarting.`,
		);
		stopChild();
	}

	function request<M extends keyof Requests>(method: M, params: Requests[M]): Promise<unknown> {
		if (stopped) return Promise.reject(new Error('App-server is "stopped"; start a new adapter.'));
		const id = nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(
					new Error(
						`App-server request ${JSON.stringify(method)} timed out; inspect the child before restarting.`,
					),
				);
			}, requestTimeoutMs);
			pending.set(id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
				if (error) fail(error);
			});
		});
	}

	async function notification(method: string, params: unknown): Promise<void> {
		if (starting) await starting;
		if (!record(params) || params.threadId !== threadId) return;
		if (method === "item/completed") {
			const item = params as ItemCompleted;
			if (item.turnId === activeTurn && assistantItem(item.item)) lastAssistant = item.item;
		} else if (method === "turn/completed") {
			if (!record(params.turn) || typeof params.turn.id !== "string")
				throw new Error('Malformed "turn/completed"; inspect the protocol.');
			const { turn } = params as TurnCompleted;
			if (completed.has(turn.id) || turn.id !== activeTurn) return;
			if (!["completed", "failed", "interrupted"].includes(turn.status) || !Array.isArray(turn.items))
				throw new Error('Invalid terminal "turn"; inspect the protocol.');
			completed.add(turn.id);
			activeTurn = undefined;
			const included = turn.items.filter(assistantItem).at(-1);
			const last = turn.itemsView === "full" ? (included ?? lastAssistant) : (lastAssistant ?? included);
			await sendMailboxEvent(mailbox.directory, "out", {
				from: "app-server",
				status: turn.status === "completed" ? "done" : turn.status === "failed" ? "failed" : "blocked",
				text: (last?.text ?? "").split(/\r\n|\r|\n/, 1)[0],
				result: resultPath,
			});
		} else if (method === "error" && params.turnId === activeTurn && params.willRetry !== true) {
			throw new Error('App-server reported a terminal "error"; inspect the job before restarting.');
		}
	}

	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		if (stopped) return;
		try {
			const message: unknown = JSON.parse(line);
			if (!record(message)) throw new Error('Invalid app-server "message"; inspect the protocol.');
			if (typeof message.method === "string") {
				if ("id" in message) {
					report(
						`WARNING: refused app-server request ${JSON.stringify(message.method)}; handle this interaction outside the adapter.`,
					);
					child.stdin.write(
						`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported client request" } })}\n`,
					);
					return;
				}
				notifications = notifications
					.then(() => notification(message.method as string, message.params))
					.catch(fail);
			} else if (typeof message.id === "number") {
				const entry = pending.get(message.id);
				if (!entry) return;
				pending.delete(message.id);
				clearTimeout(entry.timer);
				if ("error" in message)
					entry.reject(new Error('App-server returned an RPC "error"; inspect the job configuration.'));
				else if ("result" in message) entry.resolve(message.result);
				else entry.reject(new Error('App-server response lacks "result"; inspect the protocol.'));
			}
		} catch (error) {
			fail(error);
		}
	});
	child.stderr.on("data", () => {
		/* Drain private diagnostics without forwarding their contents. */
	});
	child.stdin.on("error", fail);
	child.once("error", fail);
	child.once("close", (code, signal) => {
		exited = true;
		clearTimeout(killTimer);
		if (!stopped)
			fail(
				new Error(`App-server exited with ${JSON.stringify({ code, signal })}; inspect the job before restarting.`),
			);
		rejectPending(failed ?? new Error('App-server is "closed"; start a new adapter.'));
		lines.close();
		try {
			const stat = lstatSync(lock);
			if (stat.dev !== lockStat.dev || stat.ino !== lockStat.ino) throw new Error("lock identity changed");
			rmdirSync(lock);
		} catch {
			report(
				`WARNING: retained adapter lock ${JSON.stringify(lock)} after a directory change; check its identity before removing it.`,
			);
		}
		close();
		void Promise.all([notifications, polling]).then(() => {
			if (failed) rejectFinished(failed);
			else finish();
		});
	});

	async function poll(): Promise<void> {
		if (stopped) return;
		if (inspectMailbox(mailbox.directory).identity !== mailbox.identity)
			throw new Error('Mailbox identity "changed"; reopen the intended mailbox.');
		for (const event of readMailboxEvents(mailbox.directory, "in", report).filter((event) => event.seq > after)) {
			if (stopped) return;
			const input: TextInput[] = [{ type: "text", text: event.text, text_elements: [] }];
			if (activeTurn) {
				await request("turn/steer", { threadId, input, expectedTurnId: activeTurn });
				if (event.result !== null) resultPath = event.result;
			} else {
				lastAssistant = undefined;
				resultPath = event.result ?? options.resultPath ?? null;
				starting = request("turn/start", { threadId, input }).then((response) => {
					if (!record(response) || !record(response.turn) || typeof response.turn.id !== "string")
						throw new Error('Invalid "turn/start" response; inspect the protocol.');
					activeTurn = response.turn.id;
				});
				await starting;
				starting = undefined;
			}
			after = event.seq;
		}
		if (!stopped)
			timer = setTimeout(() => {
				polling = poll().catch(fail);
			}, pollMs);
	}

	try {
		await request("initialize", {
			clientInfo: { name: "mailbox-adapter", title: null, version: "1" },
			capabilities: null,
		});
		child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
		const response = await request("thread/start", { cwd: options.cwd });
		if (!record(response) || !record(response.thread) || typeof response.thread.id !== "string")
			throw new Error('Invalid "thread/start" response; inspect the protocol.');
		threadId = response.thread.id;
		if (child.pid === undefined) throw new Error('App-server has no "pid"; inspect process startup.');
		polling = poll().catch(fail);
		return {
			pid: child.pid,
			finished,
			stop: async () => {
				stopChild();
				await closed;
				await finished;
			},
		};
	} catch (error) {
		fail(error);
		await closed;
		throw error;
	}
}
