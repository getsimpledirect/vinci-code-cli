import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "../src/components/text.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen, type TuiAltScreenOptions } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

async function fixture(options: TuiAltScreenOptions = {}, component: Component = new Text("alpha   ", 0, 0)) {
	const terminal = new VirtualTerminal(24, 6);
	const copies: string[] = [];
	const ui = new TuiAltScreen(terminal, false, {
		...options,
		copySelection: async (text) => {
			copies.push(text);
			return "native";
		},
	});
	ui.addChild(component);
	ui.start();
	await terminal.waitForRender();
	return { terminal, copies, ui };
}

async function click(terminal: VirtualTerminal, column = 2) {
	terminal.sendInput(`\x1b[<0;${column};1M`);
	terminal.sendInput(`\x1b[<0;${column};1m`);
	await terminal.waitForRender();
}

test("line-only padding fallback trims triple-click fill without changing word copies", async () => {
	const { terminal, copies, ui } = await fixture({ trimLineSelectionPadding: true });
	try {
		await click(terminal);
		await click(terminal);
		assert.deepEqual(copies, ["alpha"], "double-click copies the unchanged word");
		await click(terminal);
		assert.equal(copies.at(-1), "alpha", "triple-click LINE copy drops renderer fill padding");
	} finally {
		ui.stop({ preserveScreen: true });
	}
});

test("line fallback cannot distinguish intentional trailing spaces in rendered source", async () => {
	const component: Component = { render: () => ["alpha   "], invalidate() {} };
	const { terminal, copies, ui } = await fixture({ trimLineSelectionPadding: true }, component);
	try {
		await click(terminal);
		await click(terminal);
		await click(terminal);
		assert.equal(copies.at(-1), "alpha", "LINE-only fallback trims indistinguishable trailing spaces");
	} finally {
		ui.stop({ preserveScreen: true });
	}
});

test("drag copies retain selected spaces when the line-only option is enabled", async () => {
	const { terminal, copies, ui } = await fixture({ trimLineSelectionPadding: true });
	try {
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;8;1M");
		terminal.sendInput("\x1b[<0;8;1m");
		await terminal.waitForRender();
		assert.deepEqual(copies, ["alpha   "], "drag copy preserves its three selected trailing spaces");
	} finally {
		ui.stop({ preserveScreen: true });
	}
});

test("default library behavior keeps the ported triple-click padding", async () => {
	const { terminal, copies, ui } = await fixture();
	try {
		await click(terminal);
		await click(terminal);
		await click(terminal);
		assert.equal(copies.at(-1), "alpha".padEnd(24), "default option preserves plain-pi line copies");
	} finally {
		ui.stop({ preserveScreen: true });
	}
});

for (const policy of ["strip", "forward", undefined] as const) {
	test(`custom modal mouse policy ${policy ?? "unset"} uses the focused component only`, async () => {
		const { terminal, copies, ui } = await fixture({ customModalMouse: () => policy });
		const inputs: string[] = [];
		const panel: Component = {
			render: () => ["modal"],
			invalidate() {},
			handleInput: (data) => inputs.push(data),
		};
		const overlay = ui.showOverlay(panel);
		try {
			await terminal.waitForRender();
			const mouse = ["\x1b[<64;2;1M", "\x1b[<0;2;1M", "\x1b[<32;5;1M", "\x1b[<0;5;1m"];
			for (const data of mouse) terminal.sendInput(data);
			terminal.sendInput("x");
			assert.deepEqual(
				inputs,
				policy === "strip" ? ["x"] : policy === "forward" ? [...mouse, "x"] : [mouse[0], "x"],
				"custom modal policy strips all SGR or forwards all SGR; unset keeps ported wheel deferral",
			);
			assert.deepEqual(copies, [], "focused overlay never copies the hidden transcript");
		} finally {
			overlay.hide();
			ui.stop({ preserveScreen: true });
		}
	});
}
