import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { getCapabilities, setCapabilities, setCellDimensions, TUI, Text } from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const productVersion = JSON.parse(readFileSync(join(root, "vinci/identity.json"), "utf8")).version;
const testDir = mkdtempSync(join(tmpdir(), "look-registered-"));
const environmentKeys = [
  "TMPDIR", "GIT_CEILING_DIRECTORIES", "PI_OFFLINE", "VINCI_CODE", "VINCI_NO_VERIFY", "VINCI_NO_SANDBOX", "OPENAI_API_KEY",
  "CI", "LC_ALL", "VINCI_ASCII", "VINCI_ASCII_WORDMARK", "VINCI_HERO_HEADER", "VINCI_VERO_IMAGES", "NO_COLOR", "TERM", "VINCI_PLAIN", "VINCI_SCREEN_READER", "VINCI_REDUCED_MOTION",
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
  for (const key of ["CI", "VINCI_ASCII", "VINCI_ASCII_WORDMARK", "VINCI_HERO_HEADER", "VINCI_VERO_IMAGES", "NO_COLOR", "VINCI_PLAIN", "VINCI_SCREEN_READER", "VINCI_REDUCED_MOTION"]) {
    delete process.env[key];
  }
  process.env.TERM = "xterm-256color";
  Object.assign(process.env, overrides);
}

function imagePayload(lines, protocol) {
  const text = lines.join("\n");
  const chunks = protocol === "kitty" ? text.matchAll(/\x1b_G[^;]*;([^\x1b]*)\x1b\\/g)
    : text.matchAll(/\x1b\]1337;File=[^:]*:([^\x07]*)\x07/g);
  return Buffer.from(Array.from(chunks, (chunk) => chunk[1]).join(""), "base64");
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
  const veroImages = await loader.import(resolve(here, "../extensions/lib/vero-image.ts"), { default: false });
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
    const context = { mode, cwd: profile, model: { name: "Vinci", provider: "vinci" }, ui, getContextUsage: () => ({ percent: null, tokens: null }) };
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
      header: registeredHeader, editor, terminal, tui, writes, emit, context,
      async frame() { tui.requestRender(); await bounded(terminal.waitForRender(), "registered TUI repaint"); return terminal.getViewport(); },
      async close() { await emit("session_shutdown"); tui.stop(); await bounded(terminal.flush(), "registered TUI shutdown"); },
    };
  }

  const transitions = [
    ["Ready", () => {}],
    ["Thinking", (ui) => ui.emit("agent_start")],
    ["Thinking - Checking...", (ui) => ui.emit("tool_call", { toolCallId: "check", toolName: "rerun_check", input: {} })],
    ["Blocked", () => control.requestVinciAutomationStop("A real fixture stop")],
    ["Waiting for you", () => { control.clearVinciAutomationStop(); state.setVinciWorking(false); outcome("WAITING"); }],
    ["Not sure", () => outcome("DONE_UNVERIFIED")],
    ["Done", () => outcome("DONE")],
  ];
  for (const protocol of ["kitty", "iterm2", null]) {
    presentationEnvironment({ VINCI_ASCII: "1", VINCI_REDUCED_MOTION: "1", VINCI_VERO_IMAGES: "1", VINCI_HERO_HEADER: "1" });
    for (const themeName of ["dark", "light"]) {
      const ui = await registeredUi(protocol, 80, themeName);
      try {
        for (const width of [40, 80, 120, 40]) {
          ui.terminal.resize(width, 24);
          resetPresentation();
          const baseline = await ui.frame();
          const composerRow = baseline.findIndex((line) => line.includes("UNSENT COMPOSER SENTINEL"));
          check(`${protocol ?? "text"} composer is visible at ${width} columns`, composerRow >= 0);
          for (const [label, transition] of transitions) {
            await transition(ui);
            const lines = ui.header.render(width);
            const text = stripVTControlCharacters(lines.join("\n"));
            check(`${protocol ?? "text"} header keeps four content rows and product identity`,
              lines.length === 5 && text.includes("Vinci Code") && text.includes(productVersion));
            check("legacy image flags have no effect on the wordmark", !/\x1b_G|\x1b\]1337;File=|✹|𝐯/.test(lines.join("\n")));
            check(`${label} is visible on the editor border`, stripVTControlCharacters(ui.editor.render(width)[1]).includes(label));
            const frame = await ui.frame();
            check(`${label} leaves the draft on the same row`, frame.findIndex((line) =>
              line.includes("UNSENT COMPOSER SENTINEL")) === composerRow && ui.editor.getText() === "UNSENT COMPOSER SENTINEL");
          }
        }
        check("header and shell add no presentation transcript entries", ui.writes.length === 0);
      } finally {
        await ui.close();
      }
    }
  }

  presentationEnvironment({ VINCI_VERO_IMAGES: "1" });
  const fallbackRoot = join(testDir, "fallback");
  const fallbackAssets = join(fallbackRoot, "assets", "vero");
  mkdirSync(fallbackAssets, { recursive: true });
  writeFileSync(join(fallbackAssets, "manifest.json"), JSON.stringify(manifest));
  const fallbackUrl = pathToFileURL(`${fallbackRoot}/`);
  check("missing assets retain the text path", veroImages.createVeroImages(fallbackUrl).size === 0);
  writeFileSync(join(fallbackAssets, "vero-rich.png"), assets.get("rich"));
  check("the approved hero asset loads", veroImages.createVeroImages(fallbackUrl).has("rich"));
  const corruptHero = Buffer.from(assets.get("rich"));
  corruptHero[corruptHero.length - 1] ^= 1;
  writeFileSync(join(fallbackAssets, "vero-rich.png"), corruptHero);
  check("a corrupt hero asset with intact dimensions is rejected", !veroImages.createVeroImages(fallbackUrl).has("rich"));

  for (const protocol of ["kitty", "iterm2"]) {
    presentationEnvironment({ LC_ALL: "C.UTF-8", VINCI_REDUCED_MOTION: "1" });
    const compact = await registeredUi(protocol);
    let compactLines;
    try {
      compactLines = compact.header.render(80);
      const text = stripVTControlCharacters(compactLines.join("\n"));
      check(`${protocol} compact header retains its identity and login`, compactLines.length === 5 &&
        text.includes(`Vinci Code ${productVersion}`) && text.includes("/login to connect"));
    } finally {
      await compact.close();
    }

    process.env.VINCI_VERO_IMAGES = "1";
    const imagesOnly = await registeredUi(protocol);
    try {
      check(`${protocol} image support alone leaves compact header bytes identical`,
        JSON.stringify(imagesOnly.header.render(80)) === JSON.stringify(compactLines));
    } finally {
      await imagesOnly.close();
    }

    process.env.VINCI_HERO_HEADER = "1";
    const ui = await registeredUi(protocol);
    try {
      const idle = ui.header.render(80);
      check(`${protocol} hero idle sends the approved rich PNG`, imagePayload(idle, protocol).equals(assets.get("rich")));
      await ui.emit("agent_start");
      const working = ui.header.render(80);
      check(`${protocol} hero working sends the approved working PNG without changing height`, working.length === idle.length &&
        imagePayload(working, protocol).equals(assets.get("working")));
      check(`${protocol} hero working keeps its identity and activity readable`,
        stripVTControlCharacters(working[0]).includes(`Vinci Code ${productVersion}`) &&
        stripVTControlCharacters(ui.editor.render(80)[1]).includes("Thinking"));
      state.setVinciProviderError("Fixture provider failure.");
      check(`${protocol} hero provider failure sends the approved blocked PNG`,
        imagePayload(ui.header.render(80), protocol).equals(assets.get("blocked")));
      check(`${protocol} narrow header omits the hero`, imagePayload(ui.header.render(39), protocol).length === 0);
    } finally {
      await ui.close();
    }
  }

  presentationEnvironment({ VINCI_ASCII: "1", VINCI_REDUCED_MOTION: "1" });
  const failedActivityUi = await registeredUi("kitty");
  try {
    await failedActivityUi.emit("agent_start");
    await failedActivityUi.emit("message_end", {
      message: { role: "assistant", provider: "vinci", stopReason: "error", errorMessage: "Fixture provider returned 503." },
    });
    await failedActivityUi.emit("agent_end");
    check("a reported provider failure remains visible after activity ends",
      stripVTControlCharacters(failedActivityUi.editor.render(80)[1]).includes("Error - Fixture provider returned 503."));
    await failedActivityUi.emit("agent_start");
    check("starting new activity retains an unresolved provider error", vero.getVeroPresentation().label === "Error");
    await failedActivityUi.emit("message_end", { message: { role: "assistant", provider: "vinci", stopReason: "stop", content: [{ type: "text", text: "Observed successful response." }] } });
    check("observed success clears its provider error", vero.getVeroPresentation().label === "Thinking");
  } finally {
    await failedActivityUi.close();
  }

  const tty = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  for (const [name, environment, ttyAttached, frames] of [
    ["animated", {}, true, [".", "o", "*", "o"]],
    ["NO_COLOR with motion allowed", { NO_COLOR: "1" }, true, [".", "o", "*", "o"]],
    ["reduced motion", { VINCI_REDUCED_MOTION: "1" }, true, []],
    ["CI", { CI: "true" }, true, []],
    ["non-TTY", {}, false, []],
  ]) {
    presentationEnvironment({ VINCI_ASCII: "1", ...environment });
    for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: ttyAttached, configurable: true });
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
    const stateLine = () => stripVTControlCharacters(ui.editor.render(80)[1]);
    try {
      await ui.emit("agent_start");
      check(`${name} starts the expected number of pulse timers`, intervals.size === Number(frames.length > 0));
      if (frames.length) {
        const [timer] = intervals;
        check("pulse interval is 260 ms", timer.intervalMs === 260);
        for (const frame of frames) {
          check(`pulse frame ${frame} keeps Thinking visible`, stateLine().includes(`${frame} Thinking`));
          timer.callback();
        }
      } else {
        check(`${name} keeps a steady thinking mark`, stateLine().includes("* Thinking"));
      }
      if (name === "animated") {
        check("provider error starts with a live pulse timer", intervals.size === 1);
        await ui.emit("message_end", {
          message: { role: "assistant", provider: "vinci", stopReason: "error", errorMessage: "Fixture provider returned 503." },
        });
        check("provider error clears the live pulse timer before agent end", intervals.size === 0);
        check("provider error replaces the Thinking border", stateLine().includes("Error - Fixture provider returned 503.") && !stateLine().includes("Thinking"));
        await ui.emit("message_end", { message: { role: "assistant", provider: "vinci", stopReason: "stop", content: [{ type: "text", text: "Observed successful response." }] } });
      }
      await ui.emit("agent_end");
      check("agent end clears animation intervals", intervals.size === 0);
      outcome("WAITING");
      check("a wait shows state text", stateLine().includes("Waiting for you"));
      await ui.emit("agent_start");
      await ui.emit("session_shutdown");
      check("shutdown clears animation intervals", intervals.size === 0);
    } finally {
      await ui.close();
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      for (const [index, stream] of [process.stdin, process.stdout].entries()) {
        if (tty[index]) Object.defineProperty(stream, "isTTY", tty[index]);
        else Reflect.deleteProperty(stream, "isTTY");
      }
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

  presentationEnvironment({ LC_ALL: "C.UTF-8", OPENAI_API_KEY: "fixture-key", VINCI_REDUCED_MOTION: "1" });
  const authPath = join(profile, "auth.json");
  utimesSync(authPath, 1, 1);
  const authUi = await registeredUi(null);
  try {
    const headerText = () => stripVTControlCharacters(authUi.header.render(80).join("\n"));
    check("rich header prompts for Vinci login with only an environment provider key", headerText().includes("/login to connect"));
    writeFileSync(authPath, JSON.stringify({ vinci: { type: "api_key", key: "fixture-key" } }));
    utimesSync(authPath, 2, 2);
    check("rich header shows signed in with a saved Vinci credential", headerText().includes("Signed in"));
  } finally {
    await authUi.close();
  }

  process.stdout.write(`\nvero-integration: ${checks}/${checks} checks passed (registered renderers, protocol bytes, measured text geometry and transcript isolation).\n`);
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
