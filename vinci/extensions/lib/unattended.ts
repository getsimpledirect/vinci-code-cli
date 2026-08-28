/**
 * Unattended (non-interactive) mode helpers — issues #5 and #6.
 *
 * `vinci -p` / `--mode json` runs have no user at the keyboard: a block that says "wait for the
 * user's next instruction" can never be answered, and a reserve that refuses `git commit` refuses
 * the deliverable itself (the worker daemon publishes; the agent's job ends at the commit). Every
 * extension that behaves differently without a user detects that ONE way — `ctx.hasUI`, which Pi
 * sets false in print mode — through `isVinciUnattended`, so the definition cannot drift per file.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function isVinciUnattended(ctx: Pick<ExtensionContext, "hasUI">): boolean {
  return !ctx.hasUI;
}

// A finalization-shaped bash command: every unquoted segment is one of the four local git steps an
// agent needs to land its work — stage, commit, and the two read-only checks it runs before them.
// Deliberately NOT here: `git push`, `gh`, `curl`, anything network-shaped — publishing belongs to
// the daemon, and a reserve exemption must never widen into an outward action. Compound commands
// are split on unquoted `&&`, `||`, `;`, `|`, and newlines and EVERY segment must qualify, so
// `git commit -m x && git push` is refused as a whole. Command substitution (`$(`, backticks outside
// single quotes) and redirections are refused outright — a commit message is not a place to smuggle
// an arbitrary command past the reserve.
const FINALIZATION_SEGMENT_RE = /^git(?:\s+(?:-C\s+\S+|--no-pager))*\s+(?:add|commit|status|diff)(?:\s|$)/;
// Options that make a "local git step" execute something else: `-c`/`--config-env` inject config
// (core.pager, diff.external), `--exec-path`/`--git-dir`/`--work-tree` repoint git, and
// `--textconv`/`--ext-diff` run arbitrary filters (the round-12 security ruling that keeps these
// out of loopbreak's read-only class). `--output` writes a file. None is a finalization step.
const FINALIZATION_DENIED_OPTION_RE = /(?:^|\s)(?:-c|--config-env|--exec-path|--git-dir|--work-tree|--textconv|--ext-diff|--output)(?:=|\s|$)/;

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
  return segments.every(
    (segment) => FINALIZATION_SEGMENT_RE.test(segment) && !FINALIZATION_DENIED_OPTION_RE.test(segment),
  );
}
