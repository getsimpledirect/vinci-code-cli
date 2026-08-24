import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const orchestrate = await loader.import(resolve(here, "../extensions/vinci-orchestrate.ts"), { default: false });

let abortedCalls = 0;
const abortedResult = await orchestrate.withRetry(async () => {
	abortedCalls++;
	return { stopReason: "aborted" };
});
assert.equal(abortedResult.stopReason, "aborted");
assert.equal(abortedCalls, 1, "aborted completion results must return without retry or backoff");

let errorCalls = 0;
const recovered = await orchestrate.withRetry(async () => {
	errorCalls++;
	return errorCalls === 1 ? { stopReason: "error" } : { stopReason: "stop" };
}, undefined, 2);
assert.equal(recovered.stopReason, "stop");
assert.equal(errorCalls, 2, "error completion results must still retry");

const controller = new AbortController();
let backoffCalls = 0;
const started = Date.now();
const abortingRetry = orchestrate.withRetry(async () => {
	backoffCalls++;
	return { stopReason: "error" };
}, controller.signal, 2);
setTimeout(() => controller.abort(), 20);
await assert.rejects(abortingRetry, /aborted/);
assert.equal(backoffCalls, 1);
assert.ok(Date.now() - started < 500, "aborting during retry backoff must stop the wait promptly");

const fanoutFaux = registerFauxProvider({
	api: "faux:orchestrate-fanout",
	provider: "faux-orchestrate-fanout",
	models: [{ id: "fortissimo" }],
});
try {
	fanoutFaux.setResponses([
		fauxAssistantMessage("1. Empty worker part\n2. Surviving worker part"),
		fauxAssistantMessage("  \n"),
		fauxAssistantMessage("surviving worker output"),
		fauxAssistantMessage("  \n"),
		fauxAssistantMessage("PASS\nThe surviving result is solid."),
		fauxAssistantMessage("  \n"),
	]);
	const result = await orchestrate.runOrchestrator(
		fanoutFaux.getModel("fortissimo"),
		{ apiKey: "faux-key" },
		"Complete both parts",
		resolve(here, "../.."),
		{ find: () => undefined },
		"orchestrate-fanout-test",
	);
	assert.equal(result.parts.length, 2);
	assert.equal(result.parts[0].result, "");
	assert.deepEqual(
		{ verdict: result.parts[0].verdict, critique: result.parts[0].critique },
		{ verdict: "needs-work", critique: "grader returned no usable output" },
	);
	assert.equal(result.parts[1].result, "surviving worker output");
	assert.equal(result.parts[1].verdict, "pass");
	assert.equal(result.synthesis, "Synthesis unavailable — the reviewed parts are shown as produced.");
} finally {
	fanoutFaux.unregister();
}

const plannerFaux = registerFauxProvider({
	api: "faux:orchestrate-planner",
	provider: "faux-orchestrate-planner",
	models: [{ id: "fortissimo" }],
});
try {
	plannerFaux.setResponses([
		fauxAssistantMessage("  \n"),
		fauxAssistantMessage("single worker output"),
		fauxAssistantMessage("PASS\nThe result is solid."),
		fauxAssistantMessage("single synthesis"),
	]);
	const result = await orchestrate.runOrchestrator(
		plannerFaux.getModel("fortissimo"),
		{ apiKey: "faux-key" },
		"Use the original task",
		resolve(here, "../.."),
		{ find: () => undefined },
		"orchestrate-planner-test",
	);
	assert.equal(result.parts.length, 1);
	assert.equal(result.parts[0].task, "Use the original task");
	assert.equal(result.synthesis, "single synthesis");
} finally {
	plannerFaux.unregister();
}

console.log("orchestrate-integration: completion degradation checks passed");
