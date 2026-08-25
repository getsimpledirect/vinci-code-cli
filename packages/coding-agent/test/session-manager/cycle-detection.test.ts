import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CustomEntry,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "../../src/core/session-manager.ts";
import {
	selectSharedVinciVerificationState,
	VINCI_CORRUPTED_VERIFICATION_MESSAGE,
	VINCI_VERIFICATION_ENTRY,
} from "../../src/core/vinci-grader.ts";

describe("session parent cycle detection", () => {
	let tempDir: string;
	let file: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-cycle-detection-"));
		file = join(tempDir, "session.jsonl");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function customEntry(id: string, parentId: string | null): CustomEntry {
		return {
			type: "custom",
			customType: "cycle-test",
			id,
			parentId,
			timestamp: "2025-01-01T00:00:00.000Z",
		};
	}

	function openSession(entries: SessionEntry[]): SessionManager {
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "cycle-session",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: tempDir,
		};
		writeFileSync(file, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		return SessionManager.open(file, tempDir);
	}

	function expectCycleSignal(session: SessionManager, expectedPathIds: string[]): void {
		expect(session.buildContextEntries().map((entry) => entry.id)).toEqual(expectedPathIds);

		const branch = session.getBranch();
		expect(branch.slice(0, -1).map((entry) => entry.id)).toEqual(expectedPathIds);
		expect(branch.at(-1)).toMatchObject({
			type: "custom",
			customType: VINCI_VERIFICATION_ENTRY,
			parentId: expectedPathIds.at(-1) ?? null,
			data: {
				variant: "terminal-unverifiable",
				status: "failed",
				summary: VINCI_CORRUPTED_VERIFICATION_MESSAGE,
			},
		});
		expect(selectSharedVinciVerificationState(branch)).toMatchObject({
			variant: "terminal-unverifiable",
			status: "failed",
			summary: VINCI_CORRUPTED_VERIFICATION_MESSAGE,
		});
	}

	it("rejects a self-parenting entry and reports corruption", () => {
		const session = openSession([customEntry("self", "self")]);

		expect(session.getEntries()).toEqual([]);
		expect(session.getParsingErrors()).toEqual([
			expect.objectContaining({
				lineNumber: 2,
				message: expect.stringMatching(/parentId.*id/i),
			}),
		]);
		expect(selectSharedVinciVerificationState(session.getBranch())).toMatchObject({
			variant: "terminal-unverifiable",
			status: "failed",
			summary: VINCI_CORRUPTED_VERIFICATION_MESSAGE,
		});
	});

	it("detects a two-entry cycle", () => {
		const session = openSession([customEntry("a", "b"), customEntry("b", "a")]);

		expectCycleSignal(session, ["a", "b"]);
	});

	it("detects a three-entry cycle", () => {
		const session = openSession([customEntry("a", "c"), customEntry("b", "a"), customEntry("c", "b")]);

		expectCycleSignal(session, ["a", "b", "c"]);
	});

	it("detects a cycle reached partway through a longer path", () => {
		const session = openSession([
			customEntry("a", "b"),
			customEntry("b", "a"),
			customEntry("c", "b"),
			customEntry("d", "c"),
			customEntry("e", "d"),
		]);

		expectCycleSignal(session, ["a", "b", "c", "d", "e"]);
	});

	it("traverses a long legitimate chain completely", () => {
		const entries = Array.from({ length: 4096 }, (_, index) =>
			customEntry(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`),
		);
		const session = openSession(entries);
		const expectedIds = entries.map((entry) => entry.id);

		expect(session.buildContextEntries().map((entry) => entry.id)).toEqual(expectedIds);
		expect(session.getBranch().map((entry) => entry.id)).toEqual(expectedIds);
		expect(selectSharedVinciVerificationState(session.getBranch())).toBeUndefined();
		expect(session.getParsingErrors()).toEqual([]);
	});
});
