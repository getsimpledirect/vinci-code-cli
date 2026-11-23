import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sleep } from "../src/utils/sleep.ts";

describe("sleep", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("rejects an already-aborted signal without scheduling a timeout", async () => {
		const controller = new AbortController();
		controller.abort();

		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const waiting = sleep(100, controller.signal);
		const scheduledTimeouts = setTimeoutSpy.mock.calls.length;
		setTimeoutSpy.mockRestore();

		await expect(waiting).rejects.toThrow(/^Aborted$/);
		expect(vi.getTimerCount()).toBe(0);
		expect(scheduledTimeouts).toBe(0);
	});

	it("resolves at the requested duration", async () => {
		const onResolved = vi.fn();
		const waiting = sleep(100).then(onResolved);

		await vi.advanceTimersByTimeAsync(99);
		expect(onResolved).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(onResolved).toHaveBeenCalledWith(undefined);
		await waiting;
	});

	it("resolves at the requested duration with a live signal", async () => {
		const controller = new AbortController();
		const onResolved = vi.fn();
		const waiting = sleep(100, controller.signal).then(onResolved);

		await vi.advanceTimersByTimeAsync(99);
		expect(onResolved).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(onResolved).toHaveBeenCalledWith(undefined);
		await waiting;
	});

	it("clears the timeout and rejects when aborted during the wait", async () => {
		const controller = new AbortController();
		const waiting = sleep(100, controller.signal);

		vi.advanceTimersByTime(40);
		expect(vi.getTimerCount()).toBe(1);
		controller.abort();

		await expect(waiting).rejects.toThrow(/^Aborted$/);
		expect(vi.getTimerCount()).toBe(0);
	});
});
