import { appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarnessWithExtensions } from "./test-harness.ts";

// Record the home this child resolves, so the parent can prove it never used the caller's real HOME.
if (process.env.VINCI_FULLSCREEN_CHILD_LOG) {
	appendFileSync(
		process.env.VINCI_FULLSCREEN_CHILD_LOG,
		`${new Date().toISOString()} HOME pid=${process.pid} case=${process.env.VINCI_FULLSCREEN_CHILD_CASE} home=${homedir()} xdg=${["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map((key) => `${key}:${process.env[key] ?? "<unset>"}`).join(",")}\n`,
	);
}
const tuiMode = process.argv[2] === "fullscreen" ? "fullscreen" : "regular";
const startError = process.argv[3] === "start-error";
const transcriptMarker = "fullscreen-exit-transcript-marker";
const core = await createHarnessWithExtensions({
	settings: {
		theme: "dark",
		quietStartup: true,
		retry: { enabled: false },
		terminal: { showImages: false, showTerminalProgress: false },
	},
	extensionFactories: [
		(pi) => {
			pi.on("session_shutdown", async () => {
				process.stdout.write("SESSION_SHUTDOWN\n");
			});
		},
	],
});
process.env[ENV_AGENT_DIR] = core.tempDir;
process.env.GIT_CEILING_DIRECTORIES = core.tempDir;
const editorPath = join(core.tempDir, "editor.mjs");
writeFileSync(
	editorPath,
	[
		'import { appendFileSync } from "node:fs";',
		"const log = process.env.VINCI_FULLSCREEN_CHILD_LOG;",
		'const label = process.env.VINCI_FULLSCREEN_CHILD_CASE + ": external editor";',
		'if (log) appendFileSync(log, new Date().toISOString() + " START pid=" + process.pid + " case=" + label + "\\n");',
		'process.on("exit", (code) => { if (log) appendFileSync(log, new Date().toISOString() + " EXIT pid=" + process.pid + " case=" + label + " code=" + code + "\\n"); });',
		'process.stdout.write("EXTERNAL_EDITOR\\n");',
		'appendFileSync(process.argv[2], " edited");',
		"",
	].join("\n"),
);
const editorCommand = `${process.execPath} ${editorPath}`;
process.env.EDITOR = editorCommand;
process.env.VISUAL = editorCommand;
core.settingsManager.applyOverrides({ externalEditor: editorCommand });

class ErrorTerminal extends ProcessTerminal {
	dead = false;

	override start(...args: Parameters<ProcessTerminal["start"]>): void {
		super.start(...args);
		if (startError) throw new Error("fixture terminal start failed after entry");
	}

	override write(data: string): void {
		if (this.dead) {
			process.stderr.write("WRITE_AFTER_DEAD_TERMINAL\n");
			throw Object.assign(new Error("fixture terminal is dead"), { code: "EIO" });
		}
		super.write(data);
	}
}

const terminal = new ErrorTerminal();
const runtime = new AgentSessionRuntime(
	core.session,
	{
		cwd: core.tempDir,
		agentDir: core.tempDir,
		authStorage: core.authStorage,
		settingsManager: core.settingsManager,
		modelRegistry: core.modelRegistry,
		resourceLoader: core.resourceLoader,
		diagnostics: [],
	},
	async () => {
		throw new Error("Session replacement is not used by the fullscreen exit fixture");
	},
);
// Deliberately leave manageProcessSignals at its production default, true.
const mode = new InteractiveMode(runtime, { terminal, tuiMode });
process.on("uncaughtExceptionMonitor", (_error, origin) => {
	process.stderr.write(`UNCAUGHT_EXCEPTION_MONITOR:${origin}\n`);
});
process.on("exit", (code) => {
	if (process.env.VINCI_FULLSCREEN_CHILD_LOG) {
		appendFileSync(
			process.env.VINCI_FULLSCREEN_CHILD_LOG,
			`${new Date().toISOString()} EXIT pid=${process.pid} case=${process.env.VINCI_FULLSCREEN_CHILD_CASE} code=${code}\n`,
		);
	}
	core.cleanup();
});
const watchdog = setTimeout(() => {
	process.stderr.write("Fixture exceeded 20 seconds; inspect its captured output.\n");
	process.exit(70);
}, 20_000);
watchdog.unref();

await mode.init();
// Initialization can save settings and replace transient harness overrides.
core.settingsManager.applyOverrides({ externalEditor: editorCommand });
mode.showWarning(transcriptMarker);
await new Promise((resolve) => setTimeout(resolve, 40));
process.send?.({ event: "ready", pid: process.pid, mode: tuiMode, node: process.version });

// Faults are injected at terminal/process boundaries; all lifecycle handlers remain real.
process.on("message", (message: unknown) => {
	if (typeof message !== "object" || message === null || !("command" in message)) return;
	const command = message.command;
	if (command === "throw") {
		setImmediate(() => {
			throw new Error("fixture async uncaught failure");
		});
	} else if (command === "reject") {
		setImmediate(() => {
			void Promise.reject(new Error("fixture unhandled rejection"));
		});
	} else if (command === "exit") {
		process.stderr.write("Fixture error requests process.exit(1).\n");
		process.exit(1);
	} else if (command === "stop-throws") {
		// Fail the ordinary stop before renderer reset, so only the exit fallback can recover.
		const ui = (mode as unknown as { ui: { stop: () => void } }).ui;
		ui.stop = () => {
			throw new Error("fixture ordinary UI stop failed before reset");
		};
		try {
			mode.stop();
		} catch (error) {
			process.stderr.write(`${String(error)}\n`);
			process.exit(1);
		}
	} else if (command === "duplicate") {
		mode.stop();
		mode.stop();
		process.exit(0);
	} else if (command === "editor") {
		// Invoke the production editor entry directly; stdin hotkey mapping is outside this lifecycle test.
		void (mode as unknown as { openExternalEditor: () => Promise<void> }).openExternalEditor();
	} else if (command === "probe") {
		process.send?.({ event: "alive" });
	} else if (command === "dead-EIO" || command === "dead-EPIPE" || command === "dead-ENOTCONN") {
		terminal.dead = true;
		process.stdout.emit("error", Object.assign(new Error("fixture dead terminal"), { code: command.slice(5) }));
	} else if (command === "cleanup") {
		try {
			mode.stop();
		} finally {
			process.exit(0);
		}
	}
});
