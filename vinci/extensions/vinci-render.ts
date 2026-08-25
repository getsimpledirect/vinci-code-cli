/**
 * Vinci tool rendering — a non-technical user wants to know WHAT Vinci is doing, not read a raw
 * `bash sed …` invocation. So for the command/search tools we replace the CALL header with a
 * friendly, emphasized verb ("Running a command", "Reading a file") and grey the raw detail —
 * while DELEGATING the result/output rendering to Pi's own collapse ("… N more lines, ctrl+o to
 * expand"), which is already good. Edit and write calls use the same compact outcome-first
 * treatment so source contents never dominate the default transcript.
 *
 * Additive: re-registering a built-in name replaces its RENDERING only — execute() and the result
 * renderer delegate to the original tool unchanged (see examples/built-in-tool-renderer.ts).
 * Vinci's shell owns the single animated working state. Collapsed results say what they MEAN
 * ("found 12 matches"), not their shape ("12 lines").
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  vinciMaskEnabled,
  vinciMaskSecrets,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalLabel } from "@earendil-works/pi-coding-agent";

// Mask secrets in a tool RESULT before it's rendered expanded (ctrl+o) — a `cat .env`, a read of a
// secrets file, or a grep for a key would otherwise print the raw value on screen. Display-only: returns
// a shallow copy for the renderer; the model's own copy of the result keeps the real value. No-op unless
// VINCI_CODE.
// biome-ignore lint/suspicious/noExplicitAny: tool result shape is opaque here; we only touch text parts.
function maskResult(result: any): any {
  if (!vinciMaskEnabled() || !Array.isArray(result?.content)) return result;
  return {
    ...result,
    // biome-ignore lint/suspicious/noExplicitAny: content parts are text/image; only text is masked.
    content: result.content.map((c: any) =>
      c?.type === "text" && typeof c.text === "string" ? { ...c, text: vinciMaskSecrets(c.text) } : c,
    ),
  };
}

const TOOL_LABEL_LIMIT = 60;
const UNLIMITED_LABEL_WIDTH = Number.MAX_SAFE_INTEGER;

/** Finalize every tool label after composition: sanitize, mask, then enforce one shared limit. */
export function formatVinciToolLabel(label: string): string {
  const sanitized = sanitizeTerminalLabel(label, UNLIMITED_LABEL_WIDTH);
  const masked = vinciMaskEnabled() ? vinciMaskSecrets(sanitized) : sanitized;
  return sanitizeTerminalLabel(masked, TOOL_LABEL_LIMIT);
}

type ToolArgs = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
// A heredoc/herestring body is file CONTENT, not command; it must never reach a visible label.
// The guarantee is STRUCTURAL, not grammatical: a heredoc body always begins after a physical
// newline (bash requires it) and a herestring body always follows <<<, so labels render only the
// first line, cut unconditionally at any <<<. No shell-quoting subtlety can smuggle a body past
// that — quote-state mistakes can only over-truncate (cosmetic), never leak. The walker below is
// purely cosmetic on the remaining first-line text: it trims a delimiter-shaped operator (<<EOF,
// <<-'END') outside quotes so labels end at the command, and a bit-shift like 1<<2 is left alone.
const labelSafeCommand = (command: string) => {
  const firstLine = command.split("\n", 1)[0] ?? "";
  const herestring = firstLine.indexOf("<<<");
  return herestring === -1 ? firstLine : firstLine.slice(0, herestring);
};
const HEREDOC_OPERATOR = /^<<<|^<<-?\s*(?:'[A-Za-z_][^']*'|"[A-Za-z_][^"]*"|[A-Za-z_][A-Za-z0-9_]*)/;
const beforeHeredoc = (command: string) => {
  // "ansi" is bash's $'…' quoting, where backslash escapes apply (including \').
  let quote: "'" | '"' | "ansi" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "ansi") {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "$" && command[i + 1] === "'") {
      quote = "ansi";
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      if (HEREDOC_OPERATOR.test(command.slice(i))) return command.slice(0, i);
      i++;
    }
  }
  return command;
};

export type VinciDiffPreview = {
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
};

const ADDED_DIFF_LINE = /^\+\s*\d+\s/;
const REMOVED_DIFF_LINE = /^-\s*\d+\s/;

/** Keep the first changed hunk visible while the full diff remains one ctrl+o away. */
export function compactVinciDiff(diff: string, maxLines = 8): VinciDiffPreview | null {
  const lines = diff.replaceAll("\r\n", "\n").split("\n");
  const added = lines.filter((line) => ADDED_DIFF_LINE.test(line)).length;
  const removed = lines.filter((line) => REMOVED_DIFF_LINE.test(line)).length;
  const firstChange = lines.findIndex((line) => ADDED_DIFF_LINE.test(line) || REMOVED_DIFF_LINE.test(line));
  if (firstChange === -1) return null;

  const limit = Math.max(2, Math.floor(maxLines));
  const start = Math.max(0, firstChange - 1);
  const end = Math.min(lines.length, start + limit);
  const shown = lines.slice(start, end);
  if (start > 0 && !/^\s*\.\.\./.test(shown[0] ?? "")) shown.unshift("     ...");
  if (end < lines.length && !/^\s*\.\.\./.test(shown.at(-1) ?? "")) shown.push("     ...");
  return { text: shown.join("\n"), added, removed, truncated: start > 0 || end < lines.length };
}

/** A new file is a pure addition, rendered with the same visual language as an edit. */
export function compactVinciWrite(content: string, maxLines = 8): VinciDiffPreview | null {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  while (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return null;
  const limit = Math.max(1, Math.floor(maxLines));
  const shown = lines.slice(0, limit).map((line, index) => `+${String(index + 1).padStart(3)} ${line}`);
  if (lines.length > limit) shown.push("     ...");
  return { text: shown.join("\n"), added: lines.length, removed: 0, truncated: lines.length > limit };
}

function renderVinciDiffPreview(preview: VinciDiffPreview, activeTheme: Theme): string {
  const text = vinciMaskEnabled() ? vinciMaskSecrets(preview.text) : preview.text;
  return text
    .split("\n")
    .map((line) => {
      if (ADDED_DIFF_LINE.test(line)) {
        return activeTheme.bg("toolSuccessBg", activeTheme.fg("toolDiffAdded", ` ${line} `));
      }
      if (REMOVED_DIFF_LINE.test(line)) {
        return activeTheme.bg("toolErrorBg", activeTheme.fg("toolDiffRemoved", ` ${line} `));
      }
      return activeTheme.fg("toolDiffContext", ` ${line}`);
    })
    .join("\n");
}

// ── Burst folding ────────────────────────────────────────────────────────────────────────────────
// Ten `ls` calls in a row used to render as ten full accent headers — a wall of "Looking in X" that
// reads as inside baseball. Each tool call is its own TUI component (they can't be merged), but we
// CAN quiet the repeats: the FIRST call of a run keeps the accent header; consecutive same-kind
// calls with no narration in between render as dim `·` continuation lines. Narration, an edit, or a
// different kind of call starts a new run. State is keyed by (tool + args) so repaints stay stable.
const VERB_OF: Record<string, string> = {
  read: "Reading",
  grep: "Searching",
  find: "Finding",
  ls: "Looking",
  edit: "Updating",
  write: "Creating",
};
function categoryOf(name: string, input: unknown): string {
  if (name === "bash") return sanitizeTerminalLabel(bashIntent(str((input as ToolArgs)?.command)).split(" ")[0], 60);
  return VERB_OF[name] ?? name;
}
const runKey = (name: string, input: unknown): string => {
  try {
    return name + " " + JSON.stringify(input ?? {});
  } catch {
    return name + " " + String(input);
  }
};
const runContinuation = new Map<string, boolean>(); // runKey -> render as a quiet continuation line

/**
 * Turn a shell command into a plain-language "what it's doing" label, so a run of commands reads as
 * intent ("Looking in src", "Installing packages", "Checking what's changed") instead of a wall of
 * raw shell. This is the header only — the actual command still shows, greyed, next to it. Unknown
 * commands fall back to a plain "Running a command", so we never mislabel.
 */
export function bashIntent(command: string): string {
  const raw = sanitizeTerminalLabel(beforeHeredoc(labelSafeCommand(str(command))), UNLIMITED_LABEL_WIDTH).trim();
  if (!raw) return "Running a command";
  // Describe the FIRST real command: drop a leading `cd <path> &&` (the model often cd's first),
  // strip sudo / leading VAR=val env assignments, and cut at the first pipe / chain operator.
  let c = raw
    .replace(/^\s*cd\s+[^\s&|;]+\s*&&\s*/i, "")
    .replace(/^\s*sudo\s+/i, "")
    .replace(/^\s*(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/i, "")
    .trim();
  c = c.split(/\s*(?:\||&&|\|\||;)\s*/)[0].trim();
  const parts = c.split(/\s+/).filter(Boolean);
  const cmd0 = parts[0] ?? "";
  const args = parts.slice(1);
  // Skip flags AND shell plumbing (redirects, heredoc markers) — `cat > file` must not pick ">" as
  // the "filename" (observed live: a heredoc write labeled "Reading >").
  const nonFlag = args.filter((a) => !a.startsWith("-") && !/^(?:>>?|<<?<?|\d>>?&?\d?)$/.test(a));
  const first = nonFlag[0] ?? "";
  const leafOf = (p: string) => p.replace(/["']/g, "").split("/").filter(Boolean).pop() || p;
  const leaf = first ? leafOf(first) : "";
  const redirects = /(^|\s)>>?[^&]/.test(raw);
  // The file a redirect writes to ("cat > apps/web/src/x.ts << EOF" → "x.ts").
  const redirectTarget = raw.match(/(?:^|[^&\d])>>?\s*([^\s;&|<]+)/)?.[1];
  const targetLeaf = redirectTarget ? leafOf(redirectTarget) : "";
  const action = c.replace(/\s+/g, " ");
  const specific = (gloss: string) => `${gloss} (${action})`;

  switch (cmd0) {
    case "ls":
    case "exa":
    case "eza":
      return specific(leaf ? `Looking in ${leaf}` : "Looking through the files");
    case "cat":
    case "head":
    case "tail":
    case "less":
    case "more":
    case "bat":
      // `cat > file` / `cat >> file` (heredoc writes) are WRITES, not reads — label them honestly
      // (observed live: shell file-writes labeled "Reading >").
      if (redirects) {
        return /(^|[^>])>>(?!>)/.test(raw)
          ? targetLeaf
            ? specific(`Adding to ${targetLeaf}`)
            : specific("Adding to a file")
          : targetLeaf
            ? specific(`Writing ${targetLeaf}`)
            : specific("Writing to a file");
      }
      return specific(leaf ? `Reading ${leaf}` : "Reading a file");
    case "grep":
    case "rg":
    case "egrep":
    case "ag":
      return specific("Searching the code");
    case "find":
    case "fd":
      return specific("Looking for files");
    case "tree":
      return specific("Mapping the folders");
    case "mkdir":
      return specific("Making a folder");
    case "touch":
      return specific(leaf ? `Creating ${leaf}` : "Creating a file");
    case "rm":
    case "rmdir":
    case "unlink":
      return specific(leaf ? `Deleting ${leaf}` : "Deleting files");
    case "mv":
      return specific("Moving / renaming");
    case "cp":
    case "rsync":
      return specific("Copying files");
    case "wc":
      return specific("Counting");
    case "echo":
    case "printf":
      return specific(redirects ? "Writing to a file" : "Printing a message");
    case "pwd":
      return specific("Checking where we are");
    case "cd":
      return specific("Moving to a folder");
    case "which":
    case "type":
    case "command":
    case "whereis":
    case "whoami":
    case "env":
      return specific("Checking the setup");
    case "chmod":
    case "chown":
      return specific("Changing permissions");
    case "curl":
    case "wget":
    case "http":
      return specific("Fetching from the web");
    case "node":
    case "python":
    case "python3":
    case "ruby":
    case "deno":
      return specific("Running a script");
    case "tsc":
    case "tsgo":
      return specific("Type-checking");
    case "sed":
    case "awk":
      // `sed -n '10,50p'` PRINTS lines — that's reading, not editing (observed mislabeled live).
      if (cmd0 === "sed" && /^sed\s+(-\S+\s+)*-n\b/.test(c) && !/\s-i\b/.test(c)) {
        return specific("Reading part of a file");
      }
      return specific(redirects ? "Writing to a file" : "Editing text");
    case "diff":
      return specific("Comparing files");
    case "docker":
      return specific("Running Docker");
    case "make":
      return specific("Building the project");
    case "npm":
    case "npx":
    case "pnpm":
    case "yarn":
    case "bun": {
      const packageArgs: string[] = [];
      for (let index = 0; index < args.length; index++) {
        const token = args[index] ?? "";
        if (/^(?:--filter|-F|--workspace|-w|--dir|-C|--prefix|--cwd)$/.test(token)) {
          index++;
          continue;
        }
        if (/^(?:--filter|-F|--workspace|-w|--dir|-C|--prefix|--cwd)=/.test(token) || token.startsWith("-")) {
          continue;
        }
        packageArgs.push(token.replace(/["']/g, ""));
      }
      if (packageArgs[0] === "workspace") packageArgs.splice(0, 2);
      const sub = packageArgs[0] ?? "";
      if (/^(install|add|i|ci)$/.test(sub)) return specific("Installing packages");
      if (/^(remove|rm|uninstall|un)$/.test(sub)) return specific("Removing a package");
      if (cmd0 === "npx") {
        return sub ? `${cmd0} ${sub}` : "Running a command";
      }
      if (/^(run|run-script|exec|dlx|x)$/.test(sub)) {
        const scriptOrExecutable = packageArgs[1] ?? "";
        return scriptOrExecutable ? `${cmd0} ${scriptOrExecutable}` : "Running a command";
      }
      return sub ? `${cmd0} ${sub}` : "Running a command";
    }
    case "git": {
      const sub = nonFlag[0] ?? "";
      const map: Record<string, string> = {
        status: "Checking what's changed",
        log: "Looking at the history",
        diff: "Reviewing the changes",
        add: "Staging the changes",
        commit: "Saving a checkpoint",
        push: "Pushing to the remote",
        pull: "Getting the latest",
        fetch: "Getting the latest",
        clone: "Cloning a repo",
        checkout: "Switching branches",
        switch: "Switching branches",
        branch: "Looking at the branches",
        init: "Setting up git",
        stash: "Setting changes aside",
        reset: "Undoing changes",
        revert: "Undoing a change",
        merge: "Merging branches",
        rebase: "Replaying the changes",
        show: "Looking at a commit",
        restore: "Restoring a file",
        rm: "Removing a file",
        mv: "Moving a file",
        tag: "Tagging a version",
        remote: "Checking the remotes",
        worktree: "Working with worktrees",
      };
      return specific(map[sub] ?? "Working with git");
    }
    default:
      return "Running a command";
  }
}

/**
 * Wrap a built-in tool: same execute, friendly CALL header, NATIVE result rendering. `verb` is the
 * emphasized "what it's doing"; `arg` pulls the greyed detail (command / path / pattern) from args;
 * `summarize` turns the collapsed result into words a non-programmer understands ("found 12
 * matches", not "12 lines").
 */
function friendly(
  pi: ExtensionAPI,
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: the built-in tool factory returns AgentTool<…>;
  // we only touch description/parameters/execute/renderResult, and extensions are type-stripped.
  create: (...args: any[]) => any,
  cwd: string,
  // A fixed label, or one computed per-call from the args (bash derives it from the command).
  verb: string | ((a: ToolArgs) => string),
  arg: (a: ToolArgs) => string,
  summarize?: (n: number) => string,
) {
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  let original: any;
  try {
    original = create(cwd);
  } catch {
    return; // signature drift on a version bump — skip this one rather than break the extension.
  }
  // Delegate the result/output renderer to Pi's native one (collapse is already good). Guard in
  // case a version drops it, so we never blank the output.
  const nativeResult = typeof original.renderResult === "function"
    ? (original.renderResult as (...a: unknown[]) => unknown).bind(original)
    : undefined;

  pi.registerTool({
    name,
    label: name,
    description: String(original.description ?? name),
    // biome-ignore lint/suspicious/noExplicitAny: delegating to the built-in's own schema.
    parameters: original.parameters as any,
    async execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: ExtensionContext) {
      // biome-ignore lint/suspicious/noExplicitAny: pass-through to the real tool.
      const activeTool = ctx.cwd === cwd ? original : create(ctx.cwd);
      return (activeTool.execute as any)(toolCallId, params, signal, onUpdate, ctx);
    },
    // biome-ignore lint/suspicious/noExplicitAny: Pi types args as unknown; we read our own fields.
    renderCall(args: any, theme, context) {
      let label = typeof verb === "function" ? verb(args as ToolArgs) : verb;
      // Mask secrets in the always-visible call header too — a `curl -H "Authorization: Bearer …"` or
      // an inline `export API_KEY=…` would otherwise leak its head here even though the expanded result
      // is masked. Display-only; the real command still runs unchanged. Collapse newlines so a heredoc
      // command renders as ONE dim line, not its file content spilling into the transcript.
      let detail = sanitizeTerminalLabel(arg(args as ToolArgs), UNLIMITED_LABEL_WIDTH).replace(/\s+/g, " ").trim();
      if (vinciMaskEnabled()) {
        if (detail) detail = vinciMaskSecrets(detail);
      }
      label = formatVinciToolLabel(label);
      // Continuation of a same-kind run → a quiet `·` line; only the run's first call gets the
      // accent header (see "Burst folding" above).
      if (runContinuation.get(runKey(name, args)) === true) {
        let t = theme.fg("dim", `  · ${label}`);
        if (detail && context.expanded) t += theme.fg("dim", "  " + sanitizeTerminalLabel(detail, 48));
        return new Text(t, 0, 0);
      }
      let t = theme.fg("accent", "● ") + theme.fg("toolTitle", theme.bold(label));
      if (detail && context.expanded) t += theme.fg("dim", "  " + sanitizeTerminalLabel(detail, 60));
      return new Text(t, 0, 0);
    },
    // Collapsed (the VINCI default): a single quiet summary line instead of an output preview, so a
    // run of commands reads as a tight, scannable list — not a wall. Expanded (ctrl+o) → full native.
    // biome-ignore lint/suspicious/noExplicitAny: native renderer signature varies by version.
    renderResult: ((result: any, options: any, thm: any, context: any) => {
      if (!context.isError && (name === "edit" || name === "write")) {
        const maxLines = options?.expanded ? 2_000 : 8;
        const preview = name === "edit"
          ? compactVinciDiff(str(result?.details?.diff), maxLines)
          : compactVinciWrite(str((context.args as ToolArgs | undefined)?.content), maxLines);
        if (preview) {
          const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
          component.clear();
          const outcome = name === "edit" ? "changed" : "saved";
          const counts = `+${preview.added} −${preview.removed}`;
          const hint = options?.expanded ? "" : " · ctrl+o for full diff";
          component.addChild(
            new Text(
              thm.fg("success", "  └ ✓ ") + thm.fg("dim", `${outcome} · ${counts}${hint}`),
              0,
              0,
            ),
          );
          component.addChild(new Text(renderVinciDiffPreview(preview, thm as Theme), 2, 0));
          return component;
        }
      }
      if (options?.expanded) {
        // Expanded output can carry secrets (cat .env, read of a key file, grep for a token) — mask them.
        return nativeResult ? nativeResult(maskResult(result), options, thm, context) : new Text("", 0, 0);
      }
      const parts = Array.isArray(result?.content) ? result.content : [];
      const text = parts.filter((c: any) => c?.type === "text").map((c: any) => String(c?.text ?? "")).join("\n");
      const n = text.trim() ? text.split("\n").filter((l: string) => l.trim()).length : 0;
      // Errors teach the affordance right where it matters; successes get plain words, not "lines".
      const summary = context.isError
        ? "didn't work · ctrl+o to see why"
        : summarize
          ? summarize(n)
          : n
            ? `${n} line${n === 1 ? "" : "s"}`
            : "done";
      return context.isError
        ? new Text(thm.fg("error", "  └ ! ") + thm.fg("muted", summary), 0, 0)
        : new Text(thm.fg("success", "  └ ✓ ") + thm.fg("dim", summary), 0, 0);
    }) as any,
  });
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // Every everyday tool gets a compact activity row. Raw commands, output, and diffs stay available
  // through ctrl+o, but the default transcript describes outcomes rather than implementation noise.
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const leaf = (value: unknown) => {
    const path = str(value);
    return path.split("/").filter(Boolean).pop() || path;
  };
  friendly(pi, "bash", createBashTool, cwd, (a) => bashIntent(str(a.command)), (a) => beforeHeredoc(labelSafeCommand(str(a.command))),
    (n) => (n ? `finished · ${plural(n, "line")} of output` : "finished quietly"));
  friendly(pi, "read", createReadTool, cwd, (a) => (leaf(a.path) ? `Read ${leaf(a.path)}` : "Read a file"), (a) => str(a.path),
    (n) => (n ? `read ${plural(n, "line")}` : "empty file"));
  friendly(pi, "grep", createGrepTool, cwd, (a) => {
    const query = str(a.pattern) || str(a.query);
    return query ? `Searched for “${query}”` : "Searched the project";
  }, (a) => str(a.pattern) || str(a.query),
    (n) => (n ? `found ${plural(n, "match", "matches")}` : "no matches"));
  friendly(pi, "find", createFindTool, cwd, (a) => {
    const query = str(a.pattern) || str(a.query);
    return query ? `Found files matching “${query}”` : "Looked for files";
  }, (a) => str(a.pattern) || str(a.query) || str(a.path),
    (n) => (n ? `found ${plural(n, "file")}` : "none found"));
  friendly(pi, "ls", createLsTool, cwd, (a) => (leaf(a.path) ? `Inspected ${leaf(a.path)}` : "Inspected the project"), (a) => str(a.path),
    (n) => (n ? plural(n, "item") : "empty folder"));
  friendly(pi, "edit", createEditTool, cwd, (a) => (leaf(a.path) ? `Update ${leaf(a.path)}` : "Update a file"), (a) => str(a.path),
    () => "changes applied · ctrl+o to review");
  friendly(pi, "write", createWriteTool, cwd, (a) => (leaf(a.path) ? `Create ${leaf(a.path)}` : "Create a file"), (a) => str(a.path),
    () => "file saved · ctrl+o to review");

  // Keep implementation detail collapsed. The Vinci shell owns the single animated working state.
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    // Collapse tool OUTPUT by default so a burst of commands is a stack of quiet previews, not a wall
    // of raw output (a non-programmer doesn't want to read every grep dump). ctrl+o still expands one.
    try {
      ctx.ui.setToolsExpanded?.(false);
    } catch {
      /* not available in this build */
    }
    // When Vinci auto-resumed the previous session for this project (main.ts sets VINCI_RESUMED), tell
    // the user plainly and once — the loaded history already shows above, this just names what happened
    // and how to start over. Clear the flag so a later /new (a fresh session_start) doesn't repeat it.
    if (process.env.VINCI_RESUMED === "1") {
      delete process.env.VINCI_RESUMED;
      try {
        ctx.ui.notify?.("↩ Picked up where you left off — type /new to start fresh.", "info");
      } catch {
        /* notify not available in this build */
      }
    }
  });

  let lastRunCategory: string | null = null; // burst folding: the kind of the previous tool call

  // Burst folding: mark each call as run-start or continuation BEFORE it renders. The map is not
  // cleared per turn — old components repaint from it, and clearing would un-fold past rows.
  pi.on("tool_call", async (event) => {
    if (runContinuation.size > 5000) runContinuation.clear(); // session-lifetime backstop
    const cat = categoryOf(event.toolName, event.input);
    runContinuation.set(runKey(event.toolName, event.input), cat === lastRunCategory);
    lastRunCategory = cat;
  });

  // Narration breaks a burst: after Vinci explains a finding, the next action starts a new group.
  // The shell separately turns that narration into the one live working state.
  pi.on("message_end", async (event) => {
    const m = event.message;
    if (m.role !== "assistant" || m.stopReason === "error") return;
    if (m.content.some((part) => part.type === "text" && part.text.trim())) lastRunCategory = null;
  });

  pi.on("agent_start", async () => {
    lastRunCategory = null; // a new user turn starts a fresh run
  });
}
