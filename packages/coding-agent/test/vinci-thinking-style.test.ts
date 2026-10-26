import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme, Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "thinking", thinking: "Readable reasoning" }],
	api: "openai-completions",
	provider: "vinci",
	model: "forte",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

afterEach(() => vi.restoreAllMocks());

describe("expanded thinking contrast", () => {
	test("uses muted foreground in Vinci and preserves upstream thinkingText and italics", () => {
		initTheme("dark");
		const foreground = vi.spyOn(Theme.prototype, "fg");
		const component = new AssistantMessageComponent(message, false);
		const output = component.render(80).join("\n");
		const color = process.env.VINCI_CODE === "1" ? "muted" : "thinkingText";
		expect(foreground).toHaveBeenCalledWith(color, expect.stringContaining("Readable reasoning"));
		expect(output).toContain(theme.getFgAnsi(color));
		expect(output).toContain("\x1b[3m");
		expect(output).not.toMatch(/\x1b\[(?:\d+;)*2(?:;\d+)*m/);
		expect(stripAnsi(output)).toContain("Readable reasoning");
		component.setHideThinkingBlock(true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("Readable reasoning");
		component.setHideThinkingBlock(false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Readable reasoning");
	});
});
