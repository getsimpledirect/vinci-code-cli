import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const executableSuffix = process.platform === "win32" ? ".cmd" : "";

export const checks = [
	{
		name: "biome check --write --error-on-warnings .",
		command: `biome${executableSuffix}`,
		args: ["check", "--write", "--error-on-warnings", "."],
	},
	{
		name: "npm run check:pinned-deps",
		command: `npm${executableSuffix}`,
		args: ["run", "check:pinned-deps"],
	},

	{
		name: "npm run check:secrets",
		command: `npm${executableSuffix}`,
		args: ["run", "check:secrets"],
	},	{
		name: "npm run check:ts-imports",
		command: `npm${executableSuffix}`,
		args: ["run", "check:ts-imports"],
	},
	{
		name: "npm run check:shrinkwrap",
		command: `npm${executableSuffix}`,
		args: ["run", "check:shrinkwrap"],
	},
	{
		name: "npm run check:install-lock:coding-agent",
		command: `npm${executableSuffix}`,
		args: ["run", "check:install-lock:coding-agent"],
	},
	{
		name: "tsgo --noEmit",
		command: `tsgo${executableSuffix}`,
		args: ["--noEmit"],
	},
	{
		name: "npm run check:extensions",
		command: `npm${executableSuffix}`,
		args: ["run", "check:extensions"],
	},
	{
		name: "npm run check:browser-smoke",
		command: `npm${executableSuffix}`,
		args: ["run", "check:browser-smoke"],
	},
];

export function runChecks(checkDefinitions = checks, options = {}) {
	const spawn = options.spawn ?? spawnSync;
	const output = options.output ?? process.stdout;
	const results = [];

	for (const check of checkDefinitions) {
		output.write(`\n=== ${check.name} ===\n`);
		const result = spawn(check.command, check.args, { stdio: "inherit" });
		const status = result.status ?? 1;
		results.push({ name: check.name, status });
		if (result.error) {
			output.write(`${result.error.message}\n`);
		}
	}

	output.write("\nCheck results:\n");
	for (const result of results) {
		output.write(`${result.status === 0 ? "PASS" : "FAIL"} ${result.name} (exit ${result.status})\n`);
	}

	return results.some((result) => result.status !== 0) ? 1 : 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	process.exitCode = runChecks();
}
