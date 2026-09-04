import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const launcher = join(root, "vinci/bin/vinci");
const providerExtension = join(root, "vinci/test/fixtures/checkpoint-faux-provider.ts");
const qwenLoaderProbe = join(root, "vinci/test/fixtures/qwen-loader-probe.ts");
const launcherSource = readFileSync(launcher, "utf8");
assert.match(launcherSource, /qwen-h200\)[\s\S]*VINCI_QWEN_SELECTED[\s\S]*vinci-qwen-provider\.ts/);
assert.doesNotMatch(readFileSync(join(root, "vinci/extensions/vinci-provider.ts"), "utf8"), /qwen-runtime|vinci-qwen-provider/);

function runInPty(args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("/usr/bin/script", ["-q", "/dev/null", "bash", launcher, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk) => {
      output += chunk;
      if (output.length > 1_000_000) output = output.slice(-1_000_000);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`PTY loader regression timed out:\n${output.slice(-4_000)}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, output });
    });
  });
}

const temp = mkdtempSync(join(tmpdir(), "vinci-qwen-loader-"));
try {
  const run = await runInPty(
    [
      "--extension",
      providerExtension,
      "--list-models",
      "faux",
    ],
    {
      cwd: temp,
      env: {
        ...process.env,
        HOME: join(temp, "home"),
        VINCI_CHECKPOINT_KILL_MARKER: "",
        VINCI_INTERNAL_PROVIDER_TEST: "1",
        VINCI_MODEL: "faux-1",
        VINCI_NO_BOOTSTRAP_HEAL: "1",
        VINCI_NO_RESUME: "1",
        VINCI_NO_VERIFY: "1",
        VINCI_PROVIDER: "faux",
        VINCI_TOOL_BOOTSTRAP: "0",
      },
    },
  );
  assert.equal(run.signal, null, run.output.slice(-4_000));
  assert.equal(run.code, 0, run.output.slice(-4_000));
  assert.doesNotMatch(run.output, /ERR_MODULE_NOT_FOUND|Package subpath .* is not defined by "exports"/);
  assert.match(run.output, /faux-1/);

  const qwenLoader = await runInPty(
    ["--extension", qwenLoaderProbe, "--list-models", "qwen-loader-probe"],
    {
      cwd: temp,
      env: {
        ...process.env,
        HOME: join(temp, "home-qwen-loader"),
        VINCI_INTERNAL_PROVIDER_TEST: "1",
        VINCI_MODEL: "faux-1",
        VINCI_NO_BOOTSTRAP_HEAL: "1",
        VINCI_NO_RESUME: "1",
        VINCI_NO_VERIFY: "1",
        VINCI_PROVIDER: "faux",
        VINCI_TOOL_BOOTSTRAP: "0",
      },
    },
  );
  assert.doesNotMatch(qwenLoader.output, /ERR_MODULE_NOT_FOUND|Package subpath .* is not defined by "exports"/);
  assert.match(qwenLoader.output, /qwen-loader-probe/);

} finally {
  rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("PASS worker-qwen-loader-startup real loader, checkpoint, and PTY startup\n");
