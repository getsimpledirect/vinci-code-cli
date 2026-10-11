import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { checkForgeBackport, checkInstalledForge } from "../../scripts/check-forge-backport.mjs";

const repository = resolve(import.meta.dirname, "../..");
const project = resolve(process.env.FORGE_TEST_PROJECT ?? repository);
const projectRequire = createRequire(join(project, "package.json"));
const gondolinEntry = projectRequire.resolve("@earendil-works/gondolin");
const gondolinRequire = createRequire(gondolinEntry);
const forge = gondolinRequire("node-forge");
const { QemuNetworkBackend } = gondolinRequire("./qemu/net.js");

test("the installed Gondolin consumer resolves the sealed Forge backport", () => {
	checkForgeBackport(repository);
	checkInstalledForge(dirname(dirname(gondolinRequire.resolve("node-forge"))));
	checkInstalledForge(dirname(dirname(projectRequire.resolve("node-forge"))));
});

test("source validation refuses a coordinated seal edit and the generator refuses an unpinned archive", () => {
	assert.ok(process.env.TMPDIR, "set an owned TMPDIR for source fixtures");
	const directory = mkdtempSync(join(process.env.TMPDIR, "forge-seal-"));
	try {
		const seal = checkForgeBackport(repository);
		seal.files["lib/rsa.js"] = "0".repeat(64);
		writeFileSync(join(directory, "source-seal.json"), JSON.stringify(seal));
		assert.throws(() => checkInstalledForge(directory), /seal differs from the reviewed inventory/);
		const archive = join(directory, "wrong.tgz");
		writeFileSync(archive, "local unpinned archive fixture");
		const result = spawnSync(process.execPath, [join(repository, "scripts/check-forge-backport.mjs"), "--seal", archive], {
			encoding: "utf8", timeout: 5000, env: { TMPDIR: process.env.TMPDIR },
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /archive does not match the pinned public artifact/);
		assert.match(result.stderr, /obtain the pinned archive before retrying/);
	} finally {
		for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
		rmdirSync(directory);
	}
});

const keys = forge.pki.rsa.generateKeyPair(2048);
const digest = forge.md.sha256.create().update("local certificate verification fixture").digest().getBytes();
const asn1 = forge.asn1;
const value = (type, bytes) => asn1.create(asn1.Class.UNIVERSAL, type, false, bytes);
const sha256Oid = asn1.oidToDer(forge.oids.sha256).getBytes();
function digestInfo(parameters = [value(asn1.Type.NULL, "")], oid = sha256Oid) {
	return asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
		asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [value(asn1.Type.OID, oid), ...parameters]),
		value(asn1.Type.OCTETSTRING, digest),
	])).getBytes();
}
function accepted(bytes) {
	// The fixture owns the private key: test the parser with correctly padded local signatures.
	const signature = keys.privateKey.sign(bytes, "NONE");
	try { return keys.publicKey.verify(digest, signature); }
	catch { return false; }
}

test("PKCS#1 v1.5 preserves optional SHA NULL parameters and supported BER wrappers", () => {
	assert.equal(accepted(digestInfo()), true);
	assert.equal(accepted(digestInfo([])), true);
	const der = digestInfo();
	assert.equal(accepted("\x30\x80" + der.slice(2) + "\x00\x00"), true);
	assert.equal(accepted("\x30\x81" + der.slice(1)), true);
});

const malformed = [
	["extra algorithm child after NULL", () => digestInfo([value(asn1.Type.NULL, ""), value(asn1.Type.OCTETSTRING, "local junk")])],
	["wrong optional parameter type", () => digestInfo([value(asn1.Type.OCTETSTRING, "local junk")])],
	["nonempty NULL parameter", () => digestInfo([value(asn1.Type.NULL, "local junk")])],
	["unfinished OID component", () => digestInfo(undefined, sha256Oid + "\x80")],
];
for (const [name, makeBytes] of malformed) {
	test(`PKCS#1 v1.5 refuses ${name}`, () => assert.equal(accepted(makeBytes()), false));
}

test("existing unknown-OID and MD5-without-NULL refusals remain", () => {
	assert.equal(accepted(digestInfo([], asn1.oidToDer("1.2.3.4").getBytes())), false);
	assert.equal(accepted(digestInfo([], asn1.oidToDer(forge.oids.md5).getBytes())), false);
});

test("RSA PSS, NONE, OAEP, and CSR signing remain available", () => {
	const pss = forge.pss.create({ md: forge.md.sha256.create(), mgf: forge.mgf.mgf1.create(forge.md.sha256.create()), saltLength: 32 });
	const md = forge.md.sha256.create().update("local PSS fixture");
	assert.equal(keys.publicKey.verify(md.digest().getBytes(), keys.privateKey.sign(md, pss), pss), true);
	assert.equal(keys.publicKey.verify(digest, keys.privateKey.sign(digest, "NONE"), "NONE"), true);
	assert.equal(keys.privateKey.decrypt(keys.publicKey.encrypt("local OAEP fixture", "RSA-OAEP"), "RSA-OAEP"), "local OAEP fixture");
	const csr = forge.pki.createCertificationRequest();
	csr.publicKey = keys.publicKey;
	csr.setSubject([{ name: "commonName", value: "local.invalid" }]);
	csr.sign(keys.privateKey, forge.md.sha256.create());
	assert.equal(forge.pki.certificationRequestFromPem(forge.pki.certificationRequestToPem(csr)).verify(), true);
});

test("actual certificate verifier rejects malformed DigestAlgorithm while normal CA signing passes", () => {
	const ca = forge.pki.createCertificate();
	ca.publicKey = keys.publicKey;
	ca.serialNumber = "01";
	ca.validity.notBefore = new Date("2026-01-01T00:00:00Z");
	ca.validity.notAfter = new Date("2030-01-01T00:00:00Z");
	ca.setSubject([{ name: "commonName", value: "local fixture CA" }]);
	ca.setIssuer(ca.subject.attributes);
	ca.setExtensions([{ name: "basicConstraints", cA: true }]);
	ca.sign(keys.privateKey, forge.md.sha256.create());
	const leaf = forge.pki.createCertificate();
	leaf.publicKey = keys.publicKey;
	leaf.serialNumber = "02";
	leaf.validity = { ...ca.validity };
	leaf.setSubject([{ name: "commonName", value: "local.invalid" }]);
	leaf.setIssuer(ca.subject.attributes);
	leaf.sign(keys.privateKey, forge.md.sha256.create());
	assert.equal(ca.verify(leaf), true);
	const caNative = new X509Certificate(forge.pki.certificateToPem(ca));
	assert.equal(new X509Certificate(forge.pki.certificateToPem(leaf)).verify(caNative.publicKey), true);
	const algorithm = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
		value(asn1.Type.OID, sha256Oid), value(asn1.Type.NULL, ""), value(asn1.Type.OCTETSTRING, "local junk"),
	]);
	const info = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [algorithm, value(asn1.Type.OCTETSTRING, leaf.md.digest().getBytes())]);
	leaf.signature = keys.privateKey.sign(asn1.toDer(info).getBytes(), "NONE");
	assert.equal(new X509Certificate(forge.pki.certificateToPem(leaf)).verify(caNative.publicKey), false, "native verification discriminates the malformed fixture");
	let result = false;
	try { result = ca.verify(leaf); } catch {}
	assert.equal(result, false, "the actual Forge certificate verifier must also refuse");
});

test("Gondolin CA persistence, cached leaf reuse, malformed leaf replacement, and TLS context remain available", async () => {
	assert.ok(process.env.TMPDIR, "set an owned TMPDIR for certificate fixtures");
	const directory = mkdtempSync(join(process.env.TMPDIR, "forge-ca-"));
	try {
		const backend = new QemuNetworkBackend({ mitmCertDir: directory });
		const ca = await backend.ensureCaAsync();
		const hostname = "local.invalid";
		const leaf = await backend.ensureLeafCertificateAsync(hostname, ca);
		assert.equal(new X509Certificate(leaf.certPem).verify(new X509Certificate(ca.certPem).publicKey), true);
		const cached = await backend.ensureLeafCertificateAsync(hostname, ca);
		assert.equal(cached.keyPem === leaf.keyPem, true, "ordinary persisted leaf key is reused");
		assert.equal(cached.certPem === leaf.certPem, true, "ordinary persisted leaf certificate is reused");
		const reloaded = new QemuNetworkBackend({ mitmCertDir: directory });
		assert.equal((await reloaded.ensureCaAsync()).certPem, ca.certPem, "persisted CA is reused");
		assert.ok(await backend.getTlsContextAsync(hostname), "native TLS accepts the ordinary generated leaf");
		const parsed = forge.pki.certificateFromPem(leaf.certPem);
		const md = forge.md.sha256.create().update(asn1.toDer(forge.pki.getTBSCertificate(parsed)).getBytes());
		const algorithm = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [value(asn1.Type.OID, sha256Oid), value(asn1.Type.NULL, "junk")]);
		const info = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [algorithm, value(asn1.Type.OCTETSTRING, md.digest().getBytes())]);
		parsed.signature = ca.key.sign(asn1.toDer(info).getBytes(), "NONE");
		const malformedPem = forge.pki.certificateToPem(parsed);
		assert.equal(new X509Certificate(malformedPem).verify(new X509Certificate(ca.certPem).publicKey), false);
		const certPath = join(directory, "hosts", `${hostname}-${createHash("sha256").update(hostname).digest("hex").slice(0, 12)}.crt`);
		writeFileSync(certPath, malformedPem);
		const replaced = await reloaded.ensureLeafCertificateAsync(hostname, await reloaded.ensureCaAsync());
		assert.equal(replaced.certPem !== malformedPem, true, "the actual cache-verification consumer replaces the malformed leaf");
		assert.equal(new X509Certificate(replaced.certPem).verify(new X509Certificate(ca.certPem).publicKey), true);
		assert.equal(readFileSync(certPath, "utf8"), replaced.certPem);
	} finally {
		if (existsSync(join(directory, "hosts"))) {
			for (const file of readdirSync(join(directory, "hosts"))) unlinkSync(join(directory, "hosts", file));
			rmdirSync(join(directory, "hosts"));
		}
		for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
		rmdirSync(directory);
	}
});
