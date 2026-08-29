import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { publish } from "../worker/run.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const tempDir = mkdtempSync(join(tmpdir(), "publish-limit-real-"));

try {
  // Create stub git and gh commands that record their calls
  const stubDir = join(tempDir, "stubs");
  mkdirSync(stubDir);
  const callsLog = join(tempDir, "calls.log");

  // The stub models one remote branch: rev-parse answers a fixed sha, push marks it as on origin,
  // ls-remote reports it only after the push (so the publisher's readback sees what it pushed).
  const pushedMarker = join(tempDir, "pushed");
  const gitStub = `#!/bin/sh
echo "git $@" >> ${callsLog}
case "$3" in
  push)
    : > ${pushedMarker}
    exit 0
    ;;
  rev-parse)
    echo 0123456789abcdef0123456789abcdef01234567
    exit 0
    ;;
  ls-remote)
    if [ -f ${pushedMarker} ]; then echo "0123456789abcdef0123456789abcdef01234567	$5"; fi
    exit 0
    ;;
  remote)
    echo https://github.com/test/repo.git
    exit 0
    ;;
  cat-file)
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`;

  const ghStub = `#!/bin/sh
echo "gh $@" >> ${callsLog}
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "notice"
  echo "https://github.com/test/repo/pull/999"
  echo "trailing"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"number":999,"url":"https://github.com/test/repo/pull/999","headRefOid":"0123456789abcdef0123456789abcdef01234567"}'; exit 0; fi
exit 0
`;

  writeFileSync(join(stubDir, "git"), gitStub);
  writeFileSync(join(stubDir, "gh"), ghStub);
  execSync(`chmod +x ${join(stubDir, "git")} ${join(stubDir, "gh")}`);

  // Create a test repo
  const repoDir = join(tempDir, "test-repo");
  mkdirSync(repoDir);
  execSync(`git init`, { cwd: repoDir });
  execSync(`git config user.email test@example.com`, { cwd: repoDir });
  execSync(`git config user.name Test`, { cwd: repoDir });
  writeFileSync(join(repoDir, "file.txt"), "content");
  execSync(`git add file.txt && git commit -m "initial"`, { cwd: repoDir });
  execSync(`git remote add origin https://github.com/test/repo.git`, { cwd: repoDir });

  // Set PATH to use our stubs
  const savedPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${process.env.PATH}`;

  try {
    // TEST CASE (a): limitTripped set → PR NOT created, push called
    writeFileSync(callsLog, "");
    rmSync(pushedMarker, { force: true });
    const result1 = await publish({
      envelope: { evidence: "pr" },
      repoDir,
      branch: "worker/task1",
      taskId: "task1",
      limitTripped: "budget_usd",
    });
    
    const calls1 = readFileSync(callsLog, "utf8").trim().split("\n").filter(c => c.length > 0);
    const hasPush1 = calls1.some(c => c.includes("push"));
    const hasPrCreate1 = calls1.some(c => c.includes("pr") && c.includes("create"));
    
    assert.equal(result1.publish, "pushed", "branch must be pushed");
    assert.equal(result1.pr, null, "PR must NOT be created when limitTripped");
    assert.ok(hasPush1, "git push must be called");
    assert.equal(hasPrCreate1, false, "gh pr create must NOT be called when limitTripped");
    console.log("✓ Test case (a): limitTripped suppresses PR, push still happens");

    // TEST CASE (b): limitTripped null → PR created normally
    writeFileSync(callsLog, "");
    rmSync(pushedMarker, { force: true });
    const result2 = await publish({
      envelope: { evidence: "pr" },
      repoDir,
      branch: "worker/task2",
      taskId: "task2",
      limitTripped: null,
    });
    
    const calls2 = readFileSync(callsLog, "utf8").trim().split("\n").filter(c => c.length > 0);
    const hasPrCreate2 = calls2.some(c => c.includes("pr") && c.includes("create"));
    
    assert.equal(result2.publish, "pushed");
    assert.equal(result2.pr, "https://github.com/test/repo/pull/999", "PR must be created");
    assert.ok(hasPrCreate2, "gh pr create must be called when limitTripped is null");
    console.log("✓ Test case (b): no limitTripped creates PR");
  } finally {
    process.env.PATH = savedPath;
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

process.stdout.write("✓ worker-publish-limit-real-integration\n");
