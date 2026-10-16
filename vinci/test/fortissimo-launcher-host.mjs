// HOST-RUN ONLY: the source launcher's tsx IPC socket is refused in the task sandbox.
// This exercises the real launcher and RPC state without sending a prompt or making a model call.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = resolve(root, "vinci/bin/vinci");

async function launch(args, model) {
  const temporaryRoot = process.env.TMPDIR || tmpdir();
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, "fortissimo-launcher-"));
  const home = join(directory, "home");
  const agent = join(directory, "agent");
  mkdirSync(home);
  mkdirSync(agent);
  try {
    return await new Promise((resolveRun) => {
      const child = spawn("bash", [launcher, ...args, "--mode", "rpc", "--no-session"], {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          LANG: process.env.LANG ?? "C.UTF-8",
          HOME: home,
          TMPDIR: directory,
          VINCI_CODING_AGENT_DIR: agent,
          PI_CODING_AGENT_DIR: agent,
          VINCI_PROVIDER: "vinci",
          VINCI_API_KEY: "offline-test-key",
          VINCI_MODEL: model,
          VINCI_SOURCE_CLI: "1",
          VINCI_SHOW_OTHER_PROVIDERS: "1",
          VINCI_NO_BOOTSTRAP_HEAL: "1",
          VINCI_TOOL_BOOTSTRAP: "0",
          VINCI_UPDATE_DISABLED: "1",
          PI_OFFLINE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let state;
      let failure;
      let killTimer;
      const timer = setTimeout(() => {
        failure = "Launcher RPC did not exit within 45 seconds";
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      }, 45_000);
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
        for (const line of stdout.split("\n")) {
          try {
            const value = JSON.parse(line);
            if (value.id === "fortissimo-state" && value.type === "response") {
              state = value;
              child.stdin.end();
            }
          } catch {}
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.stdin.on("error", () => {});
      child.on("error", (error) => { failure = error.message; });
      child.on("close", (status, signal) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        resolveRun({ status, signal, state, stdout, stderr, failure });
      });
      child.stdin.write(`${JSON.stringify({ id: "fortissimo-state", type: "get_state" })}\n`);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const { name, args, model } of [
  { name: "VINCI_MODEL=fortissimo", args: [], model: "fortissimo" },
  { name: "--model fortissimo", args: ["--model", "fortissimo"], model: "auto" },
  { name: "--model vinci/fortissimo", args: ["--model", "vinci/fortissimo"], model: "auto" },
]) {
  test(`T5 HOST-RUN launcher resolves ${name} to Forte`, async () => {
    const result = await launch(args, model);
    assert.equal(result.failure, undefined, result.failure);
    assert.equal(result.status, 0, `Legacy launcher input must resolve without error: ${result.stderr}`);
    assert.equal(result.state?.success, true, `Launcher must answer get_state: ${result.stdout}`);
    assert.equal(result.state.data.model.provider, "vinci", "Legacy launcher input must retain the Vinci provider");
    assert.equal(result.state.data.model.id, "forte", "Legacy launcher input must resolve to Forte");
    assert.doesNotMatch(result.stderr, /will not substitute|unavailable|Unknown Vinci model/);
  });
}

test("T5 HOST-RUN launcher still rejects an unknown environment class with exit 2", async () => {
  const result = await launch([], "doesnotexist");
  assert.equal(result.failure, undefined, result.failure);
  assert.equal(result.status, 2, "Unknown managed launcher class must exit 2");
  assert.match(result.stderr, /Unknown Vinci model/);
});
