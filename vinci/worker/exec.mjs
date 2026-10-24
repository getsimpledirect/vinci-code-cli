// The one structured command runner for the worker: {status, signal, stdout, stderr}, stdout AND
// stderr preserved. Throws on non-zero unless `allowFailure`; a missing binary resolves to
// status null with the error text in stderr when `allowFailure` is set.
import { spawn } from "node:child_process";

import { resolveBin } from "./build.mjs";

export function command(commandName, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    let executable;
    try {
      executable = resolveBin(commandName);
    } catch (error) {
      if (options.allowFailure) {
        resolveCommand({ status: null, signal: null, stdout: options.rawStdout ? Buffer.alloc(0) : "", stderr: error.message });
      } else {
        rejectCommand(error);
      }
      return;
    }
    const commandEnvironment = { ...process.env };
    for (const name of [
      "VINCI_WORKER_DEBRIS_ROOT_ANCHOR",
      "VINCI_WORKER_DEBRIS_ROOT_ANCHOR_SHA256",
      "VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER",
      "VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER_SHA256",
      "VINCI_WORKER_DEBRIS_AUTHORITY_CAPABILITY_FD",
      "VINCI_WORKER_DEBRIS_AUTHORITY_SERVICE_SHA256",
      "VINCI_WORKER_DEBRIS_AUTHORITY_PUBLIC_KEY_SPKI",
    ]) delete commandEnvironment[name];
    // A bounded Git command can leave SSH holding its pipes after Git exits. Own the POSIX
    // process group so the bound stops those helpers too; legacy unbounded calls keep their group.
    const ownsProcessGroup = process.platform !== "win32" && Boolean(options.timeoutMs || options.maxOutputBytes);
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: commandEnvironment,
      detached: ownsProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = options.rawStdout ? [] : "";
    let stderr = "";
    let outputBytes = 0;
    let captureError = null;
    const killCapturedCommand = () => {
      if (ownsProcessGroup && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); return; }
        catch (error) { if (error.code === "ESRCH") return; }
      }
      // Windows retains the existing direct-child termination behavior.
      child.kill("SIGKILL");
    };
    const timer = options.timeoutMs ? setTimeout(() => {
      captureError = `command exceeded ${options.timeoutMs} ms`;
      killCapturedCommand();
    }, options.timeoutMs) : null;
    const acceptsChunk = (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (options.maxOutputBytes && outputBytes > options.maxOutputBytes) {
        captureError = `command output exceeded ${options.maxOutputBytes} bytes`;
        killCapturedCommand();
      }
      return captureError === null;
    };
    if (!options.rawStdout) child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (!acceptsChunk(chunk)) return;
      if (options.rawStdout) stdout.push(Buffer.from(chunk));
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (!acceptsChunk(chunk)) return;
      stderr += chunk;
    });
    let settled = false;
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      settled = true;
      if (options.allowFailure) resolveCommand({ status: null, signal: null, stdout: options.rawStdout ? Buffer.alloc(0) : "", stderr: error.message });
      else rejectCommand(error);
    });
    child.once("close", (status, signal) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      const result = {
        status: captureError ? null : status,
        signal,
        stdout: captureError ? (options.rawStdout ? Buffer.alloc(0) : "") : options.rawStdout ? Buffer.concat(stdout) : stdout.trim(),
        stderr: captureError ?? stderr.trim(),
      };
      if ((!captureError && status === 0) || options.allowFailure) resolveCommand(result);
      else rejectCommand(new Error(`${commandName} ${args.join(" ")} failed: ${result.stderr || signal || status}`));
    });
  });
}
