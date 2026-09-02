#!/usr/bin/env node
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const [directory, pid] = process.argv.slice(2);
if (!directory || !pid) process.exit(64);

for (const name of readdirSync(directory)) {
	if (!/^update\.mjs\.heal-[0-9]+$/.test(name) || name === `update.mjs.heal-${pid}`) continue;
	try {
		const path = join(directory, name);
		const details = lstatSync(path);
		if (details.isFile() && Date.now() - details.mtimeMs > 60 * 60 * 1000) unlinkSync(path);
	} catch {}
}
