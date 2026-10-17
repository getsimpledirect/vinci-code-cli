import { appendFileSync } from "node:fs";
import { TuiAltScreen } from "@earendil-works/pi-tui";

// Observe the real renderer at startup without sending mouse input or reaching a clipboard route.
const start = TuiAltScreen.prototype.start;
TuiAltScreen.prototype.start = function (this: TuiAltScreen) {
	const events = process.env.VINCI_MODE_TEST_EVENTS;
	if (events) {
		appendFileSync(events, `identity:${process.env.VINCI_CODE ?? "unset"}\ncopyOnSelect:${this.getCopyOnSelect()}\n`);
	}
	return start.call(this);
};

// Only supply terminal capabilities for the pipe; CLI parsing, startup and InteractiveMode remain real.
Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
Object.defineProperty(process.stdout, "columns", { configurable: true, value: 80 });
Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
const watchdog = setTimeout(() => {
	process.stderr.write("CLI handoff fixture exceeded 15 seconds; inspect its captured output.\n");
	process.exit(70);
}, 15_000);
watchdog.unref();
