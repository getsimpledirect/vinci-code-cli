import { Agent } from "@earendil-works/pi-agent-core";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { exportFromFile, exportSessionToHtml } from "../../src/core/export-html/index.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { assistantMsg, createTestResourceLoader, userMsg } from "../utilities.ts";

const marker = "__vinci_record_start";

function expectNoMarker(value: unknown, context: string): void {
	if (value === null || typeof value !== "object") return;
	expect(Object.keys(value), context).not.toContain(marker);
	for (const [key, child] of Object.entries(value)) {
		expectNoMarker(child, `${context}.${key}`);
	}
}

function expectCleanHtml(path: string, entries: SessionEntry[]): void {
	const html = readFileSync(path, "utf8");
	expect(html, "T2: no marker in HTML output").not.toContain(marker);
	const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	expect(encoded, "T2: HTML contains its session payload").toBeDefined();
	const decoded = Buffer.from(encoded!, "base64").toString("utf8");
	expect(decoded, "T2: no marker in decoded HTML payload").not.toContain(marker);
	const payload = JSON.parse(decoded) as { entries: SessionEntry[] };
	expectNoMarker(payload, "T2: no marker key in HTML payload");
	expect(payload.entries).toEqual(entries);
}

// T3 is already covered by durability.test.ts:140 ("accepts complete legacy durable and unframed records")
// and :300 ("accepts legacy records without a framing prefix alongside framed records").
// Run those unchanged rather than duplicating their upstream-shaped input fixtures here.
describe.each([undefined, "1"])("ungated session-file framing with VINCI_CODE=%s", (vinciCode) => {
	let tempDir: string;
	let file: string;
	let written: SessionManager;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-framing-compat-"));
		vi.stubEnv("VINCI_CODE", vinciCode);
		vi.stubEnv(ENV_AGENT_DIR, join(tempDir, "agent"));
		file = join(tempDir, "session.jsonl");
		written = SessionManager.open(file, tempDir, tempDir);
		const userId = written.appendMessage(userMsg("Characterize session framing."));
		written.appendMessage(assistantMsg("A local fixture; no inference is needed."));
		written.appendCustomEntry("framing-compat", { nested: [{ complete: true }] });
		written.appendCompaction("Keep the fixture conversation.", userId, 2, { nested: { compacted: true } }, true);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("T1: bare JSON.parse sees an unframed header and exactly one extra boolean key per record", () => {
		const raw = readFileSync(file, "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		const records = raw
			.slice(0, -1)
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const entries = written.getEntries();
		expect(records).toHaveLength(entries.length + 1);
		expect(records[0], "T1: header has no framing marker").not.toHaveProperty(marker);
		expect(records[0]).toEqual(written.getHeader());
		for (const [index, entry] of entries.entries()) {
			const record = records[index + 1];
			expect(record[marker], "T1: record marker is boolean true").toBe(true);
			expect(Object.keys(record).sort(), "T1: exactly one extra key").toEqual(
				[...Object.keys(entry), marker].sort(),
			);
			expect(record).toEqual({ ...entry, [marker]: true });
		}
	});

	it("T2: reopening and offline HTML/JSONL exports expose only the original entries", async () => {
		const entries = written.getEntries();
		const reopened = SessionManager.open(file, tempDir);
		expectNoMarker(reopened.getEntries(), "T2: no marker key in loaded entries");
		expectNoMarker(reopened.getHeader(), "T2: no marker key in loaded header");
		expect(reopened.getEntries()).toEqual(entries);
		expect(reopened.getHeader()).toEqual(written.getHeader());
		expect(reopened.getParsingErrors()).toEqual([]);

		initTheme("dark", false);
		expectCleanHtml(
			await exportSessionToHtml(reopened, undefined, { outputPath: join(tempDir, "session.html") }),
			entries,
		);
		expectCleanHtml(await exportFromFile(file, { outputPath: join(tempDir, "file.html") }), entries);

		const session = new AgentSession({
			agent: new Agent({
				streamFn: () => {
					throw new Error("Session framing characterization must not call a provider.");
				},
			}),
			sessionManager: reopened,
			settingsManager: SettingsManager.inMemory({ theme: "dark" }),
			cwd: tempDir,
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: {},
		});
		try {
			expectCleanHtml(await session.exportToHtml(join(tempDir, "agent.html")), entries);
			const jsonl = readFileSync(session.exportToJsonl(join(tempDir, "export.jsonl")), "utf8");
			expect(jsonl, "T2: no marker in JSONL export").not.toContain(marker);
			const records = jsonl
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line));
			expectNoMarker(records, "T2: no marker key in JSONL export");
			expect(records[0]).toMatchObject({ type: "session", id: reopened.getSessionId() });
			expect(records.slice(1)).toEqual(entries);
		} finally {
			session.dispose();
		}
	});
});
