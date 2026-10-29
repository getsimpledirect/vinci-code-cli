import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Dispatcher } from "undici";

export interface QaRequestAllowance {
	schemaVersion: 1;
	id: string;
	maxRequests: number;
	expiresAt: string;
	allowedOrigins: string[];
	allowedModels: string[];
}

interface AllowanceState {
	schemaVersion: 1;
	id: string;
	configurationSha256: string;
	usedRequests: number;
	closed?: "completed" | "revoked";
}

function blocked(reason: string): never {
	throw new Error(
		`BLOCKED: QA request allowance — ${reason}. Stop requests and review the operator-approved allowance.`,
	);
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function readRegularFile(path: string): string {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size > 16_384) blocked("the allowance file is not a bounded regular file");
	return readFileSync(path, "utf8");
}

function syncDirectory(path: string): void {
	const fd = openSync(dirname(path), "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function validate(value: unknown): QaRequestAllowance {
	if (!value || typeof value !== "object" || Array.isArray(value)) blocked("configuration is invalid");
	const config = value as Partial<QaRequestAllowance>;
	if (
		config.schemaVersion !== 1 ||
		typeof config.id !== "string" ||
		!/^[a-zA-Z0-9._-]{1,128}$/.test(config.id) ||
		!Number.isSafeInteger(config.maxRequests) ||
		(config.maxRequests ?? 0) < 1 ||
		typeof config.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(config.expiresAt)) ||
		!Array.isArray(config.allowedOrigins) ||
		!Array.isArray(config.allowedModels) ||
		config.allowedModels.length < 1 ||
		!config.allowedModels.every((model) => typeof model === "string" && /^[a-zA-Z0-9._-]+$/.test(model)) ||
		config.allowedOrigins.length < 1 ||
		!config.allowedOrigins.every((origin) => {
			if (typeof origin !== "string") return false;
			try {
				const url = new URL(origin);
				return url.protocol === "https:" && origin === url.origin;
			} catch {
				return false;
			}
		})
	) {
		blocked("configuration needs an ID, positive request ceiling, expiry, and exact HTTPS origins");
	}
	return config as QaRequestAllowance;
}

/** Creates new operator-selected files only; never renews or resets an existing allowance. */
export function initializeQaRequestAllowance(path: string, value: QaRequestAllowance): void {
	if (!isAbsolute(path)) blocked("select an absolute allowance path outside the model workspace");
	const config = validate(value);
	if (Date.parse(config.expiresAt) <= Date.now()) blocked("the new allowance has already expired");
	const text = `${JSON.stringify(config, null, 2)}\n`;
	writeFileSync(path, text, { flag: "wx", mode: 0o600 });
	const state: AllowanceState = {
		schemaVersion: 1,
		id: config.id,
		configurationSha256: digest(text),
		usedRequests: 0,
	};
	writeFileSync(`${path}.state.json`, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
}

export class QaRequestGuard {
	readonly path: string;
	private readonly configurationSha256: string;

	constructor(path: string) {
		if (!isAbsolute(path)) blocked("select an absolute allowance path outside the model workspace");
		this.path = path;
		const text = readRegularFile(path);
		validate(JSON.parse(text));
		this.configurationSha256 = digest(text);
		this.readState();
	}

	private readState(): { config: QaRequestAllowance; state: AllowanceState } {
		const text = readRegularFile(this.path);
		if (digest(text) !== this.configurationSha256) blocked("configuration changed after the guard was armed");
		const config = validate(JSON.parse(text));
		const state = JSON.parse(readRegularFile(`${this.path}.state.json`)) as Partial<AllowanceState>;
		if (
			state.schemaVersion !== 1 ||
			state.id !== config.id ||
			state.configurationSha256 !== this.configurationSha256 ||
			!Number.isSafeInteger(state.usedRequests) ||
			(state.usedRequests ?? -1) < 0 ||
			(state.usedRequests ?? Infinity) > config.maxRequests ||
			(state.closed !== undefined && state.closed !== "completed" && state.closed !== "revoked")
		) {
			blocked("persisted usage is invalid or belongs to a different allowance");
		}
		// A separate tombstone closes without waiting for an in-flight reservation's lock.
		let closure: string | undefined;
		try {
			closure = readRegularFile(`${this.path}.closed.json`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (closure !== undefined) {
			const closed = JSON.parse(closure) as Partial<AllowanceState>;
			if (
				closed.id !== config.id ||
				closed.configurationSha256 !== this.configurationSha256 ||
				(closed.closed !== "completed" && closed.closed !== "revoked")
			)
				blocked("closure record is invalid");
			state.closed = closed.closed;
		}
		return { config, state: state as AllowanceState };
	}

	assertModel(model: { provider: string; api: string; id: string; baseUrl: string }): void {
		const { config, state } = this.readState();
		this.assertActive(config, state);
		if (
			model.provider !== "vinci" ||
			model.api !== "openai-completions" ||
			!config.allowedModels.includes(model.id)
		) {
			blocked("this QA allowance only permits its listed Vinci completion models");
		}
		if (!config.allowedOrigins.includes(new URL(model.baseUrl).origin)) blocked("the model origin is not approved");
	}

	private assertActive(config: QaRequestAllowance, state: AllowanceState): void {
		if (state.closed) blocked(`the allowance was ${state.closed}`);
		if (Date.now() >= Date.parse(config.expiresAt)) blocked("the allowance expired");
		if (state.usedRequests >= config.maxRequests) blocked(`the ${config.maxRequests}-request ceiling is exhausted`);
	}

	/** Closing an authorization is durable and never refunds or resets usage. */
	close(reason: "completed" | "revoked"): void {
		const { state } = this.readState();
		if (state.closed) return;
		const path = `${this.path}.closed.json`;
		let fd: number;
		try {
			fd = openSync(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			this.readState();
			return;
		}
		try {
			writeFileSync(
				fd,
				`${JSON.stringify({ id: state.id, configurationSha256: this.configurationSha256, closed: reason })}\n`,
			);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		syncDirectory(path);
	}

	/** Reserve durably before dispatch. Errors, cancellations and retries never refund a slot. */
	reserve(origin: string | URL | undefined): void {
		this.update((config, state) => {
			this.assertActive(config, state);
			const requestOrigin = origin === undefined ? undefined : new URL(origin).origin;
			if (!requestOrigin || !config.allowedOrigins.includes(requestOrigin))
				blocked("the request origin is not approved");
			return { ...state, usedRequests: state.usedRequests + 1 };
		});
	}

	private update(change: (config: QaRequestAllowance, state: AllowanceState) => AllowanceState): void {
		const lock = `${this.path}.lock`;
		let lockFd: number;
		try {
			lockFd = openSync(lock, "wx", 0o600);
		} catch {
			blocked("the reservation lock is unavailable; no request was dispatched");
		}
		let temporary: string | undefined;
		try {
			const { config, state } = this.readState();
			const next = change(config, state);
			temporary = `${this.path}.state-${process.pid}-${randomUUID()}.tmp`;
			const fd = openSync(temporary, "wx", 0o600);
			try {
				writeFileSync(fd, `${JSON.stringify(next)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(temporary, `${this.path}.state.json`);
			temporary = undefined;
			syncDirectory(this.path);
		} finally {
			if (temporary) unlinkSync(temporary);
			closeSync(lockFd);
			unlinkSync(lock);
		}
	}
}

export function guardQaRequests(dispatcher: Dispatcher, guard: QaRequestGuard | undefined): Dispatcher {
	if (!guard) return dispatcher;
	return dispatcher.compose((dispatch) => (options, handler) => {
		guard.reserve(options.origin);
		return dispatch(options, handler);
	});
}
