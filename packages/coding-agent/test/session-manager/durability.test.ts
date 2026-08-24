import { appendFileSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Worker } from "worker_threads";
import { classifyVinciTaskState } from "../../../../vinci/extensions/lib/task-outcome.ts";
import type { CustomEntry, FileEntry, SessionHeader } from "../../src/core/session-manager.ts";
import * as sessionManagerModule from "../../src/core/session-manager.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { selectSharedVinciVerificationState, VINCI_VERIFICATION_ENTRY } from "../../src/core/vinci-grader.ts";

interface TestParsingError {
	lineNumber: number;
	message: string;
}

interface TestLoadResult {
	entries: FileEntry[];
	parsingErrors: TestParsingError[];
	endsWithNewline: boolean;
}

type LoadSessionFile = (filePath: string) => TestLoadResult;

function loadSessionFile(filePath: string): TestLoadResult {
	const load = (sessionManagerModule as { loadSessionFile?: LoadSessionFile }).loadSessionFile;
	expect(load).toBeTypeOf("function");
	return load!(filePath);
}

function getParsingErrors(session: SessionManager): TestParsingError[] {
	const getErrors = (session as SessionManager & { getParsingErrors?: () => TestParsingError[] }).getParsingErrors;
	expect(getErrors).toBeTypeOf("function");
	return getErrors!.call(session);
}

describe("session file durability and corruption reporting", () => {
	let tempDir: string;
	let file: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-durability-"));
		file = join(tempDir, "session.jsonl");
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

	function customEntry(id: string, parentId: string | null, value: number): CustomEntry<number> {
		return {
			type: "custom",
			customType: "durability-test",
			data: value,
			id,
			parentId,
			timestamp: "2025-01-01T00:00:00.000Z",
		};
	}

	it("detects a truncated marker from the legacy durable record format", () => {
		const first = customEntry("entry-1", null, 1);
		const truncated = customEntry("entry-2", "entry-1", 2);
		const legacyFramedHeader = { ...header(), frameFormat: 1 };
		writeFileSync(
			file,
			`${JSON.stringify(legacyFramedHeader)}\n${JSON.stringify(first)}\t\t\t\n${JSON.stringify(truncated)}\t`,
		);

		const result = loadSessionFile(file);

		expect(result.entries).toEqual([legacyFramedHeader, first]);
		expect(result.endsWithNewline).toBe(false);
		expect(result.parsingErrors).toEqual([
			expect.objectContaining({
				lineNumber: 3,
				message: expect.stringMatching(/truncated/i),
			}),
		]);

		const session = SessionManager.open(file, tempDir);
		const appendedId = session.appendCustomEntry("durability-test", 3);
		const reloaded = SessionManager.open(file, tempDir);

		expect(reloaded.getEntries().map((entry) => entry.id)).toEqual([first.id, appendedId]);
		expect(getParsingErrors(reloaded)).toHaveLength(1);
	});

	it("distinguishes malformed and invalid-schema records from an absent entry", () => {
		const invalidRecords = [
			"not-json",
			"null",
			"42",
			"{}",
			JSON.stringify({
				type: "message",
				id: "bad-role",
				parentId: null,
				timestamp: "2025-01-01T00:00:00.000Z",
				message: { role: "bogus" },
			}),
		];
		writeFileSync(file, `${JSON.stringify(header())}\n${invalidRecords.join("\n")}\n`);

		const result = loadSessionFile(file);

		expect(result.entries).toEqual([header()]);
		expect(result.parsingErrors.map((error) => error.lineNumber)).toEqual([2, 3, 4, 5, 6]);
		expect(result.parsingErrors.every((error) => error.message.length > 0)).toBe(true);
	});

	it("appends a framed record without rewriting an existing legacy session", () => {
		const first = customEntry("entry-1", null, 1);
		const original = `${JSON.stringify(header())}\n${JSON.stringify(first)}\n`;
		writeFileSync(file, original);

		const session = SessionManager.open(file, tempDir);
		session.appendCustomEntry("durability-test", 2);

		const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
		expect(readFileSync(file, "utf8").startsWith(original)).toBe(true);
		expect(JSON.parse(lines[0])).not.toHaveProperty("frameFormat");
		expect(lines.at(-1)).toMatch(/^\{"__vinci_record_start":true,/);

		const reloaded = SessionManager.open(file, tempDir);
		expect(reloaded.getEntries()).toHaveLength(2);
		expect(getParsingErrors(reloaded)).toEqual([]);
	});

	it("accepts complete legacy durable and unframed records", () => {
		const first = customEntry("entry-1", null, 1);
		const downgraded = customEntry("entry-2", "entry-1", 2);
		const legacyFramedHeader = { ...header(), frameFormat: 1 };
		writeFileSync(file, `${JSON.stringify(legacyFramedHeader)}\n${JSON.stringify(first)}\t\t\t\n`);
		appendFileSync(file, `${JSON.stringify(downgraded)}\n`);

		const result = loadSessionFile(file);

		expect(result.entries).toEqual([legacyFramedHeader, first, downgraded]);
		expect(result.parsingErrors).toEqual([]);
		expect(result.endsWithNewline).toBe(true);
	});

	it("loads legacy messages whose content is null or missing", () => {
		const nullContent = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2025-01-01T00:00:00.000Z",
			message: { role: "user", content: null },
		};
		const missingContent = {
			type: "message",
			id: "entry-2",
			parentId: "entry-1",
			timestamp: "2025-01-01T00:00:01.000Z",
			message: { role: "assistant" },
		};
		writeFileSync(
			file,
			`${JSON.stringify(header())}\n${JSON.stringify(nullContent)}\n${JSON.stringify(missingContent)}\n`,
		);

		const session = SessionManager.open(file, tempDir);

		expect(getParsingErrors(session)).toEqual([]);
		expect(session.getEntries()).toHaveLength(2);
		expect(session.buildSessionContext().messages).toEqual([
			{ role: "user", content: [] },
			{ role: "assistant", content: [] },
		]);
	});

	it("reports corruption without refusing context, fork, or branch creation", () => {
		const first = customEntry("entry-1", null, 1);
		writeFileSync(file, `${JSON.stringify(header())}\n${JSON.stringify(first)}\t\t\t\nnot-json\n`);

		const session = SessionManager.open(file, tempDir);

		expect(getParsingErrors(session)).toHaveLength(1);
		expect(() => session.buildSessionContext()).not.toThrow();
		expect(() => session.createBranchedSession(first.id)).not.toThrow();

		const forked = SessionManager.forkFrom(file, tempDir, tempDir, { id: "forked-session" });
		expect(forked.getEntries()[0]).toEqual(first);
		expect(forked.getEntries()).toHaveLength(2);
		expect(selectSharedVinciVerificationState(forked.getBranch())?.variant).toBe("terminal-unverifiable");
		expect(getParsingErrors(forked)).toEqual([]);
	});
});

describe("issue #38 append-only record framing", () => {
	const recordPrefix = '{"__vinci_record_start":true,';
	let tempDir: string;
	let file: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-issue-38-"));
		file = join(tempDir, "session.jsonl");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function legacyHeader(cwd: string | undefined = tempDir): Record<string, unknown> {
		return {
			type: "session",
			version: 3,
			id: "session-id",
			timestamp: "2025-01-01T00:00:00.000Z",
			...(cwd === undefined ? {} : { cwd }),
		};
	}

	function customEntry(id: string, parentId: string | null, value: number): CustomEntry<number> {
		return {
			type: "custom",
			customType: "issue-38",
			data: value,
			id,
			parentId,
			timestamp: "2025-01-01T00:00:00.000Z",
		};
	}

	function assistantEntry(id: string): Record<string, unknown> {
		return {
			type: "message",
			id,
			parentId: null,
			timestamp: "2025-01-01T00:00:00.000Z",
			message: {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "openai",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
		};
	}

	it("detects adversarial framed truncation offsets without inventing a zero-length record", () => {
		const header = legacyHeader();
		const legacy = customEntry("legacy-entry", null, 1);
		const framed = Buffer.from(
			`${recordPrefix}${JSON.stringify({ ...customEntry("truncated-entry", legacy.id, 2), data: "雪-data" }).slice(1)}`,
		);
		const prefixLength = Buffer.byteLength(recordPrefix);
		const multiByteEnd = framed.indexOf(Buffer.from("雪")) + Buffer.byteLength("雪");
		const cases = [
			{ name: "mid-prefix", suffix: framed.subarray(0, Math.floor(prefixLength / 2)), truncated: true },
			{ name: "immediately post-prefix", suffix: framed.subarray(0, prefixLength), truncated: true },
			{ name: "UTF-8 multi-byte boundary", suffix: framed.subarray(0, multiByteEnd), truncated: true },
			{ name: "zero-length final line", suffix: Buffer.alloc(0), truncated: false },
		];

		for (const testCase of cases) {
			const existing = Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(legacy)}`);
			const separator = testCase.suffix.length > 0 ? Buffer.from("\n") : Buffer.alloc(0);
			writeFileSync(file, Buffer.concat([existing, separator, testCase.suffix]));

			const result = loadSessionFile(file);

			expect(result.entries, testCase.name).toEqual([header, legacy]);
			expect(result.endsWithNewline, testCase.name).toBe(false);
			if (testCase.truncated) {
				expect(result.parsingErrors, testCase.name).toEqual([
					expect.objectContaining({
						lineNumber: 3,
						message: expect.stringMatching(/truncated framed session record/i),
					}),
				]);
			} else {
				expect(result.parsingErrors, testCase.name).toEqual([]);
			}
		}
	});

	it("accepts legacy records without a framing prefix alongside framed records", () => {
		const header = legacyHeader();
		const legacy = customEntry("legacy-entry", null, 1);
		const framed = customEntry("framed-entry", legacy.id, 2);
		writeFileSync(
			file,
			`${JSON.stringify(header)}\n${JSON.stringify(legacy)}\n${recordPrefix}${JSON.stringify(framed).slice(1)}\n`,
		);

		const result = loadSessionFile(file);

		expect(result.entries).toEqual([header, legacy, framed]);
		expect(result.parsingErrors).toEqual([]);
	});

	it("preserves every append from two synchronized worker writers", async () => {
		const header = legacyHeader();
		const assistant = assistantEntry("assistant-entry");
		const original = `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n`;
		writeFileSync(file, original);
		const sessionManagerUrl = new URL("../../src/core/session-manager.ts", import.meta.url).href;
		const workerSource = `
			import { parentPort, workerData } from "node:worker_threads";
			import { SessionManager } from ${JSON.stringify(sessionManagerUrl)};

			const gate = new Int32Array(workerData.gate);
			const manager = SessionManager.open(workerData.file, workerData.tempDir);
			const readyWriters = Atomics.add(gate, 0, 1) + 1;
			if (readyWriters === 2) Atomics.notify(gate, 0);
			while (Atomics.load(gate, 0) < 2) {
				Atomics.wait(gate, 0, Atomics.load(gate, 0));
			}

			const ids = [];
			for (let sequence = 0; sequence < workerData.count; sequence++) {
				ids.push(manager.appendCustomEntry("issue-38", { writer: workerData.writer, sequence }));
			}
			parentPort.postMessage(ids);
		`;
		const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
		const writerCount = 64;
		const workerResults = await Promise.all(
			[1, 2].map(
				(writer) =>
					new Promise<string[]>((resolve, reject) => {
						const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`), {
							workerData: { gate, file, tempDir, writer, count: writerCount },
						});
						worker.once("message", resolve);
						worker.once("error", reject);
						worker.once("exit", (code) => {
							if (code !== 0) reject(new Error(`writer ${writer} exited with code ${code}`));
						});
					}),
			),
		);

		const contents = readFileSync(file, "utf8");
		const reloaded = SessionManager.open(file, tempDir);
		const writerIds = workerResults.flat();
		const payloads = reloaded
			.getEntries()
			.filter((entry): entry is CustomEntry<{ writer: number; sequence: number }> => entry.type === "custom")
			.map((entry) => entry.data);
		expect(reloaded.getEntries().map((entry) => entry.id)).toEqual(
			expect.arrayContaining(["assistant-entry", ...writerIds]),
		);
		expect(writerIds).toHaveLength(writerCount * 2);
		expect(new Set(writerIds).size).toBe(writerCount * 2);
		expect(payloads).toHaveLength(writerCount * 2);
		for (const writer of [1, 2]) {
			for (let sequence = 0; sequence < writerCount; sequence++) {
				expect(payloads).toContainEqual({ writer, sequence });
			}
		}
		expect(reloaded.getParsingErrors()).toEqual([]);
		expect(contents.startsWith(original)).toBe(true);
	});

	it("loads a legacy header without cwd", () => {
		const header = legacyHeader();
		delete header.cwd;
		const legacy = customEntry("legacy-entry", null, 1);
		writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(legacy)}\n`);

		expect(() => SessionManager.open(file, tempDir)).not.toThrow();
		const session = SessionManager.open(file, tempDir);
		expect(session.getEntries()).toEqual([legacy]);
		expect(session.getCwd()).toBe(process.cwd());
	});

	it("writes a structurally clean fork with an honest corruption sentinel", () => {
		const header = legacyHeader();
		const legacy = customEntry("legacy-entry", null, 1);
		writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(legacy)}\nnot-json\n`);

		const source = SessionManager.open(file, tempDir);
		expect(source.hadCorruptEntries()).toBe(true);

		const forked = SessionManager.forkFrom(file, tempDir, tempDir, { id: "clean-fork" });
		expect(forked.getEntries()[0]).toEqual(legacy);
		expect(forked.getEntries()).toHaveLength(2);
		expect(forked.hadCorruptEntries()).toBe(false);
		expect(selectSharedVinciVerificationState(forked.getBranch())?.variant).toBe("terminal-unverifiable");

		const reopened = SessionManager.open(forked.getSessionFile()!, tempDir);
		expect(reopened.hadCorruptEntries()).toBe(false);
		expect(selectSharedVinciVerificationState(reopened.getBranch())?.variant).toBe("terminal-unverifiable");
	});

	it("keeps v1 migration IDs and references stable across reopens without rewriting", () => {
		const header = {
			type: "session",
			id: "v1-session",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: tempDir,
		};
		const first = {
			type: "custom",
			customType: "issue-38",
			data: "first",
			timestamp: "2025-01-01T00:00:01.000Z",
		};
		const assistant = assistantEntry("ignored-v1-id");
		delete assistant.id;
		delete assistant.parentId;
		const compaction = {
			type: "compaction",
			summary: "summary",
			firstKeptEntryIndex: 1,
			tokensBefore: 10,
			timestamp: "2025-01-01T00:00:02.000Z",
		};
		const original = `${JSON.stringify(header)}\n${JSON.stringify(first)}\n${JSON.stringify(assistant)}\n${JSON.stringify(compaction)}\n`;
		writeFileSync(file, original);

		const firstOpen = SessionManager.open(file, tempDir);
		const migratedIds = firstOpen.getEntries().map((entry) => entry.id);
		const firstId = migratedIds[0];
		const labelId = firstOpen.appendLabelChange(firstId, "stable-label");
		firstOpen.branch(firstId);
		const branchId = firstOpen.appendCustomEntry("issue-38", "branch");

		expect(readFileSync(file, "utf8").startsWith(original)).toBe(true);
		expect(new Set(migratedIds).size).toBe(3);
		expect(firstOpen.getEntries()[2]).toEqual(expect.objectContaining({ firstKeptEntryId: firstId }));

		const reopened = SessionManager.open(file, tempDir);

		expect(
			reopened
				.getEntries()
				.slice(0, 3)
				.map((entry) => entry.id),
		).toEqual(migratedIds);
		expect(reopened.getEntry(labelId)).toEqual(expect.objectContaining({ targetId: firstId }));
		expect(reopened.getLabel(firstId)).toBe("stable-label");
		expect(reopened.getBranch(labelId).map((entry) => entry.id)).toEqual([...migratedIds, labelId]);
		expect(reopened.getEntry(branchId)).toEqual(expect.objectContaining({ parentId: firstId }));
		expect(reopened.getBranch(branchId).map((entry) => entry.id)).toEqual([firstId, branchId]);
	});

	it("migrates v1 entries before writing a v3 fork", () => {
		const header = {
			type: "session",
			id: "v1-source",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: tempDir,
		};
		const entries = [
			{
				type: "custom",
				customType: "issue-38",
				data: "first",
				timestamp: "2025-01-01T00:00:01.000Z",
			},
			{
				type: "custom",
				customType: "issue-38",
				data: "second",
				timestamp: "2025-01-01T00:00:02.000Z",
			},
		];
		const original = `${JSON.stringify(header)}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		writeFileSync(file, original);

		const forked = SessionManager.forkFrom(file, tempDir, tempDir, { id: "v1-fork" });
		const forkFile = forked.getSessionFile()!;
		const reopened = SessionManager.open(forkFile, tempDir);

		expect(readFileSync(file, "utf8")).toBe(original);
		expect(forked.getEntries().map((entry) => (entry as CustomEntry).data)).toEqual(["first", "second"]);
		expect(forked.getParsingErrors()).toEqual([]);
		expect(reopened.getEntries()).toEqual(forked.getEntries());
		expect(reopened.getParsingErrors()).toEqual([]);
	});

	it("accepts valid unframed JSON ending in tab whitespace", () => {
		const header = legacyHeader();
		const legacy = customEntry("legacy-entry", null, 1);
		writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(legacy)}\t`);

		const result = loadSessionFile(file);
		const session = SessionManager.open(file, tempDir);

		expect(result.entries).toEqual([header, legacy]);
		expect(result.endsWithNewline).toBe(false);
		expect(result.parsingErrors).toEqual([]);
		expect(session.hadCorruptEntries()).toBe(false);
	});
});

describe("verification state selection from durable sessions", () => {
	const recordPrefix = '{"__vinci_record_start":true,';
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-verification-corruption-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function passedVerificationState() {
		return {
			schemaVersion: 1,
			variant: "normal",
			status: "passed",
			command: "npm test",
			summary: "18 tests passed",
			requiredCommand: "",
			requiredSummary: "",
			mutationRevision: 1,
			verifiedRevision: 1,
			recoveryAttempts: 0,
			behavioralEvidenceRequired: false,
			behavioralEvidenceReason: "",
			behavioralVerifiedRevision: 1,
			diffInspectedRevision: -1,
			checkClass: "behavioral",
			commandKey: "npm test",
			requiredCommandKey: "",
			commandKeyCanonical: true,
			isReplayable: true,
			behavioralAttemptCommand: "npm test",
			behavioralAttemptCommandKey: "npm test",
			behavioralAttemptCommandKeyCanonical: true,
			behavioralAttemptCompleted: true,
		} as const;
	}

	function assistantMessage() {
		return {
			role: "assistant" as const,
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 1,
		};
	}

	function writePassedSession(snapshotCount: number): string {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMessage());
		for (let index = 0; index < snapshotCount; index++) {
			session.appendCustomEntry(VINCI_VERIFICATION_ENTRY, passedVerificationState());
		}
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");
		return sessionFile;
	}

	function truncateFinalRecord(sessionFile: string, bytesFromRecordStart: number): void {
		const contents = readFileSync(sessionFile, "utf8");
		const finalRecordStart = contents.lastIndexOf("\n", contents.length - 2) + 1;
		truncateSync(sessionFile, finalRecordStart + bytesFromRecordStart);
	}

	function selectedState(sessionFile: string) {
		const resumed = SessionManager.open(sessionFile, tempDir);
		return selectSharedVinciVerificationState(resumed.getBranch());
	}

	function expectBlocked(sessionFile: string): void {
		const state = selectedState(sessionFile);
		expect(state?.variant).toBe("terminal-unverifiable");
		if (!state) throw new Error("expected verification state");
		expect(classifyVinciTaskState([], ["changed.ts"], state).state).toBe("BLOCKED");
	}

	it("terminalizes truncation before a complete frame marker instead of selecting an older pass", () => {
		const sessionFile = writePassedSession(2);
		truncateFinalRecord(sessionFile, recordPrefix.length - 1);

		expectBlocked(sessionFile);
	});

	it("terminalizes truncation after a complete frame marker instead of selecting an older pass", () => {
		const sessionFile = writePassedSession(2);
		truncateFinalRecord(sessionFile, recordPrefix.length + 8);

		expectBlocked(sessionFile);
	});

	it("terminalizes an all-corrupt verification history with no valid snapshot", () => {
		const sessionFile = writePassedSession(1);
		truncateFinalRecord(sessionFile, recordPrefix.length + 8);

		expectBlocked(sessionFile);
	});

	it("keeps a clean durable session on its newest passed snapshot", () => {
		const sessionFile = writePassedSession(1);

		const state = selectedState(sessionFile);

		expect(state?.variant).toBe("normal");
		expect(state?.status).toBe("passed");
		expect(classifyVinciTaskState([], ["changed.ts"], state!).state).toBe("DONE");
	});

	it("keeps a valid pass appended after older file corruption", () => {
		const sessionFile = writePassedSession(2);
		truncateFinalRecord(sessionFile, recordPrefix.length + 8);
		const resumed = SessionManager.open(sessionFile, tempDir);
		resumed.appendCustomEntry(VINCI_VERIFICATION_ENTRY, passedVerificationState());

		const state = selectSharedVinciVerificationState(resumed.getBranch());

		expect(state?.variant).toBe("normal");
		expect(state?.status).toBe("passed");

		const forked = SessionManager.forkFrom(sessionFile, tempDir, tempDir, { id: "post-corruption-pass" });
		expect(selectSharedVinciVerificationState(forked.getBranch())).toMatchObject({
			variant: "normal",
			status: "passed",
		});

		const leafId = resumed.getLeafId();
		if (!leafId) throw new Error("expected a post-corruption pass leaf");
		const branchedFile = resumed.createBranchedSession(leafId);
		if (!branchedFile) throw new Error("expected a persisted branched session");
		const branched = SessionManager.open(branchedFile, tempDir);
		expect(selectSharedVinciVerificationState(branched.getBranch())).toMatchObject({
			variant: "normal",
			status: "passed",
		});
	});

	it("keeps forked and branched corrupt histories terminal instead of laundering an older pass", () => {
		const sessionFile = writePassedSession(2);
		truncateFinalRecord(sessionFile, recordPrefix.length + 8);
		const sourceContents = readFileSync(sessionFile, "utf8");
		const source = SessionManager.open(sessionFile, tempDir);
		const sourceLeafId = source.getLeafId();
		if (!sourceLeafId) throw new Error("expected a source leaf");

		expect(selectSharedVinciVerificationState(source.getBranch())?.variant).toBe("terminal-unverifiable");

		const forked = SessionManager.forkFrom(sessionFile, tempDir, tempDir, { id: "corrupt-fork" });
		const forkedState = selectSharedVinciVerificationState(forked.getBranch());
		expect(forkedState?.variant).toBe("terminal-unverifiable");
		expect(forkedState?.status).not.toBe("passed");
		expect(classifyVinciTaskState([], ["changed.ts"], forkedState!).state).toBe("BLOCKED");

		const branchedFile = source.createBranchedSession(sourceLeafId);
		if (!branchedFile) throw new Error("expected a persisted branched session");
		const branched = SessionManager.open(branchedFile, tempDir);
		const branchedState = selectSharedVinciVerificationState(branched.getBranch());
		expect(branchedState?.variant).toBe("terminal-unverifiable");
		expect(branchedState?.status).not.toBe("passed");
		expect(classifyVinciTaskState([], ["changed.ts"], branchedState!).state).toBe("BLOCKED");
		expect(readFileSync(sessionFile, "utf8")).toBe(sourceContents);
	});
});
