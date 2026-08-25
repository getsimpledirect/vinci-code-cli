// Vinci Code — advisor input-contract regression tests. No provider calls.
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const extension = await loader.import(resolve(here, "../extensions/vinci-advisor.ts"), { default: false });

let advisor;
extension.default({
  registerTool(tool) {
    if (tool.name === "advisor") advisor = tool;
  },
});
assert.ok(advisor, "advisor tool must register");

let authLookups = 0;
const ctx = {
  model: { id: "forte", provider: "vinci" },
  modelRegistry: {
    async getApiKeyAndHeaders() {
      authLookups++;
      throw new Error("invalid advisor input must be rejected before auth or provider access");
    },
  },
};

const literalDiff = await advisor.execute(
  "advisor-1",
  { question: "Review this PR", context: "$(cd project && git diff origin/main...HEAD)" },
  undefined,
  undefined,
  ctx,
);
assert.equal(literalDiff.isError, true);
assert.equal(literalDiff.details.reviewed, false);
assert.match(literalDiff.content[0].text, /did not review/i);
assert.match(literalDiff.content[0].text, /actual content/i);
assert.equal(authLookups, 0);

const literalQuestion = await advisor.execute(
  "advisor-2",
  { question: "Review $(git diff)" },
  undefined,
  undefined,
  ctx,
);
assert.equal(literalQuestion.isError, true);
assert.equal(literalQuestion.details.reviewed, false);
assert.equal(authLookups, 0);

console.log("advisor-integration: 2/2 passed");

// Error-shaped completion results must classify as failures, never as valid verdicts.
const { classifyCompletionResult } = await loader.import(
	resolve(here, "../../packages/ai/src/utils/completion-status.ts"),
	{ default: false },
);
const base = { role: "assistant", api: "t", provider: "t", model: "t", timestamp: 0 };
assert.equal(classifyCompletionResult({ ...base, stopReason: "stop", content: [] }).ok, false);
assert.equal(
	classifyCompletionResult({ ...base, stopReason: "stop", content: [{ type: "text", text: "  \n" }] }).ok,
	false,
);
const errored = classifyCompletionResult({ ...base, stopReason: "error", errorMessage: "boom", content: [] });
assert.equal(errored.ok, false);
assert.equal(errored.error, "boom");
const good = classifyCompletionResult({ ...base, stopReason: "stop", content: [{ type: "text", text: "verdict" }] });
assert.equal(good.ok, true);
assert.equal(good.text, "verdict");

console.log("advisor-integration: completion-status 4/4 passed");

const strongerFaux = registerFauxProvider({
	api: "faux:advisor-empty",
	provider: "faux-advisor-empty",
	models: [{ id: "fortissimo" }],
});
try {
	strongerFaux.setResponses([fauxAssistantMessage("  \n")]);
	const stronger = await extension.askStronger(
		{ id: "forte", provider: "vinci" },
		{ find: (_provider, id) => id === "fortissimo" ? strongerFaux.getModel("fortissimo") : undefined },
		{ apiKey: "faux-key" },
		"Review this approach",
		"advisor-empty-test",
	);
	assert.deepEqual(stronger, { unavailableClasses: ["fortissimo"] });
	assert.equal(strongerFaux.state.callCount, 1, "deterministic empty output must not retry the same class");
} finally {
	strongerFaux.unregister();
}

console.log("advisor-integration: empty stronger tier degradation passed");

// #182: on the DEFAULT "auto" model the old code returned before attempting any escalation, with an
// empty unavailableClasses — so the advisor silently became a self-review and nothing disclosed it.
const autoFaux = registerFauxProvider({
	api: "faux:advisor-auto",
	provider: "faux-advisor-auto",
	models: [{ id: "fortissimo" }],
});
try {
	autoFaux.setResponses([fauxAssistantMessage("Fortissimo's considered opinion.")]);
	const fromAuto = await extension.askStronger(
		{ id: "auto", provider: "vinci" },
		{ find: (_p, id) => (id === "fortissimo" ? autoFaux.getModel("fortissimo") : undefined) },
		{ apiKey: "faux-key" },
		"Is this approach sound?",
		"advisor-auto-test",
	);
	assert.equal(fromAuto.answer?.text, "Fortissimo's considered opinion.", "auto must escalate to the top class");
	assert.equal(fromAuto.answer?.model.id, "fortissimo", "the answering class is the strongest one");
	assert.equal(autoFaux.state.callCount, 1, "auto escalates once, to the top class only (never down to forte)");
	assert.notEqual(fromAuto.unknownClass, true, "auto is escalatable, not an unknown class");
} finally {
	autoFaux.unregister();
}

// An id that cannot be placed in TIER_ORDER must fail HONEST rather than silently self-reviewing.
const unknown = await extension.askStronger(
	{ id: "some-future-model", provider: "vinci" },
	{ find: () => undefined },
	{ apiKey: "faux-key" },
	"Is this approach sound?",
	"advisor-unknown-test",
);
assert.equal(unknown.answer, undefined, "an unplaceable class yields no stronger answer");
assert.equal(unknown.unknownClass, true, "and it is flagged so the caller can disclose it");

console.log("advisor-integration: auto escalates and unknown classes disclose (#182)");
