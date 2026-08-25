// Integration check: the REAL vinci-autoname cleanTitle — turns a model's title reply into a tidy
// session name for the resume picker (strips quotes / markdown / trailing punctuation, caps length).
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { cleanTitle } = await import(resolve(here, "../extensions/vinci-autoname.ts"));
assert.equal(typeof cleanTitle, "function", "vinci-autoname must export cleanTitle");

let pass = 0;
const is = (raw, want) => {
	const got = cleanTitle(raw);
	assert.equal(got, want, `cleanTitle(${JSON.stringify(raw)}) → ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
	console.log(`  ✓ ${JSON.stringify(raw)}  →  ${JSON.stringify(want)}`);
	pass++;
};

is("Add Dark Mode Toggle", "Add Dark Mode Toggle");
is('"Remove Anthropic Key"', "Remove Anthropic Key"); // strip surrounding quotes
is("Fix Login Redirect.", "Fix Login Redirect"); // trailing period
is("**Simplify Dashboard**", "Simplify Dashboard"); // markdown bold
is("- Update Prisma Schema", "Update Prisma Schema"); // list marker
is("`Build The Site`", "Build The Site"); // backticks
is("Add Dark Mode\n(a toggle in settings)", "Add Dark Mode"); // first non-empty line only
is("   Trim Whitespace   ", "Trim Whitespace");
is("dummy_anthropic_key", "Dummy Anthropic Key"); // 4B snake_case → readable Title Case
is("fix login redirect", "Fix Login Redirect"); // lowercase → Title Case
is("add API key", "Add API Key"); // existing caps (acronym) preserved
is(`${"x".repeat(60)}`, `X${"x".repeat(46)}…`); // capped at 48 with ellipsis (first letter capitalized)
is("", ""); // empty in → empty out (extension only sets name when length >= 2)

console.log(`\nautoname-integration: ${pass}/${pass} checks passed (real cleanTitle)`);
