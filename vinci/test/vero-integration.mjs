import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { getCapabilities, setCapabilities, setCellDimensions, TUI, Text } from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const testDir = mkdtempSync(join(root, "node_modules/.vero-integration-"));
const environmentKeys = [
  "TMPDIR", "GIT_CEILING_DIRECTORIES", "PI_OFFLINE", "VINCI_CODE", "VINCI_NO_VERIFY", "VINCI_NO_SANDBOX",
  "VINCI_ASCII_WORDMARK", "VINCI_HERO_HEADER", "NO_COLOR", "TERM", "VINCI_PLAIN", "VINCI_SCREEN_READER", "VINCI_REDUCED_MOTION",
];
const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
const originalCapabilities = { ...getCapabilities() };
let agentDirKey;
let originalAgentDir;
let checks = 0;

function check(name, condition) {
  assert.ok(condition, `${name}. Correct the Vero presentation before claiming this case passed.`);
  checks++;
}

function presentationEnvironment(overrides = {}) {
  for (const key of ["VINCI_ASCII_WORDMARK", "VINCI_HERO_HEADER", "NO_COLOR", "VINCI_PLAIN", "VINCI_SCREEN_READER", "VINCI_REDUCED_MOTION"]) {
    delete process.env[key];
  }
  process.env.TERM = "xterm-256color";
  Object.assign(process.env, overrides);
}

function imagePayload(lines, protocol) {
  const text = lines.join("\n");
  if (protocol === "kitty") {
    const chunks = [...text.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
    if (!chunks.length) return undefined;
    return {
      bytes: Buffer.from(chunks.map((chunk) => chunk[2]).join(""), "base64"),
      parameters: Object.fromEntries(chunks[0][1].split(",").map((item) => item.split("="))),
    };
  }
  const match = text.match(/\x1b\]1337;File=([^:]*):([^\x07]*)\x07/);
  if (!match) return undefined;
  return { bytes: Buffer.from(match[2], "base64"), parameters: Object.fromEntries(match[1].split(";").map((item) => item.split("="))) };
}

function withoutImages(text) {
  return text.replace(/\x1b_G[^\x1b]*\x1b\\/g, "").replace(/\x1b\]1337;File=[^\x07]*\x07/g, "");
}

async function bounded(promise, description, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}. Inspect the TUI lifecycle before retrying.`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  process.env.TMPDIR = testDir;
  process.env.GIT_CEILING_DIRECTORIES = testDir;
  process.env.PI_OFFLINE = "1";
  process.env.VINCI_CODE = "1";
  process.env.VINCI_NO_VERIFY = "1";
  process.env.VINCI_NO_SANDBOX = "1";
  presentationEnvironment();
  const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const header = await loader.import(resolve(here, "../extensions/vinci-header.ts"), { default: false });
  const shell = await loader.import(resolve(here, "../extensions/vinci-shell.ts"), { default: false });
  const state = await loader.import(resolve(here, "../extensions/lib/ui-state.ts"), { default: false });
  const vero = await loader.import(resolve(here, "../extensions/lib/vero-state.ts"), { default: false });
  const control = await loader.import(resolve(here, "../extensions/lib/control.ts"), { default: false });
  const outcomes = await loader.import(resolve(here, "../extensions/lib/task-outcome.ts"), { default: false });
  const themeModule = await loader.import(resolve(root, "packages/coding-agent/src/modes/interactive/theme/theme.ts"), { default: false });
  const { KeybindingsManager } = await loader.import(resolve(root, "packages/coding-agent/src/core/keybindings.ts"), { default: false });
  const { VirtualTerminal } = await loader.import(resolve(root, "packages/tui/test/virtual-terminal.ts"), { default: false });
  const { ENV_AGENT_DIR } = await loader.import(resolve(root, "packages/coding-agent/src/config.ts"), { default: false });
  agentDirKey = ENV_AGENT_DIR;
  originalAgentDir = process.env[agentDirKey];
  const profile = join(testDir, "profile");
  mkdirSync(profile);
  process.env[agentDirKey] = profile;
  writeFileSync(join(profile, ".vinci-thinking-hint-v1"), "");
  writeFileSync(join(profile, "auth.json"), "{}");

  const assetDir = resolve(here, "../assets/vero");
  const manifest = JSON.parse(readFileSync(join(assetDir, "manifest.json"), "utf8"));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  check("Vero provenance pins the approved marketing commit and source archive", manifest.sourceCommit === "ee968ae96f32856ae25925779d2b44ffc5f2f7f8" &&
    manifest.sourceArchiveSha256 === "e44d2e52292ea878dafc43fc0b4460e994b33c4c7e0baba882e1a65f9158e0ab");
  check("Vero manifest contains the six approved state assets", JSON.stringify(manifest.assets.map((asset) => asset.key).sort()) ===
    JSON.stringify(["blocked", "done", "pixel", "review", "rich", "working"]));
  const assets = new Map();
  for (const asset of manifest.assets) {
    const png = readFileSync(join(assetDir, asset.file));
    const svg = readFileSync(join(assetDir, asset.svgFile));
    check(`${asset.key} PNG bytes, hash and dimensions agree with the manifest`, png.length === asset.bytes && sha256(png) === asset.sha256 &&
      png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === asset.width && png.readUInt32BE(20) === asset.height);
    check(`${asset.key} SVG bytes agree with the recorded source hash`, sha256(svg) === asset.svgSha256);
    assets.set(asset.key, png);
  }
  check("the pixel SVG matches the handoff's independently pinned approved hash", manifest.assets.find((asset) => asset.key === "pixel").svgSha256 ===
    "9ed5c8172d83ba0ae19e77e8bb331122f808eef6d80b6306ef728bc25af80278");

  function resetPresentation() {
    state.resetVinciUiState();
    control.clearVinciAutomationStop();
    outcomes.setVinciTaskOutcome(undefined);
  }

  function outcome(stateName) {
    outcomes.setVinciTaskOutcome({
      schemaVersion: 1, state: stateName, taskId: "vero-render-fixture", reason: "Fixture outcome for presentation testing.",
      changedFiles: [], verificationStatus: "none", verificationCommand: "", usage: outcomes.summarizeVinciTaskUsage([]),
      recordedAt: new Date().toISOString(),
    });
  }

  async function registeredUi(protocol, width = 80, themeName = "dark", mode = "tui", headerModule = header) {
    resetPresentation();
    setCapabilities({ images: protocol, trueColor: true, hyperlinks: false });
    setCellDimensions({ widthPx: 9, heightPx: 18 });
    themeModule.initTheme(themeName, false);
    const terminal = new VirtualTerminal(width, 24);
    const tui = new TUI(terminal);
    const handlers = new Map();
    let registeredHeader;
    let editor;
    const writes = [];
    const ui = {
      theme: themeModule.theme,
      notify() {}, setWorkingVisible() {}, setFooter() {}, setTitle() {},
      setHeader(factory) { registeredHeader = factory(tui, themeModule.theme); },
      setEditorComponent(factory) { editor = factory(tui, themeModule.getEditorTheme(), new KeybindingsManager()); },
    };
    const context = { mode, cwd: profile, model: { name: "Vinci" }, ui, getContextUsage: () => ({ percent: null, tokens: null }) };
    const pi = {
      on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
      registerCommand() {},
      async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
      appendEntry(...args) { writes.push(args); }, sendMessage(...args) { writes.push(args); },
    };
    shell.default(pi);
    headerModule.default(pi);
    const emit = async (name, event = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, context);
    };
    await emit("session_start");
    if (registeredHeader) tui.addChild(registeredHeader);
    tui.addChild(new Text("TRANSCRIPT SENTINEL", 0, 0));
    if (editor) {
      editor.setText("UNSENT COMPOSER SENTINEL");
      tui.addChild(editor);
      tui.setFocus(editor);
    }
    tui.start();
    await bounded(terminal.waitForRender(), "registered TUI startup");
    return {
      header: registeredHeader, editor, terminal, tui, writes, emit,
      async frame() { tui.requestRender(); await bounded(terminal.waitForRender(), "registered TUI repaint"); return terminal.getViewport(); },
      async close() { await emit("session_shutdown"); tui.stop(); await bounded(terminal.flush(), "registered TUI shutdown"); },
    };
  }

  const transitions = [
    ["READY", "pixel", () => {}],
    ["WORKING", "working", (ui) => ui.emit("agent_start")],
    ["REVIEW", "review", (ui) => ui.emit("tool_call", { toolCallId: "check", toolName: "rerun_check", input: {} })],
    ["BLOCKED", "blocked", () => control.requestVinciAutomationStop("A real fixture stop")],
    ["WAITING", "review", () => { control.clearVinciAutomationStop(); state.setVinciWorking(false); outcome("WAITING"); }],
    ["DONE-UNVERIFIED", "review", () => outcome("DONE_UNVERIFIED")],
    ["DONE", "done", () => outcome("DONE")],
  ];

  for (const protocol of ["kitty", "iterm2", null]) {
    presentationEnvironment({ VINCI_REDUCED_MOTION: "1" });
    for (const themeName of ["dark", "light"]) {
      const ui = await registeredUi(protocol, 80, themeName);
      try {
        for (const width of [40, 80, 120, 40]) {
          ui.terminal.resize(width, 24);
          resetPresentation();
          const baseline = await ui.frame();
          const composerRow = baseline.findIndex((line) => line.includes("UNSENT COMPOSER SENTINEL"));
          check(`${protocol ?? "text"} ${themeName} composer is visible at ${width} columns`, composerRow >= 0);
          for (const [label, pose, transition] of transitions) {
            await transition(ui);
            const presentation = vero.getVeroPresentation();
            const lines = ui.header.render(width);
            check(`${protocol ?? "text"} ${themeName} ${label} keeps a five-row header at ${width} columns`, lines.length === 5 &&
              presentation.pose === pose && presentation.label === label);
            check(`${protocol ?? "text"} ${label} keeps its explicit state in header text at ${width} columns`,
              stripVTControlCharacters(withoutImages(lines.join("\n"))).includes(`Vero ${label}`));
            check(`${label} explains the next action without claiming approval or verification`, presentation.nextAction.length > 0 &&
              !/\b(?:approved|verified|passed|safe|secure)\b/i.test(presentation.nextAction));
            const payload = protocol ? imagePayload(lines, protocol) : undefined;
            if (protocol) {
              check(`${protocol} ${pose} transmits the unmodified approved PNG at ${width} columns`, payload?.bytes.equals(assets.get(pose)));
              check(`${protocol} ${pose} stays within the reserved image cells at ${width} columns`, protocol === "kitty"
                ? Number(payload.parameters.c) <= 6 && Number(payload.parameters.r) <= 3 && payload.parameters.C === "1"
                : Number(payload.parameters.width) <= 6 && payload.parameters.height === "auto" && payload.parameters.preserveAspectRatio !== "0");
              check(`${protocol} text returns to column 11 after image rows at ${width} columns`, lines.slice(1, 4).every((line) => line.includes("\x1b[11G")));
            } else {
              check(`text ${label} fallback contains no image protocol at ${width} columns`, !/\x1b_G|\x1b\]1337;File=/.test(lines.join("\n")));
            }
            // Headless xterm does not implement iTerm OSC images' native cursor movement. The
            // Kitty C=1 path and text path are admissible for measured composer row placement.
            if (protocol !== "iterm2") {
              const frame = await ui.frame();
              check(`${protocol ?? "text"} ${label} leaves the draft on the same row at ${width} columns`, frame.findIndex((line) =>
                line.includes("UNSENT COMPOSER SENTINEL")) === composerRow && ui.editor.getText() === "UNSENT COMPOSER SENTINEL");
              check(`${protocol ?? "text"} header retains its brand after ${label} at ${width} columns`, frame.some((line) => /v1nc1|𝐯𝟏𝐧𝐜𝟏/.test(line)));
            }
          }
        }
        check(`${protocol ?? "text"} header and shell add no Vero transcript entries`, ui.writes.length === 0);
      } finally {
        await ui.close();
      }
    }
  }

  for (const protocol of ["kitty", "iterm2"]) {
    presentationEnvironment({ VINCI_HERO_HEADER: "1", VINCI_REDUCED_MOTION: "1" });
    const ui = await registeredUi(protocol);
    try {
      const idle = ui.header.render(80);
      const idlePayloads = idle.map((line) => imagePayload([line], protocol)).filter(Boolean);
      check(`${protocol} hero idle sends the approved rich PNG`, idlePayloads.some((payload) => payload.bytes.equals(assets.get("rich"))));
      const idleHeight = idle.length;
      await ui.emit("agent_start");
      const working = ui.header.render(80);
      const workingPayloads = working.map((line) => imagePayload([line], protocol)).filter(Boolean);
      check(`${protocol} hero working sends the approved working PNG without changing height`, working.length === idleHeight &&
        workingPayloads.some((payload) => payload.bytes.equals(assets.get("working"))));
      check(`${protocol} hero working keeps its next action readable`, stripVTControlCharacters(withoutImages(working.join("\n"))).includes("Vero WORKING:"));
    } finally {
      await ui.close();
    }
  }

  presentationEnvironment({ VINCI_REDUCED_MOTION: "1" });
  const nextActionUi = await registeredUi(null, 120);
  try {
    for (const stateName of ["WAITING", "DONE_UNVERIFIED", "BLOCKED", "DONE"]) {
      state.setVinciWorking(false);
      outcome(stateName);
      const presentation = vero.getVeroPresentation();
      const text = stripVTControlCharacters(nextActionUi.editor.render(120).join("\n"));
      check(`${presentation.label} composer retains the call to action and receipt-grounded next step`, text.includes("Ask Vinci") &&
        text.includes(presentation.label) && text.includes(presentation.nextAction));
    }
  } finally {
    await nextActionUi.close();
  }

  presentationEnvironment({ VINCI_REDUCED_MOTION: "1" });
  const failedActivityUi = await registeredUi("kitty");
  try {
    await failedActivityUi.emit("agent_start");
    await failedActivityUi.emit("message_end", {
      message: { role: "assistant", stopReason: "error", errorMessage: "Fixture provider returned 503." },
    });
    await failedActivityUi.emit("agent_end");
    check("a reported provider failure remains visibly blocked after activity ends", vero.getVeroPresentation().pose === "blocked" &&
      imagePayload(failedActivityUi.header.render(80), "kitty")?.bytes.equals(assets.get("blocked")));
    await failedActivityUi.emit("agent_start");
    check("starting a new activity clears the prior provider blocker and shows working", vero.getVeroPresentation().pose === "working" &&
      imagePayload(failedActivityUi.header.render(80), "kitty")?.bytes.equals(assets.get("working")));
  } finally {
    await failedActivityUi.close();
  }

  for (const [name, environment] of [
    ["NO_COLOR", { NO_COLOR: "" }], ["plain", { VINCI_PLAIN: "1" }],
    ["screen reader", { VINCI_SCREEN_READER: "1" }], ["dumb terminal", { TERM: "dumb" }],
  ]) {
    presentationEnvironment({ ...environment, VINCI_HERO_HEADER: "1" });
    // A fresh module matches a fresh process's environment-derived wordmark selection.
    const plainLoader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
    const plainHeader = await plainLoader.import(resolve(here, "../extensions/vinci-header.ts"), { default: false });
    const ui = await registeredUi("kitty", 80, "dark", "tui", plainHeader);
    try {
      state.setVinciWorking(false);
      outcome("DONE_UNVERIFIED");
      const plain = ui.header.render(80);
      check(`${name} keeps an explicit DONE-UNVERIFIED text fallback without artwork`, plain.length === 5 &&
        stripVTControlCharacters(plain.join("\n")).includes("Vero DONE-UNVERIFIED") && !/\x1b_G|\x1b\]1337;File=|[\u2800-\u28ff]/.test(plain.join("\n")));
      check(`${name} header has no SGR colors or decorative wordmark glyphs`, !/\x1b|[\u2800-\u28ff]|𝐯|✹/.test(plain.join("\n")) &&
        plain.join("\n").includes("v1nc1"));
    } finally {
      await ui.close();
    }
  }

  for (const staticMode of [false, true]) {
    presentationEnvironment(staticMode ? { VINCI_REDUCED_MOTION: "1" } : {});
    const ui = await registeredUi("kitty");
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const intervals = new Set();
    globalThis.setInterval = (callback, intervalMs) => {
      const interval = { callback, intervalMs };
      intervals.add(interval);
      return interval;
    };
    globalThis.clearInterval = (interval) => intervals.delete(interval);
    try {
      await ui.emit("agent_start");
      check(staticMode ? "reduced motion starts no animation interval" : "ordinary working presentation starts one pulse interval", intervals.size === (staticMode ? 0 : 1));
      const first = ui.header.render(80);
      const second = ui.header.render(80);
      check("Vero artwork remains static during working activity", first.join("\n") === second.join("\n"));
      await ui.emit("agent_end");
      check("agent end clears animation intervals", intervals.size === 0);
    } finally {
      await ui.close();
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  }

  for (const mode of ["print", "json", "rpc"]) {
    presentationEnvironment();
    const ui = await registeredUi("kitty", 80, "dark", mode);
    try {
      check(`${mode} mode registers no artwork header or presentation transcript`, ui.header === undefined && ui.writes.length === 0);
    } finally {
      await ui.close();
    }
  }

  // Verify transcript isolation through a real AgentSession, TUI, faux response and official
  // JSONL/HTML export paths. The copy command's source is getLastAssistantText; no OS clipboard
  // mutation is needed to measure its exact input.
  presentationEnvironment({ VINCI_REDUCED_MOTION: "1" });
  const { createVinciUiHarness } = await loader.import(resolve(here, "ui/harness.mjs"), { default: false });
  const runtimeUi = await createVinciUiHarness({ connected: true, responses: ["Useful bounded answer."] });
  try {
    await bounded(runtimeUi.prompt("Describe the bounded fixture"), "real-runtime faux answer");
    const transcript = JSON.stringify(runtimeUi.session.sessionManager.getEntries());
    const artMarker = /vero-(?:pixel|rich|working|review|blocked|done)\.(?:png|svg)|vinci-vero|\x1b_G|\x1b\]1337;File=/;
    check("real session transcript contains the answer and no Vero artwork entry", transcript.includes("Useful bounded answer.") && !artMarker.test(transcript));
    const copySource = runtimeUi.session.getLastAssistantText();
    check("the exact copy-command source contains the answer and no Vero artwork", copySource.includes("Useful bounded answer.") && !artMarker.test(copySource));
    const jsonlPath = runtimeUi.session.exportToJsonl(join(testDir, "conversation.jsonl"));
    const jsonl = readFileSync(jsonlPath, "utf8");
    check("actual JSONL export contains the conversation without Vero artwork", jsonl.includes("Useful bounded answer.") && !artMarker.test(jsonl));
    const { exportFromFile } = await loader.import(resolve(root, "packages/coding-agent/src/core/export-html/index.ts"), { default: false });
    const htmlPath = await bounded(exportFromFile(jsonlPath, { outputPath: join(testDir, "conversation.html") }), "actual HTML export");
    const html = readFileSync(htmlPath, "utf8");
    const encodedSession = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
    assert.ok(encodedSession, "HTML export must carry its session data. Inspect the export template before retrying.");
    const exportedSession = Buffer.from(encodedSession, "base64").toString("utf8");
    check("actual HTML export data contains the answer without Vero artwork", exportedSession.includes("Useful bounded answer.") && !artMarker.test(exportedSession));
  } finally {
    await runtimeUi.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await bounded(runtimeUi.close(), "real-runtime UI shutdown");
  }

  process.stdout.write(`\nvero-integration: ${checks}/${checks} checks passed (registered renderers, protocol bytes, measured text geometry and transcript isolation).\n`);
  process.stdout.write("Native Kitty/iTerm image appearance and physical iTerm row placement remain unqualified by the headless terminal.\n");
} finally {
  if (agentDirKey) {
    if (originalAgentDir === undefined) delete process.env[agentDirKey];
    else process.env[agentDirKey] = originalAgentDir;
  }
  setCapabilities(originalCapabilities);
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  execFileSync("find", [testDir, "-mindepth", "1", "-delete"], { timeout: 15_000 });
  execFileSync("rmdir", [testDir], { timeout: 5_000 });
}
