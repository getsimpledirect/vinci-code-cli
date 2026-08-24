/**
 * Vinci undo — a safety net for people who can't use git. Before Vinci's write/edit tools touch a
 * file, we snapshot that file's current contents to `<project>/.vinci/undo/<turn>/`. `/undo` then
 * restores the most recent turn's changes: modified files are put back, files Vinci newly created
 * are removed (and directories that became empty are cleared). This is deliberately FILE-BACKUP
 * based, not git plumbing — it can never touch or corrupt the project's real git state.
 *
 *   • automatic → each write/edit is backed up (grouped per user turn), capped to the last 10 turns
 *   • /undo     → revert the last turn's file changes, in plain language
 *
 * Honesty rules (round-2 session-lifecycle audit P2-5/6/7): the /undo report never overclaims.
 * Shell-command mutations are invisible to the snapshotter, so a turn that ran a mutating bash
 * command carries that caveat into its report; files that could not be put back are named; a fully
 * failed restore never reads as "Nothing to change back". After a successful restore the shared
 * verification state goes stale (the reverted tree needs a fresh check) and checkpoint recovery
 * records for the restored paths are dropped.
 *
 * Additive — no core edits. Local only. Scoped to the project dir (never snapshots files elsewhere).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { persistVinciVerificationState } from "./lib/control.ts";
import { recordVinciMutation, vinciCheckWarrantedPath } from "./lib/verification-state.ts";

// A restored file that no longer parses is a sign the backup captured a mid-edit / interrupted state, so
// /undo faithfully put back BROKEN content — and must NOT report a clean "✓ restored" for it (breaker
// P0: /undo said "✓ Undone — restored config.js" while the file was invalid JS). We only judge formats
// with an unambiguous check — JSON here, and JS/CJS/MJS via `node --check` (which respects the project's
// module type). Everything else returns false: never call a file broken unless we're sure, or a clean
// undo would cry wolf.
function restoredFileLooksBroken(absPath: string): boolean {
  const ext = extname(absPath).toLowerCase();
  // Read failures (missing/unreadable) are NOT a validity signal — stay silent so a clean undo never
  // cries wolf. Only a successful read that then fails a definitive validity check counts as broken.
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return false;
  }
  if (ext === ".json") {
    // A JSON.parse throw IS the brokenness signal (invalid JSON) — flag it. (The earlier version caught
    // this throw and returned false, so a corrupt .json restore was never flagged — the JSON P0.)
    try {
      JSON.parse(content);
      return false;
    } catch {
      return true;
    }
  }
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    try {
      const check = spawnSync(process.execPath, ["--check", absPath], { encoding: "utf8", timeout: 5000 });
      // A non-zero NUMBER is a real syntax error; null means the check didn't run cleanly (timeout/signal)
      // — in that case stay silent rather than risk a false alarm.
      return check.status !== null && check.status !== 0;
    } catch {
      return false;
    }
  }
  return false;
}
import { clearVinciCheckpointRecordsForPaths } from "./vinci-checkpoint.ts";

const KEEP_TURNS = 10;
const undoRoot = (cwd: string) => join(cwd, ".vinci", "undo");

type ManifestEntry = { path: string; type: "modified" | "created"; bak?: string };
type Manifest = { entries: ManifestEntry[]; bashMutation?: boolean };

// Per-turn state (session-scoped): the current turn's backup dir + which paths we've already backed up.
let turnDir: string | null = null;
let backedUp = new Set<string>();

function readManifest(dir: string): Manifest {
  try {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return { entries: [] };
  }
}

function writeManifest(dir: string, m: Manifest): void {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m), "utf8");
}

/** Drop old checkpoint dirs beyond KEEP_TURNS so backups don't grow without bound. */
function prune(root: string): void {
  try {
    const dirs = readdirSync(root).filter((d) => /^\d+$/.test(d)).sort();
    for (const d of dirs.slice(0, Math.max(0, dirs.length - KEEP_TURNS))) {
      rmSync(join(root, d), { recursive: true, force: true });
    }
  } catch {
    /* best-effort */
  }
}

/** Lazily create this turn's backup dir on the first tracked mutation. */
function ensureTurnDir(cwd: string): string {
  if (turnDir) return turnDir;
  const root = undoRoot(cwd);
  // Timestamp keeps dirs sortable + unique; bump past collisions (two turns can share a millisecond).
  let stamp = Date.now();
  while (existsSync(join(root, String(stamp)))) stamp += 1;
  turnDir = join(root, String(stamp));
  mkdirSync(turnDir, { recursive: true });
  // Never let the backups land in the user's git (wx = create only if absent).
  try {
    writeFileSync(join(root, ".gitignore"), "*\n", { flag: "wx" });
  } catch {
    /* already exists */
  }
  writeManifest(turnDir, { entries: [] });
  prune(root);
  return turnDir;
}

/** Git subcommands that only inspect state. Anything else (checkout, add, commit, …) mutates. */
const GIT_READ_ONLY = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "shortlog",
  "describe",
  "rev-parse",
  "ls-files",
  "grep",
]);

/** Leading commands that never change files. Unknown commands count as mutating (over-warning is safe). */
const READ_ONLY_BASH = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "rg",
  "egrep",
  "fgrep",
  "wc",
  "pwd",
  "whoami",
  "which",
  "type",
  "file",
  "stat",
  "du",
  "df",
  "env",
  "printenv",
  "echo",
  "printf",
  "date",
  "uname",
  "tree",
  "diff",
  "sort",
  "uniq",
  "cut",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "jq",
  "cd",
  "true",
  "test",
]);

const BASH_WRAPPERS = new Set(["env", "sudo", "nice", "time", "xargs"]);
const WRAPPER_OPTIONS_WITH_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"]),
  sudo: new Set(["-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host", "-p", "--prompt", "-R", "--chroot", "-r", "--role", "-t", "--type", "-T", "--command-timeout", "-u", "--user"]),
  nice: new Set(["-n", "--adjustment"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
  xargs: new Set(["-a", "--arg-file", "-d", "--delimiter", "-E", "--eof", "-I", "--replace", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"]),
};

function wrappedCommand(words: readonly string[]): string[] | undefined {
  const wrapper = words[0]?.replace(/^.*\//, "");
  if (!wrapper || !BASH_WRAPPERS.has(wrapper)) return undefined;
  const optionsWithValues = WRAPPER_OPTIONS_WITH_VALUES[wrapper];
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (wrapper === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (word === "--") return words.slice(index + 1);
    if (optionsWithValues.has(word)) {
      index++;
      continue;
    }
    if (word.startsWith("-")) continue;
    return words.slice(index);
  }
  return [];
}

function bashWordsLookMutating(words: string[], segment: string): boolean {
  if (!words.length) return false;
  const cmd = words[0].replace(/^.*\//, "");
  const nested = wrappedCommand(words);
  if (nested) {
    if (bashWordsLookMutating(nested, nested.join(" "))) return true;
    // env without a nested mutation was already classified read-only. The other wrappers were
    // conservatively mutating before wrapper recursion and must not be loosened by this hardening.
    return cmd !== "env";
  }
  if (cmd === "git") return !GIT_READ_ONLY.has(words[1] ?? "");
  if (cmd === "sed" || cmd === "awk") {
    return /(^|\s)(-i\S*|--in-place)/.test(segment);
  }
  if (cmd === "find") return /-delete|-exec/.test(segment);
  return !READ_ONLY_BASH.has(cmd);
}

/**
 * Conservative "could this shell command have changed files?" classifier. Used ONLY to decide
 * whether the /undo report must admit that shell-made changes were not rolled back (snapshots
 * exist for write/edit tools alone — bash mutations are invisible to the restorer, audit P2-5).
 * False positives merely over-warn; false negatives would let /undo overclaim, so unknown
 * commands count as mutating.
 */
export function bashLooksMutating(command: string): boolean {
  const text = command.trim();
  if (!text) return false;
  if (/\$\(|`/.test(text)) return true;
  // Output redirection writes files — except into /dev/null (also scrub fd dups like 2>&1).
  const scrubbed = text.replace(/[&\d]?>{1,2}\s*\/dev\/null/g, " ").replace(/\d?>&\d/g, " ");
  if (scrubbed.includes(">")) return true;
  if (/\btee\b/.test(scrubbed)) return true;
  for (const segment of scrubbed.split(/&&|\|\||;|\|/)) {
    const words = segment
      .trim()
      .split(/\s+/)
      .filter((word) => word && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)); // skip env-var prefixes
    if (!words.length) continue;
    if (bashWordsLookMutating(words, segment)) return true;
  }
  return false;
}

/**
 * Best-effort cosmetic cleanup: removing an undone created file can leave behind empty directories
 * the turn introduced for it — clear them upward, never past (or including) the project root.
 */
function removeEmptyParents(filePath: string, cwd: string): void {
  try {
    let dir = dirname(filePath);
    while (dir.startsWith(cwd + "/") && dir !== cwd) {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
      dir = dirname(dir);
    }
  } catch {
    /* best-effort */
  }
}

export default function (pi: ExtensionAPI) {
  // New user turn → start a fresh (lazy) checkpoint.
  pi.on("turn_start", async () => {
    turnDir = null;
    backedUp = new Set<string>();
  });

  // Before a write/edit runs, snapshot the target file (once per turn). Mutating bash commands
  // can't be snapshotted, but they ARE remembered so /undo never claims to have rolled them back.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown } | undefined)?.command ?? "");
      if (!bashLooksMutating(command)) return undefined;
      try {
        const dir = ensureTurnDir(ctx.cwd);
        const m = readManifest(dir);
        if (!m.bashMutation) {
          m.bashMutation = true;
          writeManifest(dir, m);
        }
      } catch {
        /* best-effort — never block the command over an undo hiccup */
      }
      return undefined;
    }
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    const input = event.input as { path?: unknown; file_path?: unknown };
    const raw = String(input.path ?? input.file_path ?? "");
    if (!raw.trim()) return undefined;

    const cwd = ctx.cwd;
    const abs = resolve(cwd, raw);
    if (!abs.startsWith(cwd + "/") && abs !== cwd) return undefined; // project files only
    if (backedUp.has(abs)) return undefined;
    backedUp.add(abs);

    try {
      const dir = ensureTurnDir(cwd);
      const m = readManifest(dir);
      if (existsSync(abs)) {
        const bak = `${m.entries.length}.bak`;
        copyFileSync(abs, join(dir, bak)); // copyFileSync handles binary too
        m.entries.push({ path: abs, type: "modified", bak });
      } else {
        m.entries.push({ path: abs, type: "created" });
      }
      writeManifest(dir, m);
    } catch {
      /* backup is best-effort — never block the edit over an undo hiccup */
    }
    return undefined;
  });

  // /undo → revert the most recent turn's file changes.
  pi.registerCommand("undo", {
    description: "Undo the last changes Vinci made to your files",
    handler: async (_args, ctx: ExtensionContext) => {
      const root = undoRoot(ctx.cwd);
      let dirs: string[] = [];
      try {
        dirs = readdirSync(root).filter((d) => /^\d+$/.test(d)).sort();
      } catch {
        /* no undo dir yet */
      }
      if (!dirs.length) return void ctx.ui.notify("Nothing to undo — Vinci hasn't changed any files yet.", "info");

      const latest = join(root, dirs[dirs.length - 1]);
      const m = readManifest(latest);
      const restored: string[] = [];
      const restoredButBroken: string[] = [];
      const removed: string[] = [];
      const failed: string[] = [];
      const revertedPaths: string[] = [];
      for (const e of m.entries) {
        try {
          if (e.type === "modified" && e.bak) {
            copyFileSync(join(latest, e.bak), e.path);
            restored.push(basename(e.path));
            if (restoredFileLooksBroken(e.path)) restoredButBroken.push(basename(e.path));
            revertedPaths.push(e.path);
          } else if (e.type === "created" && existsSync(e.path)) {
            unlinkSync(e.path);
            removed.push(basename(e.path));
            revertedPaths.push(e.path);
            removeEmptyParents(e.path, ctx.cwd);
          }
        } catch {
          // A file we couldn't put back is NAMED in the report, never silently skipped (audit P2-5).
          failed.push(basename(e.path));
        }
      }
      rmSync(latest, { recursive: true, force: true });
      // The active turn's snapshot dir was consumed — reset BOTH pieces of turn state. Leaving
      // backedUp populated made post-undo edits skip snapshotting, so the NEXT /undo restored the
      // PREVIOUS turn while claiming success (audit P2-6).
      if (turnDir === latest) {
        turnDir = null;
        backedUp = new Set<string>();
      }

      if (revertedPaths.length) {
        // The reverted tree invalidates earlier claims about it (audit P2-7): a 'passed'
        // verification no longer describes what's on disk, and checkpoint recovery records must
        // not keep blocking retries of (or advertising) mutations that were just rolled back.
        try {
          // The warranted-fact follows what was actually reverted (#187): rolling back source is
          // check-worthy; rolling back only docs is not, and must not make a doc-only session
          // claim a check was warranted.
          recordVinciMutation("", revertedPaths.some((path) => vinciCheckWarrantedPath(path)));
          // Durably record the now-stale state to the session branch — otherwise a hard kill before the
          // next event lets resume restore the pre-undo "passed" and re-bless the reverted tree.
          persistVinciVerificationState();
        } catch {
          /* best-effort */
        }
        try {
          clearVinciCheckpointRecordsForPaths(revertedPaths);
        } catch {
          /* best-effort */
        }
      }

      const list = (names: string[]) => `${names.slice(0, 4).join(", ")}${names.length > 4 ? ` +${names.length - 4}` : ""}`;
      const parts: string[] = [];
      if (restored.length) parts.push(`restored ${list(restored)}`);
      if (removed.length) parts.push(`removed ${list(removed)}`);
      // [vinci #155] The completion receipt is a persistent widget above the editor; after an undo
      // it kept advertising the now-rolled-back change as the latest work. On a FULLY CLEAN restore,
      // replace it with an undone-state receipt naming exactly what was put back. Partial restores
      // (failures, broken files, shell-only mutations) keep the old receipt + the caveated warning —
      // this widget must never overclaim (honesty rules P2-5/6/7).
      const cleanRestore =
        (restored.length > 0 || removed.length > 0) &&
        failed.length === 0 &&
        restoredButBroken.length === 0 &&
        !m.bashMutation;
      if (cleanRestore && ctx.hasUI) {
        const undoneNames = [...restored, ...removed];
        const stepBack = dirs.length > 1 ? "  ·  say /undo again to step back further" : "";
        ctx.ui.setWidget(
          "vinci-receipt",
          [
            `↺ Undone  ·  ${undoneNames.length} file${undoneNames.length === 1 ? "" : "s"} put back`,
            `${list(undoneNames)}  ·  that change is no longer in your files${stepBack}`,
          ],
          { placement: "aboveEditor" },
        );
      }
      const caveats: string[] = [];
      if (failed.length) caveats.push(`couldn't restore ${list(failed)} — check ${failed.length === 1 ? "it" : "them"} by hand`);
      if (restoredButBroken.length)
        caveats.push(
          `${list(restoredButBroken)} came back looking broken or incomplete — the change before it may have ` +
            `been interrupted, so open ${restoredButBroken.length === 1 ? "it" : "them"} and check`,
        );
      if (m.bashMutation) caveats.push("changes made through shell commands weren't rolled back");
      if (parts.length) {
        const caveatText = caveats.length ? ` Careful: ${caveats.join("; ")}.` : "";
        ctx.ui.notify(
          `✓ Undone — ${parts.join("; ")}.${caveatText} Say /undo again to step back further.`,
          caveats.length ? "warning" : "info",
        );
      } else if (caveats.length) {
        // A fully failed (or shell-only) turn must never read as "nothing happened" (audit P2-5).
        ctx.ui.notify(`Undo couldn't finish — ${caveats.join("; ")}.`, "warning");
      } else {
        ctx.ui.notify("Nothing to change back.", "info");
      }
    },
  });
}
