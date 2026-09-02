import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePackageExcludes } from "../scripts/runtime-package-closure.mjs";

const artifactArgument = process.argv[2];
if (!artifactArgument) throw new Error("Usage: packaged-runtime-probe.mjs <unpacked-artifact-root>");
const artifactRoot = realpathSync(artifactArgument);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const authorityRoot = process.env.VINCI_PACKAGED_AUTHORITY_ROOT ?? repositoryRoot;
const checker = process.env.VINCI_PACKAGED_CHECKER
	?? join(repositoryRoot, "vinci", "test", "packaged-artifact-check.mjs");
const authorityNpmCache = process.env.npm_config_cache
	?? (process.env.HOME ? join(process.env.HOME, ".npm") : undefined);
const cleanEnv = {
	...process.env,
	HOME: mkdtempSync(join(tmpdir(), "vinci-packaged-probe-home-")),
	...(authorityNpmCache ? { npm_config_cache: authorityNpmCache } : {}),
	VINCI_NO_BOOTSTRAP_HEAL: "1",
	VINCI_UPDATE_DISABLED: "1",
};
const scratchRoots = [cleanEnv.HOME];

function run(command, args, cwd = artifactRoot) {
	return spawnSync(command, args, { cwd, encoding: "utf8", env: cleanEnv, timeout: 30_000 });
}

function output(result) {
	return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

try {
	const checked = spawnSync(process.execPath, [checker, artifactRoot], {
		cwd: tmpdir(),
		encoding: "utf8",
		env: { ...cleanEnv, VINCI_PACKAGED_AUTHORITY_ROOT: authorityRoot },
		timeout: 120_000,
	});
	assert.equal(checked.status, 0, output(checked));

	for (const excluded of runtimePackageExcludes(authorityRoot)) {
		assert.equal(existsSync(join(artifactRoot, ...excluded.split("/"))), false, `${excluded} must not ship`);
	}

	const launcher = join(artifactRoot, "vinci", "bin", "vinci");
	const identity = JSON.parse(readFileSync(join(artifactRoot, "vinci", "identity.json"), "utf8"));
	const version = run(launcher, ["--version"]);
	assert.equal(version.status, 0, output(version));
	assert.equal(version.stdout.trim(), identity.version);

	const help = run(launcher, ["--help"]);
	assert.equal(help.status, 0, output(help));
	assert.match(output(help), /Usage:/);

	const directHelp = run(process.execPath, [join(artifactRoot, "packages", "coding-agent", "dist", "cli.js"), "--help"]);
	assert.equal(directHelp.status, 0, output(directHelp));
	assert.match(output(directHelp), /Usage:/);

	const worker = run(launcher, ["worker"]);
	assert.equal(worker.status, 1, output(worker));
	assert.match(output(worker), /vinci worker: Usage:/);

	function checkSymlinks(directory) {
		for (const entry of readdirSync(directory)) {
			const path = join(directory, entry);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) {
				const target = realpathSync(path);
				const rel = relative(artifactRoot, target);
				assert.ok(rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)), `${path} escapes`);
			} else if (stat.isDirectory()) checkSymlinks(path);
		}
	}
	checkSymlinks(artifactRoot);

	const attackRoot = mkdtempSync(join(tmpdir(), "vinci-packaged-parent-probe-"));
	scratchRoots.push(attackRoot);
	const payload = join(attackRoot, "payload");
	cpSync(artifactRoot, payload, { recursive: true, verbatimSymlinks: true });
	const payloadChalk = join(payload, "node_modules", "chalk");
	assert.ok(existsSync(payloadChalk), "real packaged Chalk dependency is required for the parent-resolution probe");
	mkdirSync(join(attackRoot, "node_modules"));
	renameSync(payloadChalk, join(attackRoot, "node_modules", "chalk"));
	const malformed = spawnSync(process.execPath, [checker, payload], {
		cwd: tmpdir(),
		encoding: "utf8",
		env: { ...cleanEnv, VINCI_PACKAGED_AUTHORITY_ROOT: authorityRoot },
		timeout: 120_000,
	});
	assert.equal(malformed.status, 1, output(malformed));
	assert.match(
		malformed.stderr,
		/(?:node_modules\/chalk\/.*required by the trusted package layout is missing|-> chalk resolves outside the artifact root)/,
	);

	console.log("packaged-runtime-probe: certified package, CLI help, direct CLI, worker, metadata, symlinks, and parent refusal passed");
} finally {
	for (const scratchRoot of scratchRoots) rmSync(scratchRoot, { recursive: true, force: true });
}
