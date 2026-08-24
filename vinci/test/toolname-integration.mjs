// Integration check: exercise the REAL vinciNormalizeToolName from the core agent loop — the fix
// that folds a small model's hallucinated tool-name synonym (`editor`→`edit`, `write_file`→`write`)
// onto the real tool BEFORE resolution + before the guard hooks, so the call succeeds first try and
// the name-keyed guards are NOT bypassed. Node 23 strips the type-only imports so we can load the .ts.
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { vinciNormalizeToolName } = await import(resolve(here, "../../packages/agent/src/agent-loop.ts"));
assert.equal(typeof vinciNormalizeToolName, "function", "agent-loop must export vinciNormalizeToolName");

// The tool list a real Vinci turn carries.
const TOOLS = ["edit", "write", "read", "ls", "grep", "find", "bash"].map((name) => ({ name }));

let pass = 0;
const maps = (from, to, tools = TOOLS) => {
  const got = vinciNormalizeToolName(from, tools);
  assert.equal(got, to, `${JSON.stringify(from)} → ${JSON.stringify(got)}, want ${JSON.stringify(to)}`);
  console.log(`  ✓ ${from}  →  ${to}`);
  pass++;
};

// Known hallucinations fold onto the real tool
maps("editor", "edit");
maps("edit_file", "edit");
maps("str_replace_editor", "edit"); // Claude's real tool name — piccolo has seen it in training
maps("str_replace_based_edit_tool", "edit");
maps("apply_patch", "edit");
maps("write_file", "write");
maps("create_file", "write");
maps("read_file", "read");
maps("view_file", "read");
maps("list_files", "ls");
maps("run_command", "bash");
maps("execute_command", "bash");
maps("shell", "bash");
maps("EDITOR", "edit"); // case-insensitive

// Real tool names pass through untouched (no accidental rewrite)
maps("edit", "edit");
maps("write", "write");
maps("bash", "bash");
maps("grep", "grep");
maps("web_search", "web_search"); // a genuine Vinci tool that isn't a synonym

// Unknown names are left alone — we never guess
maps("frobnicate", "frobnicate");
maps("", "");

// SAFETY: only rewrites when the canonical tool actually EXISTS this turn — never invents a capability
maps("editor", "editor", [{ name: "bash" }]); // no `edit` tool present → left as-is
maps("write_file", "write_file", [{ name: "read" }, { name: "ls" }]); // no `write` → left as-is
// no tool list at all → left as-is (call directly: passing undefined to maps() would hit its default)
assert.equal(vinciNormalizeToolName("editor", undefined), "editor", "no tool list → unchanged");
console.log("  ✓ editor  →  editor   (no tool list at all)");
pass++;

// SAFETY: a synonym that routes to a GUARDED tool must land on the canonical name, so the guard
// (which keys on toolName === "bash" / "write") still fires. Proving the mapping target here is the
// contract the guard relies on; an additive alias tool would instead produce toolName "run_command".
maps("run_command", "bash"); // guard's bash checks will see "bash", not "run_command"
maps("write_file", "write"); // overwrite guard keys on "write" — must see "write"

console.log(`\ntoolname-integration: ${pass}/${pass} checks passed (real vinciNormalizeToolName module)`);
