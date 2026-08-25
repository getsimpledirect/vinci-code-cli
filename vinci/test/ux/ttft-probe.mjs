#!/usr/bin/env node
/**
 * TTFT / felt-snappiness probe for Vinci Code.
 *
 * Runs the REAL `vinci` CLI in print mode against the real Vinci Forte provider and measures what a
 * user actually FEELS — not total task time (the benchmark already has that), but:
 *   • TTFT   — time from launch to the FIRST byte of streamed output ("how long until it starts talking")
 *   • total  — time to completion
 *   • cadence — inter-chunk gaps, so we can see whether the stream is smooth or bursty
 *
 * This is a manual UX tool, NOT part of the offline harness or CI: it hits the provider and needs your
 * key. Keep the prompt tool-free so the number isolates first-token latency (the provider round-trip),
 * not a multi-tool task.
 *
 * Usage (from the repo root, with your key exported):
 *   VINCI_API_KEY=vinci_live_… node vinci/test/ux/ttft-probe.mjs
 *   VINCI_API_KEY=vinci_live_… node vinci/test/ux/ttft-probe.mjs --runs 5 --prompt "fix the failing test"
 *
 * Flags: --runs N (default 5) · --prompt "…" · --cwd DIR (default cwd) · --out DIR (timelines)
 *
 * Interpreting it: TTFT is dominated by the provider round-trip (gateway → DeepInfra → first token),
 * so it's the cleanest read on the #23 serving dependency's felt cost. If TTFT ≈ total on every run,
 * print mode is buffering rather than streaming and the probe says so — then first-token has to be read
 * from provider SSE timing instead.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const VINCI = resolve(ROOT, "vinci/bin/vinci");

const flag = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
};
const RUNS = Math.max(1, Number(flag("--runs", "5")));
// Default prompt is deliberately tool-free so the number is first-TOKEN latency, not a multi-tool task.
const PROMPT = flag("--prompt", "Without using any tools, reply with one short friendly sentence.");
const CWD = resolve(flag("--cwd", process.cwd()));
const OUT = resolve(flag("--out", resolve(here, ".ttft-runs")));

if (!process.env.VINCI_API_KEY) {
  console.error("VINCI_API_KEY is not set. Export your Vinci key (vinci_live_…) and re-run — this probe");
  console.error("hits the real provider, so it needs your credential (never commit it).");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

function probeOnce(i) {
  return new Promise((res) => {
    const env = {
      ...process.env,
      VINCI_CODE: "1",
      VINCI_PROVIDER: "vinci",
      VINCI_MODEL: "forte",
      VINCI_NO_RESUME: "1",
      NO_COLOR: "1",
    };
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const child = spawn(VINCI, ["-p", PROMPT], { cwd: CWD, env });
    let ttft = null;
    let bytes = 0;
    let chunks = 0;
    let lastAt = 0;
    let maxGap = 0;
    const timeline = [];
    child.stdout.on("data", (d) => {
      const at = ms();
      if (ttft === null) ttft = at;
      else maxGap = Math.max(maxGap, at - lastAt);
      lastAt = at;
      bytes += d.length;
      chunks++;
      timeline.push({ at: Number(at.toFixed(1)), bytes: d.length });
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (e) => res({ ttft: null, total: ms(), bytes, chunks, code: -1, stderr: String(e), maxGap }));
    child.on("close", (code) => {
      const total = ms();
      writeFileSync(
        resolve(OUT, `run-${i}.json`),
        JSON.stringify({ prompt: PROMPT, cwd: CWD, ttftMs: ttft, totalMs: total, bytes, chunks, maxGapMs: maxGap, code, timeline }, null, 2),
      );
      res({ ttft, total, bytes, chunks, code, stderr, maxGap });
    });
  });
}

const results = [];
for (let i = 1; i <= RUNS; i++) {
  process.stdout.write(`run ${i}/${RUNS}… `);
  const r = await probeOnce(i);
  results.push(r);
  if (r.ttft === null) {
    console.log(`no output (exit ${r.code})${r.stderr ? ` — ${r.stderr.slice(0, 140).replace(/\s+/g, " ")}` : ""}`);
  } else {
    console.log(`TTFT ${r.ttft.toFixed(0)}ms · total ${(r.total / 1000).toFixed(1)}s · ${r.chunks} chunks · ${r.bytes}b`);
  }
}

const ok = results.filter((r) => r.ttft !== null);
if (!ok.length) {
  console.error("\nNo successful runs — check VINCI_API_KEY and provider reachability.");
  process.exit(1);
}
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const ttfts = ok.map((r) => r.ttft);
const totals = ok.map((r) => r.total);
console.log(`\n── felt snappiness (n=${ok.length}/${RUNS}) ──`);
console.log(`TTFT   median ${med(ttfts).toFixed(0)}ms   (min ${Math.min(...ttfts).toFixed(0)} · max ${Math.max(...ttfts).toFixed(0)})`);
console.log(`total  median ${(med(totals) / 1000).toFixed(1)}s`);
console.log(`stream max inter-chunk gap: median ${med(ok.map((r) => r.maxGap)).toFixed(0)}ms (a big gap = a visible stall mid-answer)`);
if (ok.every((r) => r.total - r.ttft < Math.max(50, r.total * 0.1))) {
  console.log("\n⚠ TTFT ≈ total on every run — print mode is BUFFERING, not streaming. This number reflects");
  console.log("  total latency, not true first-token. Measure provider SSE first-token directly instead.");
}
console.log(`\nper-run timelines: ${OUT}/run-*.json`);
