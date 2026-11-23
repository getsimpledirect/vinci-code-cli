import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { Box } from "../src/components/box.ts";

describe("Box", () => {
	it("renders no rows when it has no children or its children render no rows", () => {
		const box = new Box();
		assert.deepEqual(box.render(10), []);

		box.addChild({ render: () => [], invalidate() {} });
		assert.deepEqual(box.render(10), []);
	});

	it("subtracts both horizontal pads from the child width and pads the rendered rows", () => {
		const box = new Box(2, 2);
		let childWidth: number | undefined;
		box.addChild({
			render(width) {
				childWidth = width;
				return ["hi", "bye"];
			},
			invalidate() {},
		});

		const blank = " ".repeat(10);
		assert.deepEqual(box.render(10), [blank, blank, "  hi      ", "  bye     ", blank, blank]);
		assert.equal(childWidth, 6);
	});

	it("reuses row decoration when the render inputs are unchanged", () => {
		const decorate = mock.fn((line: string) => `[${line}]`);
		const box = new Box(0, 0, decorate);
		box.addChild({ render: () => ["row"], invalidate() {} });

		assert.deepEqual(box.render(5), ["[row  ]"]);
		assert.equal(decorate.mock.calls.filter((call) => call.arguments[0] === "row  ").length, 1);
		decorate.mock.resetCalls();

		assert.deepEqual(box.render(5), ["[row  ]"]);
		assert.equal(decorate.mock.calls.filter((call) => call.arguments[0] === "row  ").length, 0);
	});

	it("redecorates after a change in width, child rows, or sampled background", () => {
		let rows = ["one"];
		let background = "blue";
		const box = new Box(0, 0, (line) => `${background}[${line}]`);
		box.addChild({ render: () => rows, invalidate() {} });

		assert.deepEqual(box.render(5), ["blue[one  ]"]);
		assert.deepEqual(box.render(6), ["blue[one   ]"]);

		rows = ["two"];
		assert.deepEqual(box.render(6), ["blue[two   ]"]);

		background = "red";
		assert.deepEqual(box.render(6), ["red[two   ]"]);

		rows = ["two", "new"];
		assert.deepEqual(box.render(6), ["red[two   ]", "red[new   ]"]);
	});
});
