// Vinci Code — integration test for vinci-cachewatch (prefix-cache hygiene, roadmap #52 code half).
// Drives the REAL extension: snapshot/analyze logic, registration gating, and the guarantee that the
// diagnostic never mutates the outgoing request. No gateway. Run with Node 23+ (strips TS types):
//   node --experimental-strip-types vinci/test/cachewatch-integration.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ext = await import(join(here, "..", "extensions", "vinci-cachewatch.ts"));
const { snapshotPayload, analyzePrefix, formatLine } = ext;
const register = ext.default;

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; if (!cond) console.log(`  ✗ ${label}`); };

// Synthetic provider payloads (OpenAI-completions shape).
const sys = { role: "system", content: "You are Vinci." };
const tools = [{ type: "function", function: { name: "read" } }, { type: "function", function: { name: "bash" } }];
const u1 = { role: "user", content: "hi" };
const a1 = { role: "assistant", content: "hello" };
const u2 = { role: "user", content: "next" };
const T1 = { messages: [sys, u1], tools };
const T2 = { messages: [sys, u1, a1, u2], tools }; // appended → stable foundation, commonPrefix 2
const T3 = { messages: [{ role: "system", content: "CHANGED" }, u1, a1, u2], tools }; // system changed → busted
const T4 = { messages: [sys, u1, a1, u2], tools: [...tools, { type: "function", function: { name: "edit" } }] }; // tools changed

// ── snapshotPayload ──
ok("snapshot: valid payload → hashes", (() => { const s = snapshotPayload(T1); return s && s.sys !== "(no-system)" && s.msgs.length === 2; })());
ok("snapshot: no messages → null", snapshotPayload({}) === null);
ok("snapshot: first msg not system → (no-system)", snapshotPayload({ messages: [u1] }).sys === "(no-system)");

// ── analyzePrefix ──
const s1 = snapshotPayload(T1), s2 = snapshotPayload(T2), s3 = snapshotPayload(T3), s4 = snapshotPayload(T4);
ok("analyze: first turn is baseline", (() => { const a = analyzePrefix(null, s1); return a.foundationStable && a.commonPrefix === 0 && a.total === 2; })());
{
  const a = analyzePrefix(s1, s2);
  ok("analyze: appended turn keeps foundation stable", a.foundationStable && a.changed.length === 0);
  ok("analyze: common prefix = prior message count", a.commonPrefix === 2 && a.total === 4);
}
{
  const a = analyzePrefix(s2, s3);
  ok("analyze: changed system → busted", a.foundationStable === false && a.changed.includes("system"));
  ok("analyze: busted system → 0 common prefix", a.commonPrefix === 0);
}
{
  const a = analyzePrefix(s2, s4);
  ok("analyze: changed tools → busted (tools)", a.foundationStable === false && a.changed.includes("tools") && !a.changed.includes("system"));
}
{
  // A mutated MIDDLE message (history rewrite, e.g. de-groove/compaction) truncates the common prefix.
  const mutated = snapshotPayload({ messages: [sys, u1, { role: "assistant", content: "DIFFERENT" }, u2], tools });
  const a = analyzePrefix(s2, mutated);
  ok("analyze: mutated middle msg stops common prefix at the change", a.foundationStable && a.commonPrefix === 2);
}

// ── formatLine ──
ok("format: baseline line", formatLine(1, s1, analyzePrefix(null, s1)).includes("baseline"));
ok("format: stable line shows N/M", (() => { const l = formatLine(2, s2, analyzePrefix(s1, s2)); return l.includes("STABLE") && l.includes("2/4"); })());
ok("format: busted line names what changed", formatLine(3, s3, analyzePrefix(s2, s3)).includes("BUSTED") && formatLine(3, s3, analyzePrefix(s2, s3)).includes("system"));

// ── registration gating: zero handlers when off, one when on ──
const mkPi = () => { const calls = []; return { calls, on: (ev, h) => calls.push({ ev, h }) }; };
delete process.env.VINCI_CACHE_DEBUG;
const piOff = mkPi(); register(piOff);
ok("gating: registers nothing when VINCI_CACHE_DEBUG unset", piOff.calls.length === 0);
process.env.VINCI_CACHE_DEBUG = "1";
const piOn = mkPi(); register(piOn);
ok("gating: registers before_provider_request when =1", piOn.calls.length === 1 && piOn.calls[0].ev === "before_provider_request");

// ── the handler NEVER mutates the request (returns undefined) + logs across turns ──
const handler = piOn.calls[0].h;
const logs = [];
const orig = process.stderr.write.bind(process.stderr);
process.stderr.write = (s) => { logs.push(String(s)); return true; };
const r1 = await handler({ payload: T1 });
const r2 = await handler({ payload: T2 });
const r3 = await handler({ payload: T3 });
process.stderr.write = orig;
ok("handler: returns undefined (never mutates the payload)", r1 === undefined && r2 === undefined && r3 === undefined);
ok("handler: turn 1 logs baseline", logs[0]?.includes("baseline"));
ok("handler: turn 2 logs STABLE 2/4", logs[1]?.includes("STABLE") && logs[1]?.includes("2/4"));
ok("handler: turn 3 logs BUSTED system", logs[2]?.includes("BUSTED") && logs[2]?.includes("system"));

delete process.env.VINCI_CACHE_DEBUG;
console.log(`cachewatch-integration: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
