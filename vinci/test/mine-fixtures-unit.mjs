import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The fixture miner must turn a real fix commit (code + regression test) into a staged corpus
// fixture: pinned fix commit, reverse-code patch that re-introduces the bug while keeping the
// test, a focused verify command, and reverted-fix provenance — validated by actually running the
// test on both sides of the patch. Offline: the "repository" is a local synthetic git repo using
// the plain `node test.js` runner path.

const here = dirname(fileURLToPath(import.meta.url));
const miner = resolve(here, "../scripts/mine-fixtures.mjs");

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

const work = mkdtempSync(join(tmpdir(), "vinci-mine-unit-"));
try {
  const repo = join(work, "upstream");
  execFileSync("git", ["init", "--quiet", repo]);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Corpus Test"], repo);

  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "clamp-lib", version: "1.0.0", private: true }));
  // Buggy state: clamp() ignores the upper bound.
  writeFileSync(join(repo, "index.js"), "exports.clamp = (v, lo, hi) => (v < lo ? lo : v);\n");
  writeFileSync(join(repo, "test.js"), "const assert = require('node:assert');\nconst { clamp } = require('./index.js');\nassert.equal(clamp(5, 0, 3), 3);\nassert.equal(clamp(-1, 0, 3), 0);\nconsole.log('ok');\n");
  git(["add", "."], repo);
  git(["commit", "--quiet", "-m", "initial library"], repo);

  // The real fix commit: code change + regression test strengthened together.
  writeFileSync(join(repo, "index.js"), "exports.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);\n");
  writeFileSync(join(repo, "test.js"), "const assert = require('node:assert');\nconst { clamp } = require('./index.js');\nassert.equal(clamp(5, 0, 3), 3);\nassert.equal(clamp(-1, 0, 3), 0);\nassert.equal(clamp(99, 0, 10), 10);\nconsole.log('ok');\n");
  git(["add", "."], repo);
  git(["commit", "--quiet", "-m", "fix clamp ignoring the upper bound"], repo);

  const out = join(work, "staged");
  const result = spawnSync(
    process.execPath,
    [miner, repo, "--since", "2000-01-01", "--out", out, "--max-fixtures", "2"],
    { encoding: "utf8", timeout: 240_000 },
  );
  check("miner exits cleanly", result.status === 0);

  const scenarioPath = join(out, "mined-scenarios.json");
  check("staged scenario file exists", existsSync(scenarioPath));
  const staged = JSON.parse(readFileSync(scenarioPath, "utf8"));
  check("one fixture mined from one fix commit", staged.scenarios.length === 1);

  const scenario = staged.scenarios[0];
  check("provenance records the reverted fix", scenario.provenance.kind === "reverted-fix");
  check("scenario pins the fix commit", /^[0-9a-f]{40}$/.test(scenario.commit));
  check("verify is the plain node runner for a script test", scenario.fixture.verify[0] === "node");
  check("patch filename passes the corpus inventory rule", /^[a-z0-9][a-z0-9.-]{2,80}\.patch$/.test(scenario.fixture.patch));
  check("budgets and receipt gate are set", scenario.requireFinalReceipt === true && scenario.timeoutSeconds === 600);

  // The staged patch must re-introduce the bug: applying it at the pinned commit reverts index.js
  // to the buggy body while test.js keeps the regression assertion.
  const patch = readFileSync(join(out, "fixtures", scenario.fixture.patch), "utf8");
  check("patch touches only the code file", patch.includes("index.js") && !patch.includes("test.js"));
  const checkout = join(work, "checkout");
  execFileSync("git", ["clone", "--quiet", repo, checkout]);
  git(["checkout", "--quiet", scenario.commit], checkout);
  writeFileSync(join(checkout, "bug.patch"), patch);
  git(["apply", "bug.patch"], checkout);
  const failing = spawnSync(process.execPath, ["test.js"], { cwd: checkout, encoding: "utf8" });
  check("applying the staged patch makes the regression test fail", failing.status !== 0);
  git(["apply", "-R", "bug.patch"], checkout);
  const passing = spawnSync(process.execPath, ["test.js"], { cwd: checkout, encoding: "utf8" });
  check("reverting the patch restores a passing test", passing.status === 0);

  // Re-running the miner must not duplicate scenarios (idempotent staging).
  const rerun = spawnSync(
    process.execPath,
    [miner, repo, "--since", "2000-01-01", "--out", out, "--max-fixtures", "2"],
    { encoding: "utf8", timeout: 240_000 },
  );
  check("second run exits cleanly", rerun.status === 0);
  const restaged = JSON.parse(readFileSync(scenarioPath, "utf8"));
  check("staging is idempotent by scenario id", restaged.scenarios.length === 1);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\nmine-fixtures-unit: ${pass}/${pass} checks passed (real fixes become validated corpus fixtures)`);
