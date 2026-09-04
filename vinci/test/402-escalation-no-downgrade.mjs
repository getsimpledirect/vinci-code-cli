import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	registerApiProvider,
	unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const advisorExtension = await loader.import(resolve(here, "../extensions/vinci-advisor.ts"), { default: false });
const { runCouncil } = await loader.import(resolve(here, "../extensions/vinci-council.ts"), { default: false });
const { judgeScope } = await loader.import(resolve(here, "../extensions/vinci-scope.ts"), { default: false });
const { getUnstuck } = await loader.import(resolve(here, "../extensions/vinci-loopbreak.ts"), { default: false });

const BILLING_ERRORS = [
	["in-flight", "in_flight_budget_exhausted"],
	["affordability", "You requested up to 131072 tokens, but can only afford 23014"],
];

function model(api, id) {
	return {
		id,
		name: `Vinci ${id}`,
		api,
		provider: "vinci",
		baseUrl: "http://localhost:0",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function successStream(text, requestModel) {
	const stream = createAssistantMessageEventStream();
	const message = {
		...fauxAssistantMessage(text),
		api: requestModel.api,
		provider: requestModel.provider,
		model: requestModel.id,
	};
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
	return stream;
}

async function assert402StopsEscalation(site, body, run, leadingResponses = []) {
	const api = `test:402-${site}`;
	const sourceId = `402-escalation-${site}`;
	const calls = [];
	const notices = [];
	const steps = [
		...leadingResponses,
		{ error: Object.assign(new Error(body), { status: 402 }) },
		{ error: Object.assign(new Error(body), { status: 402 }) },
		{ text: "CHEAPER FALLBACK MUST NOT RUN" },
	];
	const models = {
		forte: model(api, "forte"),
		fortissimo: model(api, "fortissimo"),
	};
	const stream = (requestModel) => {
		calls.push(requestModel.id);
		const step = steps.shift();
		assert.ok(step, `${site}: no unplanned model call may occur`);
		if (step.error) throw step.error;
		return successStream(step.text, requestModel);
	};
	registerApiProvider({ api, stream, streamSimple: stream }, sourceId);

	const registry = {
		find(provider, id) {
			return provider === "vinci" ? models[id] : undefined;
		},
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "test-key" };
		},
	};
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		model: models.forte,
		modelRegistry: registry,
		sessionManager: { getSessionId: () => `402-${site}` },
		ui: { notify: (message, level) => notices.push({ message, level }) },
	};
	usageSessionStart({}, ctx);

	try {
		await assert.rejects(
			() => run({ ctx, models, registry, announce: (message, level) => notices.push({ message, level }) }),
			(error) => {
				assert.match(error.message, /will not downgrade after an account or terminal error/i);
				assert.equal(error.cause?.status, 402, `${site}: the terminal error must retain the real HTTP status`);
				return true;
			},
			`${site}: a 402 must throw instead of returning a cheaper-class result`,
		);
		assert.deepEqual(
			calls,
			[...leadingResponses.map(() => "forte"), "fortissimo"],
			`${site}: no retry or cheaper class may be attempted after a 402`,
		);
		assert.equal(steps.length, 2, `${site}: the same-class retry and cheaper fallback must remain unused`);
		assert.equal(
			notices.some(({ level, message }) => level === "warning" || /unavailable|continuing with/i.test(message)),
			false,
			`${site}: a 402 must not enter the unavailable-class downgrade path`,
		);
	} finally {
		unregisterApiProviders(sourceId);
	}
}

let advisorTool;
let usageSessionStart;
advisorExtension.default({
	appendEntry() {},
	on(event, handler) {
		if (event === "session_start") usageSessionStart = handler;
	},
	registerTool(tool) {
		if (tool.name === "advisor") advisorTool = tool;
	},
});
assert.ok(advisorTool, "advisor tool must register");
assert.ok(usageSessionStart, "usage accumulator must bind to the active test task");

const consumers = [
	[
		"advisor",
		({ ctx }) => advisorTool.execute("402-advisor", { question: "Review this" }, undefined, undefined, ctx),
		[],
	],
	[
		"council",
		({ ctx, registry, announce }) =>
			runCouncil(
				ctx.model,
				{ apiKey: "test-key" },
				"Choose an approach",
				registry,
				ctx.sessionManager.getSessionId(),
				announce,
			),
		[
			{ text: "optimist take" },
			{ text: "skeptic take" },
			{ text: "realist take" },
			{ text: "strategist take" },
		],
	],
	["scope", ({ ctx }) => judgeScope(ctx, "unrelated.ts"), []],
	["loopbreak", ({ ctx }) => getUnstuck(ctx, "bash repeated", [], "Fix the loop"), []],
];

for (const [variant, body] of BILLING_ERRORS) {
	for (const [site, run, leadingResponses] of consumers) {
		await assert402StopsEscalation(`${site}-${variant}`, body, run, leadingResponses);
	}
}

console.log("402-escalation-no-downgrade: all four consumers reject both 402 variants without downgrade");
