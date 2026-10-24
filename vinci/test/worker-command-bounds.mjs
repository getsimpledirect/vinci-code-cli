// Bound real worker commands, including a helper that outlives its parent and holds its pipes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { command } from "../worker/exec.mjs";
import { remoteBranchSha } from "../worker/publisher.mjs";

const directory = mkdtempSync(join(tmpdir(), "worker-command-bounds-"));
const parent = join(directory, "parent.mjs");
const helper = join(directory, "helper.mjs");
let sequence = 0;

writeFileSync(helper, `import { writeFileSync } from "node:fs";
const [mode, marker] = process.argv.slice(2);
writeFileSync(marker + ".helper", String(process.pid));
writeFileSync(marker + ".ready", "helper owns the inherited stdout/stderr pipes");
process.send("ready");
process.disconnect();
if (mode === "positive") {
  process.stdout.write(Buffer.from([0, 255, 10]));
  process.stderr.write("helper stderr\\n");
} else {
  if (mode === "output") process.stdout.write(Buffer.alloc(4096, 97));
  setInterval(() => {}, 1000);
  // A failed test must not leave this fixture running indefinitely, even if cleanup is interrupted.
  setTimeout(() => process.exit(72), 20000);
}
`);
writeFileSync(parent, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [helper, mode, marker] = process.argv.slice(2);
writeFileSync(marker + ".parent", String(process.pid));
const child = spawn(process.execPath, [helper, mode, marker], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
child.once("message", () => {
  if (mode === "orphan" || mode === "output") {
    writeFileSync(marker + ".exiting", "parent exited before the command timeout");
    process.exit(0);
  }
});
child.once("exit", (code) => process.exit(code ?? 1));
setTimeout(() => process.exit(73), 15000).unref();
`);

async function boundedProcess(mode, options) {
  const marker = join(directory, `case-${sequence++}`);
  const pending = command(process.execPath, [parent, helper, mode, marker], { allowFailure: true, ...options });
  const expired = Symbol("test cap");
  let timer;
  try {
    const result = await Promise.race([
      pending,
      new Promise((resolve) => { timer = setTimeout(() => resolve(expired), 4000); }),
    ]);
    assert.ok(existsSync(`${marker}.ready`), "the real grandchild must start and own the captured pipes");
    if (mode === "orphan") assert.ok(existsSync(`${marker}.exiting`), "the parent must exit while its helper retains the pipes");
    assert.notEqual(result, expired, "bounded command must settle without test cleanup closing the grandchild's pipes");
    return result;
  } finally {
    clearTimeout(timer);
    for (const suffix of ["parent", "helper"]) {
      if (!existsSync(`${marker}.${suffix}`)) continue;
      try { process.kill(Number(readFileSync(`${marker}.${suffix}`, "utf8")), "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    // Cleanup is bounded too; fixture children have their own final backstop above.
    let drainTimer;
    await Promise.race([
      pending.catch(() => {}),
      new Promise((resolve) => { drainTimer = setTimeout(resolve, 1000); }),
    ]);
    clearTimeout(drainTimer);
  }
}

try {
  await test("ordinary commands keep their existing output, exit and raw-byte behavior", async () => {
    const normal = await command(process.execPath, ["-e", 'process.stdout.write("ok\\n"); process.stderr.write("note\\n")']);
    assert.deepEqual(normal, { status: 0, signal: null, stdout: "ok", stderr: "note" });
    const raw = await boundedProcess("positive", { timeoutMs: 1000, maxOutputBytes: 64, rawStdout: true });
    assert.equal(raw.status, 0);
    assert.equal(raw.signal, null);
    assert.deepEqual(raw.stdout, Buffer.from([0, 255, 10]));
    assert.equal(raw.stderr, "helper stderr");
    await assert.rejects(command(process.execPath, ["-e", 'process.stderr.write("expected failure"); process.exit(7)']), /expected failure/);
  });

  await test("POSIX timeout closes inherited pipes after killing the owned process group", { skip: process.platform === "win32" }, async (t) => {
    for (const mode of ["live", "orphan"]) {
      await t.test(mode === "orphan" ? "parent already exited" : "parent still running", async () => {
        const result = await boundedProcess(mode, { timeoutMs: 1000, rawStdout: true });
        assert.equal(result.status, null);
        assert.deepEqual(result.stdout, Buffer.alloc(0));
        assert.equal(result.stderr, "command exceeded 1000 ms");
      });
    }
  });

  await test("POSIX output cap also closes a helper's inherited pipes", { skip: process.platform === "win32" }, async () => {
    const result = await boundedProcess("output", { timeoutMs: 2000, maxOutputBytes: 1024 });
    assert.equal(result.status, null);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "command output exceeded 1024 bytes");
  });

  await test("remote branch probes forward finite command bounds", async () => {
    const sha = "1".repeat(40);
    const result = await remoteBranchSha({
      repoDir: directory, branch: "worker/bounds", remote: "local-fixture",
      exec: async (name, args, options) => {
        assert.equal(name, "git");
        assert.deepEqual(args, ["-C", directory, "ls-remote", "local-fixture", "refs/heads/worker/bounds"]);
        assert.equal(options?.timeoutMs, 30000, "the actual readback seam must supply its timeout");
        assert.equal(options?.maxOutputBytes, 1024 * 1024, "a one-ref probe must not accumulate unbounded output");
        return { status: 0, stdout: `${sha}\trefs/heads/worker/bounds`, stderr: "" };
      },
    });
    assert.deepEqual(result, { sha, error: null });
  });

  await test("bounded remote branch probe preserves actual local Git readback and absent refs", async () => {
    const origin = join(directory, "origin");
    mkdirSync(origin);
    const git = (...args) => execFileSync("git", ["-C", origin, ...args], { encoding: "utf8", timeout: 5000 }).trim();
    git("init", "--quiet");
    git("-c", "user.name=Worker test", "-c", "user.email=worker@example.test", "commit", "--allow-empty", "--quiet", "-m", "local probe control");
    git("branch", "worker/bounds");
    const head = git("rev-parse", "HEAD");
    assert.deepEqual(await remoteBranchSha({ repoDir: directory, branch: "worker/bounds", remote: origin }), { sha: head, error: null });
    assert.deepEqual(await remoteBranchSha({ repoDir: directory, branch: "worker/absent", remote: origin }), { sha: null, error: null });
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
