import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const sandboxSourcePath = "packages/coding-agent/examples/extensions/sandbox/vendor/sandbox-runtime";
export const sandboxVersion = "0.0.26-vinci.zod4.1";
export const sandboxArchivePath = `${sandboxSourcePath}/sandbox-runtime-${sandboxVersion}.tgz`;
export const sandboxIntegrity = "sha512-AVZL4t3NEafosoUVuQV5HUjHRb+VTczEBfX1+QSMSxaOSNlT36QtHdj0DVTtWbI2LOAR5oV2YdD/F50aPIJO8w==";
const sealHash = "73282763d6097213a5419c07d500da0d2e06265b739bba2318c357584ee9ad81";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function regularFile(path, maximum) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size > maximum) throw new Error(`Sandbox source file is not bounded and regular: ${path}`);
	return readFileSync(path);
}

// No extraction: reject links, paths, duplicate members, malformed headers and oversized output.
export function checkSandboxSource(root = repository) {
	const directory = join(resolve(root), sandboxSourcePath);
	if (realpathSync(directory) !== directory) throw new Error("Sandbox source resolves through a link.");
	const sealBytes = regularFile(join(directory, "source-seal.json"), 32 * 1024);
	if (hash(sealBytes) !== sealHash) throw new Error("Sandbox source seal differs from the reviewed inventory.");
	const seal = JSON.parse(sealBytes);
	const compressed = regularFile(join(root, sandboxArchivePath), 2 * 1024 * 1024);
	if (`sha512-${createHash("sha512").update(compressed).digest("base64")}` !== sandboxIntegrity) throw new Error("Sandbox archive integrity differs from the reviewed artifact.");
	const tar = gunzipSync(compressed, { maxOutputLength: 4 * 1024 * 1024 });
	const files = new Map();
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const field = (start, end) => header.subarray(start, end).toString().replace(/\0.*$/, "");
		const name = field(0, 100);
		const size = Number.parseInt(field(124, 136).trim(), 8);
		const mode = Number.parseInt(field(100, 108).trim(), 8);
		const checksum = Number.parseInt(field(148, 156).trim(), 8);
		const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
		if (!Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024 || offset + 512 + size > tar.length || checksum !== actualChecksum || field(345, 500) !== "" || ![0, 48].includes(header[156]) || !/^package\/[A-Za-z0-9_./-]+$/.test(name) || name.includes("/../") || name.includes("/./") || name.endsWith("/") || files.has(name.slice(8))) throw new Error("Sandbox archive contains an invalid or duplicate member.");
		files.set(name.slice(8), { bytes: tar.subarray(offset + 512, offset + 512 + size), mode });
		if (files.size > 128) throw new Error("Sandbox archive exceeds its reviewed file count.");
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	const expected = [...Object.keys(seal.files), "source-seal.json"].sort();
	if (JSON.stringify([...files.keys()].sort()) !== JSON.stringify(expected) || !files.get("source-seal.json")?.bytes.equals(sealBytes)) throw new Error("Sandbox archive inventory or embedded seal changed.");
	for (const [name, entry] of Object.entries(seal.files)) {
		const actual = files.get(name);
		if (hash(actual.bytes) !== entry.sha256 || actual.mode !== entry.mode) throw new Error(`Sandbox archive member changed: ${name}`);
	}
	if (!regularFile(join(directory, "schema.ts.txt"), 16 * 1024).equals(files.get("src/sandbox/sandbox-config.ts").bytes)) throw new Error("Sandbox schema source differs from the sealed archive.");
	return { seal, files };
}

export function checkInstalledSandbox(directory, root = repository) {
	const { seal, files } = checkSandboxSource(root);
	if (realpathSync(directory) !== resolve(directory)) throw new Error("Installed sandbox package resolves through a link.");
	const actual = [];
	function visit(path, prefix = "", budget = { count: 0 }) {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			// npm may nest dependencies here; their graph is checked separately by the lockfile gate.
			if (prefix === "" && entry.name === "node_modules" && entry.isDirectory()) continue;
			if (++budget.count > 160 || prefix.split("/").length > 8) throw new Error("Installed sandbox inventory exceeds its reviewed bounds.");
			const name = prefix + entry.name;
			if (entry.isDirectory()) visit(join(path, entry.name), `${name}/`, budget);
			else if (entry.isFile()) actual.push(name);
			else throw new Error(`Installed sandbox contains a non-regular entry: ${name}`);
		}
	}
	visit(directory);
	if (JSON.stringify(actual.sort()) !== JSON.stringify([...files.keys()].sort())) throw new Error("Installed sandbox inventory has missing or extra files.");
	for (const [name, entry] of files) {
		const path = join(directory, name);
		// npm marks the declared CLI bin executable while linking it; all payload bytes stay sealed.
		const executable = name === "dist/cli.js" ? 0o111 : entry.mode & 0o111;
		if (!regularFile(path, 1024 * 1024).equals(entry.bytes) || (lstatSync(path).mode & 0o111) !== executable) throw new Error(`Installed sandbox member changed: ${name}`);
	}
	return seal;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.length !== 2) throw new Error("Use no arguments to verify the sealed sandbox source.");
		const { files } = checkSandboxSource();
		console.log(`Sandbox consumer source seal passed for ${files.size} files; runtime policy and platform assets retain upstream bytes.`);
	} catch (error) {
		console.error(`Sandbox source verification failed: ${error.message} Restore or review the source package before retrying.`);
		process.exitCode = 1;
	}
}
