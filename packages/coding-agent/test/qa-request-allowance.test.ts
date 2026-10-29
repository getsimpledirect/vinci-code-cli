import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { complete, completeSimple, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import OpenAI from "openai";
import { Dispatcher, fetch, MockAgent, type RequestInit } from "undici";
import { afterEach, describe, expect, test, vi } from "vitest";
import { closeCompletedQaAllowance } from "../../../vinci/extensions/lib/qa-allowance.ts";
import { guardQaRequests, initializeQaRequestAllowance, QaRequestGuard } from "../src/core/qa-request-allowance.ts";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllGlobals();
});

function allowance(maxRequests = 2) {
	const directory = mkdtempSync(join(tmpdir(), "vinci-qa-limit-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "approved.json");
	initializeQaRequestAllowance(path, {
		schemaVersion: 1,
		id: "synthetic-authorization-only",
		maxRequests,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		allowedOrigins: ["https://qa.invalid"],
		allowedModels: ["forte"],
	});
	const guard = new QaRequestGuard(path);
	const state = () =>
		({
			...JSON.parse(readFileSync(`${path}.state.json`, "utf8")),
			...(existsSync(`${path}.closed.json`) ? JSON.parse(readFileSync(`${path}.closed.json`, "utf8")) : {}),
		}) as { usedRequests: number; closed?: string };
	return { path, guard, state };
}

function transport(guard: QaRequestGuard) {
	const mock = new MockAgent();
	mock.disableNetConnect();
	cleanups.push(() => mock.close());
	const dispatcher = guardQaRequests(mock, guard);
	return { mock, dispatcher };
}

describe("QA authorization at the HTTP dispatch boundary (no sockets or credentials)", () => {
	test("restarts/task IDs cannot renew usage; completion and revocation persist", () => {
		const { path, guard, state } = allowance(3);
		guard.reserve("https://qa.invalid");
		new QaRequestGuard(path).reserve("https://qa.invalid");
		expect(state().usedRequests).toBe(2);
		guard.close("completed");
		expect(() => new QaRequestGuard(path).reserve("https://qa.invalid")).toThrow(/completed/);
		expect(() => initializeQaRequestAllowance(path, JSON.parse(readFileSync(path, "utf8")))).toThrow();
		const second = allowance();
		writeFileSync(`${second.path}.lock`, "synthetic reservation in progress");
		second.guard.close("revoked");
		unlinkSync(`${second.path}.lock`);
		expect(() => new QaRequestGuard(second.path).reserve("https://qa.invalid")).toThrow(/revoked/);
	});

	test("missing/corrupt state, changed authorization, expiry and a held lock fail closed", () => {
		const missing = allowance();
		unlinkSync(`${missing.path}.state.json`);
		expect(() => missing.guard.reserve("https://qa.invalid")).toThrow();
		const corrupt = allowance();
		writeFileSync(`${corrupt.path}.state.json`, "{}");
		expect(() => corrupt.guard.reserve("https://qa.invalid")).toThrow(/persisted usage/);
		const changed = allowance();
		writeFileSync(changed.path, `${readFileSync(changed.path, "utf8")} `);
		expect(() => changed.guard.reserve("https://qa.invalid")).toThrow(/configuration changed/);
		const locked = allowance();
		writeFileSync(`${locked.path}.lock`, "");
		expect(() => locked.guard.reserve("https://qa.invalid")).toThrow(/lock/);
		expect(locked.state().usedRequests).toBe(0);
		const expired = allowance();
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
		expect(() => expired.guard.reserve("https://qa.invalid")).toThrow(/expired/);
		vi.restoreAllMocks();
	});

	test("only the selected Vinci completion model/origin is admitted", () => {
		const { guard, state } = allowance();
		const model = { provider: "vinci", api: "openai-completions", id: "forte", baseUrl: "https://qa.invalid/v1" };
		guard.assertModel(model);
		for (const override of [
			{ provider: "other" },
			{ api: "openai-responses" },
			{ id: "auto" },
			{ baseUrl: "https://unapproved.invalid" },
		]) {
			expect(() => guard.assertModel({ ...model, ...override })).toThrow(/BLOCKED/);
		}
		expect(() => guard.reserve("https://unapproved.invalid")).toThrow(/origin/);
		expect(state().usedRequests).toBe(0);
	});

	test("concurrent requests compete for one final slot before any transport", async () => {
		const { guard, state } = allowance(1);
		const { mock, dispatcher } = transport(guard);
		mock.get("https://qa.invalid").intercept({ path: "/" }).reply(200, "ok").persist();
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, () => fetch("https://qa.invalid", { dispatcher })),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(state().usedRequests).toBe(1);
	});

	test("helpers/children in separate processes share the same final slot", async () => {
		const { path, guard, state } = allowance(2);
		guard.reserve("https://qa.invalid");
		const child = new URL("./qa-allowance-child.ts", import.meta.url);
		const results = await Promise.all(
			Array.from(
				{ length: 6 },
				() =>
					new Promise<number | null>((resolve, reject) => {
						const process = spawn(globalThis.process.execPath, [child.pathname, path], { stdio: "ignore" });
						process.once("error", reject);
						process.once("exit", resolve);
					}),
			),
		);
		expect(results.filter((code) => code === 0)).toHaveLength(1);
		expect(state().usedRequests).toBe(2);
	});

	test("CLI startup arms the real global dispatcher and cannot remove the allowance", async () => {
		const { path, state } = allowance(1);
		const child = new URL("./qa-allowance-startup-child.ts", import.meta.url);
		const code = await new Promise<number | null>((resolve, reject) => {
			const childProcess = spawn(process.execPath, [child.pathname, path], { stdio: ["ignore", "ignore", "pipe"] });
			let error = "";
			childProcess.stderr.on("data", (data) => {
				error += String(data);
			});
			childProcess.once("error", reject);
			childProcess.once("exit", (code) => (code === 0 ? resolve(code) : reject(new Error(error))));
		});
		expect(code).toBe(0);
		expect(state().usedRequests).toBe(1);
	});

	test("SDK retries consume attempts; uncertain errors never refund", async () => {
		const { guard, state } = allowance(2);
		const { mock, dispatcher } = transport(guard);
		mock
			.get("https://qa.invalid")
			.intercept({ path: "/chat/completions", method: "POST" })
			.reply(500, { error: { message: "synthetic failure" } }, { headers: { "retry-after-ms": "1" } })
			.persist();
		const client = new OpenAI({
			apiKey: "synthetic-no-credential",
			baseURL: "https://qa.invalid",
			maxRetries: 3,
			fetch: (url, options) =>
				fetch(String(url), { ...(options as RequestInit), dispatcher }) as unknown as Promise<Response>,
		});
		await expect(client.chat.completions.create({ model: "forte", messages: [] })).rejects.toThrow();
		expect(state().usedRequests).toBe(2);
		expect(() => guard.reserve("https://qa.invalid")).toThrow(/ceiling/);
	}, 15_000);

	test("stream cancellation, missing responses and duplicate response IDs do not refund", async () => {
		const { guard, state } = allowance(3);
		const { mock, dispatcher } = transport(guard);
		const pool = mock.get("https://qa.invalid");
		pool.intercept({ path: "/stream" }).reply(200, 'data: {"id":"same-response"}\n\n').persist();
		pool.intercept({ path: "/uncertain" }).replyWithError(new Error("synthetic disconnect"));
		for (let index = 0; index < 2; index++) {
			const response = await fetch("https://qa.invalid/stream", { dispatcher });
			const reader = response.body!.getReader();
			await reader.read();
			await reader.cancel();
		}
		await expect(fetch("https://qa.invalid/uncertain", { dispatcher })).rejects.toThrow();
		expect(state().usedRequests).toBe(3);
		await expect(fetch("https://qa.invalid/stream", { dispatcher })).rejects.toThrow();
	});

	test("cancelling a still-open response stream cannot reopen its consumed slot", async () => {
		const { guard, state } = allowance(1);
		let aborted = false;
		let transports = 0;
		class OpenStream extends Dispatcher {
			override dispatch(_options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
				transports++;
				const controller: Dispatcher.DispatchController = {
					get aborted() {
						return aborted;
					},
					paused: false,
					reason: null,
					rawHeaders: ["content-type", "text/event-stream"],
					pause() {},
					resume() {},
					abort(error) {
						aborted = true;
						queueMicrotask(() => handler.onResponseError?.(controller, error));
					},
				};
				queueMicrotask(() => {
					handler.onRequestStart?.(controller, {});
					handler.onResponseStart?.(controller, 200, { "content-type": "text/event-stream" }, "OK");
					handler.onResponseData?.(controller, Buffer.from("data: synthetic still running\n\n"));
				});
				return true;
			}
		}
		const dispatcher = guardQaRequests(new OpenStream(), guard);
		const response = await fetch("https://qa.invalid/stream", { dispatcher });
		const reader = response.body!.getReader();
		expect((await reader.read()).done).toBe(false);
		await reader.cancel();
		expect(aborted).toBe(true);
		await expect(fetch("https://qa.invalid/stream", { dispatcher })).rejects.toThrow();
		expect(state().usedRequests).toBe(1);
		expect(transports).toBe(1);
	});

	test("top-level completion closes; waiting/helper completion does not", () => {
		const { guard, state } = allowance();
		vi.stubGlobal("__vinciQaRequestGuard", { close: (reason: "completed") => guard.close(reason) });
		closeCompletedQaAllowance("WAITING", "");
		closeCompletedQaAllowance("DONE", "1");
		expect(state().closed).toBeUndefined();
		closeCompletedQaAllowance("DONE", "");
		expect(state().closed).toBe("completed");
	});

	test("foreground/grader/scope compatibility and Models streams share the actual dispatch counter", async () => {
		const { guard, state } = allowance(4);
		const { mock, dispatcher } = transport(guard);
		const chunk = { id: "synthetic-duplicate-id", object: "chat.completion.chunk", created: 0, model: "forte" };
		const body = `${[
			{
				...chunk,
				choices: [{ index: 0, delta: { role: "assistant", content: "synthetic ok" }, finish_reason: null }],
			},
			{
				...chunk,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			},
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("")}data: [DONE]\n\n`;
		mock
			.get("https://qa.invalid")
			.intercept({ path: "/chat/completions", method: "POST" })
			.reply(200, body, { headers: { "content-type": "text/event-stream" } })
			.persist();
		vi.stubGlobal("fetch", (url: string | URL, options: RequestInit) =>
			fetch(String(url), { ...options, dispatcher }),
		);
		vi.stubGlobal("__vinciQaRequestGuard", { assertModel: guard.assertModel.bind(guard) });
		const model: Model<"openai-completions"> = {
			id: "forte",
			name: "Synthetic Forte",
			provider: "vinci",
			api: "openai-completions",
			baseUrl: "https://qa.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "vinci",
				models: [model],
				api: openAICompletionsApi(),
				auth: {
					apiKey: { name: "synthetic", resolve: async () => ({ auth: { apiKey: "synthetic-no-credential" } }) },
				},
			}),
		);
		const context = { messages: [{ role: "user" as const, content: "Synthetic test only", timestamp: 0 }] };
		for (const run of [
			() => complete(model, context, { apiKey: "synthetic-no-credential" }),
			() => completeSimple(model, context, { apiKey: "synthetic-no-credential" }),
			() => models.complete(model, context),
			() => models.completeSimple(model, context),
		]) {
			const result = await run();
			expect(result.stopReason, result.errorMessage).toBe("stop");
		}
		expect(state().usedRequests).toBe(4);
		await expect(complete(model, context, { apiKey: "synthetic-no-credential" })).rejects.toThrow(/ceiling/);
	});
});
