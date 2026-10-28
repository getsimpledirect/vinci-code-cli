import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type * as directUndici from "undici";
import { describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const projectRequire = createRequire(new URL("../../../package.json", import.meta.url));
const gondolinRequire = createRequire(projectRequire.resolve("@earendil-works/gondolin"));
const forgePath = "packages/coding-agent/examples/extensions/gondolin/vendor/node-forge";
const sandboxPath = "packages/coding-agent/examples/extensions/sandbox/vendor/sandbox-runtime";

function checkVersion(path?: string, version?: string) {
	const fixture = mkdtempSync(join(tmpdir(), "undici-floor-"));
	try {
		mkdirSync(join(fixture, "scripts"));
		for (const file of [
			"scripts/check-pinned-deps.mjs",
			"scripts/check-forge-backport.mjs",
			"scripts/check-sandbox-runtime-source.mjs",
			"package.json",
		]) {
			cpSync(join(repository, file), join(fixture, file));
		}
		mkdirSync(dirname(join(fixture, forgePath)), { recursive: true });
		cpSync(join(repository, forgePath), join(fixture, forgePath), { recursive: true });
		mkdirSync(dirname(join(fixture, sandboxPath)), { recursive: true });
		cpSync(join(repository, sandboxPath), join(fixture, sandboxPath), { recursive: true });
		const lock = JSON.parse(readFileSync(join(repository, "package-lock.json"), "utf8")) as {
			packages: Record<string, { version?: string }>;
		};
		if (path && version) lock.packages[path] = { ...lock.packages[path], version };
		writeFileSync(join(fixture, "package-lock.json"), JSON.stringify(lock));
		return spawnSync(process.execPath, [join(fixture, "scripts/check-pinned-deps.mjs")], {
			cwd: fixture,
			encoding: "utf8",
			timeout: 5_000,
			env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
		});
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
}

describe("reviewed Undici version floors", () => {
	it("accepts the actual patched graph with both sealed source packages", () => {
		const result = checkVersion();
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
	});
	for (const [path, version] of [
		["node_modules/undici", "8.10.2"],
		["node_modules/@earendil-works/gondolin/node_modules/undici", "6.28.1"],
		["node_modules/other/node_modules/undici", "7.29.1"],
		["node_modules/zod", "4.6.5"],
		["node_modules/source-map-js", "1.2.1"],
		["node_modules/vite", "8.1.5"],
		["packages/agent/node_modules/vitest", "4.1.11"],
		["packages/ai/node_modules/@vitest/mocker", "4.1.11"],
		["packages/agent/node_modules/@vitest/coverage-v8", "4.1.11"],
	]) {
		it(`refuses affected ${version} at ${path}`, () => {
			const result = checkVersion(path, version);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`affected version "${version}"`);
		});
	}
	it("refuses the affected Zod 3 major", () => {
		const result = checkVersion("node_modules/other/node_modules/zod", "3.25.76");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('unreviewed version "3.25.76"');
	});
});

// Exercise both installed consumers; the parser fixtures are bounded and use no network.
for (const [name, loader] of [
	["direct", projectRequire],
	["Gondolin", gondolinRequire],
] as const) {
	const undici = loader("undici") as typeof directUndici;
	const packageRequire = createRequire(loader.resolve("undici"));
	const { EventSourceStream } = packageRequire("./lib/web/eventsource/eventsource-stream.js") as {
		EventSourceStream: new (options: { maxEventSize: number }) => Transform;
	};
	describe(`${name} installed Undici`, () => {
		for (const [label, input, limit] of [
			["unfinished line", `data: ${"x".repeat(256)}`, 32],
			["empty data-field count", "data:\n".repeat(1025), 131072],
		] as const) {
			it(`bounds retained EventSource state for ${label}`, async () => {
				const parser = new EventSourceStream({ maxEventSize: limit });
				parser.on("error", () => {});
				try {
					const error = await new Promise<Error | null | undefined>((resolve) => {
						parser.write(Buffer.from(input), resolve);
					});
					expect(error).toBeInstanceOf(Error);
				} finally {
					parser.destroy();
				}
			});
		}
		it("preserves an ordinary EventSource message", async () => {
			const parser = new EventSourceStream({ maxEventSize: 64 });
			const events: unknown[] = [];
			parser.on("data", (event: unknown) => events.push(event));
			try {
				await new Promise<void>((resolve, reject) => {
					parser.on("error", reject);
					parser.end(Buffer.from("data: ordinary\n\n"), resolve);
				});
				expect(events).toHaveLength(1);
				expect(events[0]).toMatchObject({ type: "message", options: { data: "ordinary" } });
			} finally {
				parser.destroy();
			}
		});
		it("preserves compressed HTTP response decoding without external requests", async () => {
			const agent = new undici.MockAgent();
			agent.disableNetConnect();
			agent
				.get("https://local.invalid")
				.intercept({ path: "/fixture" })
				.reply(200, gzipSync("ordinary response"), {
					headers: { "content-encoding": "gzip" },
				});
			try {
				const response = await undici.fetch("https://local.invalid/fixture", { dispatcher: agent });
				expect(await response.text()).toBe("ordinary response");
			} finally {
				await agent.close();
			}
		});
	});
}
