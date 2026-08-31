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
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: commandEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = options.rawStdout ? [] : "";
    let stderr = "";
    if (!options.rawStdout) child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (options.rawStdout) stdout.push(Buffer.from(chunk));
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let settled = false;
    child.once("error", (error) => {
      settled = true;
      if (options.allowFailure) resolveCommand({ status: null, signal: null, stdout: options.rawStdout ? Buffer.alloc(0) : "", stderr: error.message });
      else rejectCommand(error);
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      const result = {
        status,
        signal,
        stdout: options.rawStdout ? Buffer.concat(stdout) : stdout.trim(),
        stderr: stderr.trim(),
      };
      if (status === 0 || options.allowFailure) resolveCommand(result);
      else rejectCommand(new Error(`${commandName} ${args.join(" ")} failed: ${stderr.trim() || signal || status}`));
    });
  });
}
