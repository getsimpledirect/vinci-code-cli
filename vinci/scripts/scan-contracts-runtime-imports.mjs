#!/usr/bin/env node
// Find every place a tree could load `@getsimpledirect/*` at RUNTIME. Used by
// check-no-contracts-at-runtime.sh against the repo (sources + built output) and against an
// unpacked tarball. Prints one `path:line: detail` per hit and exits 1 on any hit.
//
//   --manifest <package.json>...  private scope under dependencies / optionalDependencies /
//       peerDependencies (devDependencies is the ONE place the package belongs: typecheck + tests)
//   --source <dir-or-file>...     repo sources (.ts/.mts/.cts/.js/.mjs/.cjs): any import / export /
//       require / dynamic import of the scope that is not type-only, and the prefix anywhere else
//       — comments included; a comment is never an exemption.
//   --shipped <dir-or-file>...    (alias: --built) CONSERVATIVE, for anything that ships: every
//       regular file is read as RAW BYTES — any extension, no extension, node_modules, binaries
//       included (a NUL byte does not stop bash from executing the rest of a script, so it does not
//       stop this scan either; only *.map is skipped, since a source map is never loaded and
//       package.sh excludes them). The rule is the byte string `@getsimpledirect` ANYWHERE,
//       including template/concatenated strings and COMMENTS (a comment is never an exemption:
//       the lexer cannot tell `/*` from a regex literal, so it is used only to REJECT, never to
//       allow). Exemptions are exact, not by line: in a .ts/.d.ts file, the character span of an
//       `import type` / `export type` statement (or an import whose every specifier is `type`); in a
//       package.json, an exact `devDependencies` KEY; in an npm lockfile, an entry whose key is an
//       exact `node_modules/@getsimpledirect/<name>` path marked "dev": true. A symlink is skipped
//       only when it resolves inside the scanned root (its target is scanned where it lives); one
//       that escapes the root, or dangles, is a violation. Built .js can never legitimately
//       contain the scope (type imports do not survive emit), so no import syntax is parsed here —
//       `import(\`@getsimpledirect/${x}\`)`, `require.resolve("@getsimpledirect/...")`,
//       `export * from`, and `"@getsimpledirect" + "/x"` are all caught by the prefix.
//
// 0.0.51 is why the shipped scan exists: the source-side doctrine held for the esbuild bundles under
// vinci/dist/extensions, but the coding-agent build ALSO emits un-bundled copies of
// vinci/extensions/lib/*.ts in place, and those shipped with the bare import intact.
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const SCOPE = "@getsimpledirect/";
const PREFIX = "@getsimpledirect";
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);
const SKIP_SOURCE_DIRECTORIES = new Set(["node_modules", ".git"]);
// Skipped in shipped mode: ONLY source maps. Everything else is read as bytes (item 5 of #243: an
// early NUL used to classify a file as binary and suppress the scan, while bash executes past it).
const SKIP_SHIPPED_EXTENSIONS = new Set([".map"]);

function walkSources(path, out = []) {
	const details = lstatSync(path);
	if (details.isSymbolicLink()) return out;
	if (details.isFile()) {
		if (SOURCE_EXTENSIONS.has(extname(path)) && !path.endsWith(".d.ts")) out.push(path);
		return out;
	}
	if (!details.isDirectory()) return out;
	for (const entry of readdirSync(path)) {
		if (SKIP_SOURCE_DIRECTORIES.has(entry)) continue;
		walkSources(join(path, entry), out);
	}
	return out;
}

// `root` is the containment boundary for symlinks (item 4 of #243): a link whose real target lies
// under the root is skipped because that target is scanned where it lives; a link that resolves
// outside the root is reported, since it would load bytes this scan never saw. A dangling link is
// judged by its lexical target: inside the root it loads nothing, outside it is a violation.
function walkShipped(path, root, out = [], symlinkFindings = []) {
	const details = lstatSync(path);
	if (details.isSymbolicLink()) {
		const inside = (candidate) => candidate === root || candidate.startsWith(root + sep);
		let target;
		try {
			target = realpathSync(path);
		} catch {
			// Dangling. Judge the LEXICAL target: a link into the archive that points at nothing loads
			// nothing (npm workspace links to unshipped examples are this shape); a link whose lexical
			// target leaves the root could resolve on an install machine and is a violation.
			const lexical = resolve(realpathSync(dirname(path)), readlinkSync(path));
			if (!inside(lexical)) symlinkFindings.push({ path, detail: `dangling symlink escapes the scanned root: -> ${lexical}` });
			return out;
		}
		if (!inside(target)) {
			symlinkFindings.push({ path, detail: `symlink escapes the scanned root: -> ${target}` });
		}
		return out;
	}
	if (details.isFile()) {
		if (!SKIP_SHIPPED_EXTENSIONS.has(extname(path).toLowerCase())) out.push(path);
		return out;
	}
	if (!details.isDirectory()) return out;
	for (const entry of readdirSync(path)) walkShipped(join(path, entry), root, out, symlinkFindings);
	return out;
}

// One lexer for strings, template literals and comments, used ONLY to REJECT: a type-only span that
// starts inside one of these ranges is not a statement. It never exempts anything — it cannot tell
// `/*` inside a regex literal from a comment opener (`/\/*/` would otherwise open a "comment" that
// swallows the rest of the file), so a range that runs to end-of-file unterminated is reported as a
// violation rather than trusted. A template literal is one range from backtick to backtick: `${…}`
// expressions are not lexed (a nested, brace-counting lexer well past twenty lines), so a scope
// mention inside one is string content and reported — fail-closed.
function lexRanges(source) {
	const ranges = [];
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		const next = source[index + 1];
		if (character === '"' || character === "'" || character === "`") {
			const start = index;
			let terminated = false;
			for (index++; index < source.length; index++) {
				if (source[index] === "\\") {
					index++;
					continue;
				}
				if (source[index] === character) {
					terminated = true;
					break;
				}
				if (character !== "`" && source[index] === "\n") break;
			}
			ranges.push({ start, end: Math.min(index + 1, source.length), kind: "string", terminated });
			index++;
			continue;
		}
		if (character === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			ranges.push({ start: index, end: end === -1 ? source.length : end + 2, kind: "comment", terminated: end !== -1 });
			index = end === -1 ? source.length : end + 2;
			continue;
		}
		if (character === "/" && next === "/") {
			const end = source.indexOf("\n", index);
			ranges.push({ start: index, end: end === -1 ? source.length : end, kind: "comment", terminated: true });
			index = end === -1 ? source.length : end;
			continue;
		}
		index++;
	}
	return ranges;
}

function unterminatedRangeFindings(source, ranges) {
	return ranges
		.filter((range) => !range.terminated)
		.map((range) => ({ line: lineOf(source, range.start), detail: `unterminated lexical range (${range.kind}) runs to end of file; scanning cannot be trusted past it` }));
}

function lineOf(source, offset) {
	let line = 1;
	for (let index = 0; index < offset; index++) if (source[index] === "\n") line++;
	return line;
}

const STATIC_FROM = /\b(import|export)\b([^;'"`]*?)\bfrom\s*["'](@getsimpledirect\/[^"']*)["']/g;
const SIDE_EFFECT = /\bimport\s*["'](@getsimpledirect\/[^"']*)["']/g;
const DYNAMIC = /\b(?:import|require)\s*\(\s*["'`](@getsimpledirect\/[^"'`]*)["'`]/g;
const EQUALS_REQUIRE = /\bimport\s+[\w$]+\s*=\s*require\s*\(\s*["'](@getsimpledirect\/[^"']*)["']/g;

function isTypeOnlyClause(clause) {
	const trimmed = clause.trim();
	if (/^type\b/.test(trimmed)) return true;
	const braces = trimmed.match(/^\{([\s\S]*)\}$/);
	if (!braces) return false;
	const specifiers = braces[1]
		.split(",")
		.map((specifier) => specifier.trim())
		.filter(Boolean);
	return specifiers.length > 0 && specifiers.every((specifier) => /^type\b/.test(specifier));
}

function scanSource(path) {
	const source = readFileSync(path, "utf8");
	const findings = [];
	if (!source.includes(PREFIX)) return findings;
	findings.push(...unterminatedRangeFindings(source, lexRanges(source)));
	for (const match of source.matchAll(STATIC_FROM)) {
		const [, keyword, clause, specifier] = match;
		if (isTypeOnlyClause(clause)) continue;
		findings.push({ line: lineOf(source, match.index), detail: `${keyword} ${clause.trim()} from "${specifier}"` });
	}
	for (const pattern of [SIDE_EFFECT, DYNAMIC, EQUALS_REQUIRE]) {
		for (const match of source.matchAll(pattern)) {
			findings.push({ line: lineOf(source, match.index), detail: match[0].replace(/\s+/g, " ") });
		}
	}
	// Anything the import grammar above did not classify still counts: `require.resolve`, template
	// specifiers, `export *`, concatenation, and comments. The prefix rule is the backstop in source
	// mode too, exempting only the exact spans of type-only statements in TypeScript.
	const coveredLines = new Set(findings.map((finding) => finding.line));
	const spans = TYPESCRIPT_EXTENSIONS.has(extname(path)) ? typeOnlyStatementSpans(source) : [];
	for (let offset = source.indexOf(PREFIX); offset !== -1; offset = source.indexOf(PREFIX, offset + PREFIX.length)) {
		const line = lineOf(source, offset);
		if (coveredLines.has(line)) continue;
		if (spans.some(([start, stop]) => start <= offset && offset < stop)) continue;
		const lineStart = source.lastIndexOf("\n", offset) + 1;
		const lineEnd = source.indexOf("\n", offset);
		findings.push({ line, detail: `${PREFIX} referenced outside a type-only import: ${source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim()}` });
	}
	return findings;
}

// Character spans (not lines) of type-only import/export statements — item 1 of #243: a runtime
// reference on the same line as an allowed `import type` used to be exempted with it. A span is
// accepted ONLY when its `import`/`export` keyword starts outside every string, template and
// comment range (#244 review: import-shaped text inside a template literal was being exempted) AND
// sits at statement position — preceded, modulo spaces/tabs, by start-of-file, `;`, `}` or a newline.
function typeOnlyStatementSpans(source, ranges = lexRanges(source)) {
	const insideRange = (offset) => ranges.some((range) => range.start <= offset && offset < range.end);
	const atStatementPosition = (offset) => {
		const before = source.slice(0, offset).replace(/[ \t]+$/, "");
		return before === "" || /[;}\n]$/.test(before);
	};
	const spans = [];
	for (const match of source.matchAll(STATIC_FROM)) {
		const [statement, , clause] = match;
		if (!isTypeOnlyClause(clause)) continue;
		if (insideRange(match.index)) continue;
		if (!atStatementPosition(match.index)) continue;
		spans.push([match.index, match.index + statement.length]);
	}
	return spans;
}

function scanShipped(path) {
	const buffer = readFileSync(path);
	// Raw bytes first: binary classification never suppresses a hit (item 5 of #243).
	if (!buffer.includes(PREFIX)) return [];
	if (basename(path) === "package.json") return scanManifest(path);
	if (basename(path) === "package-lock.json" || basename(path) === ".package-lock.json") return scanLockfile(path);
	const isTypeScript = TYPESCRIPT_EXTENSIONS.has(extname(path)) || path.endsWith(".d.ts");
	// A .ts/.d.ts file is read RAW — comments included, since a comment is never an exemption — and
	// only the exact spans of type-only statements are exempt (item 1), each accepted only when it
	// starts outside every string/template/comment range and at statement position. A range left
	// unterminated at end of file is itself a violation. Anything else — a .js, an executable, a
	// blob — is checked byte-for-byte with no exemption at all.
	const source = isTypeScript ? buffer.toString("utf8") : buffer.toString("latin1");
	const ranges = isTypeScript ? lexRanges(source) : [];
	const spans = isTypeScript ? typeOnlyStatementSpans(source, ranges) : [];
	const findings = isTypeScript ? unterminatedRangeFindings(source, ranges) : [];
	for (let offset = source.indexOf(PREFIX); offset !== -1; offset = source.indexOf(PREFIX, offset + PREFIX.length)) {
		if (spans.some(([start, stop]) => start <= offset && offset < stop)) continue;
		const lineStart = source.lastIndexOf("\n", offset) + 1;
		const lineEnd = source.indexOf("\n", offset);
		const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
		findings.push({ line: lineOf(source, offset), detail: `${PREFIX} in a shipped file: ${line.slice(0, 160)}` });
	}
	return findings;
}

// Item 2 of #243: the prefix may appear in a package.json ONLY as an exact devDependencies key.
// `imports` maps, npm aliases ("x": "npm:@getsimpledirect/y"), custom fields, and every other
// key or value that carries it are violations.
function scanManifest(path) {
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [{ line: 0, detail: "package.json is not valid JSON" }];
	}
	const findings = [];
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		for (const name of Object.keys(manifest[field] ?? {})) {
			if (name.startsWith(SCOPE)) findings.push({ line: 0, detail: `${field}.${name}` });
		}
	}
	const isExemptDevKey = (trail, key) => trail.length === 1 && trail[0] === "devDependencies" && key.startsWith(SCOPE);
	walkJson(manifest, [], (trail, key, value) => {
		if (key !== undefined && key.includes(PREFIX) && !isExemptDevKey(trail, key)) {
			findings.push({ line: 0, detail: `key ${[...trail, key].join(".")} names the private scope` });
		}
		if (typeof value === "string" && value.includes(PREFIX)) {
			findings.push({ line: 0, detail: `${[...trail, key ?? "[]"].join(".")} = ${JSON.stringify(value)}` });
		}
	});
	return findings;
}

// Visit every key/value pair in a JSON document. `visit(trail, key, value)` is called for object
// members (key defined) and array elements (key undefined) alike, before descending.
function walkJson(node, trail, visit) {
	if (Array.isArray(node)) {
		for (const item of node) {
			visit(trail, undefined, item);
			walkJson(item, trail, visit);
		}
		return;
	}
	if (node && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			visit(trail, key, value);
			walkJson(value, [...trail, key], visit);
		}
	}
}

// npm's lockfile (and the hidden node_modules/.package-lock.json that every install carries) lists
// the devDependency. That entry is inert — the files it describes are excluded from the archive —
// but only while it is marked `"dev": true`. Any private-scope entry that is not dev-only, or a
// root manifest section in the lockfile that lists the scope as a runtime dependency, is a violation.
const EXACT_SCOPED_PACKAGE_PATH = /(?:^|\/)node_modules\/@getsimpledirect\/[^/]+$/;
function scanLockfile(path) {
	let lock;
	try {
		lock = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [{ line: 0, detail: "lockfile is not valid JSON" }];
	}
	const findings = [];
	const packages = lock.packages ?? {};
	for (const [key, entry] of Object.entries(packages)) {
		if (key === "") {
			for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
				for (const name of Object.keys(entry?.[field] ?? {})) {
					if (name.startsWith(SCOPE)) findings.push({ line: 0, detail: `packages[""].${field}.${name}` });
				}
			}
			continue;
		}
		// Item 3 of #243: only an EXACT node_modules/@getsimpledirect/<name> path marked dev-only is
		// inert. `@getsimpledirect-wrapper`, `@getsimpledirect/x/lib`, or a non-dev entry is not.
		const exact = EXACT_SCOPED_PACKAGE_PATH.test(key);
		if (exact && entry && typeof entry === "object" && entry.dev === true) continue;
		if (exact) {
			findings.push({ line: 0, detail: `lockfile entry ${key} is not dev-only` });
			continue;
		}
		if (key.includes(PREFIX)) findings.push({ line: 0, detail: `lockfile entry ${key} names the private scope` });
		walkJson(entry, ["packages", key], (trail, member, value) => {
			if (member !== undefined && member.includes(PREFIX)) findings.push({ line: 0, detail: `lockfile ${[...trail, member].join(".")}` });
			if (typeof value === "string" && value.includes(PREFIX)) findings.push({ line: 0, detail: `lockfile ${[...trail, member ?? "[]"].join(".")} = ${JSON.stringify(value)}` });
		});
	}
	for (const [name, entry] of Object.entries(lock.dependencies ?? {})) {
		if (name.startsWith(SCOPE) && !(entry && typeof entry === "object" && entry.dev === true)) {
			findings.push({ line: 0, detail: `lockfile dependency ${name} is not dev-only` });
		} else if (!name.startsWith(SCOPE) && name.includes(PREFIX)) {
			findings.push({ line: 0, detail: `lockfile dependency ${name} names the private scope` });
		}
	}
	for (const [key, value] of Object.entries(lock)) {
		if (key === "packages" || key === "dependencies") continue;
		if (typeof value === "string" && value.includes(PREFIX)) findings.push({ line: 0, detail: `lockfile ${key} = ${JSON.stringify(value)}` });
	}
	return findings;
}

const args = process.argv.slice(2);
let mode;
const targets = { manifest: [], source: [], shipped: [] };
for (const arg of args) {
	if (arg === "--manifest" || arg === "--source" || arg === "--shipped" || arg === "--built") {
		mode = arg === "--built" ? "shipped" : arg.slice(2);
		continue;
	}
	if (!mode) {
		console.error("usage: scan-contracts-runtime-imports.mjs (--manifest <package.json>... | --source <path>... | --shipped <path>...)+");
		process.exit(2);
	}
	targets[mode].push(resolve(arg));
}

const cwd = process.cwd();
const display = (path) => {
	const local = relative(cwd, path);
	return local.startsWith("..") ? path : local;
};

let hits = 0;
let scanned = 0;
const report = (path, findings) => {
	for (const finding of findings) {
		hits++;
		console.error(`${display(path)}${finding.line ? `:${finding.line}` : ""}: ${finding.detail}`);
	}
};

for (const manifest of targets.manifest) {
	scanned++;
	report(manifest, scanManifest(manifest));
}
for (const target of targets.source) {
	for (const file of walkSources(target)) {
		scanned++;
		report(file, scanSource(file));
	}
}
for (const target of targets.shipped) {
	const root = realpathSync(target);
	const containment = lstatSync(root).isDirectory() ? root : dirname(root);
	const symlinkFindings = [];
	const files = walkShipped(target, containment, [], symlinkFindings);
	for (const finding of symlinkFindings) {
		scanned++;
		report(finding.path, [{ line: 0, detail: finding.detail }]);
	}
	for (const file of files) {
		scanned++;
		report(file, scanShipped(file));
	}
}

if (hits > 0) {
	console.error(`${hits} runtime reference(s) to ${SCOPE}* across ${scanned} file(s)`);
	process.exit(1);
}
console.log(`  ✓ ${scanned} file(s) scanned: no runtime reference to ${SCOPE}*`);
