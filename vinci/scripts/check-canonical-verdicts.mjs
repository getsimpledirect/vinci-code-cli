#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const canonicalVerdicts = resolve(repoRoot, "vinci/extensions/lib/canonical-verdicts.ts");
const launcherParser = resolve(repoRoot, "vinci/test/launcher-extensions.mjs");
const statusPattern = /(["'`])(VERIFIED_PASS|BLOCKED|CONDITIONAL|FAILED|CANCELLED)\1/g;

function filesUnder(path) {
	const entries = readdirSync(path, { withFileTypes: true });
	return entries.flatMap((entry) => {
		const entryPath = resolve(path, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "dist" || entry.name === "node_modules" || entry.name === "test") return [];
			return filesUnder(entryPath);
		}
		return entry.isFile() ? [entryPath] : [];
	});
}

function defaultFiles() {
	const productionTypeScript = [resolve(repoRoot, "vinci/extensions"), resolve(repoRoot, "vinci/bin")]
		.flatMap(filesUnder)
		.filter((path) => extname(path) === ".ts");
	const launcherTests = readdirSync(resolve(repoRoot, "vinci/test"), { withFileTypes: true })
		.filter((entry) => entry.isFile() && extname(entry.name) === ".mjs")
		.map((entry) => resolve(repoRoot, "vinci/test", entry.name));
	return [...productionTypeScript, ...launcherTests];
}

function inputFiles(args) {
	if (args.length === 0) return defaultFiles();
	return args.flatMap((arg) => {
		const path = resolve(arg);
		try {
			return filesUnder(path).filter((candidate) => [".ts", ".mjs"].includes(extname(candidate)));
		} catch (error) {
			if (error?.code === "ENOTDIR") return [path];
			throw error;
		}
	});
}

function displayPath(path) {
	const local = relative(repoRoot, path);
	return local.startsWith("..") ? path : local;
}

function codeBeforeLineComment(line) {
	let quote;
	for (let index = 0; index < line.length; index++) {
		const character = line[index];
		if (quote) {
			if (character === "\\") index++;
			else if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			continue;
		}
		if (character === "/" && line[index + 1] === "/") return line.slice(0, index);
	}
	return line;
}

function structuralLiteralContexts(source) {
	const contexts = new Map();
	const bracketStack = [];
	const parenthesisStack = [];
	let blockComment = false;
	let lineNumber = 1;
	let lineStart = 0;

	const record = (index, kind) => {
		const key = `${lineNumber}:${index - lineStart}`;
		const found = contexts.get(key) ?? new Set();
		found.add(kind);
		contexts.set(key, found);
	};

	for (let index = 0; index < source.length; index++) {
		const character = source[index];
		const next = source[index + 1];
		if (character === "\n") {
			lineNumber++;
			lineStart = index + 1;
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				blockComment = false;
				index++;
			}
			continue;
		}
		if (character === "/" && next === "*") {
			blockComment = true;
			index++;
			continue;
		}
		if (character === "/" && next === "/") {
			const newline = source.indexOf("\n", index);
			if (newline === -1) break;
			index = newline - 1;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			const start = index;
			for (index++; index < source.length; index++) {
				if (source[index] === "\n") {
					lineNumber++;
					lineStart = index + 1;
				} else if (source[index] === "\\") index++;
				else if (source[index] === character) break;
			}
			const literal = source.slice(start, index + 1);
			if (/^(["'`])(VERIFIED_PASS|BLOCKED|CONDITIONAL|FAILED|CANCELLED)\1$/.test(literal)) {
				if (bracketStack.some((entry) => entry)) record(start, "array literal");
				if (parenthesisStack.some((entry) => entry === "Set")) record(start, "Set");
				if (parenthesisStack.some((entry) => entry === "includes")) record(start, "includes");
			}
			continue;
		}
		if (character === "[") {
			const prefix = source.slice(lineStart, index).trimEnd();
			const previous = prefix.at(-1);
			bracketStack.push(previous === undefined || !/[\w$)\]]/.test(previous));
			continue;
		}
		if (character === "]") {
			bracketStack.pop();
			continue;
		}
		if (character === "(") {
			const prefix = source.slice(lineStart, index);
			parenthesisStack.push(/\bnew\s+Set\s*$/.test(prefix) ? "Set" : /\.includes\s*$/.test(prefix) ? "includes" : undefined);
			continue;
		}
		if (character === ")") parenthesisStack.pop();
	}
	return contexts;
}

function isTypePosition(line, literalIndex) {
	const prefix = line.slice(0, literalIndex);
	return (
		/^\s*(?:export\s+)?type\b[^=]*=/.test(prefix) ||
		/^\s*(?:readonly\s+)?[\w$]+\??\s*:/.test(prefix) ||
		/^\s*(?:export\s+)?interface\b/.test(prefix)
	);
}

function isLocalTaskStateComparison(status, beforeOperator, afterOperator) {
	if (status !== "BLOCKED") return false;
	// BLOCKED is also a VinciTaskState. Comparisons against a property named exactly `state` govern
	// local task flow, not remote verdict semantics; displayState is intentionally not exempt here
	// and must carry the rendering marker when it selects user-facing copy.
	const stateExpression = /(?:^|[^\w$])(?:[\w$]+\.)*state\s*$/;
	return stateExpression.test(beforeOperator) || /^\s*(?:[\w$]+\.)*state(?:[^\w$]|$)/.test(afterOperator);
}

function comparisonKind(line, literalIndex, literalLength, status) {
	const before = line.slice(0, literalIndex);
	const after = line.slice(literalIndex + literalLength);
	const operatorBefore = before.match(/(===|!==)\s*$/);
	if (operatorBefore) {
		const operand = before.slice(0, operatorBefore.index);
		return isLocalTaskStateComparison(status, operand, "") ? undefined : "comparison";
	}
	const operatorAfter = after.match(/^\s*(===|!==)/);
	if (operatorAfter) {
		const operand = after.slice(operatorAfter[0].length);
		return isLocalTaskStateComparison(status, "", operand) ? undefined : "comparison";
	}
	return undefined;
}

function scanTypeScript(path, source) {
	if (path === canonicalVerdicts) return [];
	const findings = [];
	const lines = source.split("\n");
	const structuralContexts = structuralLiteralContexts(source);
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const originalLine = lines[lineIndex];
		const line = codeBeforeLineComment(originalLine);
		const comment = originalLine.slice(line.length);
		if (comment.startsWith("//") && comment.includes("canonical-rendering")) continue;
		statusPattern.lastIndex = 0;
		for (const match of line.matchAll(statusPattern)) {
			const literalIndex = match.index;
			if (isTypePosition(line, literalIndex)) continue;
			const contexts = structuralContexts.get(`${lineIndex + 1}:${literalIndex}`);
			const kind = /\bcase\s*$/.test(line.slice(0, literalIndex))
				? "switch case"
				: comparisonKind(line, literalIndex, match[0].length, match[2]) ??
					(contexts?.has("array literal")
						? "array literal"
						: contexts?.has("Set")
							? "Set"
							: contexts?.has("includes")
								? "includes"
								: undefined);
			if (kind) findings.push({ path, line: lineIndex + 1, status: match[2], kind });
		}
	}
	return findings;
}

function scanLauncherRegex(path, source) {
	if (path === launcherParser) return [];
	const findings = [];
	for (const [lineIndex, line] of source.split("\n").entries()) {
		const extension = line.indexOf('--extension "');
		if (extension !== -1 && line.lastIndexOf("/", extension) !== -1) {
			findings.push({ path, line: lineIndex + 1, kind: "launcher extension regex" });
		}
	}
	return findings;
}

const findings = inputFiles(process.argv.slice(2)).flatMap((path) => {
	const source = readFileSync(path, "utf8");
	return extname(path) === ".ts" ? scanTypeScript(path, source) : scanLauncherRegex(path, source);
});

if (findings.length === 0) {
	console.log("canonical verdict sweep: ok");
} else {
	for (const finding of findings) {
		const detail = finding.status ? `${finding.kind} uses ${finding.status}` : finding.kind;
		console.error(`${displayPath(finding.path)}:${finding.line}: ${detail}`);
	}
	console.error(
		`canonical verdict sweep: ${findings.length} independent decision${findings.length === 1 ? "" : "s"} found; use canonical-verdicts.ts or launcher-extensions.mjs`,
	);
	process.exitCode = 1;
}
