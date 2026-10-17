/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

import { validRpcData, validRpcEvent } from "./rpc-validation.ts";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

/** [vinci] Opt-in governed transport. Legacy consumers retain their wire contract. */
export interface BoundedRpcTransport {
	startupTimeoutMs?: number;
	maxFrameBytes?: number;
	maxStderrBytes?: number;
	maxPendingRequests?: number;
	shutdownTimeoutMs?: number;
	maxCollectedEvents?: number;
	maxCollectedBytes?: number;
}
const DEFAULT_BOUNDS = {
	startupTimeoutMs: 5000,
	maxFrameBytes: 4 * 1024 * 1024,
	maxStderrBytes: 64 * 1024,
	maxPendingRequests: 128,
	shutdownTimeoutMs: 1000,
	maxCollectedEvents: 10000,
	maxCollectedBytes: 16 * 1024 * 1024,
};

export interface RpcClientOptions {
	/** [vinci] Negotiate protocol v1 and enforce finite transport bounds. */
	boundedTransport?: BoundedRpcTransport;
	/** [vinci] Treat env as complete, rather than merging parent variables. */
	completeEnv?: boolean;
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export type RpcEventListener = (event: AgentEvent) => void;

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private pendingRequests: Map<
		string,
		{ command: string; resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
	> = new Map();
	private requestId = 0;
	private bounds: typeof DEFAULT_BOUNDS | undefined;
	private ready = false;
	private stopping: Promise<void> | null = null;
	private uiListeners: Array<(request: RpcExtensionUIRequest) => void> = [];
	private uiRequests = new Map<string, RpcExtensionUIRequest>();
	private uiTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private stderrBytes = 0;
	// [vinci] Event-waiters (waitForIdle/collectEvents) settle only on `agent_end`, so a child that
	// dies — crash, SIGKILL, or a deliberate stop() — used to leave their promise pending AND their
	// timeout timer armed and refed for its full duration (10 minutes for a crew helper). That timer
	// alone keeps the Node event loop alive, which is how `vinci/test/run.sh` came to sit at 0% CPU
	// after every check had passed. Every waiter registers its aborter here so the same code paths
	// that already reject in-flight requests can settle waiters too.
	private eventWaiterAborts: Set<(error: Error) => void> = new Set();
	private stderr = "";
	private exitError: Error | null = null;
	private options: RpcClientOptions;

	constructor(options: RpcClientOptions = {}) {
		this.options = options;
		if (options.boundedTransport) {
			this.bounds = { ...DEFAULT_BOUNDS, ...options.boundedTransport };
			for (const [name, value] of Object.entries(this.bounds)) {
				if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) {
					throw new Error(`Invalid RPC bound: ${name}`);
				}
			}
		}
	}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		this.exitError = null;
		this.ready = false;
		this.stderr = "";
		this.stderrBytes = 0;

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const childProcess = spawn(this.options.completeEnv ? process.execPath : "node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: this.options.completeEnv ? { ...this.options.env } : { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = childProcess;

		// Collect stderr for debugging
		childProcess.stderr?.on("data", (data) => {
			if (this.bounds) {
				if (this.exitError) return;
				const remaining = this.bounds.maxStderrBytes - this.stderrBytes;
				const bytes = Buffer.from(data);
				// Avoid a replacement character making the retained UTF-8 string exceed its byte cap.
				const retained = bytes.subarray(0, remaining).toString("utf8");
				this.stderr += retained;
				while (Buffer.byteLength(this.stderr) > this.bounds.maxStderrBytes) this.stderr = this.stderr.slice(0, -1);
				this.stderrBytes += bytes.length;
				if (bytes.length > remaining) this.failTransport(new Error("RPC protocol stderr exceeds byte limit"));
			} else {
				this.stderr += data.toString();
				process.stderr.write(data);
			}
		});

		childProcess.once("exit", (code, signal) => {
			if (this.process !== childProcess) return;
			const error = this.exitError ?? this.createProcessExitError(code, signal);
			this.exitError = error;
			this.rejectPendingRequests(error);
		});
		childProcess.once("error", (error) => {
			if (this.process !== childProcess) return;
			const processError = new Error(`Agent process error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = processError;
			this.rejectPendingRequests(processError);
		});
		childProcess.stdin?.on("error", (error) => {
			if (this.process !== childProcess) return;
			const stdinError =
				this.exitError ?? new Error(`Agent process stdin error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = stdinError;
			this.rejectPendingRequests(stdinError);
		});

		// Set up strict JSONL reader for stdout.
		this.stopReadingStdout = attachJsonlLineReader(
			childProcess.stdout!,
			(line) => {
				this.handleLine(line);
			},
			this.bounds
				? { maxFrameBytes: this.bounds.maxFrameBytes, onError: (error) => this.failTransport(error) }
				: undefined,
		);

		if (this.bounds) {
			try {
				const response = await this.send({ type: "get_protocol" }, this.bounds.startupTimeoutMs);
				if (!response.success || response.command !== "get_protocol" || response.data.version !== 1) {
					throw new Error("RPC protocol incompatible: version 1 required");
				}
				if (this.exitError) throw this.exitError;
				this.ready = true;
				return;
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				this.failTransport(failure);
				await this.stop();
				throw failure;
			}
		}

		// Wait a moment for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null) {
			const error = this.exitError ?? this.createProcessExitError(this.process.exitCode, this.process.signalCode);
			this.exitError = error;
			throw error;
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		const child = this.process;
		if (!child) return;
		this.ready = false;
		this.exitError ??= new Error("Agent process was stopped.");
		this.rejectPendingRequests(this.exitError);
		this.uiRequests.clear();
		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.stopping = (async () => {
			// Check before subscribing: a child which already exited will not emit exit again.
			const wait = (ms: number) =>
				new Promise<boolean>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined)
						return resolve(true);
					const finish = (exited: boolean) => {
						clearTimeout(timer);
						child.off("exit", onExit);
						resolve(exited);
					};
					const onExit = () => finish(true);
					const timer = setTimeout(() => finish(false), ms);
					child.once("exit", onExit);
				});
			child.kill("SIGTERM");
			if (!(await wait(this.bounds?.shutdownTimeoutMs ?? 1000))) {
				child.kill("SIGKILL");
				if (!(await wait(this.bounds?.shutdownTimeoutMs ?? 1000))) {
					throw new Error("RPC child exit could not be confirmed after SIGKILL");
				}
			}
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			if (this.process === child) this.process = null;
		})();
		try {
			await this.stopping;
		} finally {
			this.stopping = null;
		}
	}

	/** [vinci] UI requests are separate from agent progress. No automatic approval. */
	onUIRequest(listener: (request: RpcExtensionUIRequest) => void): () => void {
		this.uiListeners.push(listener);
		return () => {
			this.uiListeners = this.uiListeners.filter((item) => item !== listener);
		};
	}

	/** Explicit response to an outstanding dialog only, at most once. */
	respondToUI(response: RpcExtensionUIResponse): void {
		const request = this.uiRequests.get(response.id);
		if (!request || this.exitError || !this.ready) throw new Error("No outstanding RPC UI request");
		if (
			!("cancelled" in response && response.cancelled === true) &&
			!(request.method === "confirm"
				? "confirmed" in response && typeof response.confirmed === "boolean"
				: "value" in response &&
					typeof response.value === "string" &&
					(request.method !== "select" || request.options.includes(response.value)))
		) {
			throw new Error("Invalid RPC UI response");
		}
		const line = serializeJsonLine(response);
		if (this.bounds && Buffer.byteLength(line) > this.bounds.maxFrameBytes)
			throw new Error("RPC UI response exceeds frame limit");
		if (this.bounds && this.process!.stdin!.writableLength + Buffer.byteLength(line) > this.bounds.maxFrameBytes)
			throw new Error("RPC stdin pending byte limit reached");
		this.process!.stdin!.write(line);
		clearTimeout(this.uiTimers.get(response.id));
		this.uiTimers.delete(response.id);
		this.uiRequests.delete(response.id);
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "prompt", message, images });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * Clone the current active branch into a new session.
	 * @returns Object with `cancelled: true` if an extension cancelled the clone
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	/**
	 * Get messages available for forking.
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get session entries in append order, optionally only those after the `since` entry id.
	 */
	async getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		const response = await this.send({ type: "get_entries", since });
		return this.getData<{ entries: SessionEntry[]; leafId: string | null }>(response);
	}

	/**
	 * Get the session entry tree.
	 */
	async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
		const response = await this.send({ type: "get_tree" });
		return this.getData<{ tree: SessionTreeNode[]; leafId: string | null }>(response);
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * Set the session display name.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		if (this.exitError) return Promise.reject(this.exitError);
		if (this.bounds && this.eventWaiterAborts.size >= this.bounds.maxPendingRequests)
			return Promise.reject(new Error("RPC pending event waiter limit reached"));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				settle();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			// [vinci] One teardown for every exit route (agent_end, timeout, process death) so the
			// timer is always cleared and can never outlive the wait it was guarding.
			const settle = () => {
				clearTimeout(timer);
				unsubscribe();
				this.eventWaiterAborts.delete(abort);
			};
			const abort = (error: Error) => {
				settle();
				reject(error);
			};
			this.eventWaiterAborts.add(abort);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_end") {
					settle();
					resolve();
				}
			});
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000, signal?: AbortSignal): Promise<AgentEvent[]> {
		if (this.exitError) return Promise.reject(this.exitError);
		if (signal?.aborted) return Promise.reject(new Error("RPC event collection cancelled"));
		if (this.bounds && this.eventWaiterAborts.size >= this.bounds.maxPendingRequests)
			return Promise.reject(new Error("RPC pending event waiter limit reached"));
		return new Promise((resolve, reject) => {
			const events: AgentEvent[] = [];
			let bytes = 0;
			const timer = setTimeout(() => {
				settle();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			// [vinci] Same single teardown as waitForIdle: the collection timer is released on
			// agent_end, on timeout, AND when the agent process goes away underneath the wait.
			const settle = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				unsubscribe();
				this.eventWaiterAborts.delete(abort);
			};
			const abort = (error: Error) => {
				settle();
				reject(error);
			};
			const onAbort = () => abort(new Error("RPC event collection cancelled"));
			this.eventWaiterAborts.add(abort);

			const unsubscribe = this.onEvent((event) => {
				if (this.bounds) bytes += Buffer.byteLength(JSON.stringify(event));
				if (
					this.bounds &&
					(events.length >= this.bounds.maxCollectedEvents || bytes > this.bounds.maxCollectedBytes)
				) {
					abort(new Error("RPC collected event limit reached"));
					return;
				}
				events.push(event);
				if (event.type === "agent_end") {
					settle();
					resolve(events);
				}
			});
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const controller = new AbortController();
		const eventsPromise = this.collectEvents(timeout, controller.signal);
		try {
			// Observe both promises immediately: events may fail before prompt preflight responds.
			const [, events] = await Promise.all([this.prompt(message, images), eventsPromise]);
			return events;
		} finally {
			controller.abort();
		}
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);
			if (this.bounds) {
				this.handleBoundedMessage(data);
				return;
			}

			// Check if it's a response to a pending request
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			// Otherwise it's an event
			for (const listener of this.eventListeners) {
				listener(data as AgentEvent);
			}
		} catch {
			if (this.bounds) this.failTransport(new Error("RPC protocol malformed message"));
			// Legacy clients retain tolerance for non-JSON lines.
		}
	}

	private failTransport(error: Error): void {
		this.exitError ??= error;
		this.ready = false;
		this.rejectPendingRequests(this.exitError);
		this.uiRequests.clear();
		// Retain the error for the caller; bounded teardown is also awaited by explicit stop().
		void this.stop().catch(() => {});
	}

	private handleBoundedMessage(data: unknown): void {
		if (this.exitError) return;
		if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("Invalid RPC record");
		const value = data as Record<string, unknown>;
		if (value.type === "response") {
			if (
				typeof value.id !== "string" ||
				typeof value.command !== "string" ||
				typeof value.success !== "boolean" ||
				(!value.success && typeof value.error !== "string")
			)
				throw new Error("Invalid RPC response");
			const pending = this.pendingRequests.get(value.id);
			// Unknown, duplicate and late responses cannot settle a different operation or become events.
			if (!pending) return;
			if (value.command !== pending.command) throw new Error("Mismatched RPC response command");
			if (value.success && !validRpcData(value.command, value.data)) throw new Error("Invalid RPC response data");
			// Ready before dispatching another record in the same stdout chunk (e.g. a UI dialog).
			if (value.command === "get_protocol" && value.success && (value.data as { version: number }).version === 1)
				this.ready = true;
			this.pendingRequests.delete(value.id);
			pending.resolve(value as RpcResponse);
			return;
		}
		if (value.type === "extension_ui_request") {
			if (typeof value.id !== "string" || typeof value.method !== "string") throw new Error("Invalid UI request");
			const dialog = ["confirm", "select", "input", "editor"].includes(value.method);
			if (dialog) {
				if (
					value.timeout !== undefined &&
					(!Number.isSafeInteger(value.timeout) ||
						typeof value.timeout !== "number" ||
						value.timeout < 0 ||
						value.timeout > 0x7fffffff)
				)
					throw new Error("Invalid UI timeout");
				if (
					typeof value.title !== "string" ||
					(value.method === "confirm" && typeof value.message !== "string") ||
					(value.method === "select" &&
						(!Array.isArray(value.options) || !value.options.every((x) => typeof x === "string")))
				)
					throw new Error("Invalid UI dialog");
				if (this.uiRequests.has(value.id) || this.uiRequests.size >= this.bounds!.maxPendingRequests)
					throw new Error("RPC UI pending limit or duplicate ID");
				this.uiRequests.set(value.id, value as RpcExtensionUIRequest);
				if (typeof value.timeout === "number" && value.timeout > 0) {
					const id = value.id;
					this.uiTimers.set(
						id,
						setTimeout(() => {
							this.uiRequests.delete(id);
							this.uiTimers.delete(id);
						}, value.timeout),
					);
				}
			} else {
				const stringFields: Record<string, string> = {
					notify: "message",
					setStatus: "statusKey",
					setWidget: "widgetKey",
					setTitle: "title",
					set_editor_text: "text",
				};
				const field = stringFields[value.method];
				if (!field || typeof value[field] !== "string") throw new Error("Invalid UI notification");
			}
			for (const listener of this.uiListeners) listener(value as RpcExtensionUIRequest);
			return;
		}
		if (!validRpcEvent(value)) throw new Error("Invalid RPC event");
		for (const listener of this.eventListeners) listener(value as AgentEvent);
	}

	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
	}

	private rejectPendingRequests(error: Error): void {
		for (const timer of this.uiTimers.values()) clearTimeout(timer);
		this.uiTimers.clear();
		this.uiRequests.clear();
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
		// [vinci] A dead agent will never emit another `agent_end`, so anything waiting for one is
		// waiting forever. Fail those waits with the same error the requests get — and, crucially,
		// release their timers, which is what actually let the event loop drain.
		this.abortEventWaiters(error);
	}

	/**
	 * [vinci] Settle every outstanding waitForIdle/collectEvents wait. Iterates a copy: each abort
	 * removes itself from the live set.
	 */
	private abortEventWaiters(error: Error): void {
		for (const abort of [...this.eventWaiterAborts]) {
			abort(error);
		}
		this.eventWaiterAborts.clear();
	}

	private async send(command: RpcCommandBody, timeoutMs = 30000): Promise<RpcResponse> {
		const childProcess = this.process;
		const stdin = childProcess?.stdin;
		if (!childProcess || !stdin) {
			throw new Error("Client not started");
		}
		if (this.exitError) {
			throw this.exitError;
		}
		if (childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		if (stdin.destroyed || !stdin.writable) {
			const error = new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
			this.exitError = error;
			throw error;
		}

		if (this.bounds && command.type !== "get_protocol" && !this.ready) throw new Error("RPC protocol not ready");
		if (this.bounds && this.pendingRequests.size >= this.bounds.maxPendingRequests)
			throw new Error("RPC pending request limit reached");
		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;
		const line = serializeJsonLine(fullCommand);
		if (this.bounds && Buffer.byteLength(line) > this.bounds.maxFrameBytes)
			throw new Error("RPC command exceeds frame limit");
		if (this.bounds && stdin.writableLength + Buffer.byteLength(line) > this.bounds.maxFrameBytes)
			throw new Error("RPC stdin pending byte limit reached");

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				command: command.type,
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			try {
				stdin.write(line);
			} catch (error: unknown) {
				const writeError = error instanceof Error ? error : new Error(String(error));
				const pending = this.pendingRequests.get(id);
				this.pendingRequests.delete(id);
				pending?.reject(writeError);
			}
		});
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
