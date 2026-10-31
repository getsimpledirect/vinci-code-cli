#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function labels(text, name) {
	const lines = text.replace(/\n$/, "").split("\n");
	if (lines.some((line) => !/^[a-z0-9][a-z0-9-]*$/.test(line))) {
		throw new Error(`invalid or empty group list "${name}"; regenerate the label artifact.`);
	}
	return lines;
}

export function checkTestShards(expectedText, shardTexts) {
	const expected = labels(expectedText, "expected");
	if (new Set(expected).size !== expected.length) {
		throw new Error('duplicate labels in "expected"; give each harness group a unique label.');
	}
	if (shardTexts.length !== 3) {
		throw new Error(`expected "3" shard lists, received "${shardTexts.length}"; restore every shard artifact.`);
	}
	const counts = new Map();
	for (const [index, text] of shardTexts.entries()) {
		for (const label of labels(text, `shard ${index + 1}`)) {
			counts.set(label, (counts.get(label) ?? 0) + 1);
		}
	}
	const duplicates = [...counts].filter(([, count]) => count !== 1).map(([label]) => label);
	if (duplicates.length) {
		throw new Error(`duplicate groups: "${duplicates.join(", ")}"; run each group in exactly one shard.`);
	}
	const missing = expected.filter((label) => !counts.has(label));
	if (missing.length) {
		throw new Error(`missing groups: "${missing.join(", ")}"; restore the omitted shard groups.`);
	}
	const expectedSet = new Set(expected);
	const unexpected = [...counts.keys()].filter((label) => !expectedSet.has(label));
	if (unexpected.length) {
		throw new Error(`unexpected groups: "${unexpected.join(", ")}"; use the same runtime and harness conditions.`);
	}
	return expected.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [expectedPath, shardDirectory] = process.argv.slice(2);
		if (!expectedPath || !shardDirectory || process.argv.length !== 4) {
			throw new Error('invalid arguments "check-test-shards"; supply an expected-label file and shard directory.');
		}
		const files = readdirSync(shardDirectory).sort();
		if (files.join(",") !== "groups-1.txt,groups-2.txt,groups-3.txt") {
			throw new Error(`invalid shard artifacts "${files.join(", ")}"; supply exactly groups-1.txt through groups-3.txt.`);
		}
		const count = checkTestShards(
			readFileSync(expectedPath, "utf8"),
			files.map((name) => readFileSync(resolve(shardDirectory, name), "utf8")),
		);
		console.log(`offline shard proof: ${count} groups ran exactly once across 3 shards`);
	} catch (error) {
		console.error(`offline shard proof failed: ${error.message}`);
		process.exitCode = 1;
	}
}
