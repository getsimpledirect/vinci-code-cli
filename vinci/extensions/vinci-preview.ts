/**
 * Vinci `/preview` — close the loop for a non-programmer: after Vinci builds something, this OPENS it
 * so they can actually see it. For a static site it opens the HTML file; for an app with a dev server
 * it starts the server in the background, waits for the local URL, and opens the browser. No more
 * "I built you a website" → "…where is it?".
 *
 * Additive: a slash command + a small character nudge so Vinci mentions it after building a viewable
 * project. No core patch.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Viewable =
  | { kind: "static"; path: string }
  | { kind: "dev"; command: string; args: string[] }
  | null;

// Common static entry points, in order of preference.
const STATIC_ENTRIES = ["index.html", "dist/index.html", "build/index.html", "out/index.html", "public/index.html"];

export function findViewable(cwd: string): Viewable {
  // 1. A dev/start script (a running app beats a stale build).
  try {
    const pkgPath = join(cwd, "package.json");
    if (existsSync(pkgPath)) {
      const scripts = (JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}) as Record<string, string>;
      const script = scripts.dev ? "dev" : scripts.start ? "start" : undefined;
      if (script) {
        // Pick the package manager from the lockfile.
        const pm = existsSync(join(cwd, "pnpm-lock.yaml"))
          ? "pnpm"
          : existsSync(join(cwd, "yarn.lock"))
            ? "yarn"
            : existsSync(join(cwd, "bun.lockb"))
              ? "bun"
              : "npm";
        return { kind: "dev", command: pm, args: pm === "npm" ? ["run", script] : [script] };
      }
    }
  } catch {
    /* unreadable package.json → fall through to static */
  }
  // 2. A static HTML entry.
  for (const rel of STATIC_ENTRIES) {
    if (existsSync(join(cwd, rel))) return { kind: "static", path: join(cwd, rel) };
  }
  return null;
}

/** The OS "open this in the default app / browser" command. */
function opener(): { cmd: string; pre: string[] } {
  if (process.platform === "darwin") return { cmd: "open", pre: [] };
  if (process.platform === "win32") return { cmd: "cmd", pre: ["/c", "start", ""] };
  return { cmd: "xdg-open", pre: [] };
}

function openTarget(target: string): void {
  const { cmd, pre } = opener();
  try {
    spawn(cmd, [...pre, target], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* best-effort */
  }
}

// Scrape the local URL from dev-server output. The charset excludes shell metacharacters (& | < > ^ $
// ` " ') so a hostile dev script printing e.g. `http://localhost:3000/x&calc.exe` can't smuggle a
// command through the Windows `cmd /c start <url>` opener — only a clean localhost URL is ever captured.
export const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s)"'&|<>^$`]*)/i;

// The dev server this session started, if any — tracked so we don't spawn a second one on a repeat
// /preview and so we can stop it when the session ends (see session_shutdown below).
let devServer: ChildProcess | undefined;

// Start the dev server, watch its output for the local URL (up to ~timeoutMs), open the browser, and
// leave it running (tied to this session) so the user can view.
function startDevAndOpen(ctx: ExtensionContext, v: { command: string; args: string[] }, timeoutMs = 12000): void {
  if (devServer && devServer.exitCode === null && !devServer.killed) {
    ctx.ui.notify("Your app is already running from a previous /preview — reopen its tab, or /quit to stop it.", "info");
    return;
  }
  let child: ChildProcess;
  try {
    // NOT detached: the server stays in Vinci's process group so it's tied to this session — it stops
    // when Vinci exits (session_shutdown kills it; a terminal close SIGHUPs the group) rather than
    // orphaning. unref() so it still doesn't block Vinci's own exit.
    child = spawn(v.command, v.args, { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    ctx.ui.notify(`Couldn't start the dev server (${v.command} ${v.args.join(" ")}). Try running it yourself.`, "warning");
    return;
  }
  devServer = child;
  let lastErr = "";
  child.on("exit", () => {
    if (devServer === child) devServer = undefined;
  });
  // Capture the tail of stderr so a failed start can say WHY, instead of sending the user to a dead
  // link (round-2 audit P1: the fallback used to open localhost:3000 and claim "Opened" even after the
  // dev server crashed or bound another port). This only reads stderr; it never opens anything.
  child.stderr?.on("data", (buf: Buffer) => {
    const line = buf.toString().split("\n").map((l) => l.trim()).filter(Boolean).pop();
    if (line) lastErr = line;
  });
  ctx.ui.notify("Starting your app…", "info");
  let opened = false;
  const onData = (buf: Buffer) => {
    if (opened) return;
    const m = URL_RE.exec(buf.toString());
    if (m) {
      opened = true;
      const url = m[1].replace(/0\.0\.0\.0/, "localhost");
      openTarget(url);
      ctx.ui.notify(`↗ Opened your app at ${url} (it runs while Vinci is open; it stops when you /quit).`, "info");
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData); // some servers print the URL to stderr
  child.unref(); // survive as a background process
  setTimeout(() => {
    if (opened) return;
    child.stdout?.off("data", onData);
    child.stderr?.off("data", onData);
    if (child.exitCode !== null || child.killed) {
      // The server died before printing an address — never send the user to a link that won't load.
      const why = lastErr ? ` (${lastErr.slice(0, 200)})` : "";
      ctx.ui.notify(
        `Your app stopped while starting${why}. Try running it yourself — ${v.command} ${v.args.join(" ")} — to see the full error.`,
        "warning",
      );
      return;
    }
    // Still running but no address seen yet. Open the most common dev port as a convenience, but do
    // NOT assert it's the app — we couldn't confirm where it's actually listening.
    openTarget("http://localhost:3000");
    ctx.ui.notify(
      "I opened http://localhost:3000, the most common address — if your app didn't appear there, it's " +
        "still starting or uses a different address (check the terminal it prints).",
      "info",
    );
  }, timeoutMs);
}

export default function (pi: ExtensionAPI) {
  // Stop the dev server this session started, so it doesn't outlive Vinci as an orphan process.
  pi.on("session_shutdown", async () => {
    if (devServer && devServer.exitCode === null && !devServer.killed) {
      try {
        devServer.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
    }
    devServer = undefined;
  });

  pi.registerCommand("preview", {
    description: "Open what Vinci built — your website or app — in the browser",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const v = findViewable(ctx.cwd);
      if (!v) {
        ctx.ui.notify("Nothing to preview here yet — ask Vinci to build a site or app first.", "info");
        return;
      }
      if (v.kind === "static") {
        openTarget(v.path);
        ctx.ui.notify(`↗ Opened ${v.path.split("/").pop()} in your browser.`, "info");
        return;
      }
      startDevAndOpen(ctx, v);
    },
  });
}
