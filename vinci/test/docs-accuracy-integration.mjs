import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

/** Every public-facing doc in the exported tree. `ops/` never ships, so it is out of scope. */
function docs(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (["node_modules", ".git", "ops", "dist", "release"].includes(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) docs(full, out);
		else if (entry.endsWith(".md") || entry.endsWith(".tape")) out.push(full);
	}
	return out;
}

const files = docs(root);
assert.ok(files.length > 10, `expected to find public docs, found ${files.length}`);

const violations = [];
for (const file of files) {
	const text = readFileSync(file, "utf8");
	const rel = file.slice(root.length + 1);
	if (rel.startsWith("vinci/UPSTREAM-")) continue; // upstream Pi's own docs, preserved verbatim

	// 1. The opt-in is obsolete: providers are OPEN by default and no account is required.
	//    Telling a reader to set this makes the product look gated when it is not.
	for (const [i, line] of text.split("\n").entries()) {
		if (/VINCI_SHOW_OTHER_PROVIDERS\s*=\s*1/.test(line)) {
			violations.push(`${rel}:${i + 1} teaches the obsolete opt-in (default is already open)`);
		}
		// 2. A private repository a public reader cannot open.
		if (/getsimpledirect\/vinci-code(?!-cli|-releases)\b/.test(line)) {
			violations.push(`${rel}:${i + 1} points at the private repo`);
		}
		// 3. Claims that were TRUE for a managed-only product and are FALSE for a BYOK client.
		//    Each of these actually shipped in vinci/README.md and had to be corrected by hand.
		for (const [pattern, why] of [
			[/redacted before session persistence/i, "false: redaction is display+egress, NOT at rest"],
			[/managed cloud product/i, "false: works with your own provider key too"],
			[/(?:\/login|\/model)[^.\n]*show only Vinci/i, "false: every Pi provider is offered"],
			[/Vinci is single-provider/i, "false: BYOK is supported"],
			[/sends? (?:your |the )?key nowhere/i, "false: the key IS sent to the chosen provider"],
		]) {
			if (pattern.test(line) && !/^>|earlier version|claimed/.test(line.trim())) {
				violations.push(`${rel}:${i + 1} ${why}`);
			}
		}

		// 4. A pinned version in an INSTALL-facing doc goes stale the moment anything ships, and
		//    tells a new reader they have the wrong build. Excluded: changelogs and release notes
		//    (naming versions is their point), and comparative/historical references like "older
		//    than 0.0.42 predates the dev gate", which are version THRESHOLDS, not stale pins.
		//    A guard that fires on correct content is a guard somebody disables.
		const installFacing = /README\.md$/.test(rel) && !/release-notes/.test(rel);
		if (installFacing && /\bv?0\.0\.\d+\b/.test(line) && !/said|once|already|through five|older than|newer than|predates|prior to|since|before|from [0-9]/.test(line)) {
			violations.push(`${rel}:${i + 1} pins a version — use \`vinci --version\` instead`);
		}
	}
}

// Relative links must resolve. Moving vinci/SECURITY.md to the root silently broke three links
// that still pointed at the same directory — a dead link in a public doc is a wrong claim about
// where to report a vulnerability.
for (const file of files) {
	if (!file.endsWith(".md")) continue;
	const rel = file.slice(root.length + 1);
	// Only VINCI-owned docs. Upstream Pi's own docs use (url)/(link) template placeholders and are
	// not ours to police; policing them would make the guard noisy and it would get disabled.
	if (!/^(vinci\/|README\.md|CONTRIBUTING\.md|SECURITY\.md|UPSTREAM\.md|TRADEMARKS\.md|THIRD_PARTY_NOTICES\.md)/.test(rel)) continue;
	if (rel.startsWith("vinci/UPSTREAM-") || rel.includes("CHANGELOG") || rel.includes("release-notes")) continue;
	const text = readFileSync(file, "utf8");
	for (const [, target] of text.matchAll(/\]\(([^)#\s]+)\)/g)) {
		if (/^(https?:|mailto:|#)/.test(target)) continue;
		const resolved = resolve(dirname(file), target);
		try {
			statSync(resolved);
		} catch {
			violations.push(`${rel} links to a missing target: ${target}`);
		}
	}
}

assert.deepEqual(violations, [], `public docs are inaccurate:\n  ${violations.join("\n  ")}`);
process.stdout.write(
	`docs-accuracy-integration: ${files.length} public docs carry no obsolete opt-in, private-repo link, or pinned version\n`,
);
