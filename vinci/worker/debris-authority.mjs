import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { canonicalize } from "./contracts/canonical.mjs";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_RESPONSE_BYTES = 1024 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalize(value)}\n`, "utf8");
}

function parseCanonicalResponse(bytes) {
  let value;
  try {
    value = JSON.parse(utf8Decoder.decode(bytes));
  } catch (error) {
    throw new Error(`debris authority adapter: invalid canonical response: ${error.message}`);
  }
  if (!canonicalBytes(value).equals(bytes)) throw new Error("debris authority adapter: response bytes are not canonical JSON");
  return value;
}

export function createDebrisAuthorityClient(stateDir) {
  const configured = process.env.VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER;
  const configuredSha256 = process.env.VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER_SHA256;
  const channelToken = process.env.VINCI_WORKER_DEBRIS_AUTHORITY_CHANNEL_TOKEN;
  if (!configured || !isAbsolute(configured)) {
    throw new Error("debris authority adapter: VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER must name an absolute deployment-owned executable");
  }
  if (!/^[0-9a-f]{64}$/.test(configuredSha256 ?? "")) {
    throw new Error("debris authority adapter: VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER_SHA256 must pin the exact executable bytes");
  }
  if (!/^[0-9a-f]{64}$/.test(channelToken ?? "")) {
    throw new Error("debris authority adapter: VINCI_WORKER_DEBRIS_AUTHORITY_CHANNEL_TOKEN must be an exact deployment-issued 32-byte token");
  }
  const executable = resolve(configured);
  const fromState = relative(resolve(stateDir), executable);
  if (fromState === "" || (!fromState.startsWith("..") && !isAbsolute(fromState))) {
    throw new Error("debris authority adapter: executable must be outside the replaceable worker state directory");
  }
  const initialStat = lstatSync(executable);
  if (!initialStat.isFile() || initialStat.isSymbolicLink() || initialStat.nlink !== 1 || (initialStat.mode & 0o022) !== 0 || (initialStat.mode & 0o111) === 0) {
    throw new Error("debris authority adapter: unsafe executable identity");
  }
  const initialBytes = readFileSync(executable);
  if (sha256(initialBytes) !== configuredSha256) {
    throw new Error("debris authority adapter: executable digest mismatch");
  }
  // A script adapter is always launched by the already-running worker's exact Node runtime.
  // Never let an /usr/bin/env shebang or caller-controlled PATH select a second interpreter
  // after the adapter bytes have been authenticated.
  const launchWithWorkerRuntime = initialBytes.length >= 2 && initialBytes[0] === 0x23 && initialBytes[1] === 0x21;
  const identity = {
    dev: String(initialStat.dev),
    ino: String(initialStat.ino),
    uid: initialStat.uid,
    gid: initialStat.gid,
    mode: initialStat.mode & 0o777,
    nlink: initialStat.nlink,
  };
  const verifyExecutable = () => {
    const stat = lstatSync(executable);
    const current = { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777, nlink: stat.nlink };
    if (!stat.isFile() || stat.isSymbolicLink() || canonicalize(current) !== canonicalize(identity)) {
      throw new Error("debris authority adapter: executable identity changed");
    }
    if (sha256(readFileSync(executable)) !== configuredSha256) throw new Error("debris authority adapter: executable digest mismatch");
  };

  return async function requestDebrisAuthority(request) {
    verifyExecutable();
    const input = canonicalBytes({ ...request, channel_token: channelToken });
    const responseBytes = await new Promise((resolveResponse, rejectResponse) => {
      const child = spawn(launchWithWorkerRuntime ? process.execPath : executable, launchWithWorkerRuntime ? [executable] : [], {
        env: { LANG: "C", LC_ALL: "C" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout = [];
      let stdoutLength = 0;
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("debris authority adapter: timed out"));
      }, 10_000);
      timer.unref();
      const finish = (error, bytes) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectResponse(error);
        else resolveResponse(bytes);
      };
      child.once("error", (error) => finish(new Error(`debris authority adapter: spawn failed: ${error.message}`)));
      child.stdout.on("data", (chunk) => {
        stdoutLength += chunk.length;
        if (stdoutLength > MAX_RESPONSE_BYTES) {
          child.kill("SIGKILL");
          finish(new Error("debris authority adapter: response exceeds the byte limit"));
          return;
        }
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 8192) stderr += chunk;
      });
      child.once("close", (status, signal) => {
        if (status !== 0) {
          finish(new Error(`debris authority adapter: exited ${status ?? signal}: ${stderr.trim()}`));
          return;
        }
        finish(null, Buffer.concat(stdout));
      });
      child.stdin.end(input);
    });
    verifyExecutable();
    return parseCanonicalResponse(responseBytes);
  };
}
