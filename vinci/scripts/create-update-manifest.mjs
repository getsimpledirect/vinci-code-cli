import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function option(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		if (fallback !== undefined) return fallback;
		throw new Error(`Missing required option: ${name}`);
	}
	const value = process.argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
	return value;
}

function version(value, label) {
	if (!VERSION_PATTERN.test(value)) throw new Error(`${label} must be X.Y.Z`);
	if (value.split(".").some((part) => !Number.isSafeInteger(Number(part)))) {
		throw new Error(`${label} contains a numeric component that is too large`);
	}
	return value;
}

function integer(value, label) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value) {
		throw new Error(`${label} must be a positive integer`);
	}
	return parsed;
}

function boolean(value, label) {
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${label} must be true or false`);
}

function artifactUrl(value) {
	const parsed = new URL(value);
	if (parsed.protocol !== "https:" && !(parsed.protocol === "file:" && process.env.VINCI_UPDATE_ALLOW_FILE_URLS === "1")) {
		throw new Error("Artifact URL must use HTTPS");
	}
	return parsed.href;
}

async function sha256File(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

const artifact = resolve(option("--artifact"));
const privateKeyPath = resolve(option("--private-key"));
const publicKeyPath = resolve(option("--public-key"));
const output = resolve(option("--output"));
const targetVersion = version(option("--version"), "Version");
const minimumVersion = version(option("--minimum-version", targetVersion), "Minimum version");
const sequence = integer(option("--sequence"), "Sequence");
const channel = option("--channel", "beta");
if (channel !== "beta" && channel !== "stable") throw new Error("Channel must be beta or stable");
const publishedAt = option("--published-at", new Date().toISOString());
if (Number.isNaN(Date.parse(publishedAt))) throw new Error("Published timestamp must be ISO-compatible");

const privateDetails = await stat(privateKeyPath);
if (process.platform !== "win32" && (privateDetails.mode & 0o077) !== 0) {
	throw new Error("Update signing key must not be readable by group or other users (chmod 600)");
}
const privatePem = await readFile(privateKeyPath, "utf8");
const expectedPublicPem = (await readFile(publicKeyPath, "utf8")).trim();
const derivedPublicPem = createPublicKey(createPrivateKey(privatePem)).export({ type: "spki", format: "pem" }).trim();
if (derivedPublicPem !== expectedPublicPem) throw new Error("Signing key does not match the checked-in update public key");

const artifactDetails = await stat(artifact);
const signed = {
	schemaVersion: 1,
	updaterSchemaVersion: 1,
	sequence,
	channel,
	version: targetVersion,
	minimumVersion,
	mandatory: boolean(option("--mandatory", "false"), "Mandatory"),
	publishedAt: new Date(publishedAt).toISOString(),
	artifact: {
		url: artifactUrl(option("--artifact-url")),
		sha256: await sha256File(artifact),
		size: artifactDetails.size,
	},
};
const signature = sign(null, Buffer.from(JSON.stringify(signed)), privatePem).toString("base64");
const envelope = { signed, signature };
await writeFile(output, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o644 });
console.log(`Wrote signed ${channel} manifest for Vinci Code ${targetVersion} (sequence ${sequence})`);
console.log(`Artifact SHA-256: ${signed.artifact.sha256}`);
