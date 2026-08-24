// Vinci Code — integration test for vinci-toolload (deferred tool schemas, roadmap #54).
// Drives the REAL extension: deferred-set resolution (env), the active-set filter, the menu, the
// load_tools tool (activates via ctx.setActiveTools, rejects unknowns), and registration gating.
// No gateway. Run with Node 23+: node --experimental-strip-types vinci/test/toolload-integration.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ext = await import(join(here, "..", "extensions", "vinci-toolload.ts"));
const { deferredSet, applyDeferral, loadMenu } = ext;
const register = ext.default;

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; if (!cond) console.log(`  ✗ ${label}`); };
const DEFAULT4 = ["advisor", "convene_council", "orchestrate", "spawn_helper"];

// ── deferredSet: env resolution ──
ok("default deferred set is the 4 specialists", JSON.stringify(deferredSet({})) === JSON.stringify(DEFAULT4));
ok("VINCI_NO_DEFER=1 → nothing deferred", deferredSet({ VINCI_NO_DEFER: "1" }).length === 0);
ok("env override is honored", JSON.stringify(deferredSet({ VINCI_DEFERRED_TOOLS: "advisor,library_docs" })) === JSON.stringify(["advisor", "library_docs"]));
ok("unknown names are dropped (only describable tools defer)", JSON.stringify(deferredSet({ VINCI_DEFERRED_TOOLS: "advisor,made_up_tool" })) === JSON.stringify(["advisor"]));
// An empty override falls back to the DEFAULT set, because `""` is falsy and the code reads
// `raw ? raw.split(",") : DEFAULT_DEFERRED`. Assert that outright.
//
// This previously read `…length === 0 || …=== DEFAULT4`, under the name "empty override → empty
// (defers nothing)". Those two arms describe OPPOSITE behaviours, so the assertion held whichever
// the code did and could never fail — and the name asserted the arm that is not what happens.
// (Removing the ternary so `"".split(",")` runs unconditionally is caught by other assertions in
// this file, so no behaviour was unpinned; the line was simply meaningless and misleading.)
//
// If "defer nothing" is ever the wanted meaning of an explicit empty override, that is a product
// change to `deferredSet`, and this assertion should flip with it rather than accommodate both.
ok("empty override → the default set (empty is falsy, so it is not an override)", JSON.stringify(deferredSet({ VINCI_DEFERRED_TOOLS: "" })) === JSON.stringify(DEFAULT4));

// ── applyDeferral: filter the active set ──
const ACTIVE = ["read", "bash", "edit", "todo", "web_search", "advisor", "convene_council", "orchestrate", "spawn_helper", "load_tools"];
const deferred = new Set(DEFAULT4);
{
  const next = applyDeferral(ACTIVE, deferred, new Set());
  ok("filter removes all deferred-not-loaded", DEFAULT4.every((t) => !next.includes(t)));
  ok("filter keeps everyday + meta tools", ["read", "bash", "edit", "todo", "web_search", "load_tools"].every((t) => next.includes(t)));
}
{
  const next = applyDeferral(ACTIVE, deferred, new Set(["advisor"]));
  ok("a loaded tool is kept active", next.includes("advisor"));
  ok("still-deferred tools stay removed", !next.includes("convene_council") && !next.includes("orchestrate"));
}

// ── loadMenu ──
ok("menu lists each deferred tool with a purpose", (() => { const m = loadMenu(DEFAULT4); return DEFAULT4.every((t) => m.includes(t)) && m.includes("second opinion"); })());

// ── register wires a before_agent_start handler + load_tools tool; deferral shrinks the active set ──
// Tool-set control is on `pi` (ExtensionAPI), NOT the event ctx — mirror that in the mock.
function mkPi(activeRef) {
  const tools = []; const handlers = {};
  return { tools, handlers, setTo: null,
    registerTool: (d) => tools.push(d),
    on: (ev, h) => { (handlers[ev] ||= []).push(h); },
    getActiveTools() { return [...activeRef.current]; },
    setActiveTools(t) { this.setTo = t; activeRef.current = t; },
    registerCommand() {}, registerShortcut() {} };
}
// kill switch → registers nothing
const piOff = mkPi({ current: [...ACTIVE] });
const savedEnv = process.env.VINCI_NO_DEFER; process.env.VINCI_NO_DEFER = "1";
register(piOff);
ok("kill switch → no load_tools tool, no handler", piOff.tools.length === 0 && !piOff.handlers.before_agent_start);
if (savedEnv === undefined) delete process.env.VINCI_NO_DEFER; else process.env.VINCI_NO_DEFER = savedEnv;

// default → registers load_tools + a before_agent_start handler
const activeRef = { current: [...ACTIVE] };
const piOn = mkPi(activeRef);
register(piOn);
ok("registers load_tools tool", piOn.tools.some((t) => t.name === "load_tools"));
ok("registers a before_agent_start handler", (piOn.handlers.before_agent_start || []).length === 1);
ok("registers a session_start handler (apply deferral early)", (piOn.handlers.session_start || []).length === 1);

// both session_start and before_agent_start shrink the active set via pi.setActiveTools
{
  await piOn.handlers.session_start[0]({}, {});
  ok("session_start removes the 4 deferred tools", piOn.setTo && DEFAULT4.every((t) => !piOn.setTo.includes(t)) && piOn.setTo.includes("read"));
  activeRef.current = [...ACTIVE]; piOn.setTo = null;
  await piOn.handlers.before_agent_start[0]({}, {});
  ok("before_agent_start removes the 4 deferred tools", piOn.setTo && DEFAULT4.every((t) => !piOn.setTo.includes(t)) && piOn.setTo.includes("read"));
}

// load_tools.execute activates the requested tool (via pi) and rejects unknowns
{
  const loadTool = piOn.tools.find((t) => t.name === "load_tools");
  activeRef.current = ["read", "load_tools"];
  const good = await loadTool.execute("id", { tool: "advisor" });
  ok("load_tools activates the requested tool", activeRef.current.includes("advisor"));
  ok("load_tools confirms availability", good.content[0].text.includes("advisor") && good.content[0].text.includes("available"));
  const bad = await loadTool.execute("id", { tool: "nope" });
  ok("load_tools rejects an unknown tool", bad.content[0].text.toLowerCase().includes("isn't a loadable"));
}

// E2: when activation silently fails (setActiveTools ignores an unregistered name), report honestly
{
  const REGISTERED = new Set(["read", "load_tools"]); // advisor NOT registered in this session
  const stubborn = { current: ["read", "load_tools"] };
  const piMisconfig = {
    tools: [], handlers: {},
    registerTool: (d) => piMisconfig.tools.push(d),
    on: (ev, h) => { (piMisconfig.handlers[ev] ||= []).push(h); },
    getActiveTools: () => [...stubborn.current],
    setActiveTools: (t) => { stubborn.current = t.filter((n) => REGISTERED.has(n)); }, // drops unknowns
    registerCommand() {}, registerShortcut() {},
  };
  process.env.VINCI_DEFERRED_TOOLS = "advisor";
  register(piMisconfig);
  delete process.env.VINCI_DEFERRED_TOOLS;
  const loadTool = piMisconfig.tools.find((t) => t.name === "load_tools");
  const res = await loadTool.execute("id", { tool: "advisor" });
  ok("load_tools reports honest failure when activation doesn't take", res.content[0].text.toLowerCase().includes("couldn't activate"));
}

console.log(`toolload-integration: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
