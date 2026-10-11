import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const forgeSourcePath = "packages/coding-agent/examples/extensions/gondolin/vendor/node-forge";
const origin = {
	url: "https://registry.npmjs.org/node-forge/-/node-forge-1.4.0.tgz",
	integrity: "sha512-LarFH0+6VfriEhqMMcLX2F7SwSXeWwnEAJEsYm5QKWchiVYVvJyV9v7UDvUv+w5HO23ZpQTXDv/GxdDdMyOuoQ==",
};
// This seal pins the reviewed file inventory as well as the local runtime delta.
const sealHash = "5a62826b3f6c5c5aa3a7784f4ec9efee9ff32324154e33492a82146c03ebb14c";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, "\t")}\n`;

function inventory(directory, prefix = "", budget = { entries: 0 }) {
	const result = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (++budget.entries > 64 || prefix.split("/").length > 3) throw new Error("Forge source inventory exceeds its reviewed bounds; restore or review the source package.");
		const name = prefix + entry.name;
		if (entry.isDirectory()) result.push(...inventory(join(directory, entry.name), `${name}/`, budget));
		else if (entry.isFile()) result.push(name);
		else throw new Error(`Source entry "${name}" is not a regular file; restore the reviewed source package.`);
	}
	return result.sort();
}

function sourceDirectory(root) {
	const directory = join(root, forgeSourcePath);
	if (realpathSync(directory) !== directory) throw new Error("Forge source resolves through a link; restore its reviewed repository path.");
	return directory;
}

export function checkForgeBackport(root = repository) {
	const directory = sourceDirectory(resolve(root));
	return checkInstalledForge(directory);
}

export function checkInstalledForge(directory) {
	const sealPath = join(directory, "source-seal.json");
	const sealStat = lstatSync(sealPath);
	if (!sealStat.isFile() || sealStat.size > 16 * 1024) throw new Error("Forge source seal is not a bounded regular file; restore the reviewed source package.");
	const sealBytes = readFileSync(sealPath);
	if (hash(sealBytes) !== sealHash) throw new Error("Forge source seal differs from the reviewed inventory; regenerate and review it before retrying.");
	const seal = JSON.parse(sealBytes);
	const expected = [...Object.keys(seal.files), "source-seal.json"].sort();
	if (JSON.stringify(inventory(directory)) !== JSON.stringify(expected)) throw new Error("Forge source inventory changed; restore or review every added or missing file.");
	for (const [name, expectedHash] of Object.entries(seal.files)) {
		const file = join(directory, name);
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size > 1024 * 1024 || hash(readFileSync(file)) !== expectedHash) {
			throw new Error(`Forge source "${name}" differs from its reviewed bytes; restore or review the runtime change.`);
		}
	}
	return seal;
}

function minimalManifest(original) {
	return {
		...Object.fromEntries(["name", "version", "description", "license", "main", "engines", "browser"].map((key) => [key, original[key]])),
		files: ["lib/*.js", "LICENSE", "source-seal.json"],
		vinciSecurityBackport: { advisory: "GHSA-86w9-cpqp-85rv", revision: 1 },
	};
}

function patchRsa(bytes) {
	let source = bytes.toString("utf8");
	const count = "            obj.value.length !== 2) {";
	const nullCheck = "          // special check for md2 and md5 that NULL parameters exist";
	if (source.split(count).length !== 2 || source.split(nullCheck).length !== 2) {
		throw new Error("Upstream RSA patch anchors changed; review the new artifact before generating its seal.");
	}
	source = source.replace(count, "            obj.value.length !== 2 ||\n            obj.value[0].value.length !== ('parameters' in capture ? 2 : 1) ||\n            ('parameters' in capture && capture.parameters !== '')) {");
	source = source.replace(nullCheck, "          // Keep supported BER wrappers, but require canonical OID contents.\n          if(capture.algorithmIdentifier !== asn1.oidToDer(oid).getBytes()) {\n            throw new Error(\n              'Invalid RSASSA-PKCS1-v1_5 DigestAlgorithm identifier encoding.');\n          }\n\n" + nullCheck);
	return Buffer.from(source);
}

// Read only the bounded, integrity-verified public archive. No archive path is extracted.
function archiveFiles(archive) {
	const stat = lstatSync(archive);
	if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Forge archive is not a bounded regular file; obtain the reviewed registry archive before retrying.");
	const compressed = readFileSync(archive);
	if (compressed.length > 1024 * 1024 || `sha512-${createHash("sha512").update(compressed).digest("base64")}` !== origin.integrity) {
		throw new Error("Forge archive does not match the pinned public artifact; obtain the reviewed registry archive before retrying.");
	}
	const tar = gunzipSync(compressed, { maxOutputLength: 4 * 1024 * 1024 });
	const files = new Map();
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const field = (start, end) => header.subarray(start, end).toString().replace(/\0.*$/, "");
		const name = field(0, 100);
		const size = Number.parseInt(field(124, 136).trim(), 8);
		const checksum = Number.parseInt(field(148, 156).trim(), 8);
		const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
		if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length || checksum !== actualChecksum || field(345, 500) !== "") {
			throw new Error("Forge archive header is invalid; obtain the reviewed archive before retrying.");
		}
		if (name === "package/package.json" || name === "package/LICENSE" || /^package\/lib\/[A-Za-z0-9_.-]+\.js$/.test(name)) {
			if (![0, 48].includes(header[156]) || files.has(name.slice(8))) throw new Error("Forge archive source entry is invalid; obtain the reviewed archive before retrying.");
			files.set(name.slice(8), tar.subarray(offset + 512, offset + 512 + size));
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	if (files.size !== 51 || !files.has("lib/rsa.js") || !files.has("LICENSE") || !files.has("package.json")) {
		throw new Error("Forge archive runtime inventory changed; review the artifact before generating a seal.");
	}
	return files;
}

function generateSeal(archive) {
	const directory = sourceDirectory(repository);
	const upstream = archiveFiles(archive);
	const files = {};
	const upstreamFiles = {};
	for (const [name, original] of [...upstream].sort(([a], [b]) => a.localeCompare(b))) {
		upstreamFiles[name] = hash(original);
		const expected = name === "lib/rsa.js" ? patchRsa(original) : name === "package.json" ? Buffer.from(json(minimalManifest(JSON.parse(original)))) : original;
		if (!readFileSync(join(directory, name)).equals(expected)) throw new Error(`Forge source "${name}" is not the exact reviewed backport; restore the source before generating its seal.`);
		files[name] = hash(expected);
	}
	const actual = inventory(directory).filter((name) => name !== "source-seal.json");
	if (JSON.stringify(actual) !== JSON.stringify(Object.keys(files).sort())) throw new Error("Forge source inventory differs from the artifact; review it before generating its seal.");
	const seal = { schemaVersion: 1, origin, backport: { advisory: "GHSA-86w9-cpqp-85rv", revision: 1, changedFiles: ["lib/rsa.js", "package.json"] }, upstreamFiles, files };
	const output = json(seal);
	writeFileSync(join(directory, "source-seal.json"), output);
	console.log(`Forge source seal generated from the pinned public artifact; review and pin SHA256 "${hash(output)}" before accepting the source.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.length === 4 && process.argv[2] === "--seal") generateSeal(resolve(process.argv[3]));
		else if (process.argv.length === 2) {
			const seal = checkForgeBackport();
			console.log(`Forge source backport seal passed for ${Object.keys(seal.files).length} runtime/license/manifest files; this checks the reviewed backport, not all cryptographic behavior.`);
		} else throw new Error("Unsupported checker arguments; use no arguments to check or --seal with the pinned archive to regenerate its provenance.");
	} catch (error) {
		console.error(`Forge backport verification failed: ${error.message} Restore the reviewed source package or obtain the pinned archive before retrying.`);
		process.exitCode = 1;
	}
}
