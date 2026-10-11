import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyHttpProxySettings } from "../src/core/http-dispatcher.ts";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY"] as const;

describe("installed HTTP dispatcher WebSocket safety", () => {
	const dispatcherUrl = new URL("../src/core/http-dispatcher.ts", import.meta.url).href;
	const cwd = fileURLToPath(new URL("..", import.meta.url));

	for (const unsolicited of [false, true, true, true]) {
		it(`keeps the process alive for ${unsolicited ? "an unsolicited subprotocol" : "a valid handshake"}`, () => {
			const source = `
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { configureHttpDispatcher } from ${JSON.stringify(dispatcherUrl)};
configureHttpDispatcher();
const sockets = new Set();
const server = createServer();
server.on("connection", socket => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.on("upgrade", (request, socket) => {
  const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n" + (${unsolicited} ? "Sec-WebSocket-Protocol: unsolicited\\r\\n" : "") + "\\r\\n");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const socket = new WebSocket("ws://127.0.0.1:" + server.address().port);
const outcome = await new Promise(resolve => {
  socket.addEventListener("open", () => resolve("open"), { once: true });
  socket.addEventListener("error", () => resolve("error"), { once: true });
});
for (const connection of sockets) connection.destroy();
await new Promise(resolve => server.close(resolve));
if (outcome !== ${JSON.stringify(unsolicited ? "error" : "open")}) throw new Error("Unexpected WebSocket handshake outcome; inspect the installed dispatcher.");
console.log("WebSocket handshake completed with the expected outcome and the process stayed alive.");
`;
			const result = spawnSync(
				process.execPath,
				["--experimental-strip-types", "--input-type=module", "-e", source],
				{
					cwd,
					env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
					encoding: "utf8",
					timeout: 5_000,
				},
			);
			expect(result.error, result.stderr).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("the process stayed alive");
		});
	}
});

describe("http proxy settings", () => {
	let savedEnv: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of PROXY_ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("applies httpProxy to HTTP_PROXY and HTTPS_PROXY", () => {
		applyHttpProxySettings("http://127.0.0.1:7890");

		expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
	});

	it("does not override existing proxy env vars", () => {
		process.env.HTTP_PROXY = "http://env-http:8080";
		process.env.HTTPS_PROXY = "http://env-https:8080";

		applyHttpProxySettings("http://settings:7890");

		expect(process.env.HTTP_PROXY).toBe("http://env-http:8080");
		expect(process.env.HTTPS_PROXY).toBe("http://env-https:8080");
	});

	it("ignores empty values", () => {
		applyHttpProxySettings("   ");

		expect(process.env.HTTP_PROXY).toBeUndefined();
		expect(process.env.HTTPS_PROXY).toBeUndefined();
	});
});
