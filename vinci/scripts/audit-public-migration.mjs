#!/usr/bin/env node
// Compare pinned Git tree metadata without reading private operations or product content.
// Dispositions are review proposals; matching blob hashes do not qualify execution.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [publicRepo, privateRepo, publicSha, privateSha, exportSha, outputDir] = process.argv.slice(2);
if (!publicRepo || !privateRepo || !outputDir || ![publicSha, privateSha, exportSha].every((sha) => /^[0-9a-f]{40}$/.test(sha ?? ""))) {
	console.error("Usage: audit-public-migration.mjs <public-repo> <private-repo> <public-sha> <private-sha> <export-sha> <output-dir>; supply pinned 40-hex commits and an ignored evidence directory.");
	process.exit(2);
}

function tree(repo, sha) {
	const bytes = execFileSync("git", ["-C", repo, "ls-tree", "-r", "-z", sha], { timeout: 30000 });
	return new Map(bytes.toString("utf8").split("\0").filter(Boolean).map((entry) => {
		const tab = entry.indexOf("\t");
		const [mode, type, oid] = entry.slice(0, tab).split(" ");
		return [entry.slice(tab + 1), { mode, type, oid }];
	}));
}

const publicTree = tree(publicRepo, publicSha);
const privateTree = tree(privateRepo, privateSha);
const exportTree = tree(publicRepo, exportSha);
const exportParent = execFileSync("git", ["-C", publicRepo, "rev-parse", `${exportSha}^`], { encoding: "utf8", timeout: 5000 }).trim();
const laterPublicPaths = new Set(execFileSync("git", ["-C", publicRepo, "diff", "--no-renames", "--name-only", "-z", exportParent, publicSha], { timeout: 30000 }).toString("utf8").split("\0").filter(Boolean));
const equal = (left, right) => left?.mode === right?.mode && left?.type === right?.type && left?.oid === right?.oid;
function workingEntry(path) {
	const file = join(publicRepo, path);
	if (!existsSync(file)) return null;
	const details = lstatSync(file);
	if (!details.isFile() && !details.isSymbolicLink()) return null;
	const input = details.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
	const oid = execFileSync("git", ["hash-object", "--stdin"], { input, encoding: "utf8", timeout: 5000 }).trim();
	return { mode: details.isSymbolicLink() ? "120000" : details.mode & 0o111 ? "100755" : "100644", type: "blob", oid };
}
const counts = { privateOnly: 0, publicOnly: 0, differingShared: 0, identicalShared: 0 };
const rows = [];
for (const path of [...new Set([...publicTree.keys(), ...privateTree.keys()])].sort()) {
	const publicEntry = publicTree.get(path);
	const privateEntry = privateTree.get(path);
	const exportEntry = exportTree.get(path);
	const category = !publicEntry ? "privateOnly" : !privateEntry ? "publicOnly" : equal(publicEntry, privateEntry) ? "identicalShared" : "differingShared";
	counts[category]++;
	if (category === "identicalShared") continue;
	const lane = path.startsWith("ops/") ? "private-operations" : /(?:crew|agents|child-continuation)/.test(path) ? "crew" : /(?:runtime|canonical|verification|receipt|verdict|task-outcome|control\.ts|unattended)/.test(path) ? "runtime" : /(?:header|identity|themes|assets|snapshots)/.test(path) ? "identity-and-vero" : /(?:workflow|package|build|launcher|check-all|contracts|run\.sh)/.test(path) || path === "vinci/bin/vinci" ? "packaging" : "review";
	const disposition = lane === "private-operations" ? "retain-private; do not export" : category === "publicOnly" ? "preserve-public; review private omission" : equal(publicEntry, exportEntry) ? "already-public; retain current bytes" : equal(privateEntry, exportEntry) ? "review sanitized #87 patch; preserve later public changes" : "manual reconciliation required; do not overwrite public";
	const working = lane === "private-operations" ? null : workingEntry(path);
	const currentDisposition = lane === "private-operations" ? "retained-private" : equal(working, publicEntry) && category === "publicOnly" ? "preserved-public" : equal(working, publicEntry) && laterPublicPaths.has(path) ? "preserved-public-change-after-export-base" : working && equal(working, exportEntry) ? "reviewed-export-bytes-present" : working && !equal(working, publicEntry) ? "locally-reconciled; review diff and tests" : "retained-public; private delta remains for review";
	rows.push({ path, category, lane, disposition, currentDisposition, working, public: publicEntry ?? null, private: privateEntry ?? null, export: exportEntry ?? null });
}
const measuredAt = execFileSync("date", ["-u", "+%Y-%m-%dT%H:%M:%SZ"], { timeout: 5000, encoding: "utf8" }).trim();
const currentDispositions = {};
for (const row of rows) currentDispositions[row.currentDisposition] = (currentDispositions[row.currentDisposition] ?? 0) + 1;
const report = { measuredAt, instrument: "git ls-tree -r -z; mode/type/blob comparison; current public working bytes hashed; git diff paths after export parent; private file content never read", publicSha, privateSha, exportSha, exportParent, counts, currentDispositions, privateProductOnly: rows.filter((row) => row.category === "privateOnly" && !row.path.startsWith("ops/")).length, rows };
mkdirSync(resolve(outputDir), { recursive: true });
writeFileSync(join(outputDir, "migration-dispositions.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(outputDir, "migration-dispositions.tsv"), ["path\tcategory\tlane\tproposal\tcurrent_disposition\tpublic_blob\tprivate_blob\texport_blob\tworking_blob", ...rows.map((row) => [row.path, row.category, row.lane, row.disposition, row.currentDisposition, row.public?.oid ?? "", row.private?.oid ?? "", row.export?.oid ?? "", row.working?.oid ?? ""].join("\t"))].join("\n") + "\n");
console.log(`Migration metadata measured ${measuredAt}: ${counts.privateOnly} private-only entries (${report.privateProductOnly} outside ops), ${counts.differingShared} differing shared entries, ${counts.publicOnly} public-only entries, ${counts.identicalShared} identical shared entries; review the generated path dispositions in ${resolve(outputDir)}.`);
