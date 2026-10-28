import assert from "node:assert/strict";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";
import { QaRequestGuard } from "../src/core/qa-request-allowance.ts";

const path = process.argv[2];
process.env.VINCI_QA_ALLOWANCE_FILE = path;
const guard = new QaRequestGuard(path);
guard.reserve("https://qa.invalid");
configureHttpDispatcher();
configureHttpDispatcher(30_000);
await assert.rejects(
	fetch("https://qa.invalid"),
	(error: unknown) => error instanceof Error && error.cause instanceof Error && /ceiling/.test(error.cause.message),
); // Exhausted before transport; no socket.
const bridge = (
	globalThis as typeof globalThis & {
		__vinciQaRequestGuard: {
			assertModel(model: { provider: string; api: string; id: string; baseUrl: string }): void;
		};
	}
).__vinciQaRequestGuard;
globalThis.fetch = () => {
	throw new Error("Synthetic replacement must never execute");
};
assert.throws(
	() =>
		bridge.assertModel({ provider: "vinci", api: "openai-completions", id: "forte", baseUrl: "https://qa.invalid" }),
	/fetch was replaced/,
);
delete process.env.VINCI_QA_ALLOWANCE_FILE;
assert.throws(() => configureHttpDispatcher(), /cannot be removed/);
