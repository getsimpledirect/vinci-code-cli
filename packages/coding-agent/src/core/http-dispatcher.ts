import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import * as undici from "undici";
import { guardQaRequests, QaRequestGuard } from "./qa-request-allowance.ts";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;
let qaRequestGuard: QaRequestGuard | undefined;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing pi.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const allowancePath = process.env.VINCI_QA_ALLOWANCE_FILE;
	if (qaRequestGuard && allowancePath !== qaRequestGuard.path) {
		throw new Error(
			"QA allowance cannot be removed or replaced in a running process. Stop and review a new allowance.",
		);
	}
	if (allowancePath !== undefined && !qaRequestGuard) {
		const location = relative(realpathSync(process.cwd()), realpathSync(allowancePath));
		if (location === "" || (!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`))) {
			throw new Error("BLOCKED: keep the operator's QA allowance outside the model workspace.");
		}
		qaRequestGuard = new QaRequestGuard(allowancePath);
	}
	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: normalizedTimeoutMs,
			headersTimeout: normalizedTimeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (qaRequestGuard && !shouldInstallGlobals) {
		void dispatcher.destroy();
		throw new Error("QA allowance cannot protect a custom global fetch. Stop and restore the managed HTTP runtime.");
	}
	undici.setGlobalDispatcher(guardQaRequests(dispatcher, qaRequestGuard));
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
	if (qaRequestGuard && !Object.hasOwn(globalThis, "__vinciQaRequestGuard")) {
		const guard = qaRequestGuard;
		const guardedFetch = globalThis.fetch;
		Object.defineProperty(globalThis, "__vinciQaRequestGuard", {
			value: Object.freeze({
				assertModel(model: { provider: string; api: string; id: string; baseUrl: string }) {
					if (globalThis.fetch !== guardedFetch) throw new Error("BLOCKED: managed QA fetch was replaced.");
					guard.assertModel(model);
				},
				close: (reason: "completed" | "revoked") => guard.close(reason),
			}),
		});
	}
}
