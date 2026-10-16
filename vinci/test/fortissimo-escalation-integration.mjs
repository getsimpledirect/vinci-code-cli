// Exercise the real escalation entry points with an offline provider, including ordinary paths.
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false, fsCache: false });
const advisor = await loader.import(resolve(here, "../extensions/vinci-advisor.ts"), { default: false });
const council = await loader.import(resolve(here, "../extensions/vinci-council.ts"), { default: false });
const scope = await loader.import(resolve(here, "../extensions/vinci-scope.ts"), { default: false });
const orchestrate = await loader.import(resolve(here, "../extensions/vinci-orchestrate.ts"), { default: false });
const loopbreak = await loader.import(resolve(here, "../extensions/vinci-loopbreak.ts"), { default: false });

const NO_STRONGER = /no stronger (?:Vinci )?(?:class|tier|model)|same (?:class|model)|self[- ]review/i;

function fixture(name, modelId = "forte") {
	const faux = registerFauxProvider({
		api: `faux:fortissimo-escalation-${name}`,
		provider: `faux-fortissimo-escalation-${name}`,
		models: [
			{ id: "auto", name: "Vinci" },
			{ id: "forte", name: "Vinci Forte" },
			{ id: "fortissimo", name: "Vinci Fortissimo" },
		],
	});
	const lookups = [];
	const calls = [];
	const notices = [];
	const registry = {
		find(provider, id) {
			lookups.push({ provider, id });
			return faux.getModel(id);
		},
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "offline-faux-key", headers: {}, env: {} };
		},
	};
	const ctx = {
		model: faux.getModel(modelId),
		modelRegistry: registry,
		cwd: resolve(here, "../.."),
		hasUI: true,
		mode: "tui",
		ui: { notify: (message, level) => notices.push({ message, level }) },
		sessionManager: { getSessionId: () => `fortissimo-escalation-${name}`, getBranch: () => [] },
	};
	return {
		faux, lookups, calls, notices, registry, ctx,
		respond(makeText, count = 12) {
			faux.setResponses(Array.from({ length: count }, () => (context, _options, _state, model) => {
				calls.push(model.id);
				return fauxAssistantMessage(typeof makeText === "function" ? makeText(context, model) : makeText);
			}));
		},
		announce: (message, level) => notices.push({ message, level }),
	};
}

function assertNoFortissimo(name, f) {
	assert.equal(
		[...f.lookups.map(({ id }) => id), ...f.calls].includes("fortissimo"),
		false,
		`${name}: a Forte session must never request Fortissimo as a stronger class`,
	);
}

function noticeText(f) {
	return f.notices.map(({ message }) => message).join("\n");
}

function advisorTool() {
	let tool;
	advisor.default({
		on() {},
		appendEntry() {},
		registerTool(value) { if (value.name === "advisor") tool = value; },
	});
	assert.ok(tool, "advisor must register its real tool entry point");
	return tool;
}

test("T3 advisor: Forte uses disclosed self-review without requesting Fortissimo", async () => {
	const f = fixture("advisor-forte");
	try {
		f.respond("The focused self-review found one useful risk.");
		const result = await advisorTool().execute("advisor-alias", { question: "Is this approach sound?" }, undefined, undefined, f.ctx);
		assertNoFortissimo("advisor", f);
		assert.match(result.content[0].text, NO_STRONGER, "advisor: disclose that no stronger class was used");
		assert.match(result.content[0].text, /focused self-review found/);
		assert.deepEqual(f.calls, ["forte"], "advisor: only the current Forte model performs the self-review");
	} finally {
		f.faux.unregister();
	}
});

test("T3 advisor positive control: Auto obtains a useful available advisor opinion", async () => {
	const f = fixture("advisor-auto", "auto");
	try {
		f.respond("The normal advisor opinion is actionable.");
		const result = await advisor.askStronger(f.ctx.model, f.registry, { apiKey: "offline-faux-key" }, "Is this sound?", "advisor-auto-control");
		assert.equal(result.answer?.text, "The normal advisor opinion is actionable.");
		assert.ok(result.answer?.model, "advisor: Auto must still obtain an available advisor answer");
		assert.equal(f.calls.length, 1, "advisor: normal Auto advice uses one completion");
		assert.notEqual(result.unknownClass, true, "advisor: Auto is a known selection");
	} finally {
		f.faux.unregister();
	}
});

test("T3 council: Forte synthesizes with honest same-class disclosure", async () => {
	const f = fixture("council-forte");
	try {
		f.respond((context) => context.systemPrompt.includes("chair of") ? "The council recommends a small implementation." : "A useful independent lens.");
		const result = await council.runCouncil(f.ctx.model, { apiKey: "offline-faux-key" }, "Which design?", f.registry, "council-forte-alias", f.announce);
		assertNoFortissimo("council", f);
		assert.match(`${result}\n${noticeText(f)}`, NO_STRONGER, "council: disclose that no stronger class was used");
		assert.match(result, /council recommends a small implementation/);
		assert.deepEqual(f.calls, Array(5).fill("forte"), "council: four lenses and the chair remain on Forte");
	} finally {
		f.faux.unregister();
	}
});

test("T3 council positive control: the normal Auto lenses and chair remain usable", async () => {
	const f = fixture("council-auto", "auto");
	try {
		f.respond((context) => context.systemPrompt.includes("chair of") ? "Normal council synthesis." : "Normal lens take.");
		const result = await council.runCouncil(f.ctx.model, { apiKey: "offline-faux-key" }, "Which design?", f.registry, "council-auto-control", f.announce);
		assert.match(result, /Normal council synthesis\./);
		assert.deepEqual(f.calls, Array(5).fill("auto"), "council: the ordinary path still runs four lenses and one chair");
	} finally {
		f.faux.unregister();
	}
});

test("T3 scope: Forte judges scope without inventing a stronger class", async () => {
	const f = fixture("scope-forte");
	try {
		f.respond("IN — directly relevant");
		const result = await scope.judgeScope(f.ctx, "src/relevant.ts");
		assertNoFortissimo("scope", f);
		assert.match(noticeText(f), NO_STRONGER, "scope: disclose that no stronger class was used");
		assert.equal(result, "in", "scope: the same-class judge still produces an in-scope verdict");
		assert.deepEqual(f.calls, ["forte"]);
	} finally {
		f.faux.unregister();
	}
});

test("T3 scope positive control: the normal Auto path retains OUT verdicts", async () => {
	const f = fixture("scope-auto", "auto");
	try {
		f.respond("OUT — unrelated change");
		assert.equal(await scope.judgeScope(f.ctx, "src/unrelated.ts"), "out");
		assert.deepEqual(f.calls, ["auto"], "scope: normal judging uses the selected model once");
	} finally {
		f.faux.unregister();
	}
});

function orchestrationResponse(context, model, pass) {
	if (context.systemPrompt.includes("Vinci's planner")) return "1. Inspect the implementation";
	if (context.systemPrompt.includes("strict reviewer")) return pass ? "PASS\nThe result is complete." : "NEEDS WORK\nThe implementation still needs proof.";
	if (context.systemPrompt.includes("orchestrator integrating")) return "The integrated result preserves the review findings.";
	return model.id === "fortissimo" ? "A distinct retry result." : "The original focused worker result.";
}

test("T3 orchestrate: a failed Forte review is retained with no-stronger-class disclosure", async () => {
	const f = fixture("orchestrate-forte");
	try {
		f.respond((context, model) => orchestrationResponse(context, model, false));
		const phases = [];
		const result = await orchestrate.runOrchestrator(f.ctx.model, { apiKey: "offline-faux-key" }, "Inspect the implementation", f.ctx.cwd, f.registry, "orchestrate-forte-alias", (message) => phases.push(message));
		assertNoFortissimo("orchestrate", f);
		assert.match(result.synthesis, NO_STRONGER, "orchestrate: the returned synthesis must disclose that no stronger class was used");
		assert.equal(result.parts[0].verdict, "needs-work", "orchestrate: no stronger class must not turn a failed review into a pass");
		assert.equal(result.parts[0].result, "The original focused worker result.");
		assert.equal(result.parts[0].tier, undefined, "orchestrate: the retained result must not claim a stronger retry tier");
		assert.deepEqual(f.calls, Array(4).fill("forte"), "orchestrate: no stronger class means no extra worker retry");
	} finally {
		f.faux.unregister();
	}
});

test("T3 orchestrate positive control: normal Auto work still plans, works, grades and synthesizes", async () => {
	const f = fixture("orchestrate-auto", "auto");
	try {
		f.respond((context, model) => orchestrationResponse(context, model, true));
		const result = await orchestrate.runOrchestrator(f.ctx.model, { apiKey: "offline-faux-key" }, "Inspect the implementation", f.ctx.cwd, f.registry, "orchestrate-auto-control");
		assert.equal(result.parts.length, 1);
		assert.equal(result.parts[0].verdict, "pass");
		assert.equal(result.synthesis, "The integrated result preserves the review findings.");
		assert.deepEqual(f.calls, Array(4).fill("auto"));
	} finally {
		f.faux.unregister();
	}
});

test("T3 loopbreak: Forte recovery is explicitly a same-class reframe", async () => {
	const f = fixture("loopbreak-forte");
	try {
		f.respond("Read the failed assertion and repair its owning branch.");
		const result = await loopbreak.getUnstuck(f.ctx, "bash node focused-test.mjs", [], "Repair this regression");
		assertNoFortissimo("loopbreak", f);
		assert.equal(result?.escalated, false, "loopbreak: a Forte retry must never be reported as a stronger teammate");
		assert.match(`${result?.text}\n${noticeText(f)}`, NO_STRONGER, "loopbreak: disclose that no stronger class was used");
		assert.doesNotMatch(result.text, /a stronger teammate/i);
		assert.deepEqual(f.calls, ["forte"]);
	} finally {
		f.faux.unregister();
	}
});

test("T3 loopbreak positive control: normal Auto recovery keeps its actionable fresh pass", async () => {
	const f = fixture("loopbreak-auto", "auto");
	try {
		f.respond("Inspect the failing branch before changing it.");
		const result = await loopbreak.getUnstuck(f.ctx, "bash node focused-test.mjs", [], "Repair this regression");
		assert.equal(result?.escalated, false);
		assert.match(result.text, /Inspect the failing branch before changing it\./);
		assert.match(result.text, /fresh look/i);
		assert.deepEqual(f.calls, ["auto"]);
	} finally {
		f.faux.unregister();
	}
});
