import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import vinciGuard, { isTrusted } from "../../../../../vinci/extensions/vinci-guard.ts";
import type { ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import { VinciContextReview } from "../../../src/modes/interactive/components/vinci-context-review.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

const label = "Display only: ASCII-escaped context";
const options = ["No, don't", "Yes, run it", "Always allow this exact command in this project"];
const nextPage = "\x1b[6~";

function collectContext(review: VinciContextReview, width: number, rows: number): string {
	const context: string[] = [];
	for (let page = 0; page < 1000; page++) {
		const lines = review.render(width).map(stripAnsi);
		expect(lines.length).toBeLessThanOrEqual(rows);
		const status = lines.findIndex((line) => line.startsWith("Review "));
		context.push(...lines.slice(0, status === -1 ? lines.indexOf("") : status));
		if (lines.some((line) => line.includes(options[1]))) {
			const labelLines = new Text(label, 0, 0).render(width).map(stripAnsi);
			expect(context.slice(0, labelLines.length)).toEqual(labelLines);
			return context.slice(labelLines.length).join("");
		}
		review.handleInput(nextPage);
	}
	throw new Error("Context review did not finish");
}

function decodeDisplay(display: string): string {
	return display.replace(/\\u([0-9a-f]{4})/g, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

describe("PR #82: terminal-independent approval context", () => {
	const harnesses: Harness[] = [];
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
	});

	it.each([
		["literal escape", "\\u6f22\\n\\t\\x1b", "\\u005cu6f22\\u005cn\\u005ct\\u005cx1b"],
		["actual Unicode and controls", "漢\n\t\x1b[2J", "\\u6f22\\u000a\\u0009\\u001b[2J"],
		["joined emoji", "👩‍💻🇨🇦❤️", "\\ud83d\\udc69\\u200d\\ud83d\\udcbb\\ud83c\\udde8\\ud83c\\udde6\\u2764\\ufe0f"],
		["no normalization or surrogate replacement", "é e\u0301 \ud800 \udfff", "\\u00e9 e\\u0301 \\ud800 \\udfff"],
	])("shows an unambiguous display for %s", (_name, input, expected) => {
		const review = new VinciContextReview(
			input,
			options,
			() => ({ width: 40, rows: 10 }),
			() => {},
			() => {},
		);
		const display = collectContext(review, 40, 10);
		expect(display).toBe(expected);
		expect(display).toMatch(/^[\x20-\x7e]*$/);
		expect(decodeDisplay(display)).toBe(input);
	});

	it("round-trips every UTF-16 code unit without losing spaces at wrap boundaries", () => {
		const input = `  ${Array.from({ length: 65536 }, (_, code) => String.fromCharCode(code)).join("")}  `;
		const review = new VinciContextReview(
			input,
			options,
			() => ({ width: 80, rows: 10000 }),
			() => {},
			() => {},
		);
		const display = collectContext(review, 80, 10000);
		expect(display).toMatch(/^[\x20-\x7e]*$/);
		expect(decodeDisplay(display)).toBe(input);
	});

	it.each([
		[80, 21],
		[40, 9],
	])("requires review for native-width-mismatched emoji at %ix%i", (width, rows) => {
		const command = `echo ${"漢👩‍💻🇨🇦❤️sample_".repeat(35)} END_COMMAND`;
		const title = `Risk: destructive command\n\n${command}\n\nRun it?`;
		const selected: string[] = [];
		let cancelled = false;
		const review = new VinciContextReview(
			title,
			options,
			() => ({ width, rows }),
			(choice) => selected.push(choice),
			() => {
				cancelled = true;
			},
		);
		const firstPage = review.render(width).map(stripAnsi);
		expect(firstPage.join("\n")).toContain("Risk: destructive command");
		expect(firstPage.join("\n")).not.toContain(options[1]);
		review.handleInput("j");
		review.handleInput("\r");
		expect(selected).toEqual([options[0]]);
		const display = collectContext(review, width, rows);
		expect(display).toMatch(/^[\x20-\x7e]*$/);
		expect(decodeDisplay(display)).toBe(title);
		review.handleInput("\x1b");
		expect(cancelled).toBe(true);
	});

	it("keeps real guard decisions, execution input and project trust keyed to the original command", async () => {
		// The faux bash tool only records input; no shell command or provider is executed.
		const command = "git reset --hard # é 👩‍💻 \\u6f22";
		const commands = [command, command, command.replace("é", "e\u0301"), command.replace("é", "\\u00e9")];
		const executed: string[] = [];
		const dialogs: string[] = [];
		const bash: AgentTool = {
			name: "bash",
			label: "Fixture bash",
			description: "Record an approved command without running it",
			parameters: Type.Object({ command: Type.String() }),
			execute: async (_id, params) => {
				if (typeof params !== "object" || params === null || !("command" in params))
					throw new Error("Missing command");
				executed.push(String(params.command));
				return { content: [{ type: "text", text: "Recorded only" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [bash], extensionFactories: [vinciGuard] });
		harnesses.push(harness);
		const trustFile = join(harness.tempDir, "trust.json");
		vi.stubEnv("VINCI_TRUST_FILE", trustFile);
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: {
				select: async (...[title, choices, opts]: Parameters<ExtensionUIContext["select"]>) => {
					expect(choices).toEqual(options);
					expect(opts?.vinciReviewContext).toBe(true);
					dialogs.push(title);
					let selected: string | undefined;
					const review = new VinciContextReview(
						title,
						choices,
						() => ({ width: 40, rows: 10 }),
						(choice) => {
							selected = choice;
						},
						() => {},
					);
					expect(decodeDisplay(collectContext(review, 40, 10))).toBe(title);
					if (dialogs.length === 1) {
						review.handleInput("j");
						review.handleInput("j");
					}
					review.handleInput("\r");
					return selected;
				},
				notify() {},
			} as unknown as ExtensionUIContext,
		});
		for (const proposed of commands) {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: proposed }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Fixture complete"),
			]);
			await harness.session.prompt("Exercise the fixture command approval");
		}
		expect(executed).toEqual([command, command]);
		expect(dialogs).toHaveLength(3);
		expect(JSON.parse(readFileSync(trustFile, "utf8"))).toEqual({ [harness.tempDir]: [command] });
		expect(isTrusted(harness.tempDir, command)).toBe(true);
		expect(isTrusted(join(harness.tempDir, "other-project"), command)).toBe(false);
		for (const other of commands.slice(2)) expect(isTrusted(harness.tempDir, other)).toBe(false);
	});
});
