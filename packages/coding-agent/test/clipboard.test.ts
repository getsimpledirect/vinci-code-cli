import { execSync, spawn } from "child_process";
import { platform } from "os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import vinciCopy from "../../../vinci/extensions/vinci-copy.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { copyToClipboard, copyToClipboardWithRoute } from "../src/utils/clipboard.ts";

const mocks = vi.hoisted(() => {
	return {
		clipboard: {
			setText: vi.fn<(text: string) => Promise<void>>(),
		},
		execSync: vi.fn(),
		spawn: vi.fn(),
		platform: vi.fn<() => NodeJS.Platform>(),
		isWaylandSession: vi.fn<() => boolean>(),
	};
});

vi.mock("../src/utils/clipboard-native.js", () => {
	return {
		clipboard: mocks.clipboard,
	};
});

vi.mock("child_process", () => {
	return {
		execSync: mocks.execSync,
		spawn: mocks.spawn,
	};
});

vi.mock("os", () => {
	return {
		platform: mocks.platform,
	};
});

vi.mock("../src/utils/clipboard-image.js", () => {
	return {
		isWaylandSession: mocks.isWaylandSession,
	};
});

// The extension receives the mocked source writer explicitly, never its package default.
vi.mock("@earendil-works/pi-coding-agent", () => ({ copyToClipboard: vi.fn() }));

const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);
const mockedPlatform = vi.mocked(platform);

let originalWrite: typeof process.stdout.write;
let stdoutWrites: string[];
let nativeResolved = false;

function osc52Writes(): string[] {
	return stdoutWrites.filter((write) => write.startsWith("\x1b]52;c;"));
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("SSH_CONNECTION", "");
	vi.stubEnv("SSH_CLIENT", "");
	vi.stubEnv("MOSH_CONNECTION", "");
	stdoutWrites = [];
	nativeResolved = false;
	mocks.clipboard.setText.mockReset();
	mocks.execSync.mockReset();
	mocks.spawn.mockReset();
	mocks.platform.mockReset();
	mocks.isWaylandSession.mockReset();
	mockedPlatform.mockReturnValue("darwin");
	mocks.isWaylandSession.mockReturnValue(false);
	mocks.clipboard.setText.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		nativeResolved = true;
	});
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
		const [chunk] = args;
		if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
			stdoutWrites.push(chunk);
			return true;
		}
		return originalWrite(...args);
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	vi.unstubAllEnvs();
});

describe("copyToClipboard", () => {
	test("local native success skips OSC 52 and shell fallbacks", async () => {
		await copyToClipboard("hello");

		expect(mocks.clipboard.setText).toHaveBeenCalledWith("hello");
		expect(osc52Writes()).toHaveLength(0);
		expect(mockedExecSync).not.toHaveBeenCalled();
		expect(mockedSpawn).not.toHaveBeenCalled();
	});

	test("remote native success emits OSC 52 after native write", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect(osc52Writes()).toHaveLength(0);
			nativeResolved = true;
		});

		await copyToClipboard("hello");

		expect(nativeResolved).toBe(true);
		expect(osc52Writes()).toHaveLength(1);
		expect(mockedExecSync).not.toHaveBeenCalled();
	});

	test("local shell fallback success skips OSC 52", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		expect(mockedExecSync).toHaveBeenCalledWith("pbcopy", {
			input: "hello",
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		expect(osc52Writes()).toHaveLength(0);
	});

	test("uses OSC 52 fallback when native and shell tools fail", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(1);
	});

	test("does not emit oversized OSC 52 payloads", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow("Failed to copy to clipboard");
		expect(osc52Writes()).toHaveLength(0);
	});
});

describe("copyToClipboardWithRoute", () => {
	test("confirmed local native write returns native without OSC 52", async () => {
		await expect(copyToClipboardWithRoute("hello")).resolves.toBe("native");
		expect(nativeResolved).toBe(true);
		expect(osc52Writes()).toHaveLength(0);
		expect(mockedExecSync).not.toHaveBeenCalled();
	});

	test("local shell success returns native without OSC 52", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await expect(copyToClipboardWithRoute("hello")).resolves.toBe("native");
		expect(mockedExecSync).toHaveBeenCalledWith("pbcopy", {
			input: "hello",
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		expect(osc52Writes()).toHaveLength(0);
	});

	test("local native and shell failures return terminal after OSC 52 fallback", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await expect(copyToClipboardWithRoute("hello")).resolves.toBe("terminal");
		expect(osc52Writes()).toEqual(["\x1b]52;c;aGVsbG8=\x07"]);
	});

	test("absent Linux native tools return terminal after OSC 52 fallback", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("TERMUX_VERSION", "");
		vi.stubEnv("WAYLAND_DISPLAY", "");
		vi.stubEnv("DISPLAY", "");

		await expect(copyToClipboardWithRoute("hello")).resolves.toBe("terminal");
		expect(mocks.clipboard.setText).not.toHaveBeenCalled();
		expect(mockedExecSync).not.toHaveBeenCalled();
		expect(mockedSpawn).not.toHaveBeenCalled();
		expect(osc52Writes()).toEqual(["\x1b]52;c;aGVsbG8=\x07"]);
	});

	for (const remoteVariable of ["SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION"]) {
		test(`${remoteVariable} native success returns terminal only after OSC 52`, async () => {
			vi.stubEnv(remoteVariable, "remote");
			await expect(copyToClipboardWithRoute("hello")).resolves.toBe("terminal");
			expect(nativeResolved).toBe(true);
			expect(osc52Writes()).toHaveLength(1);
		});

		test(`${remoteVariable} oversized native success resolves remote-only without OSC 52`, async () => {
			vi.stubEnv(remoteVariable, "remote");
			await expect(copyToClipboardWithRoute("x".repeat(75_001))).resolves.toBe("remote-only");
			expect(nativeResolved).toBe(true);
			expect(osc52Writes()).toHaveLength(0);
			expect(mockedExecSync).not.toHaveBeenCalled();
		});
	}

	for (const [name, text] of [
		["ASCII", "x".repeat(75_000)],
		["multibyte", "€".repeat(25_000)],
	]) {
		test(`${name} OSC 52 payload at exactly 100,000 encoded characters returns terminal`, async () => {
			mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
			mockedExecSync.mockImplementation(() => {
				throw new Error("pbcopy failed");
			});
			expect(Buffer.from(text).toString("base64")).toHaveLength(100_000);
			await expect(copyToClipboardWithRoute(text)).resolves.toBe("terminal");
			expect(osc52Writes()).toEqual([`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`]);
		});

		test(`${name} OSC 52 payload over 100,000 encoded characters emits no bytes and throws`, async () => {
			mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
			mockedExecSync.mockImplementation(() => {
				throw new Error("pbcopy failed");
			});
			const oversized = `${text}€`;
			expect(Buffer.from(oversized).toString("base64").length).toBeGreaterThan(100_000);
			let error: unknown;
			try {
				await copyToClipboardWithRoute(oversized);
			} catch (caught) {
				error = caught;
			}
			expect(osc52Writes()).toHaveLength(0);
			expect(error).toEqual(new Error("Failed to copy to clipboard"));
		});
	}

	test("oversized confirmed local native success still returns native without OSC 52", async () => {
		await expect(copyToClipboardWithRoute("x".repeat(75_001))).resolves.toBe("native");
		expect(osc52Writes()).toHaveLength(0);
	});

	test("public writer remains Promise<void> and resolves undefined for remote-only success", async () => {
		vi.stubEnv("SSH_CONNECTION", "remote");
		const writer: (text: string) => Promise<void> = copyToClipboard;
		await expect(writer("x".repeat(75_001))).resolves.toBeUndefined();
		expect(osc52Writes()).toHaveLength(0);
	});

	test("public writer preserves its failure when native and bounded fallback fail", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});
		await expect(copyToClipboard("x".repeat(75_001))).rejects.toThrow("Failed to copy to clipboard");
		expect(osc52Writes()).toHaveLength(0);
	});

	test("/copy keeps its existing success message for an oversized remote native write", async () => {
		vi.stubEnv("SSH_CONNECTION", "remote");
		const notifications: { message: string; type: string }[] = [];
		let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const api = {
			on: () => {},
			registerCommand: (_name: string, definition: { handler: typeof handler }) => {
				handler = definition.handler;
			},
		} as unknown as ExtensionAPI;
		const context = {
			hasUI: true,
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: { role: "assistant", content: [{ type: "text", text: "x".repeat(75_001) }] },
					},
				],
			},
			ui: {
				setWidget: () => {},
				select: async () => "Vinci's last message",
				notify: (message: string, type: string) => notifications.push({ message, type }),
			},
		} as unknown as ExtensionCommandContext;
		vinciCopy(api, copyToClipboard);
		expect(handler).toBeDefined();
		await handler?.("", context);
		expect(notifications).toEqual([{ message: "Copied vinci's last message.", type: "info" }]);
		expect(osc52Writes()).toHaveLength(0);
	});
});
