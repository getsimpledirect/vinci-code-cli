import "./env.mjs";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import { sendVinciControl } from "../../extensions/lib/control.ts";
import vinciLoopbreak from "../../extensions/vinci-loopbreak.ts";
import vinciTodo from "../../extensions/vinci-todo.ts";
import { createVinciUiHarness, expectSnapshot } from "./harness.mjs";

const openHarnesses = [];

afterEach(async () => {
	while (openHarnesses.length > 0) await openHarnesses.pop().close();
});

async function createUi(options) {
	const ui = await createVinciUiHarness(options);
	openHarnesses.push(ui);
	return ui;
}

function approvalExtension(pi) {
	pi.registerTool({
		name: "confirm_change",
		label: "Confirm change",
		description: "Ask before a potentially destructive project change.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const choice = await ctx.ui.select("Vinci wants to delete generated files", [
				"Allow once",
				"Always allow this",
				"Skip",
			]);
			return {
				content: [{ type: "text", text: choice ? `User chose: ${choice}` : "User cancelled" }],
				details: { choice },
			};
		},
	});
}

function helperWidgetExtension(pi) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWidget(
			"crew-test",
			["● main — you're here", "  ◐ tests · working…"],
			{ placement: "belowEditor" },
		);
	});
}

function inspectTool() {
	return {
		name: "inspect_project",
		label: "Inspect project",
		description: "Inspect the current project.",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `Found package.json and 12 source files in ${params.path}.` }],
				details: { files: 13 },
			};
		},
	};
}

function blockInternalGuidanceExtension(pi) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "inspect_project") return undefined;
		sendVinciControl(
			pi,
			"vinci-test-loop-control",
			"INTERNAL CONTROL: stop repeating this exact tool and rewrite your strategy before continuing.",
		);
		return {
			block: true,
			reason: "Vinci paused this repeated action before it ran.",
		};
	});
}

function slowTool() {
	return {
		name: "slow_check",
		label: "Check project",
		description: "Pause briefly so the active working UI can be asserted.",
		parameters: Type.Object({}),
		async execute() {
			await new Promise((resolve) => setTimeout(resolve, 900));
			return { content: [{ type: "text", text: "Check complete." }], details: {} };
		},
	};
}

describe("Vinci interactive UI", { concurrency: false }, () => {
	test("disconnected startup at the standard terminal size", async () => {
		const ui = await createUi({ connected: false });
		const screen = await ui.screen();
		assert.match(screen, /\/login to connect/);
		assert.match(screen, /Vinci\b/);
		assert.match(screen, /Ask Vinci/);
		assert.match(screen, /AUTO/);
		assert.doesNotMatch(screen, /\bpi v\d/i);
		await expectSnapshot("startup-disconnected-80x24", ui);
	});

	test("signed-in startup remains honest and usable in a narrow terminal", async () => {
		const ui = await createUi({ columns: 60, rows: 20, connected: true });
		assert.match(await ui.screen(), /● signed in/);
		assert.doesNotMatch(await ui.screen(), /● connected/);
		await expectSnapshot("startup-connected-60x20", ui);
	});

	// Was "exposes only the managed Forte class". The picker deliberately shows every managed class
	// now — hiding all but one is the bug that made a second class unreachable no matter what the
	// account had chosen. What must stay true is that only MANAGED classes appear, labelled by class
	// rather than by occupant.
	test("model picker exposes the managed classes and nothing else", async () => {
		const ui = await createUi({ connected: true });
		ui.sendKeys("/model", "\r");
		const screen = await ui.waitForText("Model Name: Vinci");
		assert.match(screen, /Vinci Forte/);
		assert.match(screen, /Vinci Fortissimo/);
		// No occupant in the label: the model behind a class rotates server-side, so naming it here
		// would go stale silently on the next swap.
		assert.doesNotMatch(screen, /GLM 5\.2|Kimi/);
		assert.doesNotMatch(screen, /Piccolo|Bozza|Tela|vinci-piccolo|vinci-bozza|vinci-tela/);
	});

	test("read-only command views scroll and dismiss without aborting", async () => {
		const ui = await createUi({ connected: true });

		ui.sendKeys("/hotkeys", "\r");
		let screen = await ui.waitForText("Keyboard Shortcuts");
		assert.match(screen, /Navigation/);
		assert.match(screen, /Press Escape\/Ctrl\+C to close/);

		ui.sendKeys("\x1b[6~");
		screen = await ui.waitForText("Editing");
		assert.doesNotMatch(screen, /Navigation/);

		ui.sendKeys("\x1b");
		screen = await ui.screen();
		assert.doesNotMatch(screen, /Keyboard Shortcuts|Operation aborted/);
		assert.match(screen, /Ask Vinci/);

		ui.sendKeys("/changelog", "\r");
		screen = await ui.waitForText("What's New");
		assert.match(screen, /Press Escape\/Ctrl\+C to close/);

		ui.sendKeys("\x1b");
		screen = await ui.screen();
		assert.doesNotMatch(screen, /What's New|Operation aborted/);
		assert.match(screen, /Ask Vinci/);
	});

	test("helper status renders below the editor without a native PTY", async () => {
		const ui = await createUi({
			extensions: [{ factory: helperWidgetExtension, path: "vinci/test/ui/helper-widget-extension.ts" }],
		});
		const screen = await ui.screen();
		assert.match(screen, /● main — you're here/);
		assert.match(screen, /tests · working…/);
		await expectSnapshot("helper-widget-80x24", ui);
	});

	test("prompt submission renders the user request and completion", async () => {
		const ui = await createUi({ responses: ["I found the entry point and mapped the project structure."] });
		await ui.prompt("Explain this project");
		const screen = await ui.screen();
		assert.match(screen, /Explain this project/);
		assert.match(screen, /mapped the project structure/);
		assert.match(screen, /● connected/);
		await expectSnapshot("prompt-complete-80x24", ui);
	});

	// Code is the most common thing Vinci renders and the least covered: every other snapshot here
	// is prose. #98 shipped raw ``` delimiters for eight releases partly because nothing rendered a
	// fenced block end to end.
	//
	// KNOW WHAT THIS GUARDS. This lane runs vitest with --root at the repo root, where no vitest
	// config exists, so the pi-tui->src alias in packages/coding-agent/vitest.config.ts does NOT
	// apply: `@earendil-works/pi-tui` resolves through the node_modules symlink to
	// packages/tui/dist. So this asserts the built artifact, not packages/tui/src, and it is only
	// meaningful when dist is current. The authoritative guard for the renderer itself is
	// packages/tui/test/markdown.test.ts, which imports src directly and covers both the default
	// and VINCI_CODE=1 branches. This test's job is narrower but still real: it proves the whole
	// assistant-message path — faux model -> agent loop -> masking -> Markdown -> xterm — renders
	// code bare under VINCI_CODE=1, which env.mjs sets for every scenario here.
	test("fenced code renders as code, not as raw fence delimiters", async () => {
		const ui = await createUi({
			responses: ['Here is the guard:\n\n```js\nconst limit = 5;\n```\n\nThat caps the retries.'],
		});
		await ui.prompt("Show me the retry guard");
		const screen = await ui.screen();

		assert.match(screen, /const limit = 5;/);
		assert.doesNotMatch(screen, /```/, "code fences must never reach the rendered screen");
		assert.doesNotMatch(screen, /^\s*js\s*$/m, "the language tag must not render as its own line");
		await expectSnapshot("code-block-80x24", ui);
	});

	test("passive inspection questions become proactive progress", async () => {
		const ui = await createUi({
			responses: [
				"The README is accurate. What improvements are you looking at?",
				"Six tracks are present. Want me to inspect the lesson files?",
				"The lesson files are complete. What else are you looking at?",
				"I compared the lesson structure and identified the highest-impact improvement.",
			],
		});

		await ui.prompt("Let's improve the courses");
		const screen = await ui.screen();
		assert.equal(ui.core.faux.callCount, 4);
		assert.doesNotMatch(screen, /What improvements are you looking at|Want me to inspect|What else are you looking at/);
		assert.match(screen, /I’ll (?:check that now|identify the highest-impact)/);
		assert.match(screen, /identified the highest-impact improvement/);
	});

	test("auto mode executes promised exploration without typed continue", async () => {
		const ui = await createUi({
			tools: [inspectTool()],
			responses: [
				"I'll look at the repo and suggest improvements.",
				{ toolCalls: [{ name: "inspect_project", args: { path: "." } }], stopReason: "toolUse" },
				"I found the repo structure and an existing improvement plan. I'm about to read a few more core files, then surface concrete improvements.",
				{ toolCalls: [{ name: "inspect_project", args: { path: "src" } }], stopReason: "toolUse" },
				"The existing diagnosis is outdated. I'm now looking at the real gaps in testing and setup.",
				"Start with automated tests: they protect every later course and infrastructure change. Next, document setup and add repeatable database workflows.",
			],
		});

		await ui.prompt("Look through this learning repo and recommend improvements");
		const screen = await ui.screen();
		assert.equal(ui.core.faux.callCount, 6);
		assert.match(screen, /Start with automated tests/);
		assert.doesNotMatch(screen, /wait for the user to say continue|progress-only turn/);
	});

	test("implicit next-step phrasing continues without typed nudges", async () => {
		const ui = await createUi({
			responses: [
				"What I'd verify next is whether the CI has a real test command. A quick check will settle that.",
				"Most files are mapped. A couple to spot-check remain before I can give a reliable answer.",
				"What's left is the glue between the workflow and package scripts.",
				"The CI currently has a placeholder test, so it can report green without testing the app. Replace that with a real narrow test suite first.",
			],
		});

		await ui.prompt("Audit this repository's infrastructure");
		assert.equal(ui.core.faux.callCount, 4);
		assert.match(await ui.screen(), /report green without\s+testing the app/);
	});

	test("completion language is reserved for the actual end of work", async () => {
		const ui = await createUi({
			responses: [
				{
					text: "Done. The workflow is working.",
					toolCalls: [{ name: "write", args: { path: "ci.yml", content: "name: CI\n" } }],
					stopReason: "toolUse",
				},
				"The workflow file is created; verification is still needed before calling it working.",
			],
		});

		await ui.prompt("Create the CI workflow");
		const screen = await ui.screen();
		assert.doesNotMatch(screen, /^\s*Done\. The workflow is working\./m);
		assert.match(screen, /That part is in place; I’m continuing/);
		assert.match(screen, /verification is still needed/);
	});

	test("specific decision questions still return control to the user", async () => {
		const ui = await createUi({
			responses: ["The two course formats lead to different outcomes. Which audience should this course target?"],
		});

		await ui.prompt("Improve the courses");
		assert.equal(ui.core.faux.callCount, 1);
		assert.match(await ui.screen(), /Which audience should this\s+course target\?/);
	});

	test("tool execution and its follow-up stay legible", async () => {
		const ui = await createUi({
			tools: [inspectTool()],
			responses: [
				{ toolCalls: [{ name: "inspect_project", args: { path: "." } }], stopReason: "toolUse" },
				"The project has one package manifest and 12 source files.",
			],
		});
		await ui.prompt("Inspect the project");
		const screen = await ui.screen();
		assert.match(screen, /Inspect project/);
		assert.match(screen, /12 source files/);
		await expectSnapshot("tool-flow-80x24", ui);
	});

	test("an ignored exploration steer does not duplicate the final answer", async () => {
		const auditCalls = Array.from({ length: 14 }, (_, index) => ({
			text: `I’m checking infrastructure area ${index + 1} because it may reveal a different deployment gap.`,
			toolCalls: [{ name: "inspect_project", args: { path: `area-${index + 1}` } }],
			stopReason: "toolUse",
		}));
		const finalAnswer =
			"I found three concrete infrastructure priorities. Start with automated tests because they protect every later database and deployment change; then document environment setup and add a repeatable migration workflow. This recommendation is based on the project structure and configuration I inspected.";
		const ui = await createUi({
			tools: [inspectTool()],
			extensions: [{ factory: vinciLoopbreak, path: "vinci/extensions/vinci-loopbreak.ts" }],
			responses: [
				...auditCalls,
				{
					text: "I have enough evidence to synthesize, but I’m trying one redundant inspection.",
					toolCalls: [{ name: "inspect_project", args: { path: "redundant-area" } }],
					stopReason: "toolUse",
				},
				finalAnswer,
				finalAnswer,
			],
		});

		await ui.prompt("Audit this repository's infrastructure and prioritize improvements");
		assert.equal(ui.core.faux.callCount, 16);
		assert.match(await ui.screen(), /Start with automated tests/);
	});

	test("permission decisions are keyboard-driven and return to the editor", async () => {
		const ui = await createUi({
			extensions: [{ factory: approvalExtension, path: "vinci/test/ui/approval-extension.ts" }],
			responses: [
				{ toolCalls: [{ name: "confirm_change", args: {} }], stopReason: "toolUse" },
				"Skipped the deletion and kept the project unchanged.",
			],
		});

		const { completion } = await ui.startPrompt("Clean generated files");
		await ui.waitForText("Vinci wants to delete generated files");
		await expectSnapshot("permission-dialog-80x24", ui);
		ui.sendKeys("j", "j", "\r");
		await completion;
		await ui.settle();
		assert.match(await ui.screen(), /Skipped the deletion/);
		await expectSnapshot("permission-complete-80x24", ui);
	});

	test("plan creation and progression use Vinci's real todo extension", async () => {
		const ui = await createUi({
			extensions: [{ factory: vinciTodo, path: "vinci/extensions/vinci-todo.ts" }],
			responses: [
				{
					toolCalls: [
						{
							name: "todo",
							args: {
								steps: [
									{ title: "Inspect the current UI", status: "doing" },
									{ title: "Implement the new layout", status: "todo" },
									{ title: "Verify terminal sizes", status: "todo" },
								],
							},
						},
					],
					stopReason: "toolUse",
				},
				{
					toolCalls: [
						{
							name: "todo",
							args: {
								steps: [
									{ title: "Inspect the current UI", status: "done" },
									{ title: "Implement the new layout", status: "doing" },
									{ title: "Verify terminal sizes", status: "todo" },
								],
							},
						},
					],
					stopReason: "toolUse",
				},
				"The three-step plan is mapped. Which terminal size should the layout prioritize?",
			],
		});
		await ui.prompt("Plan the UI work");
		const screen = await ui.screen();
		assert.match(screen, /Plan\s+1\/3/);
		assert.match(screen, /Implement the new layout/);
		assert.doesNotMatch(screen, /Plan · 0\/3 done/);
		assert.doesNotMatch(screen, /You just finished a step/);
		await expectSnapshot("plan-progressed-80x24", ui);
	});

	test("plan mode continues exploration without a typed continue", async () => {
		const ui = await createUi({
			extensions: [{ factory: vinciTodo, path: "vinci/extensions/vinci-todo.ts" }],
			responses: [
				{
					toolCalls: [
						{
							name: "todo",
							args: {
								steps: [
									{ title: "Audit the course tracks", status: "todo" },
									{ title: "Audit infrastructure", status: "todo" },
									{ title: "Form the improvement plan", status: "todo" },
								],
							},
						},
					],
					stopReason: "toolUse",
				},
				"The course tracks are mapped. Now I’m checking infrastructure.",
				"I found two infrastructure paths with different costs. Which hosting target should the plan optimize for?",
			],
		});

		await ui.prompt("Keep looking and give me a plan for courses and infrastructure");
		const screen = await ui.screen();
		assert.equal(ui.core.faux.callCount, 3);
		assert.match(screen, /Which hosting target\s+should the plan optimize for\?/);
		assert.doesNotMatch(screen, /Continue the read-only planning work|vinci-plan-continue/);
	});

	test("plan continuation stays bounded across alternating tool calls", async () => {
		const ui = await createUi({
			tools: [inspectTool()],
			responses: [
				{ toolCalls: [{ name: "inspect_project", args: { path: "." } }], stopReason: "toolUse" },
				"I’m still mapping the project before I can present the plan.",
			],
		});

		await ui.prompt("Plan the course and infrastructure improvements");
		assert.equal(ui.core.faux.callCount, 14);
		assert.match(await ui.screen(), /still mapping the project/);
	});

	test("auto mode continues an unfinished approved plan without another user prompt", async () => {
		const steps = [
			{ title: "Inspect the current README", status: "doing" },
			{ title: "Update and verify the README", status: "todo" },
		];
		const ui = await createUi({
			extensions: [{ factory: vinciTodo, path: "vinci/extensions/vinci-todo.ts" }],
			responses: [
				{ toolCalls: [{ name: "todo", args: { steps } }], stopReason: "toolUse" },
				"The inspection is finished. I am moving on to the README update.",
				{
					toolCalls: [
						{
							name: "todo",
							args: {
								steps: [
									{ title: "Inspect the current README", status: "done" },
									{ title: "Update and verify the README", status: "doing" },
								],
							},
						},
					],
					stopReason: "toolUse",
				},
				"The README update is in place. I am checking the result now.",
				{
					toolCalls: [
						{
							name: "todo",
							args: {
								steps: [
									{ title: "Inspect the current README", status: "done" },
									{ title: "Update and verify the README", status: "done" },
								],
							},
						},
					],
					stopReason: "toolUse",
				},
				"Implementation finished and checked.",
			],
		});

		await ui.prompt("Implement this approved plan");
		const screen = await ui.screen();
		assert.equal(ui.core.faux.callCount, 6);
		assert.match(screen, /Implementation finished and checked/);
		assert.match(screen, /Plan complete/);
		assert.doesNotMatch(screen, /Do not wait for the user|Keep working on the approved plan/);
	});

	test("auto mode stops an unfinished plan for a specific user question", async () => {
		const ui = await createUi({
			extensions: [{ factory: vinciTodo, path: "vinci/extensions/vinci-todo.ts" }],
			responses: [
				{
					toolCalls: [
						{
							name: "todo",
							args: {
								steps: [
									{ title: "Choose the deployment target", status: "doing" },
									{ title: "Deploy the app", status: "todo" },
								],
							},
						},
					],
					stopReason: "toolUse",
				},
				"I need one decision before deployment. Which environment should I use?",
			],
		});

		await ui.prompt("Implement this approved plan");
		assert.equal(ui.core.faux.callCount, 2);
		assert.match(await ui.screen(), /Which environment should I use\?/);
	});

	test("verified completion reconciles a stale plan without another model turn", async () => {
		const ui = await createUi({
			extensions: [{ factory: vinciTodo, path: "vinci/extensions/vinci-todo.ts" }],
			responses: [
				{
					toolCalls: [
						{
							name: "todo",
							args: {
								steps: [
									{ title: "Fix the regression", status: "doing" },
									{ title: "Run the focused test", status: "todo" },
								],
							},
						},
					],
					stopReason: "toolUse",
				},
				{
					toolCalls: [
						{
							name: "write",
							args: {
								path: "regression.test.mjs",
								content: 'import test from "node:test";\ntest("fixed", () => {});\n',
							},
						},
					],
					stopReason: "toolUse",
				},
				{
					toolCalls: [
						{
							name: "bash",
							args: { command: "node --test --test-reporter=dot regression.test.mjs" },
						},
					],
					stopReason: "toolUse",
				},
				"All tests pass. The regression fix is complete.",
			],
		});

		await ui.prompt("Fix this focused regression");
		const screen = await ui.screen();
		assert.equal(ui.core.faux.callCount, 4);
		// A verified pass closes only verification-shaped steps ("Run the focused test" → 1/2); it
		// never fabricates completion for other steps, so no "Plan complete" — the ✓ Done receipt
		// carries the verified state and the plan stays truthful, still without a paid extra turn.
		assert.match(screen, /Plan\s+1\/2/);
		assert.match(screen, /● Fix the regression/);
		assert.doesNotMatch(screen, /Plan complete/);
		assert.match(screen, /✓ Done/);
		assert.doesNotMatch(screen, /vinci-plan-auto-continue|Keep working on the approved plan/);
	});

	test("a repeated failed review pauses mutations instead of reopening forever", async () => {
		let reviewCalls = 0;
		const reviewTodoExtension = (pi) =>
			vinciTodo(pi, async () => {
				reviewCalls++;
				return {
					text: "The password migration is still unsafe for existing users.\n\n## Verdict\nneeds work",
					verdict: "needs-work",
				};
			});
		const doing = [{ title: "Make the auth migration safe", status: "doing" }];
		const done = [{ title: "Make the auth migration safe", status: "done" }];
		const ui = await createUi({
			extensions: [{ factory: reviewTodoExtension, path: "vinci/test/ui/review-todo-extension.ts" }],
			responses: [
				{ toolCalls: [{ name: "todo", args: { steps: doing } }], stopReason: "toolUse" },
				{ toolCalls: [{ name: "todo", args: { steps: done } }], stopReason: "toolUse" },
				{ toolCalls: [{ name: "todo", args: { steps: done } }], stopReason: "toolUse" },
				{ toolCalls: [{ name: "bash", args: { command: "git diff" } }], stopReason: "toolUse" },
				{ toolCalls: [{ name: "write", args: { path: "SETUP.md", content: "# Setup\n" } }], stopReason: "toolUse" },
				"Independent review still finds the migration unsafe, so I stopped before making more changes.",
			],
		});

		await ui.prompt("Fix the auth system completely");
		const screen = await ui.screen();
		assert.equal(reviewCalls, 2);
		assert.equal(ui.core.faux.callCount, 6);
		assert.equal(existsSync(join(ui.core.tempDir, "SETUP.md")), false);
		assert.match(screen, /stopped before\s+making more changes/);
		assert.doesNotMatch(screen, /Stop making changes|Automation is paused after/);
	});

	test("natural-language planning stays read-only and does not leak its control prompt", async () => {
		const ui = await createUi({
			responses: [
				{ toolCalls: [{ name: "write", args: { path: "IMPROVEMENT_PLAN.md", content: "# Internal plan" } }], stopReason: "toolUse" },
				"I kept the plan in Vinci and left the project unchanged. Should the README target users or contributors?",
			],
		});
		await ui.prompt("Let's plan this README update");
		const screen = await ui.screen();
		assert.match(screen, /PLAN/);
		assert.match(screen, /left the project unchanged/);
		assert.equal(existsSync(join(ui.core.tempDir, "IMPROVEMENT_PLAN.md")), false);
		assert.doesNotMatch(screen, /Keep the plan in Vinci's plan UI|Do not create a plan file/);
		await expectSnapshot("planning-read-only-80x24", ui);
	});

	test("an explicit compound approval leaves plan mode and starts building", async () => {
		const ui = await createUi({
			responses: [
				"The read-only plan is ready for one material choice. Should it prioritize speed or completeness?",
				"Building the approved plan now.",
			],
		});

		await ui.prompt("Let's plan this first");
		assert.match(await ui.screen(), /◇ PLAN/);
		await ui.prompt("yes approved, let's start implementing");
		const screen = await ui.screen();
		assert.match(screen, /Building the approved plan now/);
		assert.match(screen, /▶ AUTO/);
	});

	test("blocked tool guidance remains private", async () => {
		const ui = await createUi({
			tools: [inspectTool()],
			extensions: [{ factory: blockInternalGuidanceExtension, path: "vinci/test/ui/block-guidance-extension.ts" }],
			responses: [
				{ toolCalls: [{ name: "inspect_project", args: { path: "." } }], stopReason: "toolUse" },
				"I stopped the repeated action and used the available context instead.",
			],
		});
		await ui.prompt("Inspect without looping");
		const screen = await ui.screen();
		assert.match(screen, /Vinci paused this (?:action|repeated action) before it ran/);
		assert.doesNotMatch(screen, /INTERNAL CONTROL|rewrite your strategy/);
	});

	test("active work has one animated, communicative state", async () => {
		const ui = await createUi({
			tools: [slowTool()],
			responses: [
				{
					text: "I'm checking the project setup first so I can verify the result.",
					toolCalls: [{ name: "slow_check", args: {} }],
					stopReason: "toolUse",
				},
				"The project check finished.",
			],
		});
		const { completion } = await ui.startPrompt("Check the project");
		await ui.waitForText("verify the result");
		const activeScreen = await ui.screen();
		assert.doesNotMatch(activeScreen, /Ask Vinci/);
		assert.match(activeScreen, /Checking the result…/);
		const firstPulse = ui.terminal.getViewport().join("\n").match(/╭ ([·•●])\s/)?.[1];
		await new Promise((resolve) => setTimeout(resolve, 310));
		await ui.settle();
		const secondPulse = ui.terminal.getViewport().join("\n").match(/╭ ([·•●])\s/)?.[1];
		assert.ok(firstPulse);
		assert.ok(secondPulse);
		assert.notEqual(firstPulse, secondPulse);
		await expectSnapshot("active-working-80x24", ui);
		await completion;
		await ui.settle();
		assert.match(await ui.screen(), /Ask Vinci/);
	});

	test("changed files produce a transparent completion receipt", async () => {
		const ui = await createUi({
			responses: [
				{
					toolCalls: [{ name: "write", args: { path: "README.md", content: "# Test project\n" } }],
					stopReason: "toolUse",
				},
				"I updated the README and left it ready for review.",
			],
		});
		await ui.prompt("Update the README");
		const screen = await ui.screen();
		assert.match(screen, /✓ Done/);
		assert.match(screen, /README\.md/);
		assert.match(screen, /saved · \+1 −0/);
		assert.match(screen, /\+\s*1 # Test project/);
		// The UI suite runs with VINCI_NO_VERIFY=1 (see ui/env.mjs). A doc-only session records no
		// check-warranting mutation, so the honest "no check was required" survives the off switch
		// instead of over-warning "no check was run" (#187 — the skipped-vs-unneeded distinction).
		assert.match(screen, /no project check was required/);
		assert.match(screen, /2 model calls/);
		await expectSnapshot("completion-receipt-80x24", ui);
	});

	test("targeted edits show a compact added and removed preview", async () => {
		const ui = await createUi({
			responses: [
				{
					toolCalls: [{
						name: "edit",
						args: {
							path: "config.ts",
							edits: [{ oldText: 'const mood = "quiet";', newText: 'const mood = "lively";' }],
						},
					}],
					stopReason: "toolUse",
				},
				"I made the interface feel more lively.",
			],
		});
		writeFileSync(join(ui.core.tempDir, "config.ts"), 'const mood = "quiet";\n');

		await ui.prompt("Make the interface feel more lively");
		const screen = await ui.screen();
		assert.match(screen, /Done — please check it/);
		assert.match(screen, /changed · \+1 −1/);
		assert.match(screen, /-\s*1 const mood = "quiet";/);
		assert.match(screen, /\+\s*1 const mood = "lively";/);
	});

	test("successful checks are recorded without a broader verification claim", async () => {
		const ui = await createUi({
			responses: [
				{
					toolCalls: [{ name: "write", args: { path: "example.test.mjs", content: 'import test from "node:test";\ntest("works", () => {});\n' } }],
					stopReason: "toolUse",
				},
				{
					toolCalls: [{ name: "bash", args: { command: "node --test --test-reporter=dot example.test.mjs" } }],
					stopReason: "toolUse",
				},
				"The project check passed and the test file is ready for review.",
			],
		});
		await ui.prompt("Add the project check");
		const screen = await ui.screen();
		assert.match(screen, /✓ Done/);
		assert.match(screen, /check: node --test --test-reporter=dot/);
		assert.match(screen, /3 model calls/);
		assert.doesNotMatch(screen, /Changes verified/);
		await expectSnapshot("checked-completion-receipt-80x24", ui);
	});

	test("failed responses remain visible and actionable", async () => {
		const ui = await createUi({
			responses: [{ error: "The local provider stopped responding.", stopReason: "error" }],
		});
		await ui.prompt("Run the checks");
		const screen = await ui.screen();
		assert.match(screen, /local provider stopped responding/);
		assert.match(screen, /Stopped — needs you/);
		await expectSnapshot("failed-response-80x24", ui);
	});

	test("expired credentials never appear connected", async () => {
		const ui = await createUi({
			connected: true,
			responses: [{ error: "401 Unauthorized: the Vinci credential expired.", stopReason: "error" }],
		});
		await ui.prompt("Explain this project");
		const screen = await ui.screen();
		assert.match(screen, /! reconnect/);
		assert.match(screen, /Stopped — needs you/);
		assert.doesNotMatch(screen, /● connected/);
		await expectSnapshot("expired-credentials-80x24", ui);
	});

	test("completed work reflows after a terminal resize", async () => {
		const ui = await createUi({
			responses: [
				"Updated the navigation and verified that the result remains readable when the terminal becomes narrow.",
			],
		});
		await ui.prompt("Update the navigation");
		await ui.resize(60, 20);
		const screen = await ui.screen();
		assert.match(screen, /terminal becomes narrow/);
		await expectSnapshot("resized-completion-60x20", ui);
	});
});
