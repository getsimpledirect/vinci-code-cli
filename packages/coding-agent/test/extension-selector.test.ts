import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("ExtensionSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("adds a width-safe Vinci accent gutter and moves the solid selection bar", () => {
		const previousVinciCode = process.env.VINCI_CODE;
		process.env.VINCI_CODE = "1";
		try {
			const selector = new ExtensionSelectorComponent(
				"Build this?",
				["Yes", "No"],
				() => {},
				() => {},
			);
			const initialLines = selector.render(24);
			expect(initialLines.every((line) => visibleWidth(line) <= 24)).toBe(true);
			expect(initialLines.map(stripAnsi).some((line) => line.includes("▌") && line.includes("→ Yes"))).toBe(true);
			for (const width of [0, 1, 2]) {
				expect(selector.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
			}

			selector.handleInput("j");
			const movedLines = selector.render(24).map(stripAnsi);
			expect(movedLines.some((line) => line.includes("▌") && line.includes("→ No"))).toBe(true);
			expect(movedLines.every((line) => line.startsWith("▎") || line.startsWith("▌"))).toBe(true);
		} finally {
			if (previousVinciCode === undefined) delete process.env.VINCI_CODE;
			else process.env.VINCI_CODE = previousVinciCode;
		}
	});

	it("leaves the upstream selector gutter unchanged", () => {
		const previousVinciCode = process.env.VINCI_CODE;
		delete process.env.VINCI_CODE;
		try {
			const selector = new ExtensionSelectorComponent(
				"Build this?",
				["Yes", "No"],
				() => {},
				() => {},
			);
			const output = selector.render(24).map(stripAnsi).join("\n");
			expect(output).not.toContain("▎");
			expect(output).not.toContain("▌");
			expect(output).toContain("→ Yes");
		} finally {
			if (previousVinciCode === undefined) delete process.env.VINCI_CODE;
			else process.env.VINCI_CODE = previousVinciCode;
		}
	});
});
