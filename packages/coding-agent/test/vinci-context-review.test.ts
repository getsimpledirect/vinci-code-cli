import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Container, Text, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import vinciGuard from "../../../vinci/extensions/vinci-guard.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { VinciContextReview } from "../src/modes/interactive/components/vinci-context-review.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const NO = "No, don't";
const YES = "Yes, run it";
const ALWAYS = "Always allow this exact command in this project";
const options = [NO, YES, ALWAYS];
const title =
	"Vinci — confirm a risky command\n\nThis looks destructive (delete a folder):\n\n  echo disposable\n\nRun it?";
const down = "\x1b[6~";
const up = "\x1b[5~";

function fixture(text = title, width = 40, rows = 10) {
	const size = { width, rows };
	const selected: string[] = [];
	let cancelled = false;
	const review = new VinciContextReview(
		text,
		options,
		() => size,
		(choice) => selected.push(choice),
		() => {
			cancelled = true;
		},
	);
	const paint = () => review.render(size.width).map(stripAnsi);
	return { review, size, selected, paint, cancelled: () => cancelled };
}

function finishReview(f: ReturnType<typeof fixture>) {
	const seen: string[][] = [];
	for (let pages = 0; pages < 2000; pages++) {
		const lines = f.paint();
		seen.push(lines);
		if (lines.join("\n").includes(YES)) return seen;
		f.review.handleInput(down);
	}
	throw new Error("Review did not finish");
}

describe("Vinci approval context review", () => {
	beforeAll(() => initTheme("dark"));

	it("shows full context and safe default at 80 columns", () => {
		const f = fixture(title, 80, 22);
		const screen = f.paint().join("\n");
		expect(screen).toContain("echo disposable");
		expect(f.paint().join("")).toContain("delete a folder");
		expect(screen).toContain(`→ ${NO}`);
		expect(screen).toContain(ALWAYS);
		f.review.handleInput("\r");
		expect(f.selected).toEqual([NO]);
	});

	it("requires each page at 40x12, and paging never selects an approval", () => {
		const f = fixture();
		expect(f.paint().join("\n")).not.toContain(YES);
		f.review.handleInput("j");
		f.review.handleInput("j");
		const seen = finishReview(f);
		expect(seen.length).toBeGreaterThan(1);
		expect(seen.every((lines) => lines.length <= 10 && lines.every((line) => visibleWidth(line) <= 40))).toBe(true);
		expect(seen.flat().join("\n")).toContain("echo disposable");
		const reviewedContext = seen.flatMap((lines) =>
			lines.slice(
				0,
				lines.findIndex((line) => line.startsWith("Review ")),
			),
		);
		expect(reviewedContext.join(" ").replace(/\s+/g, " ")).toContain("delete a folder");
		expect(f.selected).toEqual([]);
		expect(f.paint().join("\n")).toContain(`→ ${NO}`);
		f.review.handleInput("j");
		f.paint();
		f.review.handleInput("\r");
		expect(f.selected).toEqual([YES]);
	});

	it("cannot skip unseen pages with queued page keys", () => {
		const f = fixture(`${title}\n${"review context ".repeat(50)}`);
		f.paint();
		for (let i = 0; i < 100; i++) f.review.handleInput(down);
		expect(f.paint().join("\n")).toContain("Review 2/");
		expect(f.paint().join("\n")).not.toContain(YES);
	});

	it("supports No and Escape before any review, including unusable dimensions", () => {
		for (const [width, rows] of [
			[40, 10],
			[10, 2],
			[0, 0],
			[80, 1],
		]) {
			const f = fixture(title, width, rows);
			expect(f.paint().every((line) => visibleWidth(line) <= width)).toBe(true);
			f.review.handleInput("j");
			f.review.handleInput("\r");
			expect(f.selected).toEqual([NO]);
			f.review.handleInput("\x1b");
			expect(f.cancelled()).toBe(true);
		}
	});

	it("resets review and selected approval after rewrap, growth, or shrink", () => {
		const f = fixture(`${title}\n${"long-command ".repeat(100)}`);
		finishReview(f);
		f.review.handleInput("j");
		for (const [width, rows] of [
			[60, 12],
			[80, 22],
			[40, 10],
		]) {
			f.size.width = width;
			f.size.rows = rows;
			const screen = f.paint().join("\n");
			expect(screen).toContain("Review 1/");
			expect(screen).not.toContain(YES);
			finishReview(f);
			expect(f.paint().join("\n")).toContain(`→ ${NO}`);
		}
	});

	it("declines a stale Enter between resize and paint", () => {
		const f = fixture(title, 80, 22);
		f.paint();
		f.review.handleInput("j");
		f.size.width = 40;
		f.size.rows = 10;
		f.review.handleInput("\r");
		expect(f.selected).toEqual([NO]);
	});

	it("paginates escaped Unicode commands without truncation and quotes control bytes", () => {
		const command = `echo ${"漢🙂".repeat(500)} END\x1b[2J\r\x07`;
		const f = fixture(command);
		const pages = finishReview(f);
		expect(pages.length).toBeGreaterThan(10);
		const combined = pages
			.flatMap((lines) =>
				lines.slice(
					0,
					lines.findIndex((line) => line.startsWith("Review ")),
				),
			)
			.join("");
		expect((combined.match(/\\u6f22/g) ?? []).length).toBe(500);
		expect((combined.match(/\\ud83d\\ude42/g) ?? []).length).toBe(500);
		expect(combined).toContain("END\\u001b[2J\\u000d\\u0007");
		expect(pages.flat().every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	it("new requests start unreviewed and page back does not approve", () => {
		const f = fixture();
		finishReview(f);
		f.review.handleInput(up);
		f.paint();
		expect(f.selected).toEqual([]);
		const next = fixture();
		expect(next.paint().join("\n")).not.toContain(YES);
		next.review.handleInput("\r");
		expect(next.selected).toEqual([NO]);
	});

	it("shows a stable countdown without invalidating already reviewed pages", () => {
		const f = fixture(`${title}\n${"echo sample ".repeat(50)}`, 80, 22);
		f.review.setCountdown(10);
		finishReview(f);
		f.review.setCountdown(9);
		const screen = f.paint().join("\n");
		expect(screen).toContain("Time left: 9s");
		expect(screen).toContain(YES);
		expect(f.selected).toEqual([]);
	});

	it("the real guard opts risky-command dialogs into review and denial still blocks", async () => {
		// Classifier input only: there is no bash executor, provider, or real permission action here.
		const workspace = mkdtempSync(join(process.cwd(), ".approval-review-test-"));
		const oldTrust = process.env.VINCI_TRUST_FILE;
		process.env.VINCI_TRUST_FILE = join(workspace, "empty-trust.json");
		type Handler = (
			event: { toolName: string; input: { command: string } },
			ctx: ExtensionContext,
		) => Promise<{ block?: boolean } | undefined>;
		const handlers: Handler[] = [];
		const dialogs: { title: string; choices: string[]; opts?: { vinciReviewContext?: boolean } }[] = [];
		vinciGuard({
			on(name: string, handler: Handler) {
				if (name === "tool_call") handlers.push(handler);
			},
			registerCommand() {},
			sendMessage() {},
		} as unknown as ExtensionAPI);
		const ctx = {
			cwd: workspace,
			hasUI: true,
			ui: {
				select: async (title: string, choices: string[], opts?: { vinciReviewContext?: boolean }) => {
					dialogs.push({ title, choices, opts });
					return NO;
				},
				notify() {},
			},
		} as unknown as ExtensionContext;
		try {
			for (let request = 0; request < 2; request++) {
				const outcomes = await Promise.all(
					handlers.map((handler) => handler({ toolName: "bash", input: { command: "git reset --hard" } }, ctx)),
				);
				expect(outcomes.some((result) => result?.block)).toBe(true);
			}
			expect(dialogs).toHaveLength(2);
			for (const dialog of dialogs) {
				expect(dialog.title).toContain("git reset --hard");
				expect(dialog.choices).toEqual(options);
				expect(dialog.opts?.vinciReviewContext).toBe(true);
			}
		} finally {
			if (oldTrust === undefined) delete process.env.VINCI_TRUST_FILE;
			else process.env.VINCI_TRUST_FILE = oldTrust;
			rmSync(workspace, { recursive: true });
		}
	});
});

describe("production selector in an xterm viewport", () => {
	const terminals: TUI[] = [];
	const previous = process.env.VINCI_CODE;
	afterEach(() => {
		vi.useRealTimers();
		for (const tui of terminals.splice(0)) tui.stop();
		if (previous === undefined) delete process.env.VINCI_CODE;
		else process.env.VINCI_CODE = previous;
	});
	it("keeps timed review countdown visible and expires through cancellation", () => {
		process.env.VINCI_CODE = "1";
		initTheme("dark");
		vi.useFakeTimers();
		const tui = new TUI(new VirtualTerminal(80, 24));
		let cancelled = 0;
		const selector = new ExtensionSelectorComponent(
			title,
			options,
			() => {
				throw new Error("No selection expected");
			},
			() => {
				cancelled++;
			},
			{
				tui,
				timeout: 2000,
				reviewContextDimensions: () => ({ width: 80, rows: 22 }),
			},
		);
		try {
			expect(selector.render(80).map(stripAnsi).join("\n")).toContain("Time left: 2s");
			vi.advanceTimersByTime(1000);
			expect(selector.render(80).map(stripAnsi).join("\n")).toContain("Time left: 1s");
			vi.advanceTimersByTime(1000);
			expect(cancelled).toBe(1);
		} finally {
			selector.dispose();
		}
	});
	it("keeps review above actual footer/widgets during live resize and cancellation", async () => {
		process.env.VINCI_CODE = "1";
		initTheme("dark");
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		terminals.push(tui);
		const footer = new Text("project footer\nmodel counter", 0, 0);
		const widget = new Text("pending widget", 0, 0);
		const editor = new Container();
		const selected: string[] = [];
		const selector = new ExtensionSelectorComponent(
			title,
			options,
			(choice) => selected.push(choice),
			() => {
				editor.clear();
				editor.addChild(new Text("Editor restored", 0, 0));
				tui.requestRender();
			},
			{
				tui,
				reviewContextDimensions: () => ({
					width: terminal.columns,
					rows: terminal.rows - footer.render(terminal.columns).length - widget.render(terminal.columns).length,
				}),
			},
		);
		tui.addChild(new Text("old history\n".repeat(60), 0, 0));
		editor.addChild(selector);
		tui.addChild(editor);
		tui.addChild(widget);
		tui.addChild(footer);
		tui.setFocus(selector);
		tui.start();
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("echo disposable");
		expect(terminal.getViewport().join("\n")).toContain(YES);
		terminal.resize(40, 12);
		await terminal.waitForRender();
		const narrow = terminal.getViewport().join("\n");
		expect(narrow).not.toContain(YES);
		expect(narrow).toContain("Review 1/");
		expect(narrow).toContain(NO);
		expect(narrow).toContain("pending widget");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Editor restored");
		expect(selected).toEqual([]);
	});
	it("preserves ASCII-escaped Unicode commands across actual xterm pages", async () => {
		process.env.VINCI_CODE = "1";
		initTheme("dark");
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TUI(terminal);
		terminals.push(tui);
		const command = `echo ${"漢👩‍💻🇨🇦❤️".repeat(120)} END_COMMAND`;
		const selector = new ExtensionSelectorComponent(
			command,
			options,
			() => {
				throw new Error("No approval expected");
			},
			() => {},
			{
				tui,
				reviewContextDimensions: () => ({ width: 40, rows: 10 }),
			},
		);
		tui.addChild(selector);
		tui.addChild(new Text("footer\ncounter", 0, 0));
		tui.setFocus(selector);
		tui.start();
		const context: string[] = [];
		for (let pages = 0; pages < 200; pages++) {
			await terminal.waitForRender();
			const lines = terminal.getViewport();
			const status = lines.findIndex((line) => line.startsWith("Review "));
			expect(status).toBeGreaterThanOrEqual(3);
			context.push(...lines.slice(status - 3, status));
			if (lines.join("\n").includes(YES)) break;
			terminal.sendInput(down);
		}
		const rendered = context.join("");
		for (const escaped of [
			"\\u6f22",
			"\\ud83d\\udc69\\u200d\\ud83d\\udcbb",
			"\\ud83c\\udde8\\ud83c\\udde6",
			"\\u2764\\ufe0f",
		]) {
			expect(rendered.split(escaped).length - 1).toBe(120);
		}
		expect(rendered).toContain("END_COMMAND");
	});
});
