#!/usr/bin/env node
/**
 * Pre-commit secret scanner.
 *
 * Scans ONLY staged content (`git diff --cached`) so it never fires on committed
 * history or the working tree, stays fast, and a contributor can safely re-stage
 * a fixed line. On detection it fails closed, prints the file + line number
 * (never the secret value), explains removal, and honestly documents the
 * `--no-verify` escape hatch.
 *
 * Detection patterns are NOT duplicated here. They are derived at runtime from
 * the single source of truth `TOKEN_PATTERNS` in
 * `packages/coding-agent/src/core/vinci-mask-secrets.ts`. That is the build-time
 * owner of the credential shapes, so this scanner cannot drift from the masking
 * decision engine. If that array is renamed or the file is deleted the
 * derivation throws loudly instead of silently scanning stale patterns.
 *
 * Allowlist (per line, so a real leak on an unrelated line is still caught):
 *   - a `TESTONLY` marker (repo convention for synthetic test vectors),
 *   - a `# pragma: allowlist secret` / `allowlist-secret` comment (the standard
 *     gitleaks / trufflehog marker, and the checked-in mechanism for contributors
 *     to add test vectors without editing this scanner).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
const MASK_SECRETS_SOURCE = resolve(ROOT, "packages/coding-agent/src/core/vinci-mask-secrets.ts");

/**
 * Derive the credential patterns straight from vinci-mask-secrets.ts so we never
 * drift from the masking engine. Returns RegExp objects (global flag stripped so
 * per-line testing is deterministic).
 */
export function loadTokenPatterns() {
	const src = readFileSync(MASK_SECRETS_SOURCE, "utf8");
	const block = src.match(/const TOKEN_PATTERNS = \[([\s\S]*?)\n\];/);
	if (!block) {
		throw new Error(
			"check-secrets: cannot locate `TOKEN_PATTERNS` in vinci-mask-secrets.ts. The pattern " +
				"source moved or was renamed. Refuse to scan with stale patterns; update the sync " +
				"mechanism in scripts/check-secrets.mjs.",
		);
	}
	const parsed = [];
	// Parse each array entry (a single-line regex literal: /PATTERN/FLAGS,
	// e.g. /sk-ant-[A-Za-z0-9_-]{20,}/g) per line so escaped characters and
	// trailing commas cannot bleed into the flags of the next pattern. The body
	// group allows any backslash escape (`\\/`, `\\.`, `\\d`, ...).
	const literal = /^\/((?:\\\\.|[^\\\\/])*)\/([a-z]*),?$/;
	for (const rawLine of block[1].split("\n")) {
		const trimmed = rawLine.trim();
		if (trimmed.startsWith("];")) break;
		const match = literal.exec(trimmed);
		if (match) parsed.push(new RegExp(match[1], match[2]));
	}
	// Test seam: let a CI / test harness disable exactly one pattern by index to
	// prove every named detection is load-bearing (see scripts/check-secrets.test.mjs).
	const disabled = process.env.CHECK_SECRETS_DISABLE_PATTERN;
	if (disabled !== undefined) {
		const idx = Number(disabled);
		if (!Number.isInteger(idx) || idx < 0 || idx >= parsed.length) {
			throw new Error(`check-secrets: CHECK_SECRETS_DISABLE_PATTERN=${disabled} is not a valid pattern index`);
		}
		parsed.splice(idx, 1);
	}
	return parsed;
}

/** Per-line allowlist. Returns true when a line is a deliberate look-alike. */
export function isAllowlisted(line) {
	if (/TESTONLY/i.test(line)) return true;
	if (/EXAMPLE/i.test(line)) return true;
	if (/pragma:\s*allowlist[-\s]?secret/i.test(line)) return true;
	if (/allowlist[-\s_]?secret/i.test(line)) return true;
	if (/(fake|test|dummy|sample|mock|demo|placeholder)[-_]?key/i.test(line)) return true;
	if (/(real|fake|test|dummy|sample|mock|demo)[-_]?(api|secret|token|password|credential)/i.test(line)) return true;
	return false;
}

/**
 * 🔴 Structural heuristics apply to the MATCHED TOKEN, never to the whole line.
 *
 * These previously ran against the line. That was a fail-open: any line containing
 * `aaaa`, `xxxx`, `1111`, `9999` or `0123456789` ANYWHERE — a ticket number, a
 * version string, a redacted example sitting beside a real value — silently
 * disabled detection for that entire line. Verified before the fix: a real-shaped
 * sk-ant-api03- key was caught, and the SAME key with `aaaa` in its body was not.
 *
 * Judging the token itself keeps hand-typed fixtures allowlisted without letting
 * incidental line content switch the scanner off.
 */
function looksSynthetic(token) {
	if (/0123456789|abcdefghij/i.test(token)) return true;   // full sequential runs
	if (/(.)\1{5,}/.test(token)) return true;                 // six or more identical chars
	if (/^(?:(.)(.))\1\2\1\2/.test(token)) return true;      // alternating AaAaAa filler
	if (new Set(token).size <= 4) return true;                // near-zero alphabet
	return false;
}

/**
 * Scan an array of lines, returning hits as [{ line, content }]. Each line is
 * checked against every token pattern unless it is allowlisted.
 */
export function scanLines(lines, patterns = loadTokenPatterns()) {
	const nonGlobal = patterns.map((p) => new RegExp(p.source, p.flags.replace(/g/g, "")));
	const hits = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (isAllowlisted(line)) continue;
		for (const pattern of nonGlobal) {
			const m = pattern.exec(line);
			if (m && !looksSynthetic(m[0])) {
				hits.push({ line: i + 1, content: line });
				break;
			}
		}
	}
	return hits;
}

/** Scan a whole text blob (used by tests and non-git paths). */
export function scanText(text, patterns = loadTokenPatterns()) {
	return scanLines(text.split("\n"), patterns);
}

/**
 * Scan staged content (git diff --cached), returning hits as
 * [{ file, line }]. Only the new-file (added) side is inspected and line numbers
 * correspond to the file as it will exist after the commit.
 */
export function scanStaged(patterns = loadTokenPatterns()) {
	let diff;
	try {
		diff = execFileSync("git", ["diff", "--cached"], { encoding: "utf8", cwd: ROOT });
	} catch (error) {
		throw new Error(`check-secrets: could not read staged diff: ${error.message}`);
	}
	const hits = [];
	let file = null;
	let newLine = 0;
	const nonGlobal = patterns.map((p) => new RegExp(p.source, p.flags.replace(/g/g, "")));
	for (const rawLine of diff.split("\n")) {
		if (rawLine.startsWith("diff --git ")) {
			const m = rawLine.match(/ b\/(.+)$/);
			file = m ? m[1] : null;
			continue;
		}
		const hunk = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			newLine = Number(hunk[1]) - 1; // hunk header is 1-based
			continue;
		}
		if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
			newLine++;
			if (file !== null && !isAllowlisted(rawLine.slice(1))) {
				for (const pattern of nonGlobal) {
					if (pattern.test(rawLine.slice(1))) {
						hits.push({ file, line: newLine });
						break;
					}
				}
			}
		} else if (rawLine.startsWith(" ") && !rawLine.startsWith("+++")) {
			newLine++; // unchanged context advances the new-file line counter
		}
	}
	return hits;
}

function report(hits, opts) {
	const out = opts?.out ?? process.stdout;
	for (const hit of hits) {
		out.write(`check-secrets: ${hit.file}:${hit.line}: rejected staged change — possible credential detected\n`);
	}
}

export function main(argv = process.argv.slice(2), opts = {}) {
	const patterns = opts.patterns ?? loadTokenPatterns();
	let hits = [];
	let scanned = 0;

	if (argv[0] === "--files") {
		// Non-git mode used by CI / this repo's own false-positive fixture check:
		// scan the given files' current content line by line.
		for (const rel of argv.slice(1)) {
			const abs = resolve(ROOT, rel);
			const text = readFileSync(abs, "utf8");
			const fileHits = scanText(text, patterns);
			for (const h of fileHits) hits.push({ file: rel, line: h.line });
			scanned++;
		}
	} else {
		hits = scanStaged(patterns);
		scanned = 1;
	}

	report(hits, opts);
	const out = opts?.out ?? process.stdout;
	if (hits.length > 0) {
		out.write(
			"\nStaged content looks like it contains a real credential (a value matching a known key shape,\n" +
				"not a TESTONLY / allowlisted test vector). Remove the secret, then re-stage the fixed file\n" +
				"and commit again:\n\n" +
				"    git add <file>\n    git commit\n\n" +
				"If you are absolutely sure this is a deliberate, non-secret value, add a `# pragma: allowlist secret`\n" +
				"comment or a `TESTONLY` marker to that line. To bypass this hook entirely (not recommended), commit\n" +
				"with:\n\n    git commit --no-verify\n",
		);
		return 1;
	}
	out.write(`check-secrets: no staged secrets detected (${scanned} staged source(s) scanned)\n`);
	return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main();
}
