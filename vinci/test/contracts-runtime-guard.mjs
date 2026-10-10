// Adversarial tests for the "no contracts at runtime" guard (check-no-contracts-at-runtime.sh and
// scan-contracts-runtime-imports.mjs). Every fixture is written to a temp dir: nothing here touches
// the repo. The shipped rule is the byte string `@getsimpledirect` ANYWHERE in a shipped file, so
// import forms the first version's regexes missed — template specifiers, require.resolve,
// export-star, string concatenation, comments — are all violations; the only exemptions are a
// type-only import/export statement in a .ts/.d.ts file and the manifest/lockfile rules.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const scanner = resolve(root, "vinci/scripts/scan-contracts-runtime-imports.mjs");
const guard = resolve(root, "vinci/scripts/check-no-contracts-at-runtime.sh");
const work = mkdtempSync(join(tmpdir(), "vinci-contracts-guard-test-"));
let passed = 0;

function scan(mode, ...paths) {
	return spawnSync(process.execPath, [scanner, mode, ...paths], { encoding: "utf8", cwd: work });
}
function write(relativePath, content) {
	const path = join(work, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
}
function expectFlagged(name, result, needle) {
	assert.equal(result.status, 1, `${name} must be flagged:\n${result.stdout}${result.stderr}`);
	if (needle) assert.match(result.stderr, needle, `${name}: finding must name the offending line`);
	passed++;
	console.log(`  ✓ flags ${name}`);
}
function expectClean(name, result) {
	assert.equal(result.status, 0, `${name} must be allowed:\n${result.stdout}${result.stderr}`);
	passed++;
	console.log(`  ✓ allows ${name}`);
}

try {
	// ── shipped mode: adversarial import forms in built .js ─────────────────────────────────────
	const shippedCases = {
		"template-import.js": "const x = 'vinci-contracts';\nexport const load = () => import(`@getsimpledirect/${x}`);\n",
		"require-resolve.js": "const path = require.resolve('@getsimpledirect/vinci-contracts');\nmodule.exports = path;\n",
		"export-star.js": 'export * from "@getsimpledirect/vinci-contracts";\n',
		"concatenation.js": 'const name = "@getsimpledirect" + "/vinci-contracts";\nexport default name;\n',
		"comment-only.js": "// the bundler once inlined node_modules/@getsimpledirect/vinci-contracts here\nexport const ok = 1;\n",
		"plain-import.js": 'import { RUN_STATES } from "@getsimpledirect/vinci-contracts";\nexport { RUN_STATES };\n',
		"value-import.ts": 'import { RUN_STATES, type RunState } from "@getsimpledirect/vinci-contracts";\nexport { RUN_STATES };\n',
		"type-then-value.ts": 'import type { RunState } from "@getsimpledirect/vinci-contracts";\nconst m = await import("@getsimpledirect/vinci-contracts");\nexport { m };\n',
	};
	for (const [name, content] of Object.entries(shippedCases)) {
		const path = write(`shipped/${name}`, content);
		expectFlagged(`shipped ${name}`, scan("--shipped", path), /@getsimpledirect/);
	}
	// Extensionless executable (the launcher's shape) and a file under node_modules are scanned too.
	const launcher = write("tree/vinci/bin/vinci", "#!/usr/bin/env bash\nnode -e \"import('@getsimpledirect/vinci-contracts')\"\n");
	expectFlagged("extensionless vinci/bin/vinci", scan("--shipped", launcher), /vinci\/bin\/vinci:2/);
	write("tree/node_modules/some-dep/index.js", 'module.exports = require("@getsimpledirect/vinci-contracts");\n');
	expectFlagged("node_modules/some-dep/index.js", scan("--shipped", join(work, "tree")), /node_modules\/some-dep\/index\.js:1/);

	// Allowed shipped content.
	expectClean(
		"type-only import in a shipped .ts",
		scan("--shipped", write("ok/type-only.ts", 'import type { RunState, VerdictStatus } from "@getsimpledirect/vinci-contracts";\nexport type S = RunState | VerdictStatus;\n')),
	);
	expectClean(
		"inline-type-only import in a shipped .d.ts",
		scan("--shipped", write("ok/inline.d.ts", 'import { type RunState } from "@getsimpledirect/vinci-contracts";\nexport declare const s: RunState;\n')),
	);
	expectClean(
		"package.json with the scope under devDependencies",
		scan("--shipped", write("ok/package.json", JSON.stringify({ name: "x", devDependencies: { "@getsimpledirect/vinci-contracts": "0.2.0" } }))),
	);
	expectFlagged(
		"package.json with the scope under dependencies",
		scan("--shipped", write("bad/package.json", JSON.stringify({ name: "x", dependencies: { "@getsimpledirect/vinci-contracts": "0.2.0" } }))),
		/dependencies\.@getsimpledirect/,
	);
	expectClean(
		"hidden lockfile with a dev-only entry",
		scan("--shipped", write("ok/node_modules/.package-lock.json", JSON.stringify({ packages: { "node_modules/@getsimpledirect/vinci-contracts": { version: "0.2.0", dev: true } } }))),
	);
	expectFlagged(
		"hidden lockfile with a runtime entry",
		scan("--shipped", write("bad/node_modules/.package-lock.json", JSON.stringify({ packages: { "node_modules/@getsimpledirect/vinci-contracts": { version: "0.2.0" } } }))),
		/not dev-only/,
	);
	// #243 item 5: raw bytes before any binary classification. A NUL does not stop bash from running
	// the rest of an extensionless script, so it does not stop the scan; nor does a binary extension.
	expectFlagged("binary-looking extension carrying the prefix (.node)", scan("--shipped", write("bad/native.node", "\u0000\u0001 @getsimpledirect/vinci-contracts ")), /native\.node/);
	expectFlagged("extensionless blob: NUL then the prefix", scan("--shipped", write("bad/blob", "#!/bin/sh\n\u0000\nnode -e \"import('@getsimpledirect/vinci-contracts')\"\n")), /blob:3/);
	expectClean("source map (never loaded; package.sh excludes *.map)", scan("--shipped", write("ok/x.js.map", '{"sourcesContent":["import type { A } from \\"@getsimpledirect/x\\""]}')));
	// #243 item 4: symlinks are skipped only when they resolve INSIDE the scanned root.
	mkdirSync(join(work, "linked/inside"), { recursive: true });
	writeFileSync(join(work, "linked/real.js"), "export const ok = 1;\n");
	symlinkSync("../real.js", join(work, "linked/inside/real.js"));
	expectClean("symlink resolving inside the scanned root", scan("--shipped", join(work, "linked")));
	mkdirSync(join(work, "escape"), { recursive: true });
	symlinkSync(join(work, "shipped/plain-import.js"), join(work, "escape/plain-import.js"));
	expectFlagged("symlink escaping the scanned root", scan("--shipped", join(work, "escape")), /escapes the scanned root/);
	mkdirSync(join(work, "dangling"), { recursive: true });
	symlinkSync("/nonexistent/vinci-contracts.js", join(work, "dangling/x.js"));
	expectFlagged("dangling symlink whose lexical target leaves the root", scan("--shipped", join(work, "dangling")), /dangling symlink escapes/);
	mkdirSync(join(work, "dangling-relative/node_modules"), { recursive: true });
	symlinkSync("../../../etc/vinci-contracts.js", join(work, "dangling-relative/node_modules/x.js"));
	expectFlagged("dangling relative symlink climbing out of the root", scan("--shipped", join(work, "dangling-relative")), /dangling symlink escapes/);
	mkdirSync(join(work, "dangling-inside/node_modules"), { recursive: true });
	symlinkSync("../packages/coding-agent/examples/extensions/sandbox", join(work, "dangling-inside/node_modules/pi-extension-sandbox"));
	expectClean("dangling symlink into the root (unshipped workspace link loads nothing)", scan("--shipped", join(work, "dangling-inside")));
	// #243 item 1: exemptions are exact statement spans, not whole lines.
	expectFlagged(
		"runtime reference on the same line as an import type",
		scan("--shipped", write("bad/same-line.ts", 'import type { RunState } from "@getsimpledirect/vinci-contracts"; const m = require("@getsimpledirect/vinci-contracts");\nexport { m };\n')),
		/same-line\.ts:1/,
	);
	expectClean(
		"multi-line import type",
		scan("--shipped", write("ok/multi-line.ts", 'import type {\n  RunState,\n  VerdictStatus,\n} from "@getsimpledirect/vinci-contracts";\nexport type S = RunState | VerdictStatus;\n')),
	);
	// #244 review: import-shaped text inside a string or template literal is not a statement.
	expectFlagged(
		"shipped .ts: import type inside a template literal",
		scan("--shipped", write("bad/template-shaped.ts", 'const x = `import type { X } from "@getsimpledirect/x"`;\nexport default x;\n')),
		/template-shaped\.ts:1/,
	);
	// The statement-position rule alone would already reject the case above (`=` precedes it); this
	// one puts the import-shaped text at line start INSIDE a multi-line template, so only the
	// string/template range check can catch it.
	expectFlagged(
		"shipped .ts: import type at line start inside a multi-line template literal",
		scan("--shipped", write("bad/template-line-start.ts", 'const x = `\nimport type { X } from "@getsimpledirect/x";\n`;\nexport default x;\n')),
		/template-line-start\.ts:2/,
	);
	expectFlagged(
		"shipped .ts: import type inside a single-quoted string",
		scan("--shipped", write("bad/string-shaped.ts", "const x = 'import type { X } from \"@getsimpledirect/x\"';\nexport default x;\n")),
		/string-shaped\.ts:1/,
	);
	expectFlagged(
		"shipped .ts: import type not at statement position",
		scan("--shipped", write("bad/mid-expression.ts", 'const f = (m) => m; f(import type { X } from "@getsimpledirect/x");\n')),
		/mid-expression\.ts:1/,
	);
	expectClean(
		"shipped .ts: real import type after a statement on the same line",
		scan("--shipped", write("ok/after-semicolon.ts", 'export const a = 1; import type { X } from "@getsimpledirect/x";\nexport type Y = X;\n')),
	);
	// Documented fail-closed false positive: `${…}` expressions are not lexed, so a comment inside one
	// is string content and a scope mention there is reported even though it never loads anything.
	expectFlagged(
		"shipped .ts: scope mentioned in a comment inside a template ${} expression (fail-closed)",
		scan("--shipped", write("bad/template-expression-comment.ts", 'import type { X } from "@getsimpledirect/x";\nexport const s = `${/* from @getsimpledirect/x */ 1}`;\nexport type Y = X;\n')),
		/template-expression-comment\.ts:2/,
	);
	// #244 review, round 3: a comment is NEVER an exemption. The lexer cannot tell `/*` in a regex
	// literal from a comment opener, so comment stripping was an escape (`/\/*/` swallowed the rest of
	// the file). Prose naming the scope in a shipped .ts is now reported — an accepted, fail-closed
	// false positive; the fix is to remove the mention (canonical-verdicts.ts already does).
	expectFlagged(
		"shipped .ts: comment naming the scope beside a type-only import (accepted false positive)",
		scan("--shipped", write("bad/commented.ts", '// canonical arrays live in @getsimpledirect/vinci-contracts\nimport type { RunState } from "@getsimpledirect/vinci-contracts";\nexport type S = RunState;\n')),
		/commented\.ts:1/,
	);
	expectFlagged(
		"shipped .ts: value import hidden after a comment on the same line",
		scan("--shipped", write("bad/comment-then-value.ts", '/* harmless */ import { RUN_STATES } from "@getsimpledirect/vinci-contracts";\nexport { RUN_STATES };\n')),
		/comment-then-value\.ts:1/,
	);
	expectFlagged(
		"shipped .ts: regex literal /\\/*/ followed by a value import",
		scan("--shipped", write("bad/regex-comment-opener.ts", 'const re = /\\/*/;\nimport { RUN_STATES } from "@getsimpledirect/vinci-contracts";\nexport { RUN_STATES, re };\n')),
		/regex-comment-opener\.ts:2/,
	);
	expectFlagged(
		"shipped .ts: regex literal containing the scope (fail-closed)",
		scan("--shipped", write("bad/regex-scope.ts", 'import type { RunState } from "@getsimpledirect/vinci-contracts";\nexport const re = /@getsimpledirect\\/[a-z-]+/;\nexport type S = RunState;\n')),
		/regex-scope\.ts:2/,
	);
	expectFlagged(
		"shipped .ts: unterminated block comment then a type-only import",
		scan("--shipped", write("bad/unterminated.ts", '/* never closed\nimport type { RunState } from "@getsimpledirect/vinci-contracts";\nexport type S = RunState;\n')),
		/unterminated lexical range \(comment\)/,
	);
	expectFlagged(
		"shipped .ts: unterminated template literal then a type-only import",
		scan("--shipped", write("bad/unterminated-template.ts", 'const x = `never closed\nimport type { RunState } from "@getsimpledirect/vinci-contracts";\n')),
		/unterminated lexical range \(string\)/,
	);
	// Only the unterminated-range rule catches this one: the type-only import is a valid statement
	// and nothing after the open template mentions the scope. A file the lexer could not finish is
	// still a violation — scanning cannot be trusted past the break.
	expectFlagged(
		"shipped .ts: type-only import then an unterminated template with nothing after it",
		scan("--shipped", write("bad/unterminated-trailing.ts", 'import type { RunState } from "@getsimpledirect/vinci-contracts";\nexport const s = `never closed\n')),
		/unterminated-trailing\.ts:2: unterminated lexical range \(string\)/,
	);
	expectFlagged(
		"source: regex literal /\\/*/ followed by a value import",
		scan("--source", write("src/h.ts", 'const re = /\\/*/;\nimport { RUN_STATES } from "@getsimpledirect/vinci-contracts";\nexport { RUN_STATES, re };\n')),
		/h\.ts:2/,
	);
	// #243 item 2: in a package.json the prefix is allowed ONLY as an exact devDependencies key.
	expectFlagged("package.json: imports map", scan("--shipped", write("bad/imports/package.json", JSON.stringify({ name: "x", imports: { "#contracts": "@getsimpledirect/vinci-contracts" } }))), /imports\.#contracts/);
	expectFlagged("package.json: npm alias under devDependencies", scan("--shipped", write("bad/alias/package.json", JSON.stringify({ name: "x", devDependencies: { contracts: "npm:@getsimpledirect/vinci-contracts@0.2.0" } }))), /devDependencies\.contracts = /);
	expectFlagged("package.json: custom field", scan("--shipped", write("bad/custom/package.json", JSON.stringify({ name: "x", vinci: { preload: ["@getsimpledirect/vinci-contracts"] } }))), /vinci\.preload/);
	expectFlagged("package.json: key naming the scope outside devDependencies", scan("--shipped", write("bad/key/package.json", JSON.stringify({ name: "x", overrides: { "@getsimpledirect/vinci-contracts": "0.2.0" } }))), /overrides\.@getsimpledirect/);
	// #243 item 3: only an EXACT node_modules/@getsimpledirect/<name> path may be dev-only-exempt.
	expectFlagged("hidden lockfile: @getsimpledirect-wrapper marked dev", scan("--shipped", write("bad/wrapper/node_modules/.package-lock.json", JSON.stringify({ packages: { "node_modules/@getsimpledirect-wrapper": { version: "1.0.0", dev: true } } }))), /@getsimpledirect-wrapper names the private scope/);
	expectFlagged("hidden lockfile: scoped sub-path marked dev", scan("--shipped", write("bad/subpath/node_modules/.package-lock.json", JSON.stringify({ packages: { "node_modules/@getsimpledirect/vinci-contracts/lib": { version: "1.0.0", dev: true } } }))), /names the private scope/);
	expectFlagged("hidden lockfile: dev entry elsewhere referencing the scope", scan("--shipped", write("bad/ref/node_modules/.package-lock.json", JSON.stringify({ packages: { "node_modules/left-pad": { version: "1.0.0", dev: true, dependencies: { "@getsimpledirect/vinci-contracts": "0.2.0" } } } }))), /left-pad\.dependencies\.@getsimpledirect/);
	expectClean("hidden lockfile: nested exact scoped path marked dev", scan("--shipped", write("ok/nested/node_modules/.package-lock.json", JSON.stringify({ packages: { "node_modules/foo/node_modules/@getsimpledirect/vinci-contracts": { version: "0.2.0", dev: true, resolved: "https://npm.pkg.github.com/download/@getsimpledirect/vinci-contracts/0.2.0/abc" } } }))));

	// ── source mode: what the repo scan allows and flags ───────────────────────────────────────
	expectClean("source: import type", scan("--source", write("src/a.ts", 'import type { RunState } from "@getsimpledirect/vinci-contracts";\nexport type S = RunState;\n')));
	expectFlagged("source: comment mentioning the scope (accepted false positive; comments never exempt)", scan("--source", write("src/b.ts", "// see @getsimpledirect/vinci-contracts for the canonical arrays\nexport const x = 1;\n")), /b\.ts:1/);
	expectFlagged("source: mixed value/type specifiers", scan("--source", write("src/c.ts", 'import { RUN_STATES, type RunState } from "@getsimpledirect/vinci-contracts";\nexport { RUN_STATES };\n')), /import \{ RUN_STATES/);
	expectFlagged("source: template dynamic import", scan("--source", write("src/d.ts", "export const m = () => import(`@getsimpledirect/${'x'}`);\n")), /d\.ts:1/);
	expectFlagged("source: require.resolve", scan("--source", write("src/e.mjs", "import { createRequire } from 'node:module';\nexport const p = createRequire(import.meta.url).resolve('@getsimpledirect/vinci-contracts');\n")), /e\.mjs:2/);
	expectFlagged("source: runtime reference on the same line as an import type", scan("--source", write("src/g.ts", 'import type { RunState } from "@getsimpledirect/vinci-contracts"; export const p = require.resolve("@getsimpledirect/vinci-contracts");\n')), /g\.ts:1/);
	expectFlagged("source: export star", scan("--source", write("src/f.ts", 'export * from "@getsimpledirect/vinci-contracts";\n')), /f\.ts:1/);

	// ── tarball mode through the shell guard ──────────────────────────────────────────────────
	function tarball(name, files) {
		const stage = join(work, `stage-${name}`);
		for (const [relativePath, content] of Object.entries(files)) {
			const path = join(stage, relativePath);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		const archive = join(work, `${name}.tgz`);
		const result = spawnSync("tar", ["-czf", archive, "-C", stage, "."], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return archive;
	}
	const runGuard = (archive) => spawnSync("bash", [guard, archive], { encoding: "utf8", cwd: root });
	const cleanFiles = {
		"vinci/bin/vinci": "#!/usr/bin/env bash\nexec node packages/coding-agent/dist/cli.js\n",
		"vinci/dist/extensions/vinci-accept.js": "export default () => {};\n",
		"packages/coding-agent/dist/cli.js": "console.log('ok');\n",
		"package.json": JSON.stringify({ name: "vinci-code", devDependencies: { "@getsimpledirect/vinci-contracts": "0.2.0" } }),
		"node_modules/.package-lock.json": JSON.stringify({ packages: { "node_modules/@getsimpledirect/vinci-contracts": { version: "0.2.0", dev: true } } }),
		"node_modules/left-pad/index.js": "module.exports = (s) => s;\n",
	};
	expectClean("tarball: clean shape (dev-only manifest + hidden lockfile, node_modules present)", runGuard(tarball("clean", cleanFiles)));
	expectFlagged(
		"tarball: violation planted under node_modules/",
		runGuard(tarball("planted-node-modules", { ...cleanFiles, "node_modules/left-pad/index.js": "module.exports = require('@getsimpledirect/vinci-contracts');\n" })),
		/node_modules\/left-pad\/index\.js:1/,
	);
	expectFlagged(
		"tarball: violation in the extensionless launcher",
		runGuard(tarball("planted-launcher", { ...cleanFiles, "vinci/bin/vinci": '#!/usr/bin/env bash\nexport NODE_OPTIONS="--import @getsimpledirect/vinci-contracts"\n' })),
		/vinci\/bin\/vinci:2/,
	);
	expectFlagged(
		"tarball: template import in a built extension",
		runGuard(tarball("planted-template", { ...cleanFiles, "vinci/dist/extensions/vinci-accept.js": "export default () => import(`@getsimpledirect/${'vinci-contracts'}`);\n" })),
		/vinci-accept\.js:1/,
	);
	const escapeStage = join(work, "stage-planted-symlink");
	mkdirSync(join(escapeStage, "vinci/bin"), { recursive: true });
	for (const [relativePath, content] of Object.entries(cleanFiles)) {
		mkdirSync(dirname(join(escapeStage, relativePath)), { recursive: true });
		writeFileSync(join(escapeStage, relativePath), content);
	}
	symlinkSync(join(work, "shipped/plain-import.js"), join(escapeStage, "vinci/dist/extensions/escape.js"));
	const escapeArchive = join(work, "planted-symlink.tgz");
	assert.equal(spawnSync("tar", ["-czf", escapeArchive, "-C", escapeStage, "."], { encoding: "utf8" }).status, 0);
	expectFlagged("tarball: symlink escaping the extraction root", runGuard(escapeArchive), /escapes the scanned root/);
	expectFlagged(
		"tarball: private package files present",
		runGuard(tarball("planted-files", { ...cleanFiles, "node_modules/@getsimpledirect/vinci-contracts/package.json": "{}" })),
		/contains private @getsimpledirect runtime files/,
	);
} finally {
	rmSync(work, { recursive: true, force: true });
}
console.log(`\n✓ contracts-runtime-guard.mjs: ${passed} adversarial cases passed`);
