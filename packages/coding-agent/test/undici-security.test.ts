import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const undiciUrl = pathToFileURL(createRequire(import.meta.url).resolve("undici")).href;

// Fresh processes also catch unhandled stream errors that occur after fetch rejects.
// Dispatchers supply responses in memory; these checks never bind or connect a socket.
function probe(body: string): void {
	const source = `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import undici from ${JSON.stringify(undiciUrl)};
${body}
console.log("UNDICI-SECURITY-PROBE-OK");
`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			TMPDIR: process.env.TMPDIR ?? "",
		},
		encoding: "utf8",
		timeout: 5_000,
	});
	expect(result.error, result.stderr).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toContain("UNDICI-SECURITY-PROBE-OK");
}

describe("installed Undici security boundaries", () => {
	it("preserves compressed fetch and valid mixed-case integrity", () => {
		probe(`
const agent = new undici.MockAgent();
agent.disableNetConnect();
const body = "ordinary compressed response";
agent.get("https://fixture.invalid").intercept({ path: "/valid" })
  .reply(200, gzipSync(body), { headers: { "content-encoding": "gzip" } });
const digest = createHash("sha256").update(body).digest("base64");
try {
  const response = await undici.fetch("https://fixture.invalid/valid", {
    dispatcher: agent, integrity: "SHA256-" + digest,
  });
  assert.equal(await response.text(), body);
} finally { await agent.close(); }
`);
	});

	for (const algorithm of ["SHA256", "Sha256"]) {
		it(`rejects a tampered body with ${algorithm} integrity metadata`, () => {
			probe(`
const agent = new undici.MockAgent();
agent.disableNetConnect();
agent.get("https://fixture.invalid").intercept({ path: "/tampered" }).reply(200, "different bytes");
const digest = createHash("sha256").update("expected bytes").digest("base64");
try {
  await assert.rejects(undici.fetch("https://fixture.invalid/tampered", {
    dispatcher: agent, integrity: ${JSON.stringify(algorithm)} + "-" + digest,
  }), error => error.cause?.message === "integrity mismatch");
} finally { await agent.close(); }
`);
		});
	}

	it("rejects excessive content encodings and survives an early response error", () => {
		probe(`
let aborted = false;
const dispatcher = {
  dispatch(_options, handler) {
    const controller = {
      rawHeaders: [Buffer.from("content-encoding"), Buffer.from("gzip,gzip,gzip,gzip,gzip,gzip"),
        Buffer.from("content-length"), Buffer.from("1")],
      get aborted() { return aborted; },
      pause() {}, resume() {},
      abort(error) {
        if (aborted) return;
        aborted = true;
        queueMicrotask(() => handler.onResponseError(controller, error));
      },
    };
    queueMicrotask(() => {
      handler.onRequestStart(controller);
      handler.onResponseStart(controller, 200, {
        "content-encoding": "gzip,gzip,gzip,gzip,gzip,gzip",
        "content-length": "1",
      }, "OK");
      if (!aborted) queueMicrotask(() => handler.onResponseError(controller,
        Object.assign(new Error("response closed before its body"), { code: "UND_ERR_RES_CONTENT_LENGTH_MISMATCH" })));
    });
    return true;
  },
};
await assert.rejects(undici.fetch("https://fixture.invalid/closed", { dispatcher }),
  error => /too many content-encodings/.test(error.cause?.message ?? ""));
await new Promise(resolve => setImmediate(resolve));
assert.equal(aborted, true);
`);
	});

	it("bounds retained EventSource fields while preserving ordinary events", () => {
		probe(`
const require = createRequire(import.meta.url);
const { EventSourceStream } = require(fileURLToPath(new URL("./lib/web/eventsource/eventsource-stream.js", ${JSON.stringify(undiciUrl)})));
const ordinary = new EventSourceStream({ maxEventSize: 8192 });
const events = [];
ordinary.on("data", event => events.push(event));
const normalCompletion = finished(ordinary);
ordinary.end(Buffer.from("data: one\\ndata: two\\n\\n"));
await normalCompletion;
assert.equal(events.length, 1);
assert.equal(events[0].options.data, "one\\ntwo");
const excessive = new EventSourceStream({ maxEventSize: 8192 });
excessive.resume();
const completion = finished(excessive);
excessive.end(Buffer.from("data:\\n".repeat(1025)));
await assert.rejects(completion, /EventSource message size exceeded/);
`);
	});
});
