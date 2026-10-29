import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

// No real transport is reachable in this regression. Executable lookups use only owned inert
// scripts. Set the agent root BEFORE imports: tools-manager captures its bin directory at load.
const root = process.env.VINCI_OFFLINE_TEST_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = join(root, "packages/coding-agent", process.env.VINCI_OFFLINE_TEST_PACKAGED === "1" ? "dist" : "src");
const extension = process.env.VINCI_OFFLINE_TEST_PACKAGED === "1" ? "js" : "ts";
const scratch = mkdtempSync(join(tmpdir(), "vinci-offline-policy-"));
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let attempts = 0;
let cases = 0;
const offlineValues = ["1", "true", "TRUE", "TrUe", "yes", "YES", "YeS"];
const envSet = (key, value) => value === undefined ? delete process.env[key] : process.env[key] = value;
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const executable = (file) => { put(file, "#!/bin/sh\nexit 0\n"); chmodSync(file, 0o755); };
const agent = join(scratch, "agent");
const bin = join(agent, "bin");
const emptyPath = join(scratch, "path");
mkdirSync(emptyPath);
process.env.VINCI_CODING_AGENT_DIR = agent;
process.env.PI_CODING_AGENT_DIR = agent;
const loader = createJiti(import.meta.url, { moduleCache: true, tryNative: false });
const tools = await loader.import(join(runtime, `utils/tools-manager.${extension}`), { default: false });
try {
  globalThis.fetch = async () => { attempts++; throw new Error("INERT forbidden fetch sentinel"); };
  process.env.PATH = emptyPath;
  delete process.env.VINCI_QA_ALLOWANCE_FILE;
  for (const offline of offlineValues) for (const code of [undefined, "1"]) for (const bootstrap of [undefined, "0", "1", "true"]) {
    process.env.PI_OFFLINE = offline;
    envSet("VINCI_CODE", code);
    envSet("VINCI_TOOL_BOOTSTRAP", bootstrap);
    assert.equal(tools.shouldBootstrapTools(), false);
    // Matches interactive startup's concurrent fd/rg initialization.
    assert.deepEqual(await Promise.all([tools.ensureTool("fd", true), tools.ensureTool("rg", true)]), [undefined, undefined]);
    for (const tool of ["fd", "rg"]) await assert.rejects(tools.downloadTool(tool), /disabled by the offline or QA request policy/);
    cases++;
  }
  const messages = [];
  const originalLog = console.log;
  try {
    console.log = (message) => messages.push(message);
    await Promise.all([tools.ensureTool("fd"), tools.ensureTool("rg")]);
  } finally { console.log = originalLog; }
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => /skipping download/.test(message)));
  for (const allowance of ["", join(scratch, "missing-policy")]) for (const offline of [undefined, "0", ...offlineValues]) {
    process.env.VINCI_QA_ALLOWANCE_FILE = allowance;
    envSet("PI_OFFLINE", offline);
    process.env.VINCI_TOOL_BOOTSTRAP = "1";
    assert.deepEqual(await Promise.all([tools.ensureTool("fd", true), tools.ensureTool("rg", true)]), [undefined, undefined]);
    for (const tool of ["fd", "rg"]) await assert.rejects(tools.downloadTool(tool), /disabled by the offline or QA request policy/);
    cases++;
  }
  assert.equal(attempts, 0, "no fetch invocation, including failed requests");
  assert.equal(existsSync(bin), false, "refusal precedes staging, extraction, install and chmod");

  delete process.env.VINCI_QA_ALLOWANCE_FILE;
  process.env.PI_OFFLINE = "1";
  process.env.VINCI_TOOL_BOOTSTRAP = "1";
  // Lazy calls are shared by interactive, headless and RPC consumers. No actual tool executes.
  const { createFindToolDefinition } = await loader.import(join(runtime, `core/tools/find.${extension}`), { default: false });
  const { createGrepToolDefinition } = await loader.import(join(runtime, `core/tools/grep.${extension}`), { default: false });
  await assert.rejects(createFindToolDefinition(scratch).execute("synthetic-find", { pattern: "*" }), /fd is not available/);
  await assert.rejects(createGrepToolDefinition(scratch).execute("synthetic-grep", { pattern: "synthetic" }), /ripgrep.*not available/);
  assert.equal(attempts, 0);
  assert.equal(existsSync(bin), false);

  // Cached tools and PATH/fdfind stay usable; downloadTool still refuses even when cached.
  mkdirSync(bin, { recursive: true });
  for (const tool of ["fd", "rg"]) {
    executable(join(bin, tool));
    assert.equal(await tools.ensureTool(tool, true), join(bin, tool));
    await assert.rejects(tools.downloadTool(tool), /disabled/);
  }
  assert.deepEqual(readdirSync(bin).sort(), ["fd", "rg"]);
  rmSync(bin, { recursive: true });
  for (const tool of ["fd", "rg"]) executable(join(emptyPath, tool));
  assert.equal(await tools.ensureTool("fd", true), "fd");
  assert.equal(await tools.ensureTool("rg", true), "rg");
  rmSync(join(emptyPath, "fd"));
  executable(join(emptyPath, "fdfind"));
  assert.equal(await tools.ensureTool("fd", true), "fdfind");
  assert.equal(attempts, 0);
  assert.equal(existsSync(bin), false);

  // Fresh helper process inherits policy rather than an in-memory decision/cache. This exercises
  // the same inherited environment used by managed crew/RPC children, without starting a service.
  const helper = join(scratch, "helper.mjs");
  put(helper, `import assert from "node:assert/strict";\nimport { createJiti } from ${JSON.stringify(import.meta.resolve("jiti/static"))};\nlet calls=0; globalThis.fetch=async()=>{calls++; throw Error("INERT");};\nconst loader=createJiti(import.meta.url,{moduleCache:false,tryNative:false});\nconst tools=await loader.import(${JSON.stringify(join(runtime, `utils/tools-manager.${extension}`))},{default:false});\nfor(const tool of ["fd","rg"]){assert.equal(await tools.ensureTool(tool,true),undefined); await assert.rejects(tools.downloadTool(tool),/disabled/);}\nassert.equal(calls,0); console.log("helper zero attempts");\n`);
  const safeEnv = {
    HOME: scratch, TMPDIR: scratch, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    JITI_FS_CACHE: "false", VINCI_NO_BOOTSTRAP_HEAL: "1", VINCI_CODE: "1", VINCI_TOOL_BOOTSTRAP: "1",
  };
  const childEnv = { ...safeEnv, PI_OFFLINE: "TrUe", PATH: join(scratch, "no-child-tools"), VINCI_CODING_AGENT_DIR: join(scratch, "child-agent"), PI_CODING_AGENT_DIR: join(scratch, "child-agent") };
  assert.match(execFileSync(process.execPath, [helper], { env: childEnv, encoding: "utf8" }), /helper zero attempts/);

  // Process-level direct payload representation: use the actual launcher, but a wholly inert
  // core at its ordinary local dispatch path. No profile, actual CLI state or provider is loaded.
  const direct = join(scratch, "direct");
  const directLauncher = join(direct, "vinci/bin/vinci");
  mkdirSync(dirname(directLauncher), { recursive: true });
  copyFileSync(join(root, "vinci/bin/vinci"), directLauncher);
  put(join(direct, "vinci/identity.json"), '{"version":"0.0.57"}');
  put(join(direct, "packages/coding-agent/dist/cli.js"), `console.log(JSON.stringify({offline:process.env.PI_OFFLINE,bootstrap:process.env.VINCI_TOOL_BOOTSTRAP,args:process.argv.slice(2)}));`);
  for (const offline of [undefined, ...offlineValues]) {
    const env = { ...safeEnv };
    if (offline !== undefined) env.PI_OFFLINE = offline;
    const args = offline === undefined ? ["--offline"] : [];
    const output = execFileSync("/bin/bash", [directLauncher, ...args], { cwd: scratch, env, encoding: "utf8" });
    const payload = JSON.parse(output.trim());
    assert.equal(payload.offline, "1");
    assert.equal(payload.bootstrap, "1", "conflicting opt-in is passed but cannot override offline policy");
    cases++;
  }

  // Installed shim representation. Its fake updater writes a sentinel if invoked. Every offline
  // launch must skip it altogether (including the updater timer), before inert payload dispatch.
  const installed = join(scratch, "installed");
  const marker = join(installed, "updater-called");
  put(join(installed, "updater/update.mjs"), `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(marker)},"called");`);
  put(join(installed, "current/vinci/bin/vinci"), '#!/bin/bash\nprintf "offline=%s\\n" "${PI_OFFLINE:-unset}"\n');
  const shim = join(installed, "vinci-shim");
  copyFileSync(join(root, "vinci/updater/vinci"), shim);
  for (const offline of [undefined, ...offlineValues]) {
    const env = { ...safeEnv, VINCI_HOME: installed };
    if (offline !== undefined) env.PI_OFFLINE = offline;
    const args = offline === undefined ? ["--offline"] : [];
    assert.match(execFileSync("/bin/sh", [shim, ...args], { cwd: scratch, env, encoding: "utf8" }), /offline=/);
    assert.equal(existsSync(marker), false);
    cases++;
  }
  execFileSync("/bin/sh", [shim], { env: { ...safeEnv, VINCI_HOME: installed, VINCI_QA_ALLOWANCE_FILE: "" } });
  assert.equal(existsSync(marker), false);

  // The payload's existing versioned self-heal must be able to deliver this updater repair.
  // Only an owned disposable installation is touched; no real user's bootstrap or profile.
  const healHome = join(scratch, "heal-home");
  const healPayload = join(healHome, "versions/0.0.57");
  put(join(healPayload, "vinci/bin/vinci"), readFileSync(join(root, "vinci/bin/vinci"), "utf8"));
  put(join(healPayload, "vinci/updater/update.mjs"), readFileSync(join(root, "vinci/updater/update.mjs"), "utf8"));
  put(join(healPayload, "vinci/identity.json"), '{"version":"0.0.57"}');
  const healedUpdater = join(healHome, "updater/update.mjs");
  put(healedUpdater, "// synthetic old bootstrap\n// payload-updater-version: 0.0.42\n");
  symlinkSync("versions/0.0.57", join(healHome, "current"));
  const healEnv = { ...safeEnv, VINCI_HOME: healHome, PI_OFFLINE: "1" };
  delete healEnv.VINCI_NO_BOOTSTRAP_HEAL;
  assert.equal(execFileSync("/bin/bash", [join(healPayload, "vinci/bin/vinci"), "--version"], { env: healEnv, encoding: "utf8" }).trim(), "0.0.57");
  assert.equal(readFileSync(healedUpdater, "utf8"), readFileSync(join(root, "vinci/updater/update.mjs"), "utf8"));
  cases++;

  // The real updater also checks its own network boundary. An inert preload records every fetch
  // before rejecting, so a failed mock request cannot masquerade as zero attempts.
  const fetchMarker = join(scratch, "fetch-called");
  const preload = join(scratch, "no-transport.mjs");
  put(preload, `import{appendFileSync}from"node:fs";globalThis.fetch=async()=>{appendFileSync(${JSON.stringify(fetchMarker)},"fetch\\n");throw Error("INERT forbidden fetch");};`);
  const updateHome = join(scratch, "update-home");
  put(join(updateHome, "versions/0.0.57/vinci/identity.json"), '{"version":"0.0.57"}');
  symlinkSync("versions/0.0.57", join(updateHome, "current"));
  for (const policy of [ ...offlineValues.map((value) => ({ PI_OFFLINE: value })), { VINCI_QA_ALLOWANCE_FILE: "" }, { VINCI_QA_ALLOWANCE_FILE: "/synthetic/missing" }, {} ]) {
    for (const command of ["before-launch", "check", "update"]) {
      const args = ["--import", preload, join(root, "vinci/updater/update.mjs"), command];
      if (Object.keys(policy).length === 0) args.push("--offline");
      let result;
      try { result = { status: 0, stdout: execFileSync(process.execPath, args, { env: { ...safeEnv, ...policy, VINCI_HOME: updateHome }, encoding: "utf8", stdio: "pipe" }) }; }
      catch (error) { result = { status: error.status, stderr: error.stderr.toString() }; }
      assert.equal(result.status, command === "before-launch" ? 0 : 1);
      if (command !== "before-launch") assert.match(result.stderr, /network access is disabled/);
      assert.equal(existsSync(fetchMarker), false);
      cases++;
    }
  }
  assert.equal(attempts, 0);
  console.log(`offline-download-policy: ${cases} policy/launch cases; fd/rg concurrent, direct, lazy, cached, PATH/fdfind, helper and updater zero-attempt controls passed`);
} finally {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(scratch, { recursive: true, force: true });
}
