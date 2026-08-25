#!/usr/bin/env node
/**
 * Fixture miner — grows the sealed repository corpus from real, validated bug fixes.
 *
 * Walks a repository's history for fix commits that touch a small number of source files PLUS a
 * test, then validates each candidate mechanically: revert only the code side of the fix (keeping
 * the regression test), confirm the focused test FAILS, restore the fix, confirm it PASSES. A
 * candidate that survives becomes a corpus fixture in the same shape as
 * vinci/test/ec2/repos/coding-scenarios.json — the pinned commit is the fix commit and the patch
 * re-introduces the real bug (provenance kind "reverted-fix").
 *
 * Output goes to a STAGING area (default vinci/test/ec2/repos/mined/), never into the pinned
 * campaign corpus. A human reviews and promotes entries; scored campaigns stay sealed.
 *
 * Usage:
 *   node vinci/scripts/mine-fixtures.mjs <git-url> [options]
 *
 * Options:
 *   --since <date>        Only consider commits after this date (default: 2026-01-01 — after the
 *                         serving model's training cutoff, so fixes can't be recalled from memory).
 *   --max-candidates <n>  Stop after examining n candidates (default 25).
 *   --max-fixtures <n>    Stop after n validated fixtures (default 5).
 *   --out <dir>           Staging directory (default vinci/test/ec2/repos/mined).
 *   --keep-work           Keep the temp clone for inspection.
 *
 * Only the Node runtime is implemented (ava / vitest / jest / mocha / node:test / plain scripts).
 * Other runtimes are skipped with a clear message. Validation runs the repository's own tests
 * locally — the same exposure as running the corpus itself; mine from trusted repositories.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const argv = process.argv.slice(2);
if (!argv.length || argv[0].startsWith("--")) {
  console.error("Usage: node vinci/scripts/mine-fixtures.mjs <git-url> [--since d] [--max-candidates n] [--max-fixtures n] [--out dir] [--keep-work]");
  process.exit(1);
}
const REPO_URL = argv[0];
function opt(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const SINCE = opt("--since", "2026-01-01");
const MAX_CANDIDATES = Number(opt("--max-candidates", "25"));
const MAX_FIXTURES = Number(opt("--max-fixtures", "5"));
const OUT_DIR = resolve(opt("--out", "vinci/test/ec2/repos/mined"));
const KEEP_WORK = argv.includes("--keep-work");

const FIX_MESSAGE = /\b(fix|bug|regress|crash|incorrect|wrong|broken|off.by.one|overflow|leak)\b/i;
const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test\.js$|(^|\/)test-[^/]+\.js$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const EXCLUDED_FILE = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(md|yml|yaml|snap)$/;

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}
function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
}

/** Detect the focused verify command for the touched test files at the current checkout. */
function detectVerify(workdir, testFiles) {
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(workdir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const file = testFiles[0];
  if (deps.ava) return ["npm", "exec", "--", "ava", file];
  if (deps.vitest) return ["npm", "exec", "--", "vitest", "run", file];
  if (deps.jest) return ["npm", "exec", "--", "jest", "--ci", file];
  if (deps.mocha) return ["npm", "exec", "--", "mocha", file];
  const source = (() => {
    try {
      return readFileSync(join(workdir, file), "utf8");
    } catch {
      return "";
    }
  })();
  if (/node:test/.test(source)) return ["node", "--test", file];
  // Plain executable test script (asserts and exits non-zero on failure).
  if (/\brequire\(|\bimport\b/.test(source)) return ["node", file];
  return null;
}

function verifyRuns(workdir, verify) {
  const result = run(verify[0], verify.slice(1), { cwd: workdir, timeout: 240_000 });
  return result.status === 0;
}

/** npm install once per package.json content hash — candidates on the same deps reuse it. */
const installedHashes = new Set();
function ensureInstalled(workdir) {
  let hash = "";
  try {
    hash = createHash("sha256").update(readFileSync(join(workdir, "package.json"))).digest("hex");
  } catch {
    return false;
  }
  if (installedHashes.has(hash) && existsSync(join(workdir, "node_modules"))) return true;
  const result = run("npm", ["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund"], {
    cwd: workdir,
    timeout: 420_000,
  });
  if (result.status !== 0) return false;
  installedHashes.add(hash);
  return true;
}

function classifyCommit(workdir, sha) {
  const nameStatus = git(["diff-tree", "--no-commit-id", "--name-status", "-r", sha], workdir);
  const testFiles = [];
  const codeFiles = [];
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const [status, ...parts] = line.split("\t");
    const file = parts[parts.length - 1];
    if (status.startsWith("D")) return null; // deletions complicate clean reversion — skip
    if (EXCLUDED_FILE.test(file)) return null; // lockfile/docs churn — not a focused fix
    if (TEST_FILE.test(file)) testFiles.push(file);
    else if (SOURCE_FILE.test(file)) codeFiles.push(file);
    else return null; // any other file type means the commit isn't a focused code fix
  }
  if (!testFiles.length || !codeFiles.length || codeFiles.length > 3) return null;
  return { testFiles, codeFiles };
}

function main() {
  const work = mkdtempSync(join(tmpdir(), "vinci-mine-"));
  const repoDir = join(work, "repo");
  console.log(`Cloning ${REPO_URL} …`);
  execFileSync("git", ["clone", "--quiet", "--filter=blob:none", REPO_URL, repoDir], { stdio: "inherit" });
  const repoName = slugify(basename(REPO_URL, ".git"));

  const log = git(["log", `--since=${SINCE}`, "--no-merges", "--format=%H%x09%s"], repoDir);
  const commits = log ? log.split("\n").map((line) => {
    const [sha, ...subject] = line.split("\t");
    return { sha, subject: subject.join("\t") };
  }) : [];
  console.log(`${commits.length} commits since ${SINCE}; scanning for focused fix commits…`);

  const fixtures = [];
  const rejected = [];
  let examined = 0;
  for (const { sha, subject } of commits) {
    if (examined >= MAX_CANDIDATES || fixtures.length >= MAX_FIXTURES) break;
    if (!FIX_MESSAGE.test(subject)) continue;
    const shape = classifyCommit(repoDir, sha);
    if (!shape) continue;
    examined++;
    const short = sha.slice(0, 8);
    const label = `${short} "${subject.slice(0, 60)}"`;
    console.log(`\n[${examined}] candidate ${label}`);
    console.log(`    code: ${shape.codeFiles.join(", ")}  test: ${shape.testFiles.join(", ")}`);

    git(["checkout", "--quiet", "--force", sha], repoDir);
    git(["clean", "-fdq", "-e", "node_modules"], repoDir);

    const verify = detectVerify(repoDir, shape.testFiles);
    if (!verify) {
      rejected.push([label, "no supported test runner detected"]);
      console.log("    ✗ no supported test runner detected");
      continue;
    }
    if (!ensureInstalled(repoDir)) {
      rejected.push([label, "npm install failed"]);
      console.log("    ✗ npm install failed");
      continue;
    }
    if (!verifyRuns(repoDir, verify)) {
      rejected.push([label, "focused test does not pass at the fix commit"]);
      console.log("    ✗ focused test does not pass at the fix commit");
      continue;
    }
    // Revert only the code side of the fix; the regression test stays.
    const reversePatch = execFileSync("git", ["diff", sha, `${sha}^`, "--", ...shape.codeFiles], {
      cwd: repoDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!reversePatch.trim()) {
      rejected.push([label, "empty reverse patch"]);
      console.log("    ✗ empty reverse patch");
      continue;
    }
    const patchFile = join(work, "candidate.patch");
    writeFileSync(patchFile, reversePatch);
    const applied = run("git", ["apply", patchFile], { cwd: repoDir });
    if (applied.status !== 0) {
      rejected.push([label, "reverse patch does not apply"]);
      console.log("    ✗ reverse patch does not apply");
      continue;
    }
    const failsWithBug = !verifyRuns(repoDir, verify);
    run("git", ["apply", "-R", patchFile], { cwd: repoDir });
    if (!failsWithBug) {
      rejected.push([label, "test still passes with the fix reverted — not protected by this test"]);
      console.log("    ✗ test still passes with the fix reverted");
      continue;
    }

    const id = `${repoName}-${slugify(subject) || short}`;
    fixtures.push({
      id,
      patchName: `${id}.patch`,
      patch: reversePatch,
      scenario: {
        id,
        repository: REPO_URL,
        commit: sha,
        readOnly: false,
        provenance: {
          kind: "reverted-fix",
          fixCommit: sha,
          subject,
          minedAt: new Date().toISOString().slice(0, 10),
        },
        task:
          "The test suite is failing. Diagnose and fix the underlying bug. Work autonomously: inspect the code and tests, make only necessary changes, run relevant tests, and stop only when the fix is verified. Do not commit or push. Do not ask permission for ordinary in-scope edits or tests.",
        fixture: {
          runtime: "node",
          patch: `${id}.patch`,
          prepare: [["npm", "install", "--ignore-scripts", "--no-package-lock"]],
          verify,
          expectInitialFailure: true,
          expectCleanAfter: true,
          commitSeed: false,
        },
        timeoutSeconds: 600,
        maxToolCalls: 14,
        maxRepeatedToolSignature: 3,
        maxToolErrors: 2,
        maxTranscriptBytes: 500000,
        requireFinalReceipt: true,
      },
    });
    console.log(`    ✓ VALIDATED → ${id}`);
  }

  if (fixtures.length) {
    mkdirSync(join(OUT_DIR, "fixtures"), { recursive: true });
    const scenarioPath = join(OUT_DIR, "mined-scenarios.json");
    let existing = { version: 2, scenarios: [] };
    if (existsSync(scenarioPath)) existing = JSON.parse(readFileSync(scenarioPath, "utf8"));
    const known = new Set(existing.scenarios.map((s) => s.id));
    for (const fixture of fixtures) {
      writeFileSync(join(OUT_DIR, "fixtures", fixture.patchName), fixture.patch);
      if (!known.has(fixture.scenario.id)) existing.scenarios.push(fixture.scenario);
    }
    writeFileSync(scenarioPath, `${JSON.stringify(existing, null, 2)}\n`);
  }

  console.log(`\n── mined ${fixtures.length} fixture(s) from ${REPO_URL} ──`);
  for (const fixture of fixtures) console.log(`  ✓ ${fixture.scenario.id}`);
  if (rejected.length) {
    console.log(`  rejected ${rejected.length}:`);
    for (const [label, reason] of rejected) console.log(`    - ${label}: ${reason}`);
  }
  if (fixtures.length) console.log(`\nStaged in ${OUT_DIR} — review and promote entries into coding-scenarios.json deliberately.`);

  if (KEEP_WORK) console.log(`Work dir kept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

main();
