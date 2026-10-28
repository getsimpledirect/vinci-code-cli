import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

test("one Backspace removes the unsent image without adjacent text; undo restores it", () => {
	const editor = new Editor(new TUI(new VirtualTerminal(80, 24)), defaultEditorTheme);
	editor.setText("beforeafter");
	for (let index = 0; index < 5; index++) editor.handleInput("\x1b[D");
	editor.insertImageAttachment("/synthetic/image.png");
	assert.equal(editor.getText(), "before[image #1]after");
	assert.equal(editor.getExpandedText(), "before /synthetic/image.png after");
	editor.handleInput("\x7f");
	assert.equal(editor.getText(), "beforeafter");
	assert.equal(editor.getExpandedText(), "beforeafter");
	editor.handleInput("\x1f");
	assert.equal(editor.getText(), "before[image #1]after");
});

test("multiple images keep distinct paths; cursor movement and forward delete are atomic", () => {
	const editor = new Editor(new TUI(new VirtualTerminal(40, 12)), defaultEditorTheme);
	editor.insertImageAttachment("/synthetic/first.png");
	editor.insertTextAtCursor(" caption ");
	editor.insertImageAttachment("/synthetic/second.png");
	editor.handleInput("\x1b[D");
	editor.handleInput("\x1b[3~");
	assert.equal(editor.getExpandedText(), " /synthetic/first.png  caption ");
	let submitted = "";
	editor.onSubmit = (text) => {
		submitted = text;
	};
	editor.handleInput("\r");
	assert.equal(submitted, "/synthetic/first.png  caption");
});
