import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { sanitizeTerminalLabel } from "../src/terminal-utils.ts";

describe("sanitizeTerminalLabel", () => {
	test("keeps emoji graphemes intact at the width limit", () => {
		const result = sanitizeTerminalLabel("😀".repeat(40), 60);

		expect(visibleWidth(result)).toBeLessThanOrEqual(60);
		expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
	});

	test("caps CJK labels by terminal cells", () => {
		const result = sanitizeTerminalLabel("界".repeat(60), 60);

		expect(visibleWidth(result)).toBeLessThanOrEqual(60);
		expect(result.length).toBeLessThan(60);
	});

	test("strips OSC terminal title sequences", () => {
		const result = sanitizeTerminalLabel("safe\x1b]0;hijacked title\x07 label", 60);

		expect(result).toBe("safe label");
		expect(result).not.toContain("\x1b");
	});
});
