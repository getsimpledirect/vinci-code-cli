import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SettingsList } from "../src/components/settings-list.ts";

const testTheme = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: "> ",
	hint: (text: string) => text,
};

describe("SettingsList submenu", () => {
	for (const timing of ["synchronous", "deferred"] as const) {
		it(`returns to the main list after ${timing} submenu completion`, () => {
			const changes: [string, string][] = [];
			let cancelCount = 0;
			let finish: ((value: string) => void) | undefined;
			const submenu = {
				render: () => ["Submenu"],
				invalidate() {},
			};
			const list = new SettingsList(
				[
					{
						id: "choice",
						label: "Setting",
						currentValue: "old",
						submenu: (_currentValue, done) => {
							if (timing === "synchronous") {
								done("new");
							} else {
								finish = done;
							}
							return submenu;
						},
					},
				],
				5,
				testTheme,
				(id, value) => changes.push([id, value]),
				() => {
					cancelCount++;
				},
			);

			list.handleInput("\r");
			if (timing === "deferred") {
				assert.deepEqual(list.render(80), ["Submenu"]);
				assert.ok(finish);
				finish("new");
			}

			assert.deepEqual(changes, [["choice", "new"]]);
			assert.equal(
				list.render(80)[0],
				"> Setting  new",
				"main settings list should render after submenu completion",
			);
			list.handleInput("\x1b");
			assert.equal(cancelCount, 1, "Escape should cancel the main settings list");
		});
	}
});
