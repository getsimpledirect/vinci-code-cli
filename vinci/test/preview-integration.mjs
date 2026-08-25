// Integration check: the REAL vinci-preview findViewable — decides what /preview opens (a static site,
// a dev-server app, or nothing) so a non-programmer can actually SEE what Vinci built.
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { findViewable, URL_RE } = await import(resolve(here, "../extensions/vinci-preview.ts"));
assert.equal(typeof findViewable, "function", "vinci-preview must export findViewable");

const root = join(tmpdir(), `vinci-preview-it-${process.pid}`);
const mk = (name, files) => {
  const d = join(root, name);
  for (const [f, c] of Object.entries(files)) {
    const p = join(d, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c);
  }
  return d;
};

let pass = 0;
const check = (name, cond) => { assert.ok(cond, name); console.log(`  ✓ ${name}`); pass++; };

try {
  // Static site → static kind, points at the html.
  const staticDir = mk("static", { "index.html": "<h1>hi</h1>" });
  const s = findViewable(staticDir);
  check("plain index.html → static", s?.kind === "static" && s.path.endsWith("index.html"));

  // Static build output (dist/index.html).
  const distDir = mk("dist", { "dist/index.html": "<h1>built</h1>" });
  check("dist/index.html → static", findViewable(distDir)?.kind === "static");

  // A dev script → dev kind, with the right command (dev beats a stale static file).
  const viteDir = mk("vite", {
    "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    "index.html": "<h1>app</h1>",
  });
  const v = findViewable(viteDir);
  check("package.json dev script → dev (beats static index.html)", v?.kind === "dev");
  check("npm is the default runner", v?.kind === "dev" && v.command === "npm" && v.args.join(" ") === "run dev");

  // Package manager picked from the lockfile.
  const pnpmDir = mk("pnpm", {
    "package.json": JSON.stringify({ scripts: { dev: "next dev" } }),
    "pnpm-lock.yaml": "",
  });
  const p = findViewable(pnpmDir);
  check("pnpm-lock.yaml → pnpm runner", p?.kind === "dev" && p.command === "pnpm" && p.args.join(" ") === "dev");

  // `start` script when there's no `dev`.
  const startDir = mk("start", { "package.json": JSON.stringify({ scripts: { start: "serve" } }) });
  check("start script (no dev) → dev kind", findViewable(startDir)?.kind === "dev");

  // Nothing viewable.
  const emptyDir = mk("empty", { "README.md": "# notes" });
  check("no html + no dev/start script → null", findViewable(emptyDir) === null);

  // Malformed package.json doesn't throw; falls back to static if present.
  const badDir = mk("bad", { "package.json": "{ not json", "index.html": "<h1>x</h1>" });
  check("malformed package.json → falls back to static, no throw", findViewable(badDir)?.kind === "static");

  // review finding: the URL scraped from dev-server output must not carry shell metacharacters into
  // the Windows `cmd /c start <url>` opener. A normal URL is captured whole; an injection is truncated.
  check("clean dev URL captured whole", URL_RE.exec("VITE ready http://localhost:5173/app")?.[1] === "http://localhost:5173/app");
  const inj = URL_RE.exec("Local: http://localhost:3000/x&calc.exe")?.[1];
  check("injection payload is truncated at '&' (no shell metachars)", inj === "http://localhost:3000/x");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\npreview-integration: ${pass}/${pass} checks passed (real findViewable)`);
