import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
delete process.env.VINCI_CODING_AGENT_DIR;
const loader = createJiti(import.meta.url, {
	moduleCache: false,
	tryNative: false,
	alias: {
		"@earendil-works/pi-agent-core": resolve(root, "packages/agent/src/index.ts"),
		"@earendil-works/pi-ai": resolve(root, "packages/ai/src/index.ts"),
		"@earendil-works/pi-tui": resolve(root, "packages/tui/src/index.ts"),
	},
});
const { getAuthPath } = await loader.import(resolve(root, "packages/coding-agent/src/config.ts"), { default: false });
const { KEYBINDINGS } = await loader.import(resolve(root, "packages/coding-agent/src/core/keybindings.ts"), {
	default: false,
});
const { SettingsManager } = await loader.import(resolve(root, "packages/coding-agent/src/core/settings-manager.ts"), {
	default: false,
});
const { vinciDegroove } = await loader.import(resolve(root, "packages/coding-agent/src/core/vinci-degroove.ts"), {
	default: false,
});
const { vinciMaskEnabled } = await loader.import(resolve(root, "packages/coding-agent/src/core/vinci-mask-secrets.ts"), {
	default: false,
});
const { vinciSandboxEnabled } = await loader.import(resolve(root, "packages/coding-agent/src/core/vinci-sandbox.ts"), {
	default: false,
});
const { vinciResultBudgetEnabled } = await loader.import(
	resolve(root, "packages/coding-agent/src/core/tools/vinci-result-budget.ts"),
	{ default: false },
);

assert.equal(process.env.VINCI_CODE, "1", "run this guard integration with VINCI_CODE=1");
assert.equal(getAuthPath(), resolve(homedir(), ".pi/agent/auth.json"), "BYOK must reuse Pi's existing auth file");

const settings = SettingsManager.inMemory({ showOtherProviders: true });
assert.equal(settings.getShowOtherProviders(), true);
assert.equal(settings.getHideThinkingBlock(), true, "BYOK must preserve Vinci thinking-block defaults");
assert.deepEqual(
	KEYBINDINGS["app.thinking.cycle"].defaultKeys,
	[],
	"BYOK must preserve Vinci's reserved thinking keybinding",
);
assert.equal(vinciMaskEnabled(), true, "BYOK must preserve secret masking");
assert.equal(vinciResultBudgetEnabled(), true, "BYOK must preserve the Vinci result budget");
assert.equal(vinciSandboxEnabled(), true, "BYOK must preserve the Vinci sandbox");

const repeatedRounds = Array.from({ length: 3 }, (_, index) => {
	const toolCallId = `call-${index}`;
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "same.txt" } }],
			api: "anthropic-messages",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: index,
		},
		{
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: "same failure" }],
			isError: true,
			timestamp: index,
		},
	];
}).flat();
const degrooved = vinciDegroove(repeatedRounds);
assert.equal(degrooved.length, 3, "BYOK must preserve Vinci de-grooving");
assert.equal(degrooved[2].role, "custom");

process.stdout.write("byok-guards-integration: Vinci masking, budget, de-groove, thinking, keybindings, and sandbox remain enabled\n");
