import "./env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createCrewWorktree, captureCrewPatch, removeCrewWorktree } from "../../extensions/lib/crew-worktree.ts";
import { getVinciCrewStatus, vinciCrewWorkUnresolved } from "../../extensions/lib/crew-status.ts";
import { getVinciVerificationState, recordVinciMutation, recordVinciVerification, VINCI_VERIFICATION_ENTRY } from "../../extensions/lib/verification-state.ts";
import vinciCrew from "../../extensions/vinci-crew.ts";
import { createVinciUiHarness } from "./harness.mjs";

const rpc = vi.hoisted(() => {
	const clients = [];
	class CrewRpc {
		constructor(options) { this.cwd = options.cwd; this.listeners = []; this.streaming = false; clients.push(this); }
		async start() {}
		async setSessionName() {}
		onEvent(listener) {
			this.listeners.push(listener);
			return () => { this.listeners = this.listeners.filter((entry) => entry !== listener); };
		}
		async getState() { return { isStreaming: this.streaming }; }
		async promptAndWait() {
			this.streaming = true;
			for (const listener of this.listeners) listener({ type: "agent_start" });
			await new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
		}
		finish(stopReason = "stop") {
			this.stopReason = stopReason;
			this.streaming = false;
			for (const listener of this.listeners) listener({ type: "agent_end", messages: [] });
			this.resolve?.();
		}
		async getMessages() {
			return [{ role: "assistant", stopReason: this.stopReason ?? "stop", provider: "faux", model: "crew-c3",
				...(this.stopReason === "error" ? { errorMessage: "Provider fixture unavailable" } : {}),
				content: [{ type: "text", text: 'Captured child result.\n```vinci-handoff\n{"deviations":[],"deferred":[]}\n```' }],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }];
		}
		async getLastAssistantText() { return (await this.getMessages())[0].content[0].text; }
		async getEntries() { return { entries: this.entries ?? [] }; }
		async getSessionStats() { return { tokens: { total: 2 } }; }
		async stop() { this.finish(); }
	}
	const review = { started: false };
	return { clients, CrewRpc, review };
});

vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original()), RpcClient: rpc.CrewRpc,
	runReview: async () => {
		rpc.review.started = true;
		return new Promise((resolve) => { rpc.review.resolve = resolve; });
	},
}));

const opened = [];
const priorEnv = new Map();
function environment(key, value) {
	if (!priorEnv.has(key)) priorEnv.set(key, process.env[key]);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

afterEach(async () => {
	while (opened.length) {
		const ui = opened.pop();
		ui.core.agent.clearAllQueues();
		await ui.session.abort();
		await ui.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await ui.close();
	}
	vi.restoreAllMocks();
	for (const [key, value] of priorEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	priorEnv.clear();
	rpc.clients.length = 0;
	rpc.review.started = false;
	delete rpc.review.resolve;
});

function helper(id, status, overrides = {}) {
	return { id, name: `agent-${id}`, task: "Inspect the bounded fixture", status,
		finishedAt: Date.now(), notifiedAt: Date.now(), deliveredAt: Date.now(),
		attestation: "attested", deviations: [], deferred: [], omitted: { deviations: 0, deferred: 0 }, ...overrides };
}

async function createUi(entries = [], options = {}) {
	const ui = await createVinciUiHarness({ connected: true, ...options, extensions: [
		{ factory: (pi) => pi.on("session_start", () => {
			for (const entry of entries) pi.appendEntry("vinci-crew-helper", entry);
		}), path: "vinci/test/ui/crew-c3-seed.ts" },
		{ factory: vinciCrew, path: "vinci/extensions/vinci-crew.ts" },
	] });
	opened.push(ui);
	// The real in-memory SessionManager has no disk session directory. Give Crew's saved artifacts
	// an explicit owned fixture location instead of allowing its empty directory to resolve at cwd.
	vi.spyOn(ui.session.sessionManager, "getSessionDir").mockReturnValue(ui.core.tempDir);
	return ui;
}

function latest(ui, id) {
	return ui.session.sessionManager.getBranch().filter(
		(entry) => entry.type === "custom" && entry.customType === "vinci-crew-helper" && entry.data.id === id,
	).at(-1)?.data;
}

async function waitUntil(predicate, description) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`Timed out waiting for ${description}`);
}

async function spawn(ui, name = "live") {
	const runner = ui.session.extensionRunner;
	await runner.getToolDefinition("spawn_helper").execute("c3-spawn", { name, task: "Bounded synthetic progress" },
		new AbortController().signal, () => {}, runner.createContext());
	await waitUntil(() => rpc.clients.at(-1)?.resolve, "actual Crew RPC prompt admission");
	await ui.settle();
	return rpc.clients.at(-1);
}

function widget(ui, width) {
	const component = ui.mode.extensionWidgetsBelow.get("vinci-crew");
	assert.ok(component, "the registered Crew extension must create its actual widget");
	return component.render(width);
}

const proof = { command: "node bounded-check.mjs", summary: "Passed.", mutationRevision: 1,
	verifiedRevision: 1, checkClass: "behavioral", commandKey: "node bounded-check.mjs" };

describe("Crew C3 identity and truthful state presentation", { concurrency: false }, () => {
	test("registered agents menu separates unchecked completion, current proof, stale integration and observed cancellation", async () => {
		const ui = await createUi([
			helper(1, "waiting"), helper(2, "blocked"), helper(3, "failed"), helper(4, "done"),
			helper(5, "integrated", { verification: proof, applied: true }),
			helper(6, "integrated", { verification: proof, applied: true, reason: "The combined tree needs a fresh verification." }),
			helper(7, "blocked", { cancelledAt: Date.now() }),
			helper(8, "blocked", { cancelRequestedAt: Date.now(), reason: "Lost connection; termination is unknown." }),
			helper(9, "integrated", { verification: { ...proof, verifiedRevision: 0 }, applied: true }),
			helper(10, "done", { verification: { command: 4 } }),
		]);
		const ctx = ui.session.extensionRunner.createContext();
		const select = vi.spyOn(ctx.ui, "select").mockResolvedValue(undefined);
		await ui.session.extensionRunner.getCommand("agents").handler("", ctx);
		const rows = select.mock.calls[0][1];
		const row = (id) => rows.find((entry) => entry.includes(`agent-${id} `));
		assert.match(row(1), /waiting approval/);
		assert.match(row(2), /blocked/);
		assert.match(row(3), /failed/);
		assert.match(row(4), /completed-unverified/);
		assert.doesNotMatch(row(4), /✓/);
		assert.match(row(5), /verified/);
		assert.match(row(6), /applied-unverified/);
		assert.doesNotMatch(row(6), /✓/);
		assert.match(row(7), /cancelled/);
		assert.doesNotMatch(row(8), /cancelled/, "a cancellation request or connection loss must not claim observed cancellation");
		assert.match(row(9), /applied-unverified/, "an earlier revision's passed check must not bless completion");
		assert.match(row(10), /completed-unverified/, "malformed legacy proof must remain inspectable without claiming a pass");
	});

	test("restored requested work that never produced a patch remains unresolved until dismissed", async () => {
		const ui = await createUi([helper(41, "queued", { finishedAt: undefined })]);
		assert.equal(latest(ui, 41).status, "blocked");
		assert.equal(latest(ui, 41).stoppedUnfinished, true);
		assert.equal(latest(ui, 41).cancelledAt, undefined, "an interrupted session must not claim a cancelled turn");
		assert.deepEqual(getVinciCrewStatus().stoppedUnfinished, ["agent-41"]);
		assert.equal(vinciCrewWorkUnresolved(), true);
		const runner = ui.session.extensionRunner;
		await runner.getToolDefinition("dismiss_agent_work").execute("dismiss-restored-unfinished", { agent_id: 41 },
			new AbortController().signal, () => {}, runner.createContext());
		assert.equal(vinciCrewWorkUnresolved(), false, "the existing explicit dismissal is still the recovery path");
	});

	for (const columns of [20, 39, 40, 60, 80, 120]) {
		test(`actual Crew widget has one Vero identity and bounded rows at ${columns} columns`, async () => {
			const ui = await createUi([helper(11, "waiting"), helper(12, "blocked")], { columns, rows: 24 });
			const lines = widget(ui, columns);
			assert.equal(lines.filter((line) => line.includes("Vero")).length, 1, "Vero belongs around the tree once");
			assert.ok(lines.every((line) => visibleWidth(line) <= columns), "each actual widget row must fit without wrapping");
			assert.ok(lines.some((line) => line.includes("waiting approval")), "the decision state must survive narrow rendering");
			assert.ok(lines.some((line) => line.includes("blocked")));
			ui.sendKeys("\x1b[B");
			await ui.settle();
			assert.ok(widget(ui, columns).some((line) => line.includes("›")), "the selected helper must remain visible at narrow widths");
			ui.sendKeys("\x1b");
			ui.sendKeys("draft");
			await ui.resize(columns === 20 ? 40 : 20, 12);
			assert.equal(ui.session.extensionRunner.createContext().ui.getEditorText(), "draft");
		});
	}

	for (const setting of ["NO_COLOR", "VINCI_PLAIN", "VINCI_SCREEN_READER", "VINCI_REDUCED_MOTION"]) {
		test(`${setting} retains text identity and status without motion`, async () => {
			environment(setting, "1");
			const intervals = vi.spyOn(globalThis, "setInterval");
			const ui = await createUi([helper(11, "waiting")]);
			await spawn(ui);
			const lines = widget(ui, 80);
			assert.match(lines.join("\n"), /Vero/);
			assert.match(lines.join("\n"), /working/);
			assert.equal(intervals.mock.calls.filter(([, delay]) => delay === 1_000).length, 0,
				"Crew's elapsed heartbeat must respect the established motion preference");
			if (setting !== "VINCI_REDUCED_MOTION") assert.doesNotMatch(lines.join("\n"), /\x1b/);
		});
	}

	test("observed aborted child turn is cancelled and never auto-integrated", async () => {
		const ui = await createUi();
		ui.sendKeys("Keep this correction unsent");
		const child = await spawn(ui);
		child.finish("aborted");
		await waitUntil(() => latest(ui, 1)?.finishedAt, "observed cancelled child result");
		assert.equal(typeof latest(ui, 1).cancelledAt, "number");
		assert.equal(latest(ui, 1).applied, undefined);
		assert.equal(ui.core.faux.callCount, 0);
		assert.equal(ui.session.extensionRunner.createContext().ui.getEditorText(), "Keep this correction unsent");
		assert.match(widget(ui, 80).join("\n"), /cancelled/);
	});

	for (const outcome of ["aborted", "lost connection"]) {
		test(`${outcome} retains partial work without claiming it kept running`, async () => {
			const ui = await createUi();
			writeFileSync(join(ui.core.tempDir, "partial.txt"), "before\n");
			ui.sendKeys("Unsent correction");
			const child = await spawn(ui);
			writeFileSync(join(child.cwd, "partial.txt"), "saved child work\n");
			if (outcome === "aborted") child.finish("aborted");
			else child.reject(new Error("RPC lost connection"));
			await waitUntil(() => latest(ui, 1)?.finishedAt, "retained partial result");
			const saved = latest(ui, 1);
			assert.equal(saved.status, "waiting");
			assert.ok(readFileSync(saved.diffPath, "utf8").includes("saved child work"));
			assert.equal(readFileSync(join(ui.core.tempDir, "partial.txt"), "utf8"), "before\n");
			assert.notEqual(saved.applied, true);
			assert.equal(typeof saved.cancelledAt, outcome === "aborted" ? "number" : "undefined");
			assert.equal(ui.session.extensionRunner.createContext().ui.getEditorText(), "Unsent correction");
			assert.equal(ui.core.faux.callCount, 0);
			await ui.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
			assert.equal(latest(ui, 1).status, "waiting");
			assert.equal(latest(ui, 1).diffPath, saved.diffPath);
			assert.doesNotMatch(widget(ui, 80).join("\n"), /working|verified/);
			const ctx = ui.session.extensionRunner.createContext();
			vi.spyOn(ctx.ui, "select").mockImplementation(async (_title, options) => options[0]);
			const viewing = ui.session.extensionRunner.getCommand("agents").handler("", ctx);
			await ui.waitForText("Esc to close");
			assert.match(await ui.screen(), outcome === "aborted" ? /child turn was cancelled/ : /stopped before finishing/);
			ui.sendKeys("\x1b");
			await viewing;
		});
	}

	for (const partial of [false, true]) {
		test(`an observed provider error ${partial ? "retains partial work" : "leaves the task unfinished"} instead of claiming completion`, async () => {
			const ui = await createUi();
			writeFileSync(join(ui.core.tempDir, "failed-partial.txt"), "before\n");
			ui.sendKeys("Unsent failure correction");
			const child = await spawn(ui);
			if (partial) writeFileSync(join(child.cwd, "failed-partial.txt"), "retained after provider failure\n");
			child.finish("error");
			await waitUntil(() => latest(ui, 1)?.finishedAt, "observed provider failure");
			const saved = latest(ui, 1);
			assert.equal(saved.status, partial ? "waiting" : "failed");
			assert.equal(saved.cancelledAt, undefined);
			assert.notEqual(saved.applied, true);
			assert.match(saved.reason, /Provider fixture unavailable/);
			assert.match(saved.reason, /retry|review/i, "a retained raw failure must include its next action");
			if (partial) assert.ok(readFileSync(saved.diffPath, "utf8").includes("retained after provider failure"));
			else assert.equal(saved.stoppedUnfinished, true);
			assert.equal(vinciCrewWorkUnresolved(), true);
			assert.equal(readFileSync(join(ui.core.tempDir, "failed-partial.txt"), "utf8"), "before\n");
			assert.equal(ui.session.extensionRunner.createContext().ui.getEditorText(), "Unsent failure correction");
			assert.equal(ui.core.faux.callCount, 0);
		});
	}

	test("resizing a real decision dialog leaves navigation with the dialog and retains the main draft", async () => {
		const ui = await createUi([helper(11, "waiting")], { columns: 80, rows: 24 });
		ui.sendKeys("Still typing");
		const decision = ui.session.extensionRunner.createContext().ui.select("Crew decision", ["Keep blocked", "Allow"]);
		await ui.waitForText("Crew decision");
		for (const columns of [20, 39, 40, 60, 80, 120]) {
			await ui.resize(columns, 12);
			assert.match(await ui.screen(), /Keep blocked/);
			assert.match(await ui.screen(), /Allow/);
		}
		ui.sendKeys("\x1b[B");
		await ui.settle();
		assert.doesNotMatch(await ui.screen(), /↑↓ move · enter open · esc back/);
		ui.sendKeys("\r");
		assert.equal(await decision, "Allow");
		assert.equal(ui.session.extensionRunner.createContext().ui.getEditorText(), "Still typing");
	});

	test("working and queued rows survive resize and a short viewer keeps status and exit", async () => {
		environment("VINCI_CREW_CAPACITY", "1");
		const ui = await createUi([], { columns: 80, rows: 24 });
		await spawn(ui);
		const runner = ui.session.extensionRunner;
		await runner.getToolDefinition("spawn_helper").execute("c3-queued", { name: "queued", task: "Wait for one slot" },
			new AbortController().signal, () => {}, runner.createContext());
		assert.match(widget(ui, 80).join("\n"), /working/);
		assert.match(widget(ui, 80).join("\n"), /queued/);
		ui.sendKeys("\x1b[B", "\r");
		await ui.waitForText("Esc to close");
		for (const [columns, rows] of [[20, 4], [39, 6], [40, 8], [60, 12], [80, 24], [120, 24]]) {
			await ui.resize(columns, rows);
			const screen = await ui.screen();
			assert.match(screen, /working/);
			assert.match(screen, /Esc to close/);
			assert.ok(ui.terminal.getViewport().every((line) => visibleWidth(line) <= columns));
		}
		ui.sendKeys("\x1b");
		await ui.settle();
	});

	test("real exact-check and synthetic independent-review phases never present a pass before their verdict", async () => {
		const ui = await createUi();
		writeFileSync(join(ui.core.tempDir, "bounded-check.mjs"), 'console.log("BOUNDED_CHECK_OK");\n');
		writeFileSync(join(ui.core.tempDir, "change.txt"), "before\n");
		const child = await spawn(ui);
		writeFileSync(join(child.cwd, "change.txt"), "qualified child work\n");
		recordVinciMutation();
		recordVinciVerification("node bounded-check.mjs", true, "Recorded fixture check.", false, "behavioral", "node bounded-check.mjs", true, child.cwd);
		child.entries = [{ type: "custom", customType: VINCI_VERIFICATION_ENTRY, data: { ...getVinciVerificationState() } }];
		const ctx = ui.session.extensionRunner.createContext();
		const states = [];
		const setWidget = ctx.ui.setWidget.bind(ctx.ui);
		vi.spyOn(ctx.ui, "setWidget").mockImplementation((key, content, options) => {
			if (key === "vinci-crew" && typeof content === "function") {
				states.push(content(ui.mode.ui, ctx.ui.theme).render(80).join("\n"));
			}
			return setWidget(key, content, options);
		});
		ui.sendKeys("Keep verification result behind this draft");
		child.finish();
		await waitUntil(() => rpc.review.started, "synthetic independent-review admission after the real exact check");
		assert.ok(states.some((state) => /checking/.test(state)), "the registered widget must show the real verifier stage");
		assert.match(widget(ui, 80).join("\n"), /reviewing/);
		assert.doesNotMatch(widget(ui, 80).join("\n"), /✓|verified/);
		assert.equal(readFileSync(join(ui.core.tempDir, "change.txt"), "utf8"), "before\n");
		rpc.review.resolve("## Verdict\nships\n");
		await waitUntil(() => latest(ui, 1)?.status === "integrated", "qualified synthetic integration");
		assert.equal(readFileSync(join(ui.core.tempDir, "change.txt"), "utf8"), "qualified child work\n");
		const select = vi.spyOn(ctx.ui, "select").mockResolvedValue(undefined);
		await ui.session.extensionRunner.getCommand("agents").handler("", ctx);
		assert.match(select.mock.calls[0][1][0], /✓ verified/);
		assert.equal(ui.session.extensionRunner.createContext().ui.getEditorText(), "Keep verification result behind this draft");
	});
});

function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
}

async function approvalFixture() {
	const ui = await createUi();
	const cwd = ui.core.tempDir;
	git(cwd, ["init", "-q"]);
	const original = "first\n2\n3\n4\n5\n6\n7\n8\n9\nlast\n";
	writeFileSync(join(cwd, "change.txt"), original);
	git(cwd, ["add", "change.txt"]);
	git(cwd, ["-c", "user.name=Crew fixture", "-c", "user.email=crew@example.invalid", "commit", "-qm", "fixture"]);
	const worktree = createCrewWorktree(cwd, "approval", "c3");
	let patch;
	try {
		writeFileSync(join(worktree.cwd, "change.txt"), original.replace("first", "helper"));
		patch = captureCrewPatch(worktree);
	} finally { removeCrewWorktree(cwd, worktree); }
	const diffPath = join(cwd, "proposal.diff");
	writeFileSync(diffPath, patch.diff);
	ui.session.sessionManager.appendCustomEntry("vinci-crew-helper", helper(31, "waiting", {
		diffPath, patchMetadata: patch, patchPaths: patch.paths,
	}));
	await ui.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
	const runner = ui.session.extensionRunner;
	const ctx = runner.createContext();
	let selection = 0;
	vi.spyOn(ctx.ui, "select").mockImplementation(async (_title, options) => options[selection++ === 0 ? 0 : 1]);
	return { ui, ctx, runner, cwd, original, diffPath };
}

describe("Crew final approval remains bound to the real apply proposal", { concurrency: false }, () => {
	test("a cancelled partial result requires fresh explicit approval through the actual use_agent_work tool", async () => {
		const fixture = await approvalFixture();
		fixture.ui.session.sessionManager.appendCustomEntry("vinci-crew-helper", {
			...latest(fixture.ui, 31), cancelledAt: Date.now(), reason: "The child turn was cancelled; partial work was retained.",
		});
		await fixture.runner.emit({ type: "session_start", reason: "resume" });
		const use = fixture.runner.getToolDefinition("use_agent_work");
		const refused = await use.execute("cancelled-old-authority", { agent_id: 31 },
			new AbortController().signal, () => {}, fixture.ctx);
		assert.equal(refused.details.applied, false);
		assert.equal(refused.details.userApprovalRequired, true);
		assert.match(refused.content[0].text, /cancelled.*approval|approval.*cancelled/i);
		assert.equal(readFileSync(join(fixture.cwd, "change.txt"), "utf8"), fixture.original);
		const approved = await use.execute("cancelled-fresh-authority", { agent_id: 31, user_approved: true },
			new AbortController().signal, () => {}, fixture.ctx);
		assert.equal(approved.details.applied, true);
		assert.equal(readFileSync(join(fixture.cwd, "change.txt"), "utf8"), fixture.original.replace("first", "helper"));
		assert.match(approved.content[0].text, /Verify/);
	});

	for (const trial of [1, 2, 3]) {
		test(`a later edit after the conflict decision refuses obsolete approval (trial ${trial})`, async () => {
			const fixture = await approvalFixture();
			let confirmations = 0;
			const notify = vi.spyOn(fixture.ctx.ui, "notify");
			vi.spyOn(fixture.ctx.ui, "confirm").mockImplementation(async () => {
				writeFileSync(join(fixture.cwd, "change.txt"), fixture.original.replace("last", ++confirmations === 1 ? "newer-A" : "newer-B"));
				return true;
			});
			await fixture.runner.getCommand("agents").handler("", fixture.ctx);
			assert.equal(confirmations, 2, "the existing explicit conflict decision must still be offered");
			assert.equal(readFileSync(join(fixture.cwd, "change.txt"), "utf8"), fixture.original.replace("last", "newer-B"));
			assert.notEqual(latest(fixture.ui, 31).applied, true);
			assert.ok(notify.mock.calls.some(([text]) => /changed.*approval|approval.*changed/i.test(text)), "refusal must explain why fresh approval is needed");
		});
	}

	test("same unchanged proposal and explicit override for the shown conflict both apply", async () => {
		for (const override of [false, true]) {
			const fixture = await approvalFixture();
			let confirmations = 0;
			vi.spyOn(fixture.ctx.ui, "confirm").mockImplementation(async () => {
				if (++confirmations === 1 && override) writeFileSync(join(fixture.cwd, "change.txt"), fixture.original.replace("last", "shown conflict"));
				return true;
			});
			await fixture.runner.getCommand("agents").handler("", fixture.ctx);
			assert.equal(latest(fixture.ui, 31).applied, true);
			assert.equal(readFileSync(join(fixture.cwd, "change.txt"), "utf8"), fixture.original.replace("first", "helper").replace("last", override ? "shown conflict" : "last"));
			vi.restoreAllMocks();
		}
	});

	test("dismissal while the apply dialog is open refuses its old approval and retains work", async () => {
		const fixture = await approvalFixture();
		vi.spyOn(fixture.ctx.ui, "confirm").mockImplementation(async () => {
			await fixture.runner.getToolDefinition("dismiss_agent_work").execute("dismiss-during-consent", { agent_id: 31 },
				new AbortController().signal, () => {}, fixture.ctx);
			return true;
		});
		await fixture.runner.getCommand("agents").handler("", fixture.ctx);
		assert.equal(readFileSync(join(fixture.cwd, "change.txt"), "utf8"), fixture.original);
		assert.equal(typeof latest(fixture.ui, 31).dismissedAt, "number");
		assert.notEqual(latest(fixture.ui, 31).applied, true);
		assert.ok(readFileSync(fixture.diffPath, "utf8").includes("+helper"), "dismissal must preserve the exact saved work");
	});

	test("replaced saved proposal refuses approval for the prior artifact", async () => {
		const fixture = await approvalFixture();
		vi.spyOn(fixture.ctx.ui, "confirm").mockImplementation(async () => {
			writeFileSync(fixture.diffPath, readFileSync(fixture.diffPath, "utf8").replace("+helper", "+different"));
			return true;
		});
		await fixture.runner.getCommand("agents").handler("", fixture.ctx);
		assert.equal(readFileSync(join(fixture.cwd, "change.txt"), "utf8"), fixture.original);
		assert.notEqual(latest(fixture.ui, 31).applied, true);
	});

	test("a new Git revision during approval refuses the prior revision even when patch files are unchanged", async () => {
		const fixture = await approvalFixture();
		vi.spyOn(fixture.ctx.ui, "confirm").mockImplementation(async () => {
			writeFileSync(join(fixture.cwd, "new-revision.txt"), "unrelated current work\n");
			git(fixture.cwd, ["add", "new-revision.txt"]);
			git(fixture.cwd, ["-c", "user.name=Crew fixture", "-c", "user.email=crew@example.invalid", "commit", "-qm", "new revision"]);
			return true;
		});
		await fixture.runner.getCommand("agents").handler("", fixture.ctx);
		assert.equal(readFileSync(join(fixture.cwd, "change.txt"), "utf8"), fixture.original);
		assert.notEqual(latest(fixture.ui, 31).applied, true);
	});
});
