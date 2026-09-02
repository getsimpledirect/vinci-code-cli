#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

function fail(message) {
	console.error(`vinci: invalid dispatch manifest: ${message}`);
	process.exit(65);
}

const [manifestPath, command] = process.argv.slice(2);
if (!manifestPath || command === undefined) {
	console.error("usage: resolve-dispatch.mjs <manifest> <command>");
	process.exit(64);
}

let manifest;
try {
	manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
	fail(error.message);
}

if (
	!manifest
	|| typeof manifest !== "object"
	|| Array.isArray(manifest)
	|| manifest.schema !== "vinci.node-dispatches/v1"
	|| !Array.isArray(manifest.dispatches)
	|| manifest.dispatches.length === 0
	|| Object.keys(manifest).sort().join(",") !== "dispatches,schema"
) {
	fail("wrong schema or no dispatches");
}

const commands = new Set();
let target;
for (const [index, entry] of manifest.dispatches.entries()) {
	if (
		!entry
		|| typeof entry !== "object"
		|| Array.isArray(entry)
		|| Object.keys(entry).sort().join(",") !== "command,target"
		|| typeof entry.command !== "string"
		|| !/^[a-z][a-z0-9-]*$/.test(entry.command)
		|| typeof entry.target !== "string"
		|| entry.target.length === 0
		|| isAbsolute(entry.target)
		|| entry.target.split("/").some((part) => part === "" || part === "." || part === "..")
		|| !/^[A-Za-z0-9._/-]+$/.test(entry.target)
	) {
		fail(`dispatches[${index}] is invalid`);
	}
	if (commands.has(entry.command)) fail(`duplicate command ${entry.command}`);
	commands.add(entry.command);
	if (entry.command === command) target = entry.target;
}

if (target === undefined) process.exit(3);
process.stdout.write(target);
