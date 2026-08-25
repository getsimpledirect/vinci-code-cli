/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import { writeSync } from "node:fs";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { emitSessionBeforeExitEvent } from "../core/extensions/runner.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { vinciMaskEnabled, vinciMaskJson, vinciMaskSecrets } from "../core/vinci-mask-secrets.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";

// The 180000ms default is deliberately generous to avoid false kills during slow provider activity;
// genuine silent wedges have lasted hours, so it remains a useful bound.
const VINCI_PRESTREAM_TIMEOUT_MS = 180_000;
const VINCI_PRESTREAM_TIMEOUT_MAX_MS = 300_000;
export let terminating = false;

export function setPrintModeTerminatingForTest(value: boolean): void {
	terminating = value;
}

export interface PrintModeLivenessClock {
	setTimeout(callback: () => void, timeoutMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface PrintModeLivenessWatchdog {
	activity(): void;
	toolExecutionStart(toolCallId: string): void;
	toolHooksStart(toolCallId: string): void;
	toolExecutionEnd(toolCallId: string): void;
	turnBoundary(): void;
	cancel(): void;
}

export interface StartupLivenessWatchdog {
	cancel(): void;
}

const printModeLivenessClock: PrintModeLivenessClock = {
	setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

let startupLivenessWatchdog: StartupLivenessWatchdog | undefined;

// [vinci #180] The watchdog bounds a pre-stream wedge honestly, but every occurrence printed the
// same one sentence — so a wedge that recurs in waves stayed undiagnosable for weeks. Startup now
// leaves a breadcrumb: the last phase it entered is reported when the watchdog fires, which turns
// "it hung" into "it hung in <phase>". Deliberately a plain string with no allocation on the hot
// path — this runs before anything is initialised, so it cannot depend on logging or settings.
let startupPhase = "process start";

/** Record the startup phase now in flight. Cheap, and safe to call before any service exists. */
export function markStartupPhase(phase: string): void {
	startupPhase = phase;
}

export function currentStartupPhase(): string {
	return startupPhase;
}

function cancelStartupLivenessWatchdog(): void {
	startupLivenessWatchdog?.cancel();
	startupLivenessWatchdog = undefined;
}

export function armStartupLivenessWatchdog(
	clock: PrintModeLivenessClock = printModeLivenessClock,
): StartupLivenessWatchdog {
	cancelStartupLivenessWatchdog();
	const timeoutMs = printModePrestreamTimeoutMs();
	let active = true;
	let handle: unknown;

	const stopTimer = (): void => {
		if (handle === undefined) return;
		clock.clearTimeout(handle);
		handle = undefined;
	};

	const armTimer = (): void => {
		if (!active) return;
		stopTimer();
		handle = clock.setTimeout(() => {
			handle = undefined;
			if (!active || terminating) return;
			active = false;
			writeSync(
				2,
				`BLOCKED: Startup did not complete within ${timeoutMs}ms; the run was stopped before the first prompt. ` +
					`Last startup phase reached: ${startupPhase}.\n`,
			);
			killTrackedDetachedChildren();
			process.exit(1);
		}, timeoutMs);
	};

	armTimer();

	const cancel = (): void => {
		if (!active) return;
		active = false;
		stopTimer();
	};

	startupLivenessWatchdog = { cancel };
	return startupLivenessWatchdog;
}

export function armPrintModeLivenessWatchdog(
	onTimeout: () => void,
	timeoutMs: number,
	clock: PrintModeLivenessClock = printModeLivenessClock,
): PrintModeLivenessWatchdog {
	let active = true;
	// Ids of tools whose OWN execution window is open (started, no hooks-start/end seen yet).
	// Set membership — not a counter — so duplicate or stray end/hooks events are no-ops by
	// construction and can never underflow the suspension state of a still-running sibling.
	const executing = new Set<string>();
	let handle: unknown;

	const stopTimer = (): void => {
		if (handle === undefined) return;
		clock.clearTimeout(handle);
		handle = undefined;
	};

	const armTimer = (): void => {
		if (!active || executing.size > 0) return;
		stopTimer();
		handle = clock.setTimeout(() => {
			handle = undefined;
			if (!active || executing.size > 0 || terminating) return;
			active = false;
			onTimeout();
		}, timeoutMs);
	};

	armTimer();

	const activity = (): void => {
		if (!active || executing.size > 0) return;
		armTimer();
	};

	const toolExecutionStart = (toolCallId: string): void => {
		if (!active) return;
		executing.add(toolCallId);
		stopTimer();
	};

	// The tool's own work is done; its extension hooks are ours to bound, so the timer re-arms.
	const toolHooksStart = (toolCallId: string): void => {
		if (!active) return;
		executing.delete(toolCallId);
		if (executing.size === 0) armTimer();
	};

	const toolExecutionEnd = (toolCallId: string): void => {
		if (!active) return;
		executing.delete(toolCallId);
		if (executing.size === 0) armTimer();
	};

	// A turn boundary proves no tool is still executing. Without this, an execution window whose
	// end event never arrived (abort racing the emit) would suspend the watchdog for the rest of
	// the prompt — reintroducing the unbounded silent hang this watchdog exists to prevent.
	const turnBoundary = (): void => {
		if (!active) return;
		executing.clear();
		armTimer();
	};

	const cancel = (): void => {
		if (!active) return;
		active = false;
		stopTimer();
	};

	return { activity, toolExecutionStart, toolHooksStart, toolExecutionEnd, turnBoundary, cancel };
}

export function printModePrestreamTimeoutMs(): number {
	const parsed = Number(process.env.VINCI_PRESTREAM_TIMEOUT_MS);
	return Number.isInteger(parsed) && parsed >= 1 && parsed <= VINCI_PRESTREAM_TIMEOUT_MAX_MS
		? parsed
		: VINCI_PRESTREAM_TIMEOUT_MS;
}

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
/**
 * Decide a print-mode run's exit code. Extracted so the invariant can be tested without a live
 * provider, and so it cannot drift back inside a mode guard.
 *
 * THE INVARIANT: a provider/stream failure is non-zero in EVERY output mode. This whole decision
 * used to sit inside `if (mode === "text")`, so `--mode json` returned 0 when the provider errored —
 * and json is the mode scripted callers use. That is the same bug the text path was fixed for on
 * 2026-07-16 ("scripted callers must not read exit 0 as success"), left live in the other mode.
 * Observed for real 2026-07-28: a provider outage returned 500s and corpus runs driving
 * `vinci --mode json -p` recorded exit 0 on runs that did nothing at all.
 */
export function printModeExitCode({
	mode,
	lastMessage,
	submitted,
	headlessExitHint,
}: {
	mode: "text" | "json";
	lastMessage: { role?: string; stopReason?: string; errorMessage?: string } | undefined;
	submitted: string[];
	headlessExitHint?: number;
}): { exitCode: number; emitText: boolean; message?: string } {
	if (lastMessage?.role !== "assistant") {
		const lastInput = (submitted[submitted.length - 1] ?? "").trim();
		if (submitted.every((m) => m.trim() === "")) {
			return {
				exitCode: 2,
				emitText: false,
				message: 'No prompt was provided — pass a request, e.g. vinci -p "add a login form".',
			};
		}
		// A real command token (`/undo`, `/model gpt`), NOT a path-like prompt (`/etc/hosts is wrong`).
		if (/^\/[a-z][a-z0-9-]*(?:\s|$)/.test(lastInput)) return { exitCode: 0, emitText: false };
		return {
			exitCode: 1,
			emitText: false,
			message: "The run ended without a final answer (provider or stream failure).",
		};
	}
	if (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
		return { exitCode: 1, emitText: false, message: lastMessage.errorMessage || `Request ${lastMessage.stopReason}` };
	}
	return { exitCode: headlessExitHint ?? 0, emitText: mode === "text" };
}

export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	// A SHARED, cached disposal promise so every caller (the signal handler AND the finally block) awaits
	// the SAME in-progress dispose — the old `disposed` boolean let the second caller return instantly
	// without awaiting, racing a normal return against the signal's exit code.
	let disposePromise: Promise<void> | undefined;
	// When a signal is received, the intended process exit code (143 SIGTERM / 129 SIGHUP). The main flow
	// returns THIS when terminating, so whichever path exits first yields the same code (race made benign).
	let signalExitCode: number | undefined;
	const signalCleanupHandlers: Array<() => void> = [];
	const timeoutMs = printModePrestreamTimeoutMs();
	let prestreamWatchdog: PrintModeLivenessWatchdog | undefined;

	const cancelPrestreamWatchdog = (): void => {
		prestreamWatchdog?.cancel();
		prestreamWatchdog = undefined;
	};

	const promptWithPrestreamWatchdog = async (prompt: () => Promise<void>): Promise<void> => {
		if (terminating) return;
		cancelPrestreamWatchdog();
		cancelStartupLivenessWatchdog();
		const watchdog = armPrintModeLivenessWatchdog(() => {
			writeSync(
				2,
				`BLOCKED: The provider stopped responding (no activity for ${timeoutMs}ms); the print-mode run was stopped.\n`,
			);
			killTrackedDetachedChildren();
			process.exit(1);
		}, timeoutMs);
		prestreamWatchdog = watchdog;
		try {
			await prompt();
		} finally {
			watchdog.cancel();
			if (prestreamWatchdog === watchdog) {
				prestreamWatchdog = undefined;
			}
		}
	};

	const disposeRuntime = (): Promise<void> => {
		if (!disposePromise) {
			disposePromise = (async () => {
				unsubscribe?.();
				await runtimeHost.dispose();
			})();
		}
		return disposePromise;
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				terminating = true;
				signalExitCode = signal === "SIGHUP" ? 129 : 143;
				// Record the code SYNCHRONOUSLY: even if this process later exits via the natural return
				// path (or the listener is removed), the signal's exit code stands, never a normal 0/1.
				process.exitCode = signalExitCode;
				cancelPrestreamWatchdog();
				cancelStartupLivenessWatchdog();
				killTrackedDetachedChildren();
				// Bound the signal-triggered dispose: a stalled shutdown handler must not hang the exit.
				void Promise.race([
					disposeRuntime().catch(() => {}),
					new Promise((resolve) => setTimeout(resolve, 5000)),
				]).finally(() => process.exit(signalExitCode));
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			headlessNotify: (message, type = "info") => {
				const safe = vinciMaskEnabled() ? vinciMaskSecrets(message) : message;
				process.stderr.write(`[${type}] ${safe}\n`);
			},
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			// Tool execution windows suspend the liveness timer — a long quiet local build is not a wedge.
			// Hooks run with the timer armed, and tool/boundary events are handled exclusively (not
			// also as generic activity) so the suspend/resume pairing has no ordering dependence.
			if (event.type === "tool_execution_start") {
				prestreamWatchdog?.toolExecutionStart(event.toolCallId);
			} else if (event.type === "tool_hooks_start") {
				prestreamWatchdog?.toolHooksStart(event.toolCallId);
			} else if (event.type === "tool_execution_end") {
				prestreamWatchdog?.toolExecutionEnd(event.toolCallId);
			} else if (event.type === "turn_end" || event.type === "agent_end") {
				prestreamWatchdog?.turnBoundary();
			} else {
				prestreamWatchdog?.activity();
			}
			if (mode === "json") {
				// [vinci] mask secrets in the JSON event stream too (assistant text + raw tool results
				// carry keys). Mask the structured event before serialization so redaction can never consume
				// JSON punctuation or turn numeric telemetry into invalid syntax. Same "piped to a log never
				// emits a live key" intent as the text path below — json includes raw tool output.
				const line = JSON.stringify(vinciMaskEnabled() ? vinciMaskJson(event) : event);
				writeRawStdout(`${line}\n`);
			}
		});
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage && !terminating) {
			await promptWithPrestreamWatchdog(() => session.prompt(initialMessage, { images: initialImages }));
		}

		for (const message of messages) {
			if (terminating) break;
			await promptWithPrestreamWatchdog(() => session.prompt(message));
		}

		// [vinci #194] A one-shot run must not decide its exit code while extensions still have
		// background work in flight: crew agents run for minutes after the main turn ends, and the
		// old flow exited 0 with a DONE "read-only" outcome while session_shutdown (which runs AFTER
		// the exit decision, in the finally) stopped them unfinished. Extensions await their work in
		// session_before_exit; agent results are delivered as follow-up turns, so after each pass the
		// mode waits for idle and re-checks — new work spawned by those turns gets its own pass. The
		// bound is a backstop against a pathological spawn loop, not a budget extensions should hit.
		if (!terminating) {
			for (let pass = 0; !terminating && session.extensionRunner && pass < 20; pass++) {
				const messagesBefore = session.state.messages.length;
				const emitted = await emitSessionBeforeExitEvent(session.extensionRunner, {
					type: "session_before_exit",
					mode,
				});
				if (!emitted) break;
				// Follow-up turns triggered by settled background work stream like any other turn and
				// get the same liveness watchdog: a provider wedge mid-integration must terminate the
				// run, not hang it forever. (The emit itself is unwatched on purpose — a long legit
				// crew wait is quiet on the session, and the crew narrates its own progress.)
				await promptWithPrestreamWatchdog(() => session.agent.waitForIdle());
				if (session.state.messages.length === messagesBefore) break;
			}
		}

		{
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];
			const submitted = [initialMessage, ...messages].filter((m): m is string => typeof m === "string");
			// ONE decision, shared by both modes. Keeping this inline is how `--mode json` drifted to
			// always-0 while text mode was fixed; printModeExitCode is unit-tested for both modes.
			const decision = printModeExitCode({
				mode,
				lastMessage,
				submitted,
				headlessExitHint: session.extensionRunner?.getHeadlessExitHint(),
			});
			if (decision.message) console.error(decision.message);
			exitCode = decision.exitCode;
			if (decision.emitText && lastMessage?.role === "assistant") {
				for (const content of (lastMessage as AssistantMessage).content) {
					if (content.type === "text") {
						// [vinci] mask any secret the model echoed, same as the interactive TUI, so
						// `pi -p` output (which is often piped to a file/log) never emits a live key.
						writeRawStdout(`${vinciMaskEnabled() ? vinciMaskSecrets(content.text) : content.text}\n`);
					}
				}
			}
		}

		// If a signal fired, return its exit code (143/129), never a normal one — so if the main flow
		// wins the race against the signal handler's process.exit, the caller still exits with the signal code.
		return signalExitCode ?? exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return signalExitCode ?? 1;
	} finally {
		cancelPrestreamWatchdog();
		cancelStartupLivenessWatchdog();
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
