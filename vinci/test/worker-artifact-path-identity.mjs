import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseGitNulPaths, publish } from "../worker/run.mjs";

const root = mkdtempSync(join(tmpdir(), "worker-artifact-paths-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
execFileSync("git", ["-C", root, "config", "user.email", "t@t"]);
execFileSync("git", ["-C", root, "config", "user.name", "t"]);
writeFileSync(join(root, "base.txt"), "base\n");
writeFileSync(join(root, " tracked-leading.txt"), "tracked base\n");
execFileSync("git", ["-C", root, "add", "base.txt", " tracked-leading.txt"]);
execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
writeFileSync(join(root, " tracked-leading.txt"), "tracked changed\n");

const names = [
  " leading.txt",
  "trailing .txt ",
  "line\nbreak.txt",
  'quote"file.txt',
  "back\\slash.txt",
  "café.txt",
  "nested/ordinary.txt",
  " tracked-leading.txt",
];
mkdirSync(join(root, "nested"));
for (const name of names) writeFileSync(join(root, name), `contents for ${JSON.stringify(name)}\n`);
const result = await publish({
  envelope: { output: "artifact", promotion: "none" },
  repoDir: root,
  branch: "worker/test",
  taskId: "msg_paths",
  limitTripped: false,
  baseCommit: base,
  baseRef: "main",
});
assert.equal(result.publish, "artifact");
assert.deepEqual(result.artifacts, [...names].sort(), "artifact identities are exact canonical repository paths");

const hostileNames = Buffer.from(" leading.txt\0line\nbreak.txt\0");
assert.deepEqual(parseGitNulPaths(hostileNames), [" leading.txt", "line\nbreak.txt"]);
assert.notDeepEqual(
  hostileNames.toString("utf8").trim().split("\n"),
  [" leading.txt", "line\nbreak.txt"],
  "legacy newline parsing corrupts both leading-space and embedded-newline identities",
);
assert.throws(() => parseGitNulPaths(Buffer.from("a\0a\0")), /duplicate path/);
assert.throws(() => parseGitNulPaths(Buffer.from("..\/escape\0")), /aliasing component/);
assert.throws(() => parseGitNulPaths(Buffer.from([0xff, 0])), /canonical UTF-8/);
assert.throws(() => parseGitNulPaths(Buffer.from("e\u0301.txt\0")), /NFC-normalized/);
assert.throws(() => parseGitNulPaths(Buffer.from("missing-nul")), /terminal NUL/);

console.log("PASS worker-artifact-path-identity");
