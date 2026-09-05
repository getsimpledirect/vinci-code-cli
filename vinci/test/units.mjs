// Vinci Code — unit tests for the pure logic inside the extensions/patches. Fast, no network.
// These MIRROR the logic in vinci/extensions/* (kept in sync by hand); the smoke test exercises the
// real code end-to-end. Run: node vinci/test/units.mjs   (or via vinci/test/run.sh)
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`  ✗ ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

// ── vinci-orchestrate: parseVerdict (grader output → verdict; must read the LEADING token) ──
function parseVerdict(text) {
  const clean = text.trim().replace(/^[^a-zA-Z]+/, "");
  const lead = clean.toLowerCase();
  const firstLine = clean.split("\n")[0];
  if (lead.startsWith("needs")) return "needs-work";
  if (lead.startsWith("pass")) return "pass";
  if (/\bneeds?\s*work\b|\bfail(?:s|ed)?\b/i.test(firstLine)) return "needs-work";
  if (/\bpass(?:es|ed)?\b|\bcorrect\b|\bsolid\b/i.test(firstLine)) return "pass";
  return "unclear";
}
eq("verdict: PASS with 'missing pieces'", parseVerdict("PASS — the missing helpers are clearly called out."), "pass");
eq("verdict: NEEDS WORK", parseVerdict("NEEDS WORK: never handles the error state."), "needs-work");
eq("verdict: **PASS**", parseVerdict("**PASS** looks solid."), "pass");
eq("verdict: Needs work/incomplete", parseVerdict("Needs work — incomplete, missing validation."), "needs-work");

// ── vinci-orchestrate: nextTier escalation ladder ──
const TIER_ORDER = ["vinci-piccolo", "vinci-bozza", "vinci-tela"];
const nextTier = (m, r) => { const i = TIER_ORDER.indexOf(m.id); if (i < 0 || i >= TIER_ORDER.length - 1) return null; return r.find("vinci", TIER_ORDER[i + 1]) ?? null; };
const allReg = { find: (_p, id) => (TIER_ORDER.includes(id) ? { id } : undefined) };
const noTela = { find: (_p, id) => (id !== "vinci-tela" && TIER_ORDER.includes(id) ? { id } : undefined) };
eq("tier: piccolo→bozza", nextTier({ id: "vinci-piccolo" }, allReg)?.id, "vinci-bozza");
eq("tier: bozza→tela", nextTier({ id: "vinci-bozza" }, allReg)?.id, "vinci-tela");
eq("tier: tela→null (top)", nextTier({ id: "vinci-tela" }, allReg), null);
eq("tier: bozza→null when tela unserved", nextTier({ id: "vinci-bozza" }, noTela), null);

// ── vinci-advisor: askStronger picks the STRONGEST registered tier above the current model ──
const pickStronger = (id, have) => { const i = TIER_ORDER.indexOf(id); if (i < 0) return null; for (let j = TIER_ORDER.length - 1; j > i; j--) if (have.includes(TIER_ORDER[j])) return TIER_ORDER[j]; return null; };
eq("advisor: piccolo→tela (both present)", pickStronger("vinci-piccolo", ["vinci-bozza", "vinci-tela"]), "vinci-tela");
eq("advisor: piccolo→bozza (only bozza)", pickStronger("vinci-piccolo", ["vinci-bozza"]), "vinci-bozza");
eq("advisor: piccolo→null (none) → self-review", pickStronger("vinci-piccolo", []), null);
eq("advisor: tela→null (already top)", pickStronger("vinci-tela", ["vinci-bozza", "vinci-tela"]), null);

// ── vinci-plan: Plan blocks write/edit + MUTATING bash; allows reads + read-only bash ──
eq("plan blocks write tool", new Set(["write", "edit"]).has("write"), true);
const AT = "(?:^|[;&|\\n])\\s*(?:sudo\\s+)?";
const bashMutates = (c) =>
  new RegExp(`${AT}(rm|rmdir|mv|cp|mkdir|touch|ln|tee|dd|chmod|chown|truncate|rename|shred)\\b`, "i").test(c) ||
  new RegExp(`${AT}sed\\b[^|;&]*\\s-i`, "i").test(c) ||
  new RegExp(`${AT}git\\s+(add|commit|push|checkout|switch|reset|merge|rebase|stash|apply|clean|rm|mv|tag|init)\\b`, "i").test(c) ||
  new RegExp(`${AT}(npm|pnpm|yarn|bun|pip|pip3|brew|apt|apt-get|cargo|gem|composer)\\s+(install|add|i|remove|uninstall|rm|update|upgrade|ci|link)\\b`, "i").test(c) ||
  /(?<![0-9&>])>>?(?!\s*(?:\/dev\/null\b|&))\s*\S/.test(c);
// read-only exploration → allowed (incl. tricky non-mutating: -ln flag, cp.txt file, 2>&1, INSTALL.md)
for (const c of ["ls -la", "ls -ln", "cat package.json", "cat cp.txt", "grep -r foo .", "git status", "git log --oneline", "find . -name x", "echo hi > /dev/null", "cat a 2>&1", "cat INSTALL.md", "npm run build"]) eq(`plan allows: ${c}`, bashMutates(c), false);
// changes → blocked
for (const c of ["rm -rf x", "mkdir y", "touch z", "echo hi > file.txt", "sed -i s/a/b/ f", "git commit -m x", "npm install lodash", "mv a b", "ls; rm x", "sudo rm y", "cat a >> b.txt"]) eq(`plan blocks: ${c}`, bashMutates(c), true);

// ── vinci-plan: APPROVAL auto-toggle — a whole-message "yes" leaves Plan for Auto; anything with
//    more detail stays in Plan (so Vinci keeps planning; the confirm-on-write backstops it). ──
const APPROVAL = /^\s*(?:yes|yep|yeah|yup|sure|ok(?:ay)?|go(?:\s*ahead)?|do it|build it|make it|add it|proceed|please do|go for it|sounds good|let'?s (?:do it|go|build it)|approve[d]?|confirm(?:ed)?|👍)[\s.!]*$/i;
for (const s of ["yes", "Yes", "yep", "sure", "ok", "okay", "go", "go ahead", "do it", "build it", "add it", "proceed", "sounds good", "let's do it", "approve", "approved", "confirm", "confirmed", "👍", "yes!", "Yes."]) eq(`approval: ${s}`, APPROVAL.test(s), true);
for (const s of ["yes but change the title", "no", "not yet", "hold on", "yes, and also add tests", "what about X?", "continue", "wait", "confirmation email"]) eq(`not approval: ${s}`, APPROVAL.test(s), false);

// ── vinci-loopbreak: identical no-progress calls get blocked; an edit resets the counter ──
const callKey = (tool, input) => {
  let s; try { s = JSON.stringify(input ?? {}); } catch { s = String(input); }
  return tool + " " + s.replace(/\s+/g, " ").trim();
};
// whitespace-only differences collapse to the same key; real arg changes don't
eq("loopbreak: whitespace-normalized keys match", callKey("bash", { command: "node  x.mjs" }) === callKey("bash", { command: "node x.mjs" }), true);
eq("loopbreak: different args → different key", callKey("bash", { command: "node a" }) === callKey("bash", { command: "node b" }), false);
eq("loopbreak: different tool → different key", callKey("read", { path: "a" }) === callKey("bash", { path: "a" }), false);
// simulate the guard: 3rd identical read-only repeat (no edit between) is blocked; edit clears it
const IDENTICAL_LIMIT = 3;
function simulate(calls) {
  const seen = new Map();
  const blocked = [];
  calls.forEach(([tool, input], i) => {
    if (tool === "edit" || tool === "write") {
      // an edit/write clears OTHER counters but keeps its OWN — a byte-identical rewrite is a loop
      const k = callKey(tool, input);
      const n = (seen.get(k) ?? 0) + 1;
      seen.clear();
      seen.set(k, n);
      if (n >= IDENTICAL_LIMIT) blocked.push(i);
      return;
    }
    const k = callKey(tool, input);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n >= IDENTICAL_LIMIT) blocked.push(i);
  });
  return blocked;
}
const same = { command: "node -e \"x\"" };
// 3 identical read-only calls → the 3rd (index 2) blocks
eq("loopbreak: blocks 3rd identical repeat", JSON.stringify(simulate([["bash", same], ["bash", same], ["bash", same]])), JSON.stringify([2]));
// distinct edit → test → distinct edit → test …: never blocked (each edit resets the world)
eq("loopbreak: edit-then-rerun never trips", simulate([["edit", { a: 1 }], ["bash", same], ["edit", { a: 2 }], ["bash", same], ["edit", { a: 3 }], ["bash", same]]).length, 0);
// the clamped-write loop: the SAME truncated write re-sent 3× → the 3rd blocks
const sameWrite = { path: "f.ts", content: "cut off…" };
eq("loopbreak: byte-identical write 3× trips", JSON.stringify(simulate([["write", sameWrite], ["write", sameWrite], ["write", sameWrite]])), JSON.stringify([2]));
// the real disaster (many identical, no edits) is caught from the 3rd on
eq("loopbreak: catches a long identical run", simulate(Array(10).fill(["bash", same]))[0], 2);

// ── vinci-loopbreak: RESULT-AWARE fixation — same call + CHANGING output = progress, not a loop ──
// (mirrors the tool_call increment + tool_result progress-reset; a blocked call yields no result)
function simulateRA(steps) {
  const seen = new Map();
  const lastSig = new Map();
  const blocked = [];
  steps.forEach(([tool, input, result], i) => {
    const k = callKey(tool, input);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n >= IDENTICAL_LIMIT) { blocked.push(i); return; } // blocked → no result → no sig update
    const sig = String(result).replace(/\s+/g, " ").trim();
    const prev = lastSig.get(k);
    if (prev !== undefined && prev !== sig) seen.delete(k); // progress → restart streak
    lastSig.set(k, sig);
  });
  return blocked;
}
const npmTest = { command: "npm test" };
// same command, output changes every run (polling a rebuild / flaky test) → NEVER blocks
eq("loopbreak RA: changing output never trips", simulateRA([
  ["bash", npmTest, "3 failing"], ["bash", npmTest, "2 failing"], ["bash", npmTest, "1 failing"],
  ["bash", npmTest, "0 failing"], ["bash", npmTest, "all pass"],
]).length, 0);
// same command, identical output 3× in a row (genuinely stuck) → still blocks at the 3rd
eq("loopbreak RA: identical output still trips at 3rd", JSON.stringify(simulateRA([
  ["bash", npmTest, "err"], ["bash", npmTest, "err"], ["bash", npmTest, "err"],
])), JSON.stringify([2]));
// an intervening different result resets the streak, so no 3-in-a-row accumulates in this window
// (each change deletes the counter; the block can only fire on a 3rd identical-ARGS call whose two
// predecessors already returned, which never happens here because results keep differing)
eq("loopbreak RA: an intervening different result keeps resetting", simulateRA([
  ["bash", npmTest, "err"], ["bash", npmTest, "CHANGED"], ["bash", npmTest, "err"], ["bash", npmTest, "err"],
]).length, 0);

// ── vinci-loopbreak: meta tools exempt from the explore streak; narration resets it ──
const META_TOOLS = new Set(["ask_user", "todo", "present_plan", "advisor", "convene_council", "review_changes", "remember", "spawn_helper", "orchestrate"]);
const GROUNDING_TOOLS = new Set(["web_search", "web_fetch"]);
const EXPLORE_LIMIT = 10;
function simulateExplore(events) {
  // events: a tool name, or the pseudo-events "narrate" (substantive assistant text) / "edit"
  let streak = 0;
  const trips = [];
  events.forEach((e, i) => {
    if (e === "narrate" || e === "edit" || e === "write") { streak = 0; return; }
    if (META_TOOLS.has(e) || GROUNDING_TOOLS.has(e)) return;
    streak += 1;
    if (streak >= EXPLORE_LIMIT) trips.push(i);
  });
  return trips;
}
const reads = (n) => Array(n).fill("read");
eq("loopbreak: narration resets the explore streak (review turns don't trip)", simulateExplore([...reads(9), "narrate", ...reads(9)]).length, 0);
eq("loopbreak: todo/ask_user don't count as exploration", simulateExplore([...reads(5), "todo", "ask_user", ...reads(4)]).length, 0);
eq("loopbreak: 10 silent reads still trip", simulateExplore(reads(10)).length, 1);
// grounding: persistent searching ("fire up more searches") must NOT trip the explore limit
eq("loopbreak: 14 web_search/fetch in a row don't trip explore", simulateExplore([...Array(7).fill("web_search"), ...Array(7).fill("web_fetch")]).length, 0);
// …but a consecutive-FAILURE backstop still catches a guess-spiral of different fake URLs
const fetchFailed = (t) => /page doesn'?t exist|couldn'?t (?:read|reach|resolve)|took too long to load|resolves to an internal/i.test(t);
eq("loopbreak: 404 fetch result counts as a failure", fetchFailed("That page doesn't exist (HTTP 404). The URL is likely wrong"), true);
eq("loopbreak: internal-resolve counts as a failure", fetchFailed("That address resolves to an internal server"), true);
eq("loopbreak: a real page read is NOT a failure", fetchFailed("read 2,560 words of documentation"), false);
// meta tools skip ONLY the explore streak — identical repeats still trip the fixation ladder
// (observed live: three identical todo calls after a length-cut "continue" went uncaught)
const samePlan = { items: ["a", "b"] };
eq("loopbreak: identical todo repeats still trip the fixation detector",
  JSON.stringify(simulate([["todo", samePlan], ["todo", samePlan], ["todo", samePlan]])), JSON.stringify([2]));
// a bare "continue" carries the repeat counters across the turn boundary; real asks reset them
const CONTINUEISH = /^\s*(?:continue|keep going|go on|carry on|resume|finish(?:\s+it)?)[\s.!…]*$/i;
for (const s of ["continue", "Continue", "continue.", "keep going", "go on!", "resume", "finish it"]) eq(`loopbreak carry: ${s}`, CONTINUEISH.test(s), true);
for (const s of ["continue the review in a file", "no, stop", "finish the backend part first", "continue?"]) eq(`loopbreak no-carry: ${s}`, CONTINUEISH.test(s), false);

// ── vinci-render: meaning-first collapsed summaries + narration-line extraction ──
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const grepSum = (n) => (n ? `found ${plural(n, "match", "matches")}` : "no matches");
const readSum = (n) => (n ? `read ${plural(n, "line")}` : "empty file");
eq("render: grep 12 → found 12 matches", grepSum(12), "found 12 matches");
eq("render: grep 1 → found 1 match", grepSum(1), "found 1 match");
eq("render: grep 0 → no matches", grepSum(0), "no matches");
eq("render: read 0 → empty file", readSum(0), "empty file");
const narrationLine = (text) => {
  const line = (text.split("\n").map((s) => s.trim()).filter(Boolean).pop() ?? "").replace(/[*_`#>]/g, "").trim();
  return line.length < 8 ? null : line;
};
eq("render: narration = last non-empty line, markdown stripped",
  narrationLine("Found it.\n\n**Now let me fix the save button.**"), "Now let me fix the save button.");
eq("render: tiny fragments don't replace the label", narrationLine("Done."), null);

// ── vinci-search web_fetch: SSRF guard + HTML→text (security-critical — mirror the extension) ──
function isPrivateIp(ip) {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const low = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (low === "::1" || low === "::") return true;
  const embedded = low.startsWith("::ffff:") ? low.slice(7) : low.startsWith("64:ff9b::") ? low.slice(9) : null;
  if (embedded !== null) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(embedded)) return isPrivateIp(embedded);
    const tail = embedded.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (tail) {
      const n = parseInt(tail[1], 16) * 0x10000 + parseInt(tail[2], 16);
      return isPrivateIp(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
    }
    return false;
  }
  if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) return true;
  return false;
}
// the cloud-metadata credential-theft vector MUST be blocked
eq("fetch SSRF: 169.254.169.254 (metadata) blocked", isPrivateIp("169.254.169.254"), true);
eq("fetch SSRF: 127.0.0.1 blocked", isPrivateIp("127.0.0.1"), true);
eq("fetch SSRF: 10.x blocked", isPrivateIp("10.1.2.3"), true);
eq("fetch SSRF: 192.168.x blocked", isPrivateIp("192.168.0.1"), true);
eq("fetch SSRF: 172.16-31 blocked", isPrivateIp("172.20.1.1"), true);
eq("fetch SSRF: ::1 blocked", isPrivateIp("::1"), true);
eq("fetch SSRF: v4-mapped private blocked", isPrivateIp("::ffff:127.0.0.1"), true);
// WHATWG new URL() normalises IPv4-mapped IPv6 to hex (::ffff:127.0.0.1 -> ::ffff:7f00:1) — both
// spellings, with or without brackets, must decode the embedded IPv4 and classify it.
eq("fetch SSRF: hex v4-mapped loopback blocked (URL-normalised)", isPrivateIp("[::ffff:7f00:1]"), true);
eq("fetch SSRF: hex v4-mapped loopback blocked (bare)", isPrivateIp("::ffff:7f00:1"), true);
eq("fetch SSRF: dotted v4-mapped loopback blocked (brackets)", isPrivateIp("[::ffff:127.0.0.1]"), true);
// NAT64 (64:ff9b::/96) embeds the same IPv4 — decode and classify it too.
eq("fetch SSRF: NAT64 hex loopback blocked", isPrivateIp("[64:ff9b::7f00:1]"), true);
eq("fetch SSRF: NAT64 dotted loopback blocked", isPrivateIp("64:ff9b::127.0.0.1"), true);
eq("fetch SSRF: v4-mapped 0.0.0.0 blocked", isPrivateIp("::ffff:0:0"), true);
// positive controls — decoding, not "always private"
eq("fetch SSRF: public v4 allowed (control)", isPrivateIp("93.184.216.34"), false);
eq("fetch SSRF: public v6 allowed (control)", isPrivateIp("[2606:2800:220:1:248:1893:25c8:1946]"), false);
eq("fetch SSRF: v4-mapped PUBLIC allowed (control)", isPrivateIp("::ffff:5db8:d822"), false);
eq("fetch SSRF: NAT64 PUBLIC allowed (control)", isPrivateIp("64:ff9b::5db8:d822"), false);
// regression — the previously blocked families all stay blocked
eq("fetch SSRF: public 8.8.8.8 allowed", isPrivateIp("8.8.8.8"), false);
eq("fetch SSRF: CGNAT 100.64-127 blocked", isPrivateIp("100.64.0.1"), true);
eq("fetch SSRF: link-local fe80 blocked", isPrivateIp("fe80::1"), true);
eq("fetch SSRF: ULA fc/fd blocked", isPrivateIp("fc00::1") && isPrivateIp("fd00::1"), true);
eq("fetch SSRF: public 172.15/172.32 allowed (edge)", isPrivateIp("172.15.0.1") || isPrivateIp("172.32.0.1"), false);

function preflightBlocked(raw) {
  let url; try { url = new URL(raw); } catch { return "invalid"; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return "internal";
  if ((/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) && isPrivateIp(host)) return "internal";
  return "ok";
}
eq("fetch preflight: localhost blocked", preflightBlocked("http://localhost:8080/x"), "internal");
eq("fetch preflight: metadata IP blocked", preflightBlocked("http://169.254.169.254/latest/meta-data/"), "internal");
eq("fetch preflight: file:// blocked", preflightBlocked("file:///etc/passwd"), "scheme");
eq("fetch preflight: ftp:// blocked", preflightBlocked("ftp://x.com"), "scheme");
eq("fetch preflight: public docs allowed", preflightBlocked("https://cloud.google.com/run/docs"), "ok");

function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
}
eq("fetch html: strips scripts + tags, keeps text",
  htmlToText("<html><head><style>.a{}</style></head><body><script>evil()</script><h1>Deploy</h1><p>Run gcloud run deploy</p></body></html>").replace(/\s+/g, " ").trim(),
  "Deploy Run gcloud run deploy");
eq("fetch html: no script content leaks", /evil/.test(htmlToText("<script>evil()</script>hi")), false);

// ── vinci-search Brave backend: freshness mapping + response→SearchResult shape ──
const BRAVE_FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" };
eq("brave: recency→freshness (week→pw)", BRAVE_FRESHNESS.week, "pw");
eq("brave: recency→freshness (year→py)", BRAVE_FRESHNESS.year, "py");
const mapBrave = (data) => (data.web?.results ?? []).slice(0, 8).map((r) => ({ title: r.title, url: r.url, content: r.description, publishedDate: r.page_age || r.age }));
const braveMapped = mapBrave({ web: { results: [{ title: "Cloud Run", url: "https://cloud.google.com/run", description: "Deploy <strong>containers</strong>", page_age: "2026-06-01" }] } });
eq("brave: maps web.results → {title,url,content,publishedDate}", JSON.stringify(braveMapped[0]),
  JSON.stringify({ title: "Cloud Run", url: "https://cloud.google.com/run", content: "Deploy <strong>containers</strong>", publishedDate: "2026-06-01" }));
eq("brave: empty results → []", mapBrave({}).length, 0);

// ── vinci-search web_answer: Brave Answers is OpenAI-compatible → answer = choices[0].message.content ──
const answerOf = (d) => d?.choices?.[0]?.message?.content?.trim() || null;
eq("web_answer: extracts choices[0].message.content", answerOf({ choices: [{ message: { content: "AWS recommends OIDC." } }] }), "AWS recommends OIDC.");
eq("web_answer: empty choices → null (falls back to web_search)", answerOf({ choices: [] }), null);
eq("web_answer: missing message → null", answerOf({ choices: [{}] }), null);
eq("web_answer: whitespace-only content → null", answerOf({ choices: [{ message: { content: "   " } }] }), null);

// ── verification system: grader verdict parse + untracked-file binary skip + todo auto-run gate ──
function parseGraderVerdict(text) {
  if (!text.trim()) return "none";
  const after = (text.split(/##\s*verdict/i)[1] ?? "").toLowerCase();
  const lead = after.replace(/^[^a-z]+/i, "");
  if (/^needs?\s*work/.test(lead)) return "needs-work";
  if (/^risky/.test(lead)) return "risky";
  if (/^(ships|solid|good)\b/.test(lead)) return "ships";
  if (/\bneeds?\s*work\b/.test(after.slice(0, 80))) return "needs-work";
  if (/\bneeds?\s*work\b|\brisky\b/i.test(text)) return "needs-work";
  return "none";
}
eq("grader: '## Verdict needs work' → needs-work", parseGraderVerdict("- bug X\n## Verdict\nneeds work — the auth is wrong"), "needs-work");
eq("grader: '## Verdict\\nships' → ships", parseGraderVerdict("Looks good.\n## Verdict\nships — correct and complete"), "ships");
eq("grader: risky verdict", parseGraderVerdict("## Verdict\nrisky — untested path"), "risky");
eq("grader: needs-work found even without a clean verdict line", parseGraderVerdict("This clearly needs work before shipping."), "needs-work");
eq("grader: empty → none", parseGraderVerdict("   "), "none");
// The lead token wins: a 'ships' verdict whose clause happens to say 'needs work' is still a ship.
eq("grader: 'ships, though … needs work later' → ships (lead wins)", parseGraderVerdict("## Verdict\nships, though naming still needs work later"), "ships");
eq("grader: '## Verdict\\nneeds work — …' still needs-work", parseGraderVerdict("## Verdict\nneeds work — the auth check is missing"), "needs-work");
// binary detection (untracked file inlining skips binaries via a NUL byte)
const isBinary = (s) => { for (let i = 0; i < Math.min(s.length, 8000); i++) if (s.charCodeAt(i) === 0) return true; return false; };
eq("grader: text file is not binary", isBinary("name: CI\non: push\n"), false);
eq("grader: NUL byte → binary (skipped)", isBinary("PK  data"), true);
// the todo auto-run gate fires only on the TRANSITION to all-done, and reopens the last step on needs-work
function gateFires(prev, next) {
  const isAllDone = next.every((s) => s === "done");
  const wasAllDone = prev.length > 0 && prev.every((s) => s === "done");
  return isAllDone && !wasAllDone;
}
eq("gate: fires on transition to all-done", gateFires(["done", "doing"], ["done", "done"]), true);
eq("gate: does NOT re-fire when already all-done", gateFires(["done", "done"], ["done", "done"]), false);
eq("gate: does not fire while work remains", gateFires(["done", "todo"], ["done", "doing"]), false);
const reopenLast = (steps) => steps.map((s, i) => (i === steps.length - 1 ? "doing" : s));
eq("gate: needs-work reopens the last step", JSON.stringify(reopenLast(["done", "done", "done"])), JSON.stringify(["done", "done", "doing"]));
// Phase 2 turn-end gate: looksLikeCompletionClaim is the trigger — a settled "done/correct/up to date"
// claim is what gets graded outside the todo flow. Mirrors core/vinci-grader.ts (kept in sync by hand).
function looksLikeCompletionClaim(text) {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  const CLAIM =
    /\b(all (set|done|good)|you'?re all set|is (now )?(done|complete|finished|ready)|are (now )?(done|complete|finished|up to date|correct)|task (is )?complete|(work|change|changes|implementation|feature|fix) (is|are) (complete|done|finished|ready|correct)|everything (is|looks) (good|correct|done|complete|up to date)|up to date|verified and|fully (working|functional|implemented)|successfully (implemented|completed|deployed|created|added|updated|fixed)|i'?ve (completed|finished|verified|implemented)|has been (completed|implemented|verified|deployed))\b/;
  const LEAD =
    /^(all\s+)?(done|finished|complete|completed|ready|all set|created|built|implemented|wrote|written|made|set up|installed)\b/;
  const PAST =
    /\b(i'?ve|i have|i)\s+(created|added|fixed|updated|implemented|built|wrote|written|set up|made|removed|renamed|installed)\b|\b(the|a|your)\s+[\w.-]+\s+(is|are|has been|have been|was|were)\s+(created|added|fixed|updated|implemented|built|set up|ready|done|working)\b/;
  if (!(CLAIM.test(t) || LEAD.test(t) || PAST.test(t))) return false;
  if (/\b(not (yet )?(done|complete|finished)|couldn'?t|can'?t|unable to|still needs?|todo|to-do|remaining|i'?ll|i will|let me|going to|about to|next i|then i)\b/.test(t)) return false;
  return true;
}
eq("claim: all done → fires", looksLikeCompletionClaim("All done — the deploy workflow is set up."), true);
eq("claim: changes are complete → fires", looksLikeCompletionClaim("The changes are complete and the feature is ready."), true);
eq("claim: up to date → fires", looksLikeCompletionClaim("Everything is up to date."), true);
eq("claim: i've implemented+verified → fires", looksLikeCompletionClaim("I've implemented the endpoint and verified it."), true);
eq("claim: successfully deployed → fires", looksLikeCompletionClaim("Successfully deployed to S3."), true);
// Terse completions the model actually uses (the live-test gap): these MUST fire now.
eq("claim: 'Done.' → fires", looksLikeCompletionClaim("Done."), true);
eq("claim: 'Done!' → fires", looksLikeCompletionClaim("Done!"), true);
eq("claim: 'Finished.' → fires", looksLikeCompletionClaim("Finished."), true);
eq("claim: 'Created greet.js' → fires", looksLikeCompletionClaim("Created greet.js with the greet function."), true);
eq("claim: 'I created the file' → fires", looksLikeCompletionClaim("I created the file."), true);
eq("claim: 'the file is created' → fires", looksLikeCompletionClaim("The file is created."), true);
eq("claim: neutral status → no", looksLikeCompletionClaim("Let me check the file first."), false);
eq("claim: 'I'll create it next' → no", looksLikeCompletionClaim("I'll create the file next."), false);
eq("claim: hedged 'couldn't' → no", looksLikeCompletionClaim("The migration is complete, but I couldn't run the tests."), false);
eq("claim: 'still needs' → no", looksLikeCompletionClaim("This isn't done yet — still needs the tests."), false);
eq("claim: 'remaining' edge cases → no", looksLikeCompletionClaim("The task is complete, but there are remaining edge cases."), false);
eq("claim: empty → no", looksLikeCompletionClaim("   "), false);

// ── vinci-search library_docs (Context7): pick best library + graceful error differentiation ──
const pickBestLibrary = (hits) => (hits.length ? [...hits].sort((a, b) => b.trust - a.trust)[0] : undefined);
eq("context7: picks highest-trust library", pickBestLibrary([{ id: "/a", trust: 5 }, { id: "/vercel/next.js", trust: 10 }, { id: "/b", trust: 7 }]).id, "/vercel/next.js");
eq("context7: ties broken by search order (stable)", pickBestLibrary([{ id: "/vercel/next.js", trust: 10 }, { id: "/websites/nextjs", trust: 10 }]).id, "/vercel/next.js");
eq("context7: no hits → undefined", pickBestLibrary([]), undefined);
// error handling: a Context7 outage/limit must degrade to a web_search fallback, not hang
const docErr = (name, em) => {
  if (name === "TimeoutError") return "timeout";
  if (/HTTP 429/.test(em)) return "ratelimited";
  if (/HTTP 5\d\d/.test(em)) return "down";
  return "unreachable";
};
eq("context7 err: 503 → down (fall back)", docErr("Error", "Context7 docs HTTP 503"), "down");
eq("context7 err: 429 → ratelimited", docErr("Error", "Context7 search HTTP 429"), "ratelimited");
eq("context7 err: timeout", docErr("TimeoutError", ""), "timeout");
eq("context7 err: network → unreachable", docErr("TypeError", "fetch failed"), "unreachable");

// ── vinci-todo: delta rendering — full plan only when new/restructured; one-liners for ticks ──
function todoDelta(prev, next) {
  const sameShape = prev.length === next.length && prev.every((p, i) => p.title === next[i].title);
  if (!sameShape) return "full";
  if (next.every((s, i) => s.status === prev[i].status)) return "unchanged";
  return "delta";
}
const P = (t, s) => ({ title: t, status: s });
eq("todo: new plan renders in full", todoDelta([], [P("a", "doing")]), "full");
eq("todo: restructured plan renders in full", todoDelta([P("a", "done")], [P("b", "doing")]), "full");
eq("todo: a tick renders as a delta line", todoDelta([P("a", "doing"), P("b", "todo")], [P("a", "done"), P("b", "doing")]), "delta");
eq("todo: identical resend gets the corrective", todoDelta([P("a", "done")], [P("a", "done")]), "unchanged");

// ── vinci-loopbreak: invalid-call coach — Pi validates BEFORE hooks, so coach via the result text ──
function coachTier(counts) {
  // consecutive identical-tool validation failures → coach tier per failure
  let tool = "", n = 0;
  return counts.map(([t, invalid]) => {
    if (!invalid) { tool = ""; n = 0; return "none"; }
    n = t === tool ? n + 1 : 1;
    tool = t;
    return n < 2 ? "native" : n >= 6 ? "abort" : n >= 4 ? "stop" : "split";
  });
}
eq("coach: 1st failure keeps Pi's error, 2nd coaches split, 4th says stop",
  JSON.stringify(coachTier([["edit", true], ["edit", true], ["edit", true], ["edit", true]])),
  JSON.stringify(["native", "split", "split", "stop"]));
eq("coach: 6th ignored failure ends the turn",
  coachTier(Array(6).fill(["edit", true]))[5], "abort");
eq("coach: a success resets the run",
  JSON.stringify(coachTier([["edit", true], ["read", false], ["edit", true]])),
  JSON.stringify(["native", "none", "native"]));

// ── vinci-render: bash intent — shell writes labeled honestly, sed -n is a read ──
const isAppend = (raw) => /(^|[^>])>>(?!>)/.test(raw);
eq("render: cat > is a write, not an append", isAppend("cat > f.ts << 'EOF'"), false);
eq("render: cat >> is an append", isAppend("cat >> f.ts << 'EOF'"), true);
const redirectTarget = (raw) => raw.match(/(?:^|[^&\d])>>?\s*([^\s;&|<]+)/)?.[1];
eq("render: redirect target extracted", redirectTarget("cat > apps/web/src/x.ts << 'EOF'"), "apps/web/src/x.ts");
eq("render: 2>&1 is not a write target", redirectTarget("cat f.ts 2>&1"), undefined);
const sedReads = (c) => /^sed\s+(-\S+\s+)*-n\b/.test(c) && !/\s-i\b/.test(c);
eq("render: sed -n '10,50p' is a read", sedReads("sed -n '10,50p' f.ts"), true);
eq("render: sed -i is an edit", sedReads("sed -i 's/a/b/' f.ts"), false);

// ── vinci-render: burst folding — the first of a same-kind run keeps the header, repeats go quiet ──
const VERB_OF = { read: "Reading", grep: "Searching", find: "Finding", ls: "Looking" };
const catOf = (name, label) => (name === "bash" ? label.split(" ")[0] : (VERB_OF[name] ?? name));
function foldSim(events) {
  // events: "read"/"ls"/["bash","Looking in x"]/"narrate" → continuation flag per tool call
  let last = null;
  const flags = [];
  for (const e of events) {
    if (e === "narrate") { last = null; continue; }
    const [name, label] = Array.isArray(e) ? e : [e, ""];
    const c = catOf(name, label);
    flags.push(c === last);
    last = c;
  }
  return flags;
}
eq("fold: a run of ls folds after the first", JSON.stringify(foldSim(["ls", "ls", "ls"])), JSON.stringify([false, true, true]));
eq("fold: narration breaks the run", JSON.stringify(foldSim(["ls", "narrate", "ls"])), JSON.stringify([false, false]));
eq("fold: bash-ls groups with the ls tool", JSON.stringify(foldSim([["bash", "Looking in board"], "ls"])), JSON.stringify([false, true]));
eq("fold: a different kind starts a new run", JSON.stringify(foldSim(["read", "ls"])), JSON.stringify([false, false]));

// ── vinci-loopbreak: narration nudger — every 4th consecutive silent tool round, capped at 3/turn ──
function nudgeRounds(seq) {
  // seq: "silent" (tool round, no words) | "talk" — returns indexes where a nudge fires
  let silent = 0, sent = 0;
  const fired = [];
  seq.forEach((e, i) => {
    if (e === "talk") { silent = 0; return; }
    silent++;
    if (silent % 4 === 0 && sent < 3) { sent++; fired.push(i); }
  });
  return fired;
}
eq("nudge: fires at the 4th and 8th silent round", JSON.stringify(nudgeRounds(Array(9).fill("silent"))), JSON.stringify([3, 7]));
eq("nudge: narration resets the count", nudgeRounds(["silent", "silent", "silent", "talk", "silent", "silent", "silent"]).length, 0);
eq("nudge: capped at 3 per turn", nudgeRounds(Array(40).fill("silent")).length, 3);

// ── [vinci] §20: double-encoded tool arguments repaired before validation ──
const coerceOne = (schemaType, v) => {
  if (typeof v !== "string") return v;
  try {
    const p = JSON.parse(v);
    if (schemaType === "array" && Array.isArray(p)) return p;
    if (schemaType === "object" && p && typeof p === "object" && !Array.isArray(p)) return p;
  } catch { /* not JSON */ }
  return v;
};
eq("coerce: stringified edits array parsed", Array.isArray(coerceOne("array", '\n[{"oldText":"a","newText":"b"}]\n')), true);
eq("coerce: JSON-looking string stays a string when the schema wants a string", coerceOne("string", "[1,2,3]"), "[1,2,3]");
eq("coerce: non-JSON string untouched", coerceOne("array", "not json"), "not json");
eq("coerce: wrong shape untouched (object wanted, array given)", coerceOne("object", "[1,2]"), "[1,2]");

// ── [vinci] §19: de-groove — collapse identical no-progress rounds in the model's view ──
// (failed AND successful-but-identical rounds; covers resumed histories since it runs per request)
function degroove(units) {
  // units: one signature per tool round — mirrors vinci-degroove collapsing (MIN_RUN 3)
  const MIN_RUN = 3;
  const out = [];
  let i = 0;
  while (i < units.length) {
    const sig = units[i];
    let j = i;
    while (j < units.length && units[j] === sig) j++;
    const count = j - i;
    if (count < MIN_RUN) { for (let k = i; k < j; k++) out.push(sig); }
    else { out.push(sig); out.push(`NOTE(${count - 1})`); }
    i = j;
  }
  return out;
}
eq("degroove: 9 identical failures → first + note", JSON.stringify(degroove(Array(9).fill("editfail"))), JSON.stringify(["editfail", "NOTE(8)"]));
eq("degroove: identical SUCCESSFUL rounds (the todo loop) also collapse", JSON.stringify(degroove(Array(9).fill("todo-ok"))), JSON.stringify(["todo-ok", "NOTE(8)"]));
eq("degroove: 2 identical untouched (retrying ≠ groove)", JSON.stringify(degroove(["editfail", "editfail"])), JSON.stringify(["editfail", "editfail"]));
eq("degroove: varied rounds untouched", JSON.stringify(degroove(["a", "b", "a"])), JSON.stringify(["a", "b", "a"]));
// result digits are normalized before signatures, so the loop-breaker's own counters can't hide a groove
const normSig = (t) => t.replace(/\d+/g, "#");
eq("degroove: attempt counters can't camouflage a groove", normSig("Blocked repeat #4 of this exact call"), normSig("Blocked repeat #9 of this exact call"));

// ── [vinci] §15: the completions wire marks failed tool results (so a block reads as a FAILURE) ──
const markError = (text, isError) => (isError ? `ERROR — this tool call FAILED. Do not repeat it unchanged.\n${text}` : text);
eq("wire: error result opens with the ERROR marker", markError("blocked by loop-breaker", true).startsWith("ERROR — this tool call FAILED"), true);
eq("wire: success result unchanged", markError("file contents", false), "file contents");

// ── assistant-message: friendly-error classifier (calm known transient/auth; raw for unknown) ──
function friendlyError(m) {
  if (!m) return null;
  if (/\b429\b|rate[_ ]?limit|too many requests|server busy|overloaded|quota/i.test(m)) return "busy";
  if (/\b5\d\d\b|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket hang up|dns/i.test(m)) return "offline";
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid[_ ].*(api[_ ]?key|token|credential)|not signed in|authentication/i.test(m)) return "login";
  return null;
}
eq("friendly: 429 → busy", friendlyError('429: {"message":"Server busy — retry shortly.","type":"rate_limit_error"}'), "busy");
eq("friendly: rate_limit → busy", friendlyError("rate_limit_error: slow down"), "busy");
eq("friendly: 503 → offline", friendlyError("503 Service Unavailable"), "offline");
eq("friendly: ECONNRESET → offline", friendlyError("request failed: ECONNRESET"), "offline");
eq("friendly: fetch failed → offline", friendlyError("TypeError: fetch failed"), "offline");
eq("friendly: 401 → login", friendlyError("401 Unauthorized: invalid api key"), "login");
eq("friendly: unknown → raw (null)", friendlyError("TypeError: cannot read property x of undefined"), null);
eq("friendly: context overflow is NOT swallowed here (handled by overflow path)", friendlyError("context_length_exceeded: 400"), null);

// ── vinci-crew: child launch derivation, status line, concurrency semaphore ──
function childLaunch(argv) {
  const cliPath = argv[1]; const args = []; let thinking = "high"; const self = "vinci-crew";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--extension" && argv[i + 1]) { if (!argv[i + 1].includes(self)) args.push("--extension", argv[i + 1]); i++; }
    else if (argv[i] === "--thinking" && argv[i + 1]) { thinking = argv[i + 1]; i++; }
  }
  args.push("--thinking", thinking);
  return { cliPath, args };
}
const cl = childLaunch(["node", "/x/cli.js", "--extension", "/e/vinci-provider.ts", "--extension", "/e/vinci-crew.ts", "--extension", "/e/vinci-guard.ts", "--thinking", "high", "--provider", "vinci"]);
eq("crew childLaunch: cliPath", cl.cliPath, "/x/cli.js");
eq("crew childLaunch: excludes crew (no recursion)", cl.args.includes("/e/vinci-crew.ts"), false);
eq("crew childLaunch: keeps the other extensions", cl.args.filter((a) => a.endsWith(".ts")).length, 2);
eq("crew childLaunch: carries thinking through", cl.args.slice(-2).join(" "), "--thinking high");

// Phase-2 tree: which helpers show, and the shape of the rendered lines (plain-text theme mock).
const visible = (h) => h.status === "queued" || h.status === "working" || h.status === "failed" || (h.status === "done" && !!(h.diff && h.diff.trim()) && !h.applied);
eq("crew tree: working shows", visible({ status: "working" }), true);
eq("crew tree: queued shows", visible({ status: "queued" }), true);
eq("crew tree: failed shows", visible({ status: "failed" }), true);
eq("crew tree: done+diff+unapplied shows", visible({ status: "done", diff: "x" }), true);
eq("crew tree: done+diff+APPLIED hidden", visible({ status: "done", diff: "x", applied: true }), false);
eq("crew tree: done+no-diff hidden", visible({ status: "done", diff: "" }), false);
const T = { fg: (_k, s) => s, bold: (s) => s };
function renderTree(theme, helpers) {
  const active = helpers.filter(visible);
  if (!active.length) return [];
  const dim = (s) => theme.fg("muted", s);
  const lines = [theme.fg("accent", theme.bold("● main")) + dim(" — you're here")];
  let anyReady = false;
  for (const h of active.slice(-6)) {
    const name = h.name;
    if (h.status === "working") lines.push(theme.fg("accent", "  ◐ ") + name + dim(" · working…"));
    else if (h.status === "queued") lines.push(dim(`  ○ ${name} · queued`));
    else if (h.status === "failed") lines.push(theme.fg("warning", `  ✗ ${name} · couldn't finish`));
    else { anyReady = true; lines.push(theme.fg("success", `  ✓ ${name} · ready to apply`)); }
  }
  if (anyReady) lines.push(dim("  ↳ /helpers to review & apply"));
  return lines;
}
eq("crew tree: empty → no widget", renderTree(T, []).length, 0);
eq("crew tree: root header present", renderTree(T, [{ status: "working", name: "a" }])[0], "● main — you're here");
eq("crew tree: working line", renderTree(T, [{ status: "working", name: "tests" }])[1], "  ◐ tests · working…");
eq("crew tree: done shows ready + hint", renderTree(T, [{ status: "done", diff: "x", name: "readme" }]).slice(1).join("|"), "  ✓ readme · ready to apply|  ↳ /helpers to review & apply");
eq("crew tree: applied helper drops off", renderTree(T, [{ status: "done", diff: "x", applied: true, name: "old" }]).length, 0);

// Phase-3: transcript formatting (user/assistant/tool → readable lines).
function formatTranscript(messages) {
  const out = []; const push = (p, t) => { for (const l of t.trim().split("\n")) out.push(p + l); };
  for (const m of messages) {
    const isUser = m.role === "user"; const c = m.content;
    if (typeof c === "string") { if (c.trim()) push(isUser ? "you › " : "", c); }
    else if (Array.isArray(c)) for (const p of c) {
      const t = p.type;
      if (t === "text" && p.text && p.text.trim()) push(isUser ? "you › " : "", p.text);
      else if (t === "toolCall" || t === "tool_use") out.push(`  ⚙ ${p.name ?? p.toolName ?? "tool"}`);
    }
  }
  return out.length ? out : ["(nothing captured)"];
}
eq("crew transcript: user + assistant + tool", formatTranscript([{ role: "user", content: "do X" }, { role: "assistant", content: [{ type: "text", text: "okay" }, { type: "toolCall", name: "edit" }] }]).join("|"), "you › do X|okay|  ⚙ edit");
eq("crew transcript: empty → placeholder", formatTranscript([]).join(""), "(nothing captured)");

// Phase-3: the ↓-to-arm / ↑↓-move / enter-open nav state machine (mirrors handleNavKey).
function makeNav(count) {
  let navActive = false, navIdx = 0, opened = null;
  const active = Array.from({ length: count }, (_, i) => `h${i}`);
  const key = (name, empty = true) => {
    if (!navActive) { if (name === "down" && empty) { navActive = true; navIdx = 0; return { consume: true }; } return undefined; }
    if (name === "up") { if (navIdx === 0) navActive = false; else navIdx--; return { consume: true }; }
    if (name === "down") { navIdx = Math.min(active.length - 1, navIdx + 1); return { consume: true }; }
    if (name === "escape" || name === "left") { navActive = false; return { consume: true }; }
    if (name === "enter" || name === "right") { opened = active[navIdx]; navActive = false; return { consume: true }; }
    navActive = false; return undefined;
  };
  return { key, get: () => ({ navActive, navIdx, opened }) };
}
let nav = makeNav(3);
eq("crew nav: down on non-empty input passes through", nav.key("down", false), undefined);
eq("crew nav: down on empty input arms + consumes", JSON.stringify(nav.key("down", true)), JSON.stringify({ consume: true }));
eq("crew nav: armed", nav.get().navActive, true);
nav.key("down"); eq("crew nav: down moves selection to 1", nav.get().navIdx, 1);
nav.key("down"); nav.key("down"); eq("crew nav: down clamps at last", nav.get().navIdx, 2);
nav.key("enter"); eq("crew nav: enter opens the selected helper", nav.get().opened, "h2");
eq("crew nav: enter also exits nav", nav.get().navActive, false);
nav = makeNav(3); nav.key("down"); nav.key("up");
eq("crew nav: up from first exits nav (back to input)", nav.get().navActive, false);
nav = makeNav(3); nav.key("down"); const typed = nav.key("x");
eq("crew nav: a normal key exits nav and passes through", typed, undefined);
eq("crew nav: ...and nav is off so typing lands in the input", nav.get().navActive, false);

// ── vinci-scope: scope-drift category detection + "did the user ask for it?" skip ──
const SAT = "(?:^|[;&|\\n])\\s*(?:sudo\\s+)?";
const DELETE_BASH = new RegExp(`${SAT}(rm|rmdir|unlink)\\b`, "i");
const S_GIT_RM = new RegExp(`${SAT}git\\s+rm\\b`, "i");
const DEPS_BASH = new RegExp(`${SAT}(npm|pnpm|yarn|bun|pip|pip3)\\s+(install|add|i|remove|rm|uninstall|un)\\b`, "i");
const CONFIG_FILE = /(^|\/)(tsconfig[\w.-]*\.json|[\w.-]+\.config\.(?:js|ts|mjs|cjs|json)|package\.json|Dockerfile|docker-compose\.ya?ml|next\.config\.\w+|vite\.config\.\w+|webpack\.config\.\w+|vercel\.json|netlify\.toml|\.gitlab-ci\.ya?ml|Makefile)$/i;
const CONFIG_DIR = /(^|\/)(\.github|\.circleci|\.husky)\//i;
function scopeCat(tool, arg) {
  if (tool === "bash") { if (DELETE_BASH.test(arg) || S_GIT_RM.test(arg)) return "delete"; if (DEPS_BASH.test(arg)) return "deps"; return null; }
  if (tool === "write" || tool === "edit") { if (CONFIG_FILE.test(arg) || CONFIG_DIR.test(arg)) return "config"; return null; }
  return null;
}
eq("scope: rm → delete", scopeCat("bash", "rm old.js"), "delete");
eq("scope: git rm → delete", scopeCat("bash", "git rm x"), "delete");
eq("scope: npm install pkg → deps", scopeCat("bash", "npm install lodash"), "deps");
eq("scope: pnpm add → deps", scopeCat("bash", "pnpm add react"), "deps");
eq("scope: tsconfig write → config", scopeCat("write", "tsconfig.json"), "config");
eq("scope: next.config → config", scopeCat("edit", "next.config.js"), "config");
eq("scope: .github workflow → config", scopeCat("write", ".github/workflows/ci.yml"), "config");
eq("scope: package.json → config", scopeCat("edit", "package.json"), "config");
eq("scope: normal code edit → null (no pause)", scopeCat("edit", "src/app.tsx"), null);
eq("scope: ls → null", scopeCat("bash", "ls -la"), null);
eq("scope: npm run build → null", scopeCat("bash", "npm run build"), null);
const S_ASKED = { delete: /\b(delete|deleting|remove|removing|\brm\b|drop|get rid of|clean ?up|clear out|uninstall)\b/i, deps: /\b(install|add|adding|dependenc|package|library|npm|yarn|pnpm|bun|pip|module|upgrade|bump)\b/i, config: /\b(config|configure|tsconfig|dockerfile|docker|\bci\b|workflow|pipeline|build|deploy|package\.json|makefile)\b/i };
eq("scope asked: 'delete the old file' excuses a delete", S_ASKED.delete.test("delete the old file"), true);
eq("scope asked: 'add lodash' excuses deps", S_ASKED.deps.test("add lodash please"), true);
eq("scope asked: 'fix the login bug' does NOT excuse a delete", S_ASKED.delete.test("fix the login bug"), false);

// ── vinci-scope semantic judge: keyword relatedness gate + verdict parsing ──
const STOP = new Set("the a an and or to of in on for it is fix add make update change edit create please just this that with your my our can could would should build write set get use new file code app them then some any all".split(" "));
const taskKeywords = (t) => Array.from(new Set((t.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((w) => !STOP.has(w))));
function relatedToTask(taskText, file) {
  const f = file.split("/").pop().toLowerCase(); const stem = f.replace(/\.\w+$/, "");
  return taskKeywords(taskText).some((k) => f.includes(k) || (stem.length > 2 && k.includes(stem)));
}
eq("judge gate: 'fix the login button' relates to login.tsx", relatedToTask("fix the login button", "src/login.tsx"), true);
eq("judge gate: 'fix the login button' relates to LoginForm.tsx", relatedToTask("fix the login button", "components/LoginForm.tsx"), true);
eq("judge gate: 'fix the login button' does NOT relate to payment.ts", relatedToTask("fix the login button", "src/payment.ts"), false);
eq("judge gate: vague 'make it faster' relates to nothing (→ will LLM-check)", relatedToTask("make it faster", "src/anything.ts"), false);
eq("judge gate: stopwords don't create bogus matches", relatedToTask("please update the file", "src/build.ts"), false);
// per-turn gating: task set, not already checked, under the cap, not related
function shouldCheck(taskText, file, checked, count, cap = 6) {
  if (!taskText || checked.has(file) || count >= cap) return false;
  if (relatedToTask(taskText, file)) return false;
  return true;
}
eq("judge gate: unrelated file under cap → check", shouldCheck("fix login", "src/payment.ts", new Set(), 0), true);
eq("judge gate: related file → skip", shouldCheck("fix login", "src/login.ts", new Set(), 0), false);
eq("judge gate: already checked → skip", shouldCheck("fix login", "src/payment.ts", new Set(["src/payment.ts"]), 0), false);
eq("judge gate: over the per-turn cap → skip", shouldCheck("fix login", "src/payment.ts", new Set(), 6), false);
eq("judge gate: no task → skip (nothing to compare)", shouldCheck("", "src/payment.ts", new Set(), 0), false);
// verdict parsing: leading token only (avoids "IN scope but…" misreads), bias to non-OUT
const verdict = (text) => { const first = text.toUpperCase().replace(/[^A-Z ]/g, " ").trim().split(/\s+/)[0]; if (first === "OUT") return "out"; if (first === "IN") return "in"; return "unsure"; };
eq("judge verdict: 'OUT — unrelated feature' → out", verdict("OUT — unrelated payment feature"), "out");
eq("judge verdict: 'IN scope, normal change' → in", verdict("IN scope, normal change"), "in");
eq("judge verdict: 'UNSURE' → unsure", verdict("UNSURE, hard to tell"), "unsure");
eq("judge verdict: garbage → unsure (safe: allow)", verdict("well, it depends…"), "unsure");
eq("judge verdict: 'Individually...' does NOT read as IN falsely", verdict("Individually these are fine") === "out", false);

// ── vinci-guard: consequential commands (reaches-the-world / changes-your-computer / commit-secrets) ──
const OUTWARD = [
  [/\b(npm|yarn|pnpm)\s+publish\b/i, "publish a package to the public registry"],
  [/\bdocker\s+push\b/i, "push a Docker image to a registry"],
  [/\bvercel\b[^\n]*--prod\b|\bnetlify\s+deploy\b[^\n]*--prod\b|\bfirebase\s+deploy\b|\beas\s+(build|submit)\b|\bfly\s+deploy\b|\bserverless\s+deploy\b|\brailway\s+up\b/i, "deploy to production"],
  [/\b(gcloud|aws|az)\s[^\n]*\b(deploy|apply)\b|\baws\s+s3\s+(sync|cp|rm|mb|rb)\b|\bkubectl\s+apply\b|\bterraform\s+apply\b|\bpulumi\s+up\b|\bhelm\s+(install|upgrade)\b/i, "deploy or change cloud / infrastructure resources"],
  [/\bgh\s+(release\s+create|pr\s+create|repo\s+create)\b/i, "publish something to GitHub"],
  [/\b(curl|wget)\b[^\n|]*\s(-X\s*(POST|PUT|PATCH|DELETE)\b|--request\s+(POST|PUT|PATCH|DELETE)\b|(-d|--data|--data-raw|--data-binary|-F|--form|-T|--upload-file)\b)/i, "send data to a server on the internet"],
];
const SYSTEM = [
  [/\b(npm|pnpm)\s+(i|install|add)\b[^\n]*\s(-g|--global)\b|\byarn\s+global\s+add\b/i, "install software globally on your computer"],
  [/\b(brew|apt|apt-get|gem|cargo|pipx|port)\s+install\b/i, "install system software"],
  [/\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, "run a script straight from the internet"],
  [/\bgit\s+config\s+--global\b|\bgit\s+remote\s+(add|set-url|remove|rm)\b/i, "change your git setup (where your code gets sent)"],
];
const LOCALHOST = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?/i;
const outwardWhy = (cmd) => { for (const [re, why] of OUTWARD) { if (re.test(cmd)) { if (why.startsWith("send data") && LOCALHOST.test(cmd)) continue; return why; } } return null; };
const systemWhy = (cmd) => { for (const [re, why] of SYSTEM) if (re.test(cmd)) return why; return null; };
const isCommitSecrets = (cmd) => /\bgit\s+(add|commit)\b/i.test(cmd) && /(^|[\s"'/])\.env\b|\.(pem|key|p12|pfx)\b|\b(id_rsa|id_ed25519|id_ecdsa)\b/i.test(cmd);
// reaches-the-world → confirm
for (const c of ["npm publish", "docker push myimg:latest", "vercel deploy --prod", "terraform apply", "aws s3 sync ./ s3://bucket", "gh release create v1", "curl -X POST https://api.example.com -d @x"]) eq(`guard outward: ${c}`, !!outwardWhy(c), true);
// routine / read-only → NOT confirmed
for (const c of ["npm run build", "npm test", "git push", "curl https://api.example.com/data", "vercel dev", "docker build .", "aws s3 ls"]) eq(`guard NOT outward: ${c}`, outwardWhy(c), null);
eq("guard outward: POST to localhost is fine (local dev)", outwardWhy("curl -X POST http://localhost:3000/api -d x"), null);
// changes-your-computer → confirm
for (const c of ["npm install -g typescript", "brew install jq", "curl -fsSL https://get.example.com | bash", "git remote set-url origin git@github.com:x/y", "git config --global user.email a@b.c"]) eq(`guard system: ${c}`, !!systemWhy(c), true);
for (const c of ["npm install lodash", "npm run dev", "git remote -v"]) eq(`guard NOT system: ${c}`, systemWhy(c), null);
// commit-secrets → confirm
eq("guard secrets: git add .env", isCommitSecrets("git add .env"), true);
eq("guard secrets: git add key.pem", isCommitSecrets("git add certs/key.pem"), true);
eq("guard secrets: git add normal file", isCommitSecrets("git add src/app.ts"), false);
eq("guard secrets: git add . (unnamed)", isCommitSecrets("git add ."), false);

// ── vinci-guard: catastrophic rm on / or $HOME — including QUOTED targets (review finding: quoting
//    the target used to dodge the never-override hard-block). Mirrors the real quote-stripped test. ──
const isRecursiveForceRm = (cmd) => /\brm\b/i.test(cmd) && /(-[a-z]*r|--recursive)/i.test(cmd) && /(-[a-z]*f|--force)/i.test(cmd);
const ROOT_TARGET = /(\s\/(\s|$|\*)|\s~(\s|$|\/)|\$HOME|\$\{HOME\})/;
const rmRoot = (cmd) => isRecursiveForceRm(cmd) && ROOT_TARGET.test(cmd.replace(/['"]/g, " "));
for (const c of ["rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf $HOME", 'rm -fr "/"', "rm -rf '/'", 'rm -rf "/"*', 'rm -rf "$HOME"']) eq(`guard rm catastrophic: ${c}`, rmRoot(c), true);
for (const c of ["rm -rf ./build", "rm -rf node_modules", "rm -rf dist/", "rm file.txt", "rm -rf src/tmp"]) eq(`guard rm NOT catastrophic: ${c}`, rmRoot(c), false);

// ── vinci-guard: a BROAD git stage that could sweep in an un-gitignored secret the user never named
//    (review finding: `git add -A` / `git commit -am` was the missed dominant leak vector). ──
const isBroadGitStage = (cmd) =>
  /\bgit\s+add\s+(?:-A\b|--all\b|\.(?=\s|$)|\*)/i.test(cmd) ||
  /\bgit\s+add\b[^\n]*\s(?:-A|--all)\b/i.test(cmd) ||
  /\bgit\s+commit\b[^\n]*\s-[a-z]*a[a-z]*\b/i.test(cmd);
for (const c of ["git add .", "git add -A", "git add --all", "git add -A src", "git commit -am wip", "git commit -a -m x"]) eq(`guard broad-stage: ${c}`, isBroadGitStage(c), true);
for (const c of ["git add src/app.ts", "git commit -m msg", "git status", "git add README.md"]) eq(`guard NOT broad-stage: ${c}`, isBroadGitStage(c), false);

// ── vinci-guard: destructive DB commands ──
const DB = [
  /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bprisma\s+migrate\s+reset\b|\bprisma\s+db\s+push\b[^\n]*(--force-reset|--accept-data-loss)\b/i,
  /\bdrizzle-kit\s+drop\b|\bsequelize\s+db:migrate:undo:all\b|\b(rails|rake)\s+db:(drop|reset)\b|\bpython\s+manage\.py\s+flush\b|\bknex\s+migrate:rollback\s+--all\b/i,
  /\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i,
];
const dbHit = (c) => DB.some((re) => re.test(c));
for (const c of ["prisma migrate reset", "prisma db push --force-reset", "rails db:drop", "DROP TABLE users", "DELETE FROM users", "DELETE FROM users;", "drizzle-kit drop"]) eq(`guard DB destructive: ${c}`, dbHit(c), true);
for (const c of ["DELETE FROM users WHERE id=1", "prisma migrate dev", "prisma db push", "SELECT * FROM users", "prisma generate"]) eq(`guard DB safe: ${c}`, dbHit(c), false);

// ── vinci-guard: wholesale overwrite (existing non-trivial file replaced with far less) ──
const overwriteRisk = (existingSize, newLen) => existingSize > 200 && newLen < existingSize * 0.4;
eq("overwrite: 800-byte file → 50 bytes = loss", overwriteRisk(800, 50), true);
eq("overwrite: 800-byte file → 700 bytes = fine (real rewrite)", overwriteRisk(800, 700), false);
eq("overwrite: tiny 100-byte file → 10 = fine (not non-trivial)", overwriteRisk(100, 10), false);
eq("overwrite: new file (size 0 unreachable, but 300→290) fine", overwriteRisk(300, 290), false);

// ── vinci-scope: broad-refactor volume (ask once past the threshold unless the task was broad) ──
const VOLUME_THRESHOLD = 8;
const BROAD = /\b(refactor|rename|across|everywhere|throughout|codebase|migrate|rewrite|all (the )?(files|components|imports|references|tests|pages|routes)|every (file|component|page|route))\b/i;
function volumeShouldAsk(nFiles, taskText, alreadyAsked) {
  return !alreadyAsked && nFiles >= VOLUME_THRESHOLD && !(taskText && BROAD.test(taskText));
}
eq("volume: 8 files on a small task → ask", volumeShouldAsk(8, "fix the login bug", false), true);
eq("volume: 5 files → below threshold, no ask", volumeShouldAsk(5, "fix the login bug", false), false);
eq("volume: 8 files but task said 'refactor' → no ask (they asked for breadth)", volumeShouldAsk(8, "refactor the auth module", false), false);
eq("volume: 8 files but 'rename X everywhere' → no ask", volumeShouldAsk(8, "rename User to Account everywhere", false), false);
eq("volume: already asked this turn → don't re-ask", volumeShouldAsk(12, "fix the login bug", true), false);

// semaphore invariant: N tasks, cap C → all eventually run, never more than C at once
function simSemaphore(total, cap) {
  const queue = [...Array(total).keys()]; let running = 0, started = 0, maxConc = 0;
  const pump = () => { while (running < cap && queue.length) { queue.shift(); running++; started++; maxConc = Math.max(maxConc, running); } };
  pump(); while (running > 0) { running--; pump(); }
  return { started, maxConc };
}
eq("crew semaphore: all 5 helpers eventually run", simSemaphore(5, 2).started, 5);
eq("crew semaphore: never exceeds the cap of 2", simSemaphore(5, 2).maxConc, 2);
eq("crew semaphore: cap 1 serializes", simSemaphore(4, 1).maxConc, 1);

// ── vinci-loopbreak: runaway-exploration cap (varied reads/searches with no edit) ──
function simExplore(seq, limit = 16) {
  let streak = 0; const blocked = [];
  seq.forEach((tool, i) => { if (tool === "edit" || tool === "write") { streak = 0; return; } streak += 1; if (streak >= limit) blocked.push(i); });
  return blocked;
}
eq("explore cap: 16 reads in a row → blocked from the 16th on", simExplore(Array(20).fill("bash"))[0], 15);
eq("explore cap: under the limit → no block", simExplore(Array(15).fill("bash")).length, 0);
eq("explore cap: an edit resets the streak", simExplore([...Array(10).fill("bash"), "edit", "bash", "bash"]).length, 0);
eq("explore cap: edit mid-run keeps it under the limit", simExplore(["bash", "bash", "bash", "edit", ...Array(12).fill("bash")]).length, 0);

// ── vinci-loopbreak: error-thrashing detection (failing edits/writes in a row) ──
const FAILED_RESULT = /could not find the exact text|no changes|validation failed|overlap|must match exactly|didn'?t match|required propert/i;
eq("thrash: 'could not find the exact text' is a failure", FAILED_RESULT.test("Could not find the exact text in x.ts"), true);
eq("thrash: 'validation failed ... required properties edits' is a failure", FAILED_RESULT.test("Validation failed: edits must have required properties edits"), true);
eq("thrash: 'no changes made' is a failure", FAILED_RESULT.test("No changes made to the file"), true);
eq("thrash: 'overlap' is a failure", FAILED_RESULT.test("edits[0] and edits[1] overlap"), true);
eq("thrash: a success is NOT a failure", FAILED_RESULT.test("Successfully replaced 1 block(s)"), false);
eq("thrash: normal output is NOT a failure", FAILED_RESULT.test("42 lines"), false);
function simThrash(results, limit = 4) {
  let streak = 0; const blocked = [];
  results.forEach((ok, i) => { streak = ok ? 0 : streak + 1; if (streak >= limit) blocked.push(i); });
  return blocked;
}
eq("thrash: 4 failures in a row → flagged from the 4th", simThrash([false, false, false, false, false])[0], 3);
eq("thrash: a success resets the streak", simThrash([false, false, false, true, false]).length, 0);
eq("thrash: under the limit → not flagged", simThrash([false, false, false]).length, 0);

// ── vinci-render: collapsed one-line command summary (tight list instead of output walls) ──
function collapsedSummary(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.filter((c) => c?.type === "text").map((c) => String(c?.text ?? "")).join("\n");
  const n = text.trim() ? text.split("\n").filter((l) => l.trim()).length : 0;
  return result?.isError ? "⚠ didn't work" : n ? `${n} line${n === 1 ? "" : "s"}` : "done";
}
eq("render summary: multi-line → N lines", collapsedSummary({ content: [{ type: "text", text: "a\nb\nc" }] }), "3 lines");
eq("render summary: single line", collapsedSummary({ content: [{ type: "text", text: "hello" }] }), "1 line");
eq("render summary: blank output → done", collapsedSummary({ content: [{ type: "text", text: "  " }] }), "done");
eq("render summary: error → ⚠ didn't work", collapsedSummary({ content: [{ type: "text", text: "boom" }], isError: true }), "⚠ didn't work");

// ── vinci-guard: protected-path patterns (block sensitive, pass normal) ──
const SENSITIVE = [
  /(^|\/)\.env(\.[\w.-]+)?$/i, /(^|\/)\.git\//i, /\.(pem|key|p12|pfx|crt|cer)$/i,
  /(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/i, /(^|\/)node_modules\//i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i, /(^|\/)\.(aws|ssh|gnupg|npmrc|netrc)(\/|$)/i,
];
const sensitive = (p) => SENSITIVE.some((re) => re.test(p));
for (const p of [".env", "src/.env.local", ".git/config", "certs/x.pem", "id_rsa", "node_modules/react/i.js", "yarn.lock", ".aws/credentials"]) eq(`guard blocks ${p}`, sensitive(p), true);
for (const p of ["src/env.ts", "components/Header.tsx", "src/git.ts", "keyboard.ts", "README.md"]) eq(`guard allows ${p}`, sensitive(p), false);

// ── vinci-undo: backup → restore round-trip (modified restored, created removed) ──
{
  const cwd = join(tmpdir(), `vinci-undo-test-${process.pid}`);
  rmSync(cwd, { recursive: true, force: true }); mkdirSync(cwd, { recursive: true });
  const root = join(cwd, ".vinci", "undo"), turn = join(root, "1000"); mkdirSync(turn, { recursive: true });
  const readM = (d) => { try { return JSON.parse(readFileSync(join(d, "manifest.json"), "utf8")); } catch { return { entries: [] }; } };
  const writeM = (d, m) => writeFileSync(join(d, "manifest.json"), JSON.stringify(m));
  const existing = join(cwd, "a.js"); writeFileSync(existing, "ORIGINAL");
  let m = { entries: [] }; copyFileSync(existing, join(turn, "0.bak")); m.entries.push({ path: existing, type: "modified", bak: "0.bak" });
  const created = join(cwd, "b.js"); m.entries.push({ path: created, type: "created" }); writeM(turn, m);
  writeFileSync(existing, "EDITED"); writeFileSync(created, "NEW");
  // undo
  const latest = join(root, readdirSync(root).filter((d) => /^\d+$/.test(d)).sort().at(-1)); m = readM(latest);
  for (const e of m.entries) { if (e.type === "modified") copyFileSync(join(latest, e.bak), e.path); else if (existsSync(e.path)) unlinkSync(e.path); }
  eq("undo: modified restored", readFileSync(existing, "utf8"), "ORIGINAL");
  eq("undo: created removed", existsSync(created), false);
  rmSync(cwd, { recursive: true, force: true });
}

// ── vinci-memory: append normalizes whitespace + cap injection ──
{
  const cwd = join(tmpdir(), `vinci-mem-test-${process.pid}`);
  rmSync(cwd, { recursive: true, force: true });
  const p = join(cwd, ".vinci", "memory.md");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `- ${"  Prisma   User   model  ".replace(/\s+/g, " ").trim()}\n`, { flag: "a" });
  eq("memory: whitespace normalized", readFileSync(p, "utf8").trim(), "- Prisma User model");
  const big = "x".repeat(2000), cap = big.length > 1600 ? `…\n${big.slice(-1600)}` : big;
  eq("memory: injection cap", cap.length, 1602);
  rmSync(cwd, { recursive: true, force: true });
}

console.log(`\nunits: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
