/**
 * Unattended (non-interactive) mode helpers — issues #5 and #6.
 *
 * `vinci -p` / `--mode json` runs have no user at the keyboard: a block that says "wait for the
 * user's next instruction" can never be answered, and a reserve that refuses `git commit` refuses
 * the deliverable itself (the worker daemon publishes; the agent's job ends at the commit). Every
 * extension that behaves differently without a user detects that ONE way — `ctx.hasUI`, which Pi
 * sets false in print mode — through `isVinciUnattended`, so the definition cannot drift per file.
 *
 * This module also owns the ONE argv parser for "which local git subcommand is this" — shared by the
 * loopbreak reserve exemption and the guard's checkpoint gate (review BLOCK-1: the two used to parse
 * differently, so `git -C .. commit` qualified for the exemption while evading the guard).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function isVinciUnattended(ctx: Pick<ExtensionContext, "hasUI">): boolean {
  return !ctx.hasUI;
}

// ── Shared git argv parser ─────────────────────────────────────────────────────────────────────

export type LocalGitCommand = {
  /** The git subcommand (`add`, `commit`, …), lower-cased. */
  subcommand: string;
  /** Global options that appeared BEFORE the subcommand, each with its value attached (`-C ..`). */
  globals: string[];
  /** Everything after the subcommand, quotes removed, word boundaries preserved. */
  args: string[];
};

// git globals that take a value as the NEXT word (or inline with `=`).
const GIT_VALUE_GLOBALS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace", "--config-env", "--super-prefix"]);

/** Split one shell segment into words, dropping quotes but keeping quoted word boundaries. Returns
 *  null on an unterminated quote. Backslashes are kept literally (no escape processing): a word that
 *  needs escapes is not something either caller should treat as a plain git step. */
function shellWords(segment: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
      continue;
    }
    current += ch;
    inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push(current);
  return words;
}

/**
 * Parse one shell segment as a git invocation. Returns null when the segment is not `git …` (an env
 * prefix, `sudo`, or any other leading word disqualifies it — the guard strips its own prefixes
 * before calling). Global options are collected verbatim so a caller can decide whether `-C ..` or
 * `-c core.pager=x` disqualifies the command; this function never decides that itself.
 */
export function parseLocalGitSegment(segment: string): LocalGitCommand | null {
  const words = shellWords(segment);
  if (!words || words[0] !== "git") return null;
  const globals: string[] = [];
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    const word = words[i];
    const name = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
    if (GIT_VALUE_GLOBALS.has(name) && !word.includes("=")) {
      // `-Cpath` (attached) or `-C path` (next word); a dangling `-C` with no value is malformed.
      if (word.length > name.length) globals.push(word);
      else if (i + 1 < words.length) globals.push(`${word} ${words[++i]}`);
      else return null;
    } else {
      globals.push(word);
    }
    i++;
  }
  if (i >= words.length) return null;
  return { subcommand: words[i].toLowerCase(), globals, args: words.slice(i + 1) };
}

// ── Finalization-shaped commands (the reserve exemption) ───────────────────────────────────────
//
// A finalization-shaped bash command: every unquoted segment is one of the four local git steps an
// agent needs to land its work — stage, commit, and the two read-only checks it runs before them.
// Deliberately NOT here: `git push`, `gh`, `curl`, anything network-shaped — publishing belongs to
// the daemon, and a reserve exemption must never widen into an outward action. Compound commands
// are split on unquoted `&&`, `||`, `;`, `|`, and newlines and EVERY segment must qualify, so
// `git commit -m x && git push` is refused as a whole. Command substitution (`$(`, backticks outside
// single quotes) and redirections are refused outright — a commit message is not a place to smuggle
// an arbitrary command past the reserve.

const FINALIZATION_SUBCOMMANDS = new Set(["add", "commit", "status", "diff"]);
// The only global option a finalization step may carry. `-C <path>` is rejected entirely (BLOCK-1):
// a commit aimed at another repository is not this task's finalization, and the guard's checkpoint
// gate — which now shares this parser — must never see a differently-scoped command than we do.
// `-c`/`--config-env` inject config (core.pager, diff.external), `--exec-path`/`--git-dir`/
// `--work-tree` repoint git: all of those come out as globals here and are rejected the same way.
const FINALIZATION_ALLOWED_GLOBALS = new Set(["--no-pager"]);

// Post-subcommand options that open an editor, an interactive prompt, or an external program, or
// write a file — none of which a finalization step in an unattended run may do (WARN-1) — plus,
// for commit, the forms that make a commit trivial or history-rewriting: `--allow-empty`,
// `--allow-empty-message`, `--amend`, `--no-verify`/`-n`, and message reuse (`-C`/`--reuse-message`,
// `-c`/`--reedit-message`). A landed commit RESOLVES a refusal-class hard stop
// (lib/hard-stop.ts), so an empty or rewriting commit must never count as one (PR #15 review
// note). `git add -n`/`--dry-run` stages nothing and is refused for the same reason. Long options
// are matched by name (with or without `=value`); the letters are checked inside combined short
// clusters (`-pm`, `-nm`), so a flag cannot hide behind another.
const DENIED_LONG_OPTIONS: Record<string, readonly string[]> = {
  add: ["--patch", "--interactive", "--edit", "--pathspec-from-file", "--dry-run"],
  commit: [
    "--edit",
    "--template",
    "--reedit-message",
    "--reuse-message",
    "--patch",
    "--interactive",
    "--pathspec-from-file",
    "--fixup",
    "--squash",
    "--allow-empty",
    "--allow-empty-message",
    "--amend",
    "--no-verify",
  ],
  diff: ["--textconv", "--ext-diff", "--output", "--no-index"],
  status: [],
};
const DENIED_SHORT_LETTERS: Record<string, string> = {
  add: "pien",
  commit: "etcCpin",
  diff: "",
  status: "",
};

function argsAllowed(subcommand: string, args: readonly string[]): boolean {
  const deniedLong = DENIED_LONG_OPTIONS[subcommand] ?? [];
  const deniedLetters = DENIED_SHORT_LETTERS[subcommand] ?? "";
  for (const arg of args) {
    if (arg === "--") break;
    if (!arg.startsWith("-")) continue;
    if (arg.startsWith("--")) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (deniedLong.includes(name)) return false;
      continue;
    }
    // A short cluster: `-m`, `-am`, `-pm`. Only the leading letters are flags — `-mfix` is a message
    // — but a cluster is scanned in full: over-refusing a rare attached-value form is the safe side.
    for (const letter of arg.slice(1)) {
      if (deniedLetters.includes(letter)) return false;
    }
  }
  return true;
}

function splitUnquotedSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === "`" || (ch === "$" && command[i + 1] === "("))) return null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "`" || ch === ">" || ch === "<" || (ch === "$" && command[i + 1] === "(")) return null;
    if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") {
      // `&&`, `||`, and a lone `|`/`;`/newline all separate segments; a lone `&` backgrounds — refuse.
      if (ch === "&" && command[i + 1] !== "&") return null;
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++;
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

export function isVinciFinalizationCommand(command: string): boolean {
  const segments = splitUnquotedSegments(command);
  if (!segments || segments.length === 0) return false;
  return segments.every((segment) => {
    const parsed = parseLocalGitSegment(segment);
    return (
      parsed !== null &&
      FINALIZATION_SUBCOMMANDS.has(parsed.subcommand) &&
      parsed.globals.every((global) => FINALIZATION_ALLOWED_GLOBALS.has(global)) &&
      argsAllowed(parsed.subcommand, parsed.args)
    );
  });
}
