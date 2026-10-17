import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { BashResult } from "../../src/core/bash-executor.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => rpcIo.outputLines.push(line),
}));

vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

interface LocalRun {
	command: string;
	observation: { pid?: number; result?: BashResult };
	promise: Promise<BashResult>;
}

const harnesses: Harness[] = [];
const runs: LocalRun[] = [];
const listenerCleanups: Array<() => void> = [];

function trackRun(command: string, execute: (onChunk: (chunk: string) => void) => Promise<BashResult>): LocalRun {
	const observation: LocalRun["observation"] = {};
	let output = "";
	const promise = execute((chunk) => {
		output += chunk;
		const match = output.match(/pid:(\d+)/);
		if (match) observation.pid = Number(match[1]);
	}).then((result) => {
		observation.result = result;
		return result;
	});
	const run = { command, observation, promise };
	runs.push(run);
	return run;
}

function startSleep(harness: Harness, name: string): LocalRun {
	// exec preserves the shell's PID as the real sleep process and process-group leader.
	const command = `printf '${name} pid:%s\n' "$$"; exec sleep 30`;
	return trackRun(command, (onChunk) => harness.session.executeBash(command, onChunk));
}

function pidIsGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		throw error;
	}
}

async function waitUntil(predicate: () => boolean): Promise<boolean> {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() >= deadline) return false;
		await delay(20);
	}
	return true;
}

async function expectStarted(...localRuns: LocalRun[]): Promise<void> {
	expect(await waitUntil(() => localRuns.every((run) => run.observation.pid !== undefined))).toBe(true);
	for (const run of localRuns) {
		expect(pidIsGone(run.observation.pid!)).toBe(false);
	}
}

async function expectStopped(run: LocalRun, label: string): Promise<void> {
	await vi.waitFor(
		() => {
			expect(pidIsGone(run.observation.pid!), `${label} process gone (ESRCH)`).toBe(true);
			expect(pidIsGone(-run.observation.pid!), `${label} process group gone (ESRCH)`).toBe(true);
			expect(run.observation.result?.cancelled, `${label} cancelled`).toBe(true);
		},
		{ timeout: 2000, interval: 20 },
	);
}

async function startRpc(harness: Harness): Promise<(command: object) => void> {
	// Reuse the in-process RPC harness pattern; observe output while delegating to the real executor.
	const executeBash = harness.session.executeBash.bind(harness.session);
	vi.spyOn(harness.session, "executeBash").mockImplementation((command, onChunk, options) => {
		return trackRun(command, (observe) =>
			executeBash(
				command,
				(chunk) => {
					observe(chunk);
					onChunk?.(chunk);
				},
				options,
			),
		).promise;
	});
	const stdinListeners = process.stdin.listeners("end");
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	const signalListeners = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
	listenerCleanups.push(() => {
		for (const listener of process.stdin.listeners("end")) {
			if (!stdinListeners.includes(listener)) process.stdin.off("end", listener as () => void);
		}
		for (const [signal, listeners] of signalListeners) {
			for (const listener of process.listeners(signal)) {
				if (!listeners.includes(listener)) process.off(signal, listener);
			}
		}
	});
	const runtimeHost = {
		session: harness.session,
		setRebindSession: vi.fn(),
		dispose: vi.fn(async () => {}),
	} as unknown as AgentSessionRuntime;
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	return (command) => rpcIo.lineHandler!(JSON.stringify(command));
}

function rpcResponses(): Array<Record<string, unknown>> {
	return rpcIo.outputLines.flatMap((line) => line.trim().split("\n")).map((line) => JSON.parse(line));
}

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const harness of harnesses) harness.session.abortBash();
	// Base and mutation failures must also reap the older, untracked process by its observed PID.
	for (const run of runs) {
		const pid = run.observation.pid;
		if (pid !== undefined && !pidIsGone(pid)) process.kill(pid, "SIGKILL");
	}
	expect(await waitUntil(() => runs.every((run) => run.observation.result !== undefined))).toBe(true);
	for (const run of runs) {
		if (run.observation.pid !== undefined) {
			expect(pidIsGone(run.observation.pid)).toBe(true);
			expect(pidIsGone(-run.observation.pid)).toBe(true);
		}
	}
	runs.length = 0;
	while (harnesses.length > 0) harnesses.pop()!.cleanup();
	while (listenerCleanups.length > 0) listenerCleanups.pop()!();
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
});

describe("AgentSession concurrent local bash", () => {
	it("positive control: completes one local command normally", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const result = await harness.session.executeBash("printf 'local bash works'");
		expect(result).toMatchObject({ output: "local bash works", exitCode: 0, cancelled: false });
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("T1: one abort cancels both real processes and removes both process groups", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const first = startSleep(harness, "first");
		const second = startSleep(harness, "second");
		await expectStarted(first, second);
		harness.session.abortBash();
		await expectStopped(first, "T1 first");
		await expectStopped(second, "T1 second");
		const results = await Promise.all([first.promise, second.promise]);
		expect(results.map((result) => result.cancelled)).toEqual([true, true]);
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("T2: keeps A running after B finishes first, then cancels A", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const first = startSleep(harness, "first");
		await expectStarted(first);
		const second = await harness.session.executeBash("true");
		expect(second).toMatchObject({ exitCode: 0, cancelled: false });
		expect(harness.session.isBashRunning, "T2 isBashRunning while A remains").toBe(true);
		harness.session.abortBash();
		await expectStopped(first, "T2 first");
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("T3: persists each concurrent cancelled command exactly once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const first = startSleep(harness, "first");
		const second = startSleep(harness, "second");
		await expectStarted(first, second);
		harness.session.abortBash();
		const expected = [first, second].map((run) => ({ command: run.command, cancelled: true }));
		await vi.waitFor(
			() => {
				const messages = harness.session.messages.filter((message) => message.role === "bashExecution");
				expect(messages.map(({ command, cancelled }) => ({ command, cancelled }))).toEqual(
					expect.arrayContaining(expected),
				);
				expect(messages).toHaveLength(2);
			},
			{ timeout: 2000, interval: 20 },
		);
		const entries = harness.sessionManager.getEntries();
		expect(entries).toHaveLength(2);
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
		expect(entries.map((entry) => entry.type === "message" && entry.message)).toEqual(
			expect.arrayContaining(expected.map((message) => expect.objectContaining(message))),
		);
	});

	it("T4: leaves no local process handles or pending timers after abort", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const countProcesses = () => process.getActiveResourcesInfo().filter((name) => name === "ProcessWrap").length;
		const baseline = countProcesses();
		const first = startSleep(harness, "first");
		const second = startSleep(harness, "second");
		await expectStarted(first, second);
		expect(countProcesses()).toBe(baseline + 2);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		harness.session.abortBash();
		expect(await waitUntil(() => countProcesses() === baseline), "T4 no pending local process handles").toBe(true);
		expect(vi.getTimerCount(), "T4 no pending timers").toBe(0);
		expect([first.observation.result?.cancelled, second.observation.result?.cancelled]).toEqual([true, true]);
	});

	it("dispose cancels every real local execution", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const first = startSleep(harness, "first");
		const second = startSleep(harness, "second");
		await expectStarted(first, second);
		harness.session.dispose();
		await expectStopped(first, "dispose first");
		await expectStopped(second, "dispose second");
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("RPC positive control: completes one local bash request normally", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const send = await startRpc(harness);
		send({ id: "normal", type: "bash", command: "printf 'rpc bash works'" });
		await vi.waitFor(() =>
			expect(rpcResponses()).toContainEqual({
				id: "normal",
				type: "response",
				command: "bash",
				success: true,
				data: expect.objectContaining({ output: "rpc bash works", exitCode: 0, cancelled: false }),
			}),
		);
	});

	it("T5: one RPC abort_bash cancels two overlapping local bash requests", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const send = await startRpc(harness);
		for (const id of ["first", "second"]) {
			send({ id, type: "bash", command: `printf '${id} pid:%s\n' "$$"; exec sleep 30` });
		}
		expect(runs).toHaveLength(2);
		await expectStarted(...runs);
		send({ id: "cancel", type: "abort_bash" });
		await vi.waitFor(() =>
			expect(rpcResponses()).toContainEqual({
				id: "cancel",
				type: "response",
				command: "abort_bash",
				success: true,
			}),
		);
		for (const id of ["first", "second"]) {
			await vi.waitFor(
				() =>
					expect(rpcResponses()).toContainEqual({
						id,
						type: "response",
						command: "bash",
						success: true,
						data: expect.objectContaining({ cancelled: true }),
					}),
				{ timeout: 2000, interval: 20 },
			);
		}
		expect(rpcResponses()).toHaveLength(3);
		await expectStopped(runs[0], "T5 first");
		await expectStopped(runs[1], "T5 second");
	});
});
