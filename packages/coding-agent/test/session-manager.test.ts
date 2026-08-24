import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CustomEntry, loadSessionFile, type SessionHeader, SessionManager } from "../src/core/session-manager.ts";

describe("session JSONL tail integrity", () => {
	let tempDir: string;
	let sessionFile: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-jsonl-integrity-"));
		sessionFile = join(tempDir, "session.jsonl");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function header(): SessionHeader {
		return {
			type: "session",
			version: 3,
			id: "session-id",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: tempDir,
		};
	}

	function entry(id: string, parentId: string | null): CustomEntry {
		return {
			type: "custom",
			customType: "tail-integrity-test",
			id,
			parentId,
			timestamp: "2025-01-01T00:00:00.000Z",
		};
	}

	it("reports an unterminated truncated tail while loading complete entries", () => {
		const first = entry("entry-1", null);
		const second = entry("entry-2", first.id);
		const truncated = JSON.stringify(entry("entry-3", second.id)).slice(0, -1);
		writeFileSync(
			sessionFile,
			`${JSON.stringify(header())}\n${JSON.stringify(first)}\n${JSON.stringify(second)}\n${truncated}`,
		);

		const session = SessionManager.open(sessionFile, tempDir);

		expect(session.getEntries()).toEqual([first, second]);
		expect(session.hadCorruptEntries()).toBe(true);
		expect(session.getParsingErrors()).toEqual([
			expect.objectContaining({
				kind: "truncated_tail",
				lineNumber: 4,
				message: expect.stringMatching(/truncated/i),
			}),
		]);
	});

	it("reports a malformed middle line distinctly from a truncated tail", () => {
		const first = entry("entry-1", null);
		const second = entry("entry-2", first.id);
		writeFileSync(
			sessionFile,
			`${JSON.stringify(header())}\n${JSON.stringify(first)}\n{"broken":\n${JSON.stringify(second)}\n`,
		);

		const session = SessionManager.open(sessionFile, tempDir);

		expect(session.getEntries()).toEqual([first, second]);
		expect(session.getParsingErrors()).toEqual([
			expect.objectContaining({
				kind: "malformed_line",
				lineNumber: 3,
				message: expect.stringMatching(/invalid session json/i),
			}),
		]);
	});

	it("loads a complete newline-terminated session identically without corruption", () => {
		const first = entry("entry-1", null);
		const second = entry("entry-2", first.id);
		const expectedEntries = [header(), first, second];
		writeFileSync(sessionFile, `${expectedEntries.map((fileEntry) => JSON.stringify(fileEntry)).join("\n")}\n`);

		const loadResult = loadSessionFile(sessionFile);
		const session = SessionManager.open(sessionFile, tempDir);

		expect(loadResult.entries).toEqual(expectedEntries);
		expect(loadResult.endsWithNewline).toBe(true);
		expect(loadResult.parsingErrors).toEqual([]);
		expect(session.getEntries()).toEqual([first, second]);
		expect(session.hadCorruptEntries()).toBe(false);
	});
});
