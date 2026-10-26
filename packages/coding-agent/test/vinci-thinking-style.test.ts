import type { AssistantMessage } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { afterEach, describe, expect, test, vi } from "vitest";
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

function hasDimStyle(text: string): boolean {
	for (const match of text.matchAll(/\x1b\[([\d;]*)m/g)) {
		const parameters = match[1].split(";").map(Number);
		for (let index = 0; index < parameters.length; index++) {
			const parameter = parameters[index];
			if (parameter === 38 || parameter === 48) {
				// Extended foreground/background colors consume a mode and RGB or palette arguments.
				if (parameters[index + 1] === 2) index += 4;
				else if (parameters[index + 1] === 5) index += 2;
			} else if (parameter === 2) {
				return true;
			}
		}
	}
	return false;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.resetModules();
});

describe("dim SGR detection", () => {
	test.each([
		["\x1b[38;2;128;128;128m", false],
		["\x1b[48;2;2;128;2m", false],
		["\x1b[38;5;2m", false],
		["\x1b[48;5;2m", false],
		["\x1b[2m", true],
		["\x1b[3;2m", true],
		["\x1b[38;2;128;128;128;2m", true],
		["\x1b[2;48;2;128;128;128m", true],
		["\x1b[38;5;2;3m", false],
		["\x1b[48;5;128;2m", true],
	] as const)("distinguishes dim from extended color arguments (%j)", (sequence, expected) => {
		expect(hasDimStyle(sequence)).toBe(expected);
	});
});

describe.each(["256color", "truecolor"] as const)("expanded thinking contrast in %s", (colorMode) => {
	test.each([undefined, "1"])("preserves foreground and italics with Vinci mode %j", async (vinci) => {
		const previous = process.env.VINCI_CODE;
		const previousColorTerm = process.env.COLORTERM;
		const previousColorLevel = chalk.level;
		if (vinci === undefined) delete process.env.VINCI_CODE;
		else process.env.VINCI_CODE = vinci;
		if (colorMode === "truecolor") process.env.COLORTERM = "truecolor";
		else delete process.env.COLORTERM;
		// Chalk caches support at import time, so changing FORCE_COLOR alone is insufficient.
		chalk.level = colorMode === "truecolor" ? 3 : 2;
		try {
			vi.resetModules();
			const { AssistantMessageComponent } = await import("../src/modes/interactive/components/assistant-message.ts");
			const { initTheme, Theme, theme } = await import("../src/modes/interactive/theme/theme.ts");
			initTheme("dark");
			expect(theme.getColorMode()).toBe(colorMode);
			const foreground = vi.spyOn(Theme.prototype, "fg");
			const component = new AssistantMessageComponent(message, false);
			const output = component.render(80).join("\n");
			const color = vinci === "1" ? "muted" : "thinkingText";
			expect(foreground).toHaveBeenCalledWith(color, expect.stringContaining("Readable reasoning"));
			expect(foreground).not.toHaveBeenCalledWith(
				vinci === "1" ? "thinkingText" : "muted",
				expect.stringContaining("Readable reasoning"),
			);
			expect(output).toContain(theme.getFgAnsi(color));
			expect(output).toContain("\x1b[3m");
			expect(hasDimStyle(output)).toBe(false);
			expect(stripAnsi(output)).toContain("Readable reasoning");
			component.setHideThinkingBlock(true);
			expect(stripAnsi(component.render(80).join("\n"))).not.toContain("Readable reasoning");
			component.setHideThinkingBlock(false);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("Readable reasoning");
		} finally {
			if (previous === undefined) delete process.env.VINCI_CODE;
			else process.env.VINCI_CODE = previous;
			if (previousColorTerm === undefined) delete process.env.COLORTERM;
			else process.env.COLORTERM = previousColorTerm;
			chalk.level = previousColorLevel;
		}
	});
});
