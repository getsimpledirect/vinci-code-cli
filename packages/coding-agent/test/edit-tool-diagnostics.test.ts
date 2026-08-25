import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-diagnostics-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit failure diagnostics", () => {
	it("reports per-entry matches, atomicity, and nearest current-file evidence", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "handle.js");
		const original = [
			'import { handleInputOptions } from "./input-option.js";',
			"",
			"const initializeStdioItems = ({options, fdNumber}) => {",
			"\tconst initialStdioItems = [",
			"\t\t...handleInputOptions(options, fdNumber),",
			"\t];",
			"\treturn initialStdioItems;",
			"};",
			"",
		].join("\n");
		await writeFile(filePath, original, "utf8");

		const definition = createEditToolDefinition(dir);
		const execution = definition.execute(
			"tool-1",
			{
				path: "handle.js",
				edits: [
					{
						oldText: "\t\t...handleInputOptions(options, fdNumber),",
						newText: "\t\t...handleInputOptions(options, fdNumber, true),",
					},
					{
						oldText: "const handleInputOptions = ({input}, fdNumber) => fdNumber === 0 ? [input] : [];",
						newText: "const handleInputOptions = ({input}, fdNumber, replace) => replace ? [input] : [];",
					},
				],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		await expect(execution).rejects.toThrow(/edits\[0\] matched; edits\[1\] not found/);
		await expect(execution).rejects.toThrow(/No changes were applied/);
		await expect(execution).rejects.toThrow(/one edit call can modify only its path/);
		await expect(execution).rejects.toThrow(/Nearest current-file lines by shared identifiers/);
		await expect(execution).rejects.toThrow(/handleInputOptions\(options, fdNumber\)/);
		expect(await readFile(filePath, "utf8")).toBe(original);
	});
});
