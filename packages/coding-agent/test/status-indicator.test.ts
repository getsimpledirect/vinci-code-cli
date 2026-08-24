import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyText } from "../src/modes/interactive/components/keybinding-hints.ts";
import {
	CompactionStatusIndicator,
	IdleStatus,
	RetryStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps idle status at the same height as status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});

	it("describes Vinci retries as provider reconnection", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const previousVinciCode = process.env.VINCI_CODE;
		process.env.VINCI_CODE = "1";
		try {
			const tui = { requestRender: vi.fn() } as unknown as TUI;
			const indicator = new RetryStatusIndicator(tui, 2, 3, 2000);
			expect(indicator.render(120).join("\n")).toContain("Provider response paused");
			expect(indicator.render(120).join("\n")).toContain("reconnecting (2/3)");
			indicator.dispose();
		} finally {
			if (previousVinciCode === undefined) delete process.env.VINCI_CODE;
			else process.env.VINCI_CODE = previousVinciCode;
		}
	});

	it("updates compaction elapsed time and disposes its ticker", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const previousVinciCode = process.env.VINCI_CODE;
		process.env.VINCI_CODE = "1";
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		try {
			const indicator = new CompactionStatusIndicator(tui, "manual", 90_000);

			expect(indicator.render(120).join("\n")).toContain("0s · ↓ 90k tokens");
			vi.advanceTimersByTime(1100);
			expect(indicator.render(120).join("\n")).toContain("1s · ↓ 90k tokens");

			indicator.dispose();
			const callsBeforeAdvance = requestRender.mock.calls.length;
			vi.advanceTimersByTime(2000);
			expect(requestRender).toHaveBeenCalledTimes(callsBeforeAdvance);
		} finally {
			if (previousVinciCode === undefined) delete process.env.VINCI_CODE;
			else process.env.VINCI_CODE = previousVinciCode;
		}
	});

	it("keeps the upstream compaction label static and ignores token progress", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const previousVinciCode = process.env.VINCI_CODE;
		delete process.env.VINCI_CODE;
		try {
			const tui = { requestRender: vi.fn() } as unknown as TUI;
			const indicator = new CompactionStatusIndicator(tui, "manual", 90_000);
			const expectedLabel = `Compacting context... (${keyText("app.interrupt")} to cancel)`;

			expect(indicator.render(120).join("\n")).toContain(expectedLabel);
			expect(indicator.render(120).join("\n")).not.toContain("tokens");
			vi.advanceTimersByTime(2100);
			expect(indicator.render(120).join("\n")).toContain(expectedLabel);
			expect(indicator.render(120).join("\n")).not.toContain("2s");
			indicator.dispose();
		} finally {
			if (previousVinciCode === undefined) delete process.env.VINCI_CODE;
			else process.env.VINCI_CODE = previousVinciCode;
		}
	});
});
