#!/usr/bin/env node
// Exercise the real launcher with piped stdout or a PTY and inherited terminal metadata.
// The loopback SSE provider is synthetic; no account, external provider or paid inference is used.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ptyOnly = process.argv.includes("--pty-only");
const targetRoot = resolve(ptyOnly ? sourceRoot : process.argv[2] ?? sourceRoot);
const launcher = process.argv[3] ? resolve(process.argv[3]) : join(targetRoot, "vinci/bin/vinci");
const installationHome = process.argv[4] ? resolve(process.argv[4]) : undefined;
assert.ok(existsSync(launcher), "Select a target containing the real Vinci launcher before retrying.");
const owned = mkdtempSync(join(tmpdir(), "vinci-non-tty-output-"));
const token = "NON-TTY-ANSWER-OK";
const decoration = /\x1b_G|\x1b\]1337;File=|vero-(?:pixel|rich|working|review|blocked|done)\.(?:png|svg)|Vero (?:READY|WORKING|BLOCKED|DONE-UNVERIFIED|Ready|Thinking|Done|Error|Not sure|Blocked|Needs your OK|Waiting for you)|Made, not generated\.|✹|𝐯𝟏𝐧𝐜𝟏/;
let requests = 0;
let cases = 0;
const runPty = promisify(execFile);
const server = createServer(async (request, response) => {
  if (!request.url?.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
  for await (const _chunk of request) {}
  requests++;
  if (request.url.startsWith("/motion/")) await delay(1_300);
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const base = { id: `output-fixture-${requests}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "forte" };
  for (const [delta, finish_reason] of [[{ role: "assistant" }, null], [{ content: token }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});

async function invocation(args, environment, cwd, rpc = false) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("bash", [launcher, ...args], { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const records = [];
    let timeout;
    let exported;
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { timeout = true; kill(); }, 45_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!rpc) return;
      pending += chunk;
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n");
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          records.push(event);
          if (event.type === "agent_end") {
            child.stdin.write(`${JSON.stringify({ id: "export", type: "export_html", outputPath: join(cwd, "conversation.html") })}\n`);
          }
          if (event.type === "response" && event.id === "export") {
            exported = event;
            child.stdin.end();
          }
        } catch (error) { clearTimeout(timer); kill(); reject(error); }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); kill(); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      kill();
      resolvePromise({ stdout, stderr, code, signal, timeout, records, exported });
    });
    if (rpc) {
      child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
      child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: `Reply exactly ${token}` })}\n`);
    } else child.stdin.end();
  });
}

try {
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  if (!ptyOnly) {
    assert.match("Vero READY", decoration);
    assert.match("Vero Needs your OK", decoration);
    for (const terminal of ["kitty", "iTerm.app"]) {
      for (const mode of ["automatic print", "print", "json", "rpc", "--resume"]) {
        const home = join(owned, `${terminal === "kitty" ? "kitty" : "iterm"}-${mode.replaceAll(" ", "-")}`);
        const project = join(home, "project");
        const profile = join(home, "profile");
        for (const dir of [project, profile, join(home, "tmp"), join(home, "sessions")]) mkdirSync(dir, { recursive: true });
        writeFileSync(join(profile, "auth.json"), JSON.stringify({ vinci: { type: "api_key", key: "non-tty-fixture" } }));
        writeFileSync(join(profile, "trust.json"), JSON.stringify({ [project]: true }));
        const environment = {
          PATH: process.env.PATH, HOME: home, TMPDIR: join(home, "tmp"),
          VINCI_CODING_AGENT_DIR: profile, PI_CODING_AGENT_DIR: profile,
          PI_OFFLINE: "1", VINCI_TOOL_BOOTSTRAP: "0", VINCI_UPDATE_DISABLED: "1",
          VINCI_NO_BOOTSTRAP_HEAL: "1", VINCI_NO_RESUME: "1", VINCI_NO_SANDBOX: "1", VINCI_NO_VERIFY: "1",
          VINCI_API_KEY: "non-tty-fixture", VINCI_BASE_URL: `${serverUrl}/v1`,
          FORCE_COLOR: "3", VINCI_VERO_IMAGES: "1", VINCI_HERO_HEADER: "1", TERM: "xterm-kitty", TERM_PROGRAM: terminal,
          KITTY_WINDOW_ID: "1", ITERM_SESSION_ID: "non-tty-fixture", COLORTERM: "truecolor",
          PI_TUI_WRITE_LOG: join(home, "terminal.log"), JITI_FS_CACHE: "false",
          GIT_CEILING_DIRECTORIES: owned, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        };
        if (installationHome) environment.VINCI_HOME = installationHome;
        const before = requests;
        const options = ["--session-dir", join(home, "sessions")];
        if (mode === "--resume") {
          const result = await invocation([...options, "--resume"], environment, project);
          assert.equal(result.code, 0, `${terminal} headless --resume did not exit successfully.`);
          assert.equal(result.stderr, "No session selected. Use --session <id> or --continue to resume without a picker.\n");
          assert.doesNotMatch(result.stdout, /\x1b/, `${terminal} headless --resume emitted an ESC byte on stdout.`);
          cases++;
          process.stdout.write(`non-tty output: ${terminal} headless --resume printed the picker guidance to stderr.\n`);
          continue;
        }
        if (mode === "print") options.push("-p");
        if (mode === "json" || mode === "rpc") options.push("--mode", mode);
        if (mode !== "rpc") options.push(`Reply exactly ${token}`);
        const result = await invocation(options, environment, project, mode === "rpc");
        assert.ok(!result.timeout, `${terminal} ${mode} exceeded 45 seconds. Inspect the process lifecycle before retrying.`);
        assert.equal(result.code, 0, `${terminal} ${mode} exited ${result.code}/${result.signal}: ${result.stderr}`);
        assert.ok(result.stdout.includes(token) && requests > before, `${terminal} ${mode} must complete an actual loopback-provider turn.`);
        assert.doesNotMatch(result.stdout + result.stderr, /\x1b/, `${terminal} ${mode} emitted an ESC byte.`);
        assert.doesNotMatch(result.stdout + result.stderr, decoration, `${terminal} ${mode} decorated piped output.`);
        assert.doesNotMatch(result.stdout + result.stderr, /Failed to load extension|ERR_MODULE_NOT_FOUND|Cannot find package/);
        if (mode === "json") {
          const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
          assert.ok(records.some((event) => event.type === "agent_end"), "JSON output must contain the completed turn.");
        }
        if (mode === "rpc") {
          assert.ok(result.records.some((event) => event.id === "state" && event.success), "RPC must acknowledge get_state.");
          assert.equal(result.exported?.success, true, "RPC must complete the real HTML export before shutdown.");
          const html = readFileSync(result.exported.data.path, "utf8");
          const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
          assert.ok(encoded, "Read the real exported session data before claiming transcript isolation.");
          const session = Buffer.from(encoded, "base64").toString("utf8");
          assert.ok(session.includes(token));
          assert.doesNotMatch(session, decoration);
        }
        const files = readdirSync(home, { recursive: true, withFileTypes: true });
        assert.ok(files.length < 200, "Inspect unexpected fixture growth before reading its logs.");
        const transcripts = files.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
        assert.ok(transcripts.length > 0, "The actual invocation must persist a session transcript.");
        for (const entry of transcripts) assert.doesNotMatch(readFileSync(join(entry.parentPath, entry.name), "utf8"), decoration);
        if (existsSync(environment.PI_TUI_WRITE_LOG)) assert.doesNotMatch(readFileSync(environment.PI_TUI_WRITE_LOG, "utf8"), decoration);
        cases++;
        process.stdout.write(`non-tty output: ${terminal} ${mode} completed a synthetic provider turn with clean output, transcript and export/log controls.\n`);
      }
    }
    process.stdout.write(`non-tty output: ${cases}/${cases} real-launcher cases passed against ${targetRoot}; ${requests} loopback requests, zero paid calls.\n`);
  }
  const ptyFixture = join(dirname(fileURLToPath(import.meta.url)), "pty-look-fixture.py");
  for (const [name, override, flags, presentation] of [
    ["dumb", { TERM: "dumb" }, [], "plain"],
    ["TERM=dumb --resume", { TERM: "dumb" }, ["--resume"], "plain"],
    ["TERM=dumb legacy migration", { TERM: "dumb" }, [], "plain-migration"],
    ["plain", { VINCI_PLAIN: "1" }, [], "plain"],
    ["screen reader", { VINCI_SCREEN_READER: "1" }, [], "plain"],
    ["empty NO_COLOR", { NO_COLOR: "" }, [], "rich"],
    ["nonempty NO_COLOR", { NO_COLOR: "1" }, [], "rich"],
    ["--no-color", {}, ["--no-color"], "rich"],
    ["NO_COLOR with motion allowed", {
      NO_COLOR: "1", VINCI_API_KEY: "non-tty-fixture", VINCI_BASE_URL: `${serverUrl}/motion/v1`,
    }, [], "rich-motion"],
  ]) {
    const home = mkdtempSync(join(owned, "pty-"));
    const profile = join(home, "profile");
    mkdirSync(profile);
    // A returning profile exercises the regular prompt without opening the welcome.
    writeFileSync(join(profile, ".vinci-welcome-v1"), "later");
    if (presentation === "plain-migration") mkdirSync(join(profile, "hooks"));
    if (presentation === "rich-motion") {
      writeFileSync(join(profile, "auth.json"), JSON.stringify({ vinci: { type: "api_key", key: override.VINCI_API_KEY } }));
    }
    const resume = flags.includes("--resume");
    const sessionDir = join(home, "sessions");
    if (resume) {
      const timestamp = new Date().toISOString();
      mkdirSync(sessionDir);
      writeFileSync(join(sessionDir, "resume.jsonl"), [
        { type: "session", version: 3, id: "fbc9ace4-6f1b-40c4-b0b5-d3be020a035b", timestamp, cwd: home },
        { type: "session_info", id: "01234567", parentId: null, timestamp, name: "Offline resume fixture" },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    }
    const sessionFlags = resume ? ["--session-dir", sessionDir] : ["--no-session"];
    const before = requests;
    const result = await runPty("python3", [ptyFixture, launcher, presentation, ...flags, ...sessionFlags], {
      cwd: home, timeout: 25_000, encoding: "utf8", env: {
        PATH: process.env.PATH, HOME: home, TMPDIR: home, VINCI_CODING_AGENT_DIR: profile,
        VINCI_SOURCE_CLI: targetRoot === sourceRoot && !existsSync(join(sourceRoot, "packages/coding-agent/dist/cli.js")) ? "1" : "0",
        VINCI_NO_BOOTSTRAP_HEAL: "1", VINCI_UPDATE_DISABLED: "1", VINCI_NO_RESUME: "1", JITI_FS_CACHE: "false",
        VINCI_NO_SANDBOX: "1", VINCI_NO_VERIFY: "1", PI_OFFLINE: "1",
        TERM: "xterm-256color", COLORTERM: "truecolor", FORCE_COLOR: "3", VINCI_VERO_IMAGES: "1",
        VINCI_HERO_HEADER: "1", VINCI_ASCII: "1",
        ...(installationHome ? { VINCI_HOME: installationHome } : {}), ...override,
      },
    }).catch((error) => {
      assert.fail(`${name} PTY interaction failed: ${(error.stderr || error.stdout || error.message).slice(-1400)}`);
    });
    const bytes = result.stdout + result.stderr;
    assert.match(bytes, /Vinci Code/);
    assert.match(bytes, /Ready/);
    assert.match(bytes, presentation === "rich-motion" ? /Signed in/ : /\/login/);
    if (resume) assert.match(bytes, /1\. Offline resume fixture/);
    if (presentation === "plain-migration") {
      assert.match(bytes, /Warning: Global hooks\/ directory found\. Hooks have been renamed to extensions\./);
      assert.match(bytes, /Move your extensions to the extensions\/ directory\./);
      assert.match(bytes, /Press any key to continue\.\.\.[\s\S]*Vinci Code[\s\S]*Ready/);
    }
    if (presentation.startsWith("plain")) assert.doesNotMatch(bytes, /\x1b/, `${name}: zero ESC bytes`);
    else {
      assert.match(bytes, /\x1b\[1m/);
      assert.match(bytes, /\x1b\[[?0-9;]*[HJK]/);
      const sgr = [...bytes.matchAll(/\x1b\[([\d;:]*)m/g)].flatMap((match) => match[1].split(/[;:]/).map(Number));
      assert.ok(!sgr.some((value) => (value >= 30 && value <= 49) || (value >= 90 && value <= 107)),
        `${name} sent colour SGR parameters.`);
    }
    if (presentation === "rich-motion") {
      const pulses = new Set([...stripVTControlCharacters(bytes).matchAll(/\+- ([.o*]) Thinking\b/g)].map((match) => match[1]));
      assert.ok(pulses.size >= 2, `${name} must repaint Thinking with at least two pulse marks.`);
      assert.ok(bytes.includes(token) && requests > before, `${name} must complete an actual loopback-provider turn.`);
    }
    console.log(`non-tty output: ${name} passed startup, interaction and exit over a PTY.`);
  }
} finally {
  if (server.listening) {
    server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
  const cleanup = spawnSync("find", [owned, "-mindepth", "1", "-delete"], { timeout: 15_000 });
  assert.equal(cleanup.status, 0, `Remove the owned test directory ${owned} before retrying.`);
  rmdirSync(owned);
}
