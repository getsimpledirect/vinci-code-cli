#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = process.argv[2] ?? join(root, ".github/workflows/vinci-release.yml");
const workflow = parse(readFileSync(workflowPath, "utf8"));
const steps = workflow.jobs.publish.steps;
const signing = steps.find((step) => step.name?.startsWith("Sign the TESTED archive"));
const checking = steps.find((step) => step.name?.startsWith("Verify the SIGNED manifest"));
const publishing = steps.find((step) => step.name?.startsWith("Publish the manifest LAST"));
assert.ok(signing?.run && checking?.run && publishing?.run, "Keep the real release signing, verification and activation steps available to their regression test.");

const temporary = mkdtempSync(join(root, "vinci/test/.release-cas-"));
const fixture = join(temporary, "fixture");
const bin = join(temporary, "bin");
const statePath = join(temporary, "state.json");
const callsPath = join(temporary, "calls.jsonl");
const keyPath = join(temporary, "fixture-key.pem");
const headersPath = join(temporary, "headers.txt");
const livePath = join(temporary, "live.json");
const outputPath = join(temporary, "outputs.txt");
const version = JSON.parse(readFileSync(join(root, "vinci/identity.json"), "utf8")).version;
const artifact = Buffer.from("Release fixture archive bytes, never a product release.\n");
const artifactPath = join(fixture, `release/vinci-code-${version}.tgz`);
const manifestPath = join(fixture, "release/manifest-beta.json");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const env = {
	PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
	HOME: temporary, TMPDIR: temporary, RUNNER_TEMP: temporary,
	VERSION: version, MINIMUM_VERSION: "0.0.09", S3_BUCKET: "fixture-bucket", S3_PREFIX: "vinci-code",
	MANIFEST_URL: "https://manifest.example.invalid/manifest-beta.json", GITHUB_OUTPUT: outputPath,
	FIXTURE_STATE: statePath, FIXTURE_CALLS: callsPath, FIXTURE_KEY: keyPath,
	FIXTURE_HEADERS: headersPath, FIXTURE_LIVE: livePath,
};
function executable(name, source) {
	const path = join(bin, name);
	writeFileSync(path, source);
	chmodSync(path, 0o755);
}
function reset(sequence = 43, headers = 'HTTP/1.1 200 OK\r\nETag: "revision-one"\r\n\r\n') {
	const signed = { sequence, version: "0.0.53" };
	const envelope = { signed, signature: sign(null, Buffer.from(JSON.stringify(signed)), privateKey).toString("base64") };
	writeFileSync(livePath, JSON.stringify(envelope));
	writeFileSync(headersPath, headers);
	writeFileSync(statePath, JSON.stringify({ etag: '"revision-one"', manifest: envelope, denied: false }));
	writeFileSync(callsPath, "");
	writeFileSync(outputPath, "");
	writeFileSync(manifestPath, "");
	writeFileSync(artifactPath, artifact);
}
function run(step, extraEnv = {}) {
	return spawnSync("bash", ["-c", step.run], { cwd: fixture, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 30000 });
}
function etag() {
	return readFileSync(outputPath, "utf8").match(/^live_etag=(.+)$/m)?.[1];
}
function puts() {
	return readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter((args) => args[0] === "s3api" || args[0] === "s3");
}
function candidate() {
	const result = run(signing);
	assert.equal(result.status, 0, result.stderr);
	const checked = run(checking);
	assert.equal(checked.status, 0, checked.stderr);
	return JSON.parse(readFileSync(manifestPath, "utf8"));
}
try {
	writeFileSync(join(temporary, ".gitignore"), "*\n");
	mkdirSync(bin);
	mkdirSync(join(fixture, "release"), { recursive: true });
	mkdirSync(join(fixture, "vinci/scripts"), { recursive: true });
	mkdirSync(join(fixture, "vinci/updater"), { recursive: true });
	copyFileSync(join(root, "vinci/scripts/create-update-manifest.mjs"), join(fixture, "vinci/scripts/create-update-manifest.mjs"));
	writeFileSync(keyPath, keyPem, { mode: 0o600 });
	writeFileSync(join(fixture, "vinci/updater/public-key.pem"), publicKey.export({ type: "spki", format: "pem" }));
	writeFileSync(`${artifactPath}.sha256`, `${createHash("sha256").update(artifact).digest("hex")}  vinci-code-${version}.tgz\n`);
	symlinkSync(process.execPath, join(bin, "node"));
	if (process.platform === "darwin") executable("sha256sum", '#!/bin/bash\nexec /usr/bin/shasum -a 256 "$@"\n');
	executable("curl", `#!${process.execPath}
import { copyFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("-D")) copyFileSync(process.env.FIXTURE_HEADERS, args[args.indexOf("-D") + 1]);
process.stdout.write(readFileSync(process.env.FIXTURE_LIVE));
`);
	executable("aws", `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "secretsmanager") {
  process.stdout.write(readFileSync(process.env.FIXTURE_KEY).toString("base64"));
} else {
  const state = JSON.parse(readFileSync(process.env.FIXTURE_STATE, "utf8"));
  const index = args.indexOf("--if-match");
  if (state.denied || index !== -1 && args[index + 1] !== state.etag) {
    process.stderr.write("Fixture AWS refused the manifest PUT. Inspect its permission or ETag before retrying.\\n");
    process.exit(1);
  }
  const body = args[0] === "s3" ? args[2] : args[args.indexOf("--body") + 1];
  state.manifest = JSON.parse(readFileSync(body, "utf8"));
  state.etag = '"activated"';
  writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
  process.stdout.write("Fixture manifest PUT accepted.\\n");
}
`);

	reset(43, 'HTTP/1.1 301 Moved\r\nETag: "redirect-old"\r\n\r\nHTTP/2 200\r\nETag: "revision-one"\r\n\r\n');
	const signed = candidate();
	assert.equal(signed.signed.sequence, 44);
	assert.equal(signed.signed.artifact.sha256, createHash("sha256").update(artifact).digest("hex"));
	assert.ok(verify(null, Buffer.from(JSON.stringify(signed.signed)), publicKey, Buffer.from(signed.signature, "base64")));
	assert.equal(etag(), '"revision-one"', "Bind activation to the final response body, not a redirect header.");
	assert.equal(run(publishing, { LIVE_ETAG: etag() }).status, 0);
	assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).manifest, signed);
	assert.equal(puts().length, 1);

	reset();
	candidate();
	const newer = { etag: '"revision-two"', manifest: { sequence: 45, version: "concurrent release" }, denied: false };
	writeFileSync(statePath, JSON.stringify(newer));
	const conflict = run(publishing, { LIVE_ETAG: etag() });
	assert.equal(conflict.status, 1, "Refuse a stale ETag instead of overwriting another writer's manifest.");
	assert.match(conflict.stdout, /Inspect the live manifest.*before retrying/);
	assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), newer);
	assert.equal(puts().length, 1, "Never retry a stale sequence automatically.");

	reset(43, "HTTP/1.1 200 OK\r\n\r\n");
	const missing = run(signing);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /no ETag/);
	assert.equal(puts().length, 0);
	assert.equal(readFileSync(manifestPath, "utf8"), "");

	reset();
	const forged = JSON.parse(readFileSync(livePath, "utf8"));
	forged.signed.sequence++;
	writeFileSync(livePath, JSON.stringify(forged));
	const signature = run(signing);
	assert.equal(signature.status, 1);
	assert.match(signature.stderr, /signature does not verify/);
	assert.equal(puts().length, 0);

	for (const sequence of [Number.MAX_SAFE_INTEGER, 0, "43"]) {
		reset(sequence);
		const invalid = run(signing);
		assert.equal(invalid.status, 1);
		assert.match(invalid.stderr, /safe successor|bad live sequence/);
		assert.equal(puts().length, 0);
	}

	reset();
	candidate();
	const denied = JSON.parse(readFileSync(statePath, "utf8"));
	denied.denied = true;
	writeFileSync(statePath, JSON.stringify(denied));
	assert.equal(run(publishing, { LIVE_ETAG: etag() }).status, 1);
	assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), denied);
	assert.equal(puts().length, 1);

	reset();
	writeFileSync(artifactPath, "Changed after testing.\n");
	assert.equal(run(signing).status, 1);
	assert.equal(readFileSync(callsPath, "utf8"), "", "Refuse changed tested bytes before accessing a signing key.");
	console.log("Release workflow shell passed 9 local cases: tested-byte signing and activation, concurrent-write refusal, missing ETag, invalid signature, exhausted/zero/string sequences, AWS refusal and changed archive; no live AWS calls were made.");
} finally {
	assert.equal(spawnSync("find", [temporary, "-mindepth", "1", "-delete"], { timeout: 10000 }).status, 0, "Remove the owned release fixture before retrying.");
	rmdirSync(temporary);
}
