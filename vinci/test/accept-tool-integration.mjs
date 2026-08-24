import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const tmpDir = mkdtempSync(resolve(tmpdir(), "vinci-accept-tool-"));

const launcherSource = readFileSync(resolve(root, "vinci/bin/vinci"), "utf8");
const launcherExtensions = [...launcherSource.matchAll(/--extension "\$\{VINCI\}\/extensions\/([^"]+)"/g)].map(
  (match) => match[1],
);
const identity = JSON.parse(readFileSync(resolve(root, "vinci/identity.json"), "utf8"));
assert(launcherExtensions.includes("vinci-accept.ts"), "launcher must discover vinci-accept");
assert(identity.extensions.includes("vinci-accept.ts"), "identity must register vinci-accept");

process.on("exit", () => rmSync(tmpDir, { recursive: true, force: true }));

// Create a stub vac script for testing
const stubVacPath = resolve(tmpDir, "vac");
const stubVacScript = `#!/bin/bash
# Stub vac: deterministic responses keyed by subcommand/job_id.
case "$1" in
  verify)
    printf '{"job_id":"vac_stub_1","argv":["%s"' "$1"; shift
    for a in "$@"; do printf ',"%s"' "$a"; done
    printf ']}\n'
    exit 0
    ;;
  status)
    if [ "$2" = "signal-death" ]; then
      kill -TERM $$
    fi
    echo '{"job_id":"'"$2"'","state":"COMPLETED"}'
    exit 0
    ;;
  report)
    if [ "$2" = "largeoutput" ]; then
      python3 -c "import sys; sys.stdout.write('x' * 300000)"
      exit 0
    fi
    echo '{"job_id":"'"$2"'","report":true}'
    exit 0
    ;;
  cancel)
    if [ "$2" = "fail-job" ]; then
      echo '{"error":"cannot cancel a completed verification"}'
      exit 3
    fi
    echo '{"cancelled":true,"job_id":"'"$2"'"}'
    exit 0
    ;;
  *)
    echo "Unknown action: $1" >&2
    exit 1
    ;;
esac
`;

writeFileSync(stubVacPath, stubVacScript);
chmodSync(stubVacPath, 0o755);

// Load the accept tool extension to test
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });

// Mock PI object
const mockPI = {
  tool: null,
  registerTool(tool) {
    this.tool = tool;
  },
};

// Import vinci-accept and register it with mock PI
const acceptModule = await loader.import(resolve(here, "../extensions/vinci-accept.ts"), {
  default: false,
});
const acceptExtension = acceptModule.default;
acceptExtension(mockPI);

const tool = mockPI.tool;
assert(tool, "Tool not registered");
assert.equal(tool.name, "vinci_accept", "Tool name must be vinci_accept");

const text = (result) => result.content.map((c) => c.text).join("");

// Every case below invokes the REAL tool.execute; the stub only plays vac.
process.env.VAC_CLI_PATH = stubVacPath;

// (a) verify: --json appended, raw JSON verbatim in content, exitCode 0
{
  const result = await tool.execute("t1", { action: "verify" }, undefined);
  assert.equal(result.details.exitCode, 0, "verify exitCode");
  const json = JSON.parse(text(result));
  assert(json.job_id, "raw vac JSON passes through verbatim");
  assert.equal(result.details.jobId, json.job_id, "details extract jobId");
  console.log("ok (a) verify returns raw JSON via tool.execute");
}

// (b) status maps argv: stub echoes argv back
{
  const result = await tool.execute("t2", { action: "status", job_id: "my-job-456" }, undefined);
  assert.equal(result.details.exitCode, 0);
  const json = JSON.parse(text(result));
  assert.equal(json.job_id, "my-job-456", "job_id positioned after subcommand");
  console.log("ok (b) status argv mapping through tool.execute");
}

// (b2) verify --background: flag must FOLLOW the subcommand
{
  const result = await tool.execute("t2b", { action: "verify", background: true }, undefined);
  assert.equal(result.details.exitCode, 0, "background verify must not break vac parsing");
  const json = JSON.parse(text(result));
  assert(Array.isArray(json.argv) ? json.argv[0] === "verify" : json.job_id, "subcommand stays first");
  console.log("ok (b2) background flag ordering");
}

// (c) missing vac: guidance + 127, no spawn
{
  delete process.env.VAC_CLI_PATH;
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  const result = await tool.execute("t3", { action: "verify" }, undefined);
  process.env.PATH = savedPath;
  process.env.VAC_CLI_PATH = stubVacPath;
  assert.equal(result.details.exitCode, 127);
  assert(text(result).includes("Verification isn't set up yet"), "plain-language guidance");
  console.log("ok (c) missing vac guidance + 127");
}

// (d) non-zero exit passes stdout through and surfaces the code
{
  const result = await tool.execute("t4", { action: "cancel", job_id: "fail-job" }, undefined);
  assert.equal(result.details.exitCode, 3, "vac exit code is meaningful and preserved");
  assert(text(result).length > 0, "stdout passed through on failure");
  console.log("ok (d) exit code 3 propagates with output");
}

// (d2) signal termination is a failure, never a successful exit
{
  const result = await tool.execute("t4b", { action: "status", job_id: "signal-death" }, undefined);
  assert.notEqual(result.details.exitCode, 0, "signal-terminated vac must fail");
  console.log("ok (d2) signal termination maps to a nonzero exit");
}

// (d3) missing and non-executable VAC_CLI_PATH overrides use documented setup guidance
{
  process.env.VAC_CLI_PATH = resolve(tmpDir, "missing-vac");
  const missing = await tool.execute("t4c", { action: "verify" }, undefined);
  assert.equal(missing.details.exitCode, 127);
  assert(text(missing).includes("Verification isn't set up yet"), "missing override guidance");

  const nonExecutable = resolve(tmpDir, "non-executable-vac");
  writeFileSync(nonExecutable, "#!/bin/sh\nexit 0\n");
  chmodSync(nonExecutable, 0o644);
  process.env.VAC_CLI_PATH = nonExecutable;
  const denied = await tool.execute("t4d", { action: "verify" }, undefined);
  assert.equal(denied.details.exitCode, 127);
  assert(text(denied).includes("Verification isn't set up yet"), "non-executable override guidance");
  process.env.VAC_CLI_PATH = stubVacPath;
  console.log("ok (d3) unusable VAC_CLI_PATH guidance + 127");
}

// (e) unsafe args rejected BEFORE any spawn
{
  const result = await tool.execute("t5", { action: "verify", args: ["--detail; rm -rf /"] }, undefined);
  assert(result.details.validationError, "validation error reported");
  assert.equal(result.details.exitCode, undefined, "no process was spawned");
  console.log("ok (e) shell-unsafe args rejected pre-spawn");
}

// (f) >256KB stdout is truncated with a marker
{
  const result = await tool.execute("t6", { action: "report", job_id: "largeoutput" }, undefined);
  assert.equal(result.details.exitCode, 0);
  const out = text(result);
  assert(out.length <= 256 * 1024 + 100, `bounded output (got ${out.length})`);
  assert(out.includes("truncated"), "truncation marker present");
  console.log("ok (f) truncation enforced through tool.execute");
}

console.log("accept-tool-integration: passed");
