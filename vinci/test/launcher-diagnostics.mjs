const safeCodes = new Set(["ENOENT", "EACCES", "EPERM", "ABORT_ERR", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]);
const safeSignals = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGABRT", "SIGSEGV", "SIGQUIT"]);

// Output is untrusted even in --version tests. Classify it; never print a prefix, error.message,
// command, environment, path or raw line. Pattern-based secret masking misses unknown key shapes.
function outputSummary(value) {
	const text = typeof value === "string" ? value : "";
	return {
		bytes: Buffer.byteLength(text),
		kind: text.length === 0 ? "empty" : text.length < 64 && /^\d+\.\d+\.\d+\s*$/.test(text) ? "version" : "omitted",
	};
}

export function launcherStatus(error) {
	if (!error) return 0;
	return Number.isInteger(error.code) && error.code >= 0 && error.code <= 255
		? error.code
		: safeCodes.has(error.code) ? error.code : 1;
}

export function launcherDiagnostics(error, stdout, stderr, elapsedMs, timeoutMs) {
	const terminationRequested = error?.killed === true;
	const outputLimit = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
	return JSON.stringify({
		status: launcherStatus(error),
		signal: safeSignals.has(error?.signal) ? error.signal : null,
		terminationRequested,
		elapsedMs: Math.max(0, Math.round(elapsedMs)),
		timeoutMs,
		// execFile also kills on maxBuffer overflow. Even at the deadline, report consistency,
		// not an unobserved timer callback as a proven cause.
		timeoutOutcome: outputLimit ? "output-limit" : terminationRequested
			? elapsedMs >= timeoutMs ? "deadline-consistent" : "termination-before-deadline"
			: "not-observed",
		stdout: outputSummary(stdout),
		stderr: outputSummary(stderr),
	});
}

export function launcherEnvironment(path, home) {
	return {
		PATH: path,
		HOME: home,
		TMPDIR: home,
		XDG_CONFIG_HOME: `${home}/config`,
		XDG_CACHE_HOME: `${home}/cache`,
		VINCI_HOME: `${home}/vinci-home`,
		VINCI_CODING_AGENT_DIR: `${home}/agent`,
		PI_CODING_AGENT_DIR: `${home}/agent`,
		VINCI_SOURCE_CLI: "1",
		VINCI_NO_BOOTSTRAP_HEAL: "1",
		VINCI_TOOL_BOOTSTRAP: "0",
		VINCI_UPDATE_DISABLED: "1",
		PI_OFFLINE: "1",
	};
}
