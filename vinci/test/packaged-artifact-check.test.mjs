import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("./packaged-artifact-check.mjs", import.meta.url));
const fixtureRoots = [];

const manifest = {
  schema: "vinci.launcher-dispatches/v1",
  dispatches: [
    { command: "report-wrong", kind: "node", target: "scripts/report-wrong.mjs" },
    { command: "verify", kind: "external", targetVariable: "_vinci_vac_cli" },
    { command: "worker", kind: "node", target: "worker/worker.mjs" },
  ],
};

const launcher = `#!/usr/bin/env bash
if [ "\${1:-}" = "report-wrong" ]; then
  # vinci-dispatch: report-wrong
  exec node "\${VINCI}/scripts/report-wrong.mjs" "$@"
fi
if [ "\${1:-}" = "verify" ]; then
  # vinci-dispatch: verify
  exec "\${_vinci_vac_cli}" "$@"
fi
if [ "\${1:-}" = "worker" ]; then
  # vinci-dispatch: worker
  exec node "\${VINCI}/worker/worker.mjs" "$@"
fi
`;

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vinci-packaged-check-"));
  fixtureRoots.push(root);
  write(join(root, "vinci", "identity.json"), JSON.stringify({ productName: "Vinci Code", command: "vinci" }));
  write(join(root, "vinci", "dispatch-manifest.json"), JSON.stringify(manifest));
  write(join(root, "vinci", "bin", "vinci"), launcher);
  write(join(root, "vinci", "scripts", "report-wrong.mjs"), 'import "./report-helper.mjs";\n');
  write(join(root, "vinci", "scripts", "report-helper.mjs"), "export const ready = true;\n");
  write(join(root, "vinci", "worker", "worker.mjs"), 'import {\n  run,\n} from "./run.mjs";\nrun;\n');
  write(join(root, "vinci", "worker", "run.mjs"), 'import{ready}from"./contracts/load.cjs";\nexport const run = ready;\n');
  write(join(root, "vinci", "worker", "contracts", "load.cjs"), 'const digest = require("./digest.cjs");\nmodule.exports = { ready: digest.ready };\n');
  write(join(root, "vinci", "worker", "contracts", "digest.cjs"), "module.exports = { ready: true };\n");
  write(join(root, "vinci", "extensions", "entry.ts"), 'import "./side-effect.js";\n');
  write(join(root, "vinci", "extensions", "side-effect.js"), "export {};\n");
  return root;
}

function run(root, cwd = tmpdir()) {
  return spawnSync(process.execPath, [checker, root], { cwd, encoding: "utf8", timeout: 10_000 });
}

function expectFailure(result, pattern) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, pattern);
}

test.after(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

test("positive control validates every manifest dispatch and recursive side-effect dependency", () => {
  const root = fixture();
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 manifest-bound launcher dispatches/);
  assert.match(result.stdout, /6 dispatch files\/4 imports/);
});

test("old package behavior fails when the worker target is absent", () => {
  const root = fixture();
  rmSync(join(root, "vinci", "worker"), { recursive: true });
  expectFailure(run(root), /dispatch target worker has wrong case or is missing/);
});

test("fault restoration fails when a transitive side-effect dependency is absent", () => {
  const root = fixture();
  rmSync(join(root, "vinci", "worker", "contracts", "digest.cjs"));
  expectFailure(run(root), /worker\/contracts\/load\.cjs -> \.\/digest\.cjs/);
});

test("zero-target discovery is a refusal", () => {
  const root = fixture();
  write(join(root, "vinci", "dispatch-manifest.json"), JSON.stringify({ ...manifest, dispatches: [] }));
  expectFailure(run(root), /wrong schema or no dispatches/);
});

test("partial discovery cannot pass when one exec changes spelling", () => {
  const root = fixture();
  write(
    join(root, "vinci", "bin", "vinci"),
    launcher.replace(
      '# vinci-dispatch: worker\n  exec node "${VINCI}/worker/worker.mjs" "$@"',
      'exec /usr/bin/node "$VINCI/worker/worker.mjs" "$@"',
    ),
  );
  expectFailure(run(root), /unmanifested exec/);
});

test("absolute and alternate Node exec forms are rejected", () => {
  const variants = [
    'exec /opt/homebrew/bin/node "${VINCI}/worker/worker.mjs" "$@"',
    'exec env node "${VINCI}/worker/worker.mjs" "$@"',
    'exec node "$VINCI/worker/worker.mjs" "$@"',
  ];
  for (const replacement of variants) {
    const root = fixture();
    write(
      join(root, "vinci", "bin", "vinci"),
      launcher.replace('exec node "${VINCI}/worker/worker.mjs" "$@"', replacement),
    );
    expectFailure(run(root), /does not use its exact reviewed exec/);
  }
});

test("an unmarked extra exec cannot hide beside valid entries", () => {
  const root = fixture();
  write(join(root, "vinci", "bin", "vinci"), `${launcher}\nexec "$NODE" /tmp/extra.mjs\n`);
  expectFailure(run(root), /unmanifested executable dispatch/);
});

test("shell-equivalent exec spelling cannot bypass dispatch discovery", () => {
  const root = fixture();
  write(join(root, "vinci", "bin", "vinci"), `${launcher}\ne""xec node "\${VINCI}/missing.mjs" "$@"\n`);
  expectFailure(run(root), /unmanifested executable dispatch/);
});

test("a non-exec Node dispatch cannot bypass dispatch discovery", () => {
  const root = fixture();
  write(join(root, "vinci", "bin", "vinci"), `${launcher}\nnode "\${VINCI}/missing.mjs"; exit $?\n`);
  expectFailure(run(root), /unmanifested executable dispatch/);
});

test("alternate runners and nested command substitutions cannot bypass dispatch discovery", () => {
  for (const addition of [
    'bash "${VINCI}/missing.sh"',
    'result="$(node "${VINCI}/missing.mjs")"',
    'result="`node "${VINCI}/missing.mjs"`"',
  ]) {
    const root = fixture();
    write(join(root, "vinci", "bin", "vinci"), `${launcher}\n${addition}\n`);
    expectFailure(run(root), /unmanifested executable dispatch/);
  }
});

test("missing, malformed, null, and wrong-type manifests refuse", () => {
  const cases = [
    { value: null, pattern: /wrong schema or no dispatches/ },
    { value: { schema: manifest.schema, dispatches: "worker" }, pattern: /wrong schema or no dispatches/ },
    { value: { ...manifest, extra: true }, pattern: /wrong schema or no dispatches/ },
  ];
  for (const candidate of cases) {
    const root = fixture();
    write(join(root, "vinci", "dispatch-manifest.json"), JSON.stringify(candidate.value));
    expectFailure(run(root), candidate.pattern);
  }
  const malformedRoot = fixture();
  write(join(malformedRoot, "vinci", "dispatch-manifest.json"), "{");
  expectFailure(run(malformedRoot), /malformed JSON/);
  const missingRoot = fixture();
  rmSync(join(missingRoot, "vinci", "dispatch-manifest.json"));
  expectFailure(run(missingRoot), /wrong case or is missing/);
});

test("unsafe, empty, and wrong-type target paths refuse", () => {
  for (const target of ["", "../worker.mjs", "/tmp/worker.mjs", null]) {
    const root = fixture();
    const changed = structuredClone(manifest);
    changed.dispatches[2].target = target;
    write(join(root, "vinci", "dispatch-manifest.json"), JSON.stringify(changed));
    expectFailure(run(root), /target must be a normalized relative path/);
  }
});

test("case-only target mismatches fail even on a case-insensitive host", () => {
  const root = fixture();
  const changed = structuredClone(manifest);
  changed.dispatches[2].target = "Worker/worker.mjs";
  write(join(root, "vinci", "dispatch-manifest.json"), JSON.stringify(changed));
  write(
    join(root, "vinci", "bin", "vinci"),
    launcher.replace("worker/worker.mjs", "Worker/worker.mjs"),
  );
  expectFailure(run(root), /wrong case or is missing/);
});

test("symlink targets and symlinked dependency edges refuse", () => {
  const targetRoot = fixture();
  rmSync(join(targetRoot, "vinci", "worker", "worker.mjs"));
  symlinkSync(join(targetRoot, "vinci", "scripts", "report-helper.mjs"), join(targetRoot, "vinci", "worker", "worker.mjs"));
  expectFailure(run(targetRoot), /must not traverse a symlink/);

  const dependencyRoot = fixture();
  rmSync(join(dependencyRoot, "vinci", "worker", "contracts", "digest.cjs"));
  symlinkSync(
    join(dependencyRoot, "vinci", "scripts", "report-helper.mjs"),
    join(dependencyRoot, "vinci", "worker", "contracts", "digest.cjs"),
  );
  expectFailure(run(dependencyRoot), /must not traverse a symlink/);
});

test("dynamic import, computed require, and aliased require are explicitly rejected", () => {
  for (const source of [
    'await import("./run.mjs");\n',
    'require("./" + process.env.MODULE);\n',
    'const load = require; load("./missing.cjs");\n',
    'const load = module["require"]; load("./missing.cjs");\n',
    'eval(\'require("./missing.cjs")\');\n',
  ]) {
    const root = fixture();
    write(join(root, "vinci", "worker", "worker.mjs"), source);
    expectFailure(run(root), /dynamic\/runtime module loading|aliases a runtime module loader/);
  }
});

test("compact static imports and recursively traversed CommonJS imports fail on the missing edge", () => {
  const esmRoot = fixture();
  write(join(esmRoot, "vinci", "worker", "worker.mjs"), 'import{missing}from"./absent.mjs";\n');
  expectFailure(run(esmRoot), /worker\/worker\.mjs -> \.\/absent\.mjs/);

  const cjsRoot = fixture();
  rmSync(join(cjsRoot, "vinci", "worker", "contracts", "digest.cjs"));
  expectFailure(run(cjsRoot), /worker\/contracts\/load\.cjs -> \.\/digest\.cjs/);
});

test("malformed executable module syntax refuses instead of yielding a partial graph", () => {
  const root = fixture();
  write(join(root, "vinci", "worker", "worker.mjs"), 'import { from "./missing.mjs";\n');
  expectFailure(run(root), /malformed executable module syntax/);
});

test("verification never executes packaged target code", () => {
  const root = fixture();
  const marker = join(root, "executed-marker");
  write(
    join(root, "vinci", "worker", "worker.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n`,
  );
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(marker), false);
});

test("artifact identity prevents a wrong repository from certifying", () => {
  const root = fixture();
  write(join(root, "vinci", "identity.json"), JSON.stringify({ productName: "Other", command: "vinci" }));
  expectFailure(run(root), /artifact identity is not Vinci Code/);
});

test("artifact resolution is independent of the caller working directory", () => {
  const root = fixture();
  const unrelated = mkdtempSync(join(tmpdir(), "vinci-unrelated-cwd-"));
  fixtureRoots.push(unrelated);
  write(join(unrelated, "vinci", "worker", "worker.mjs"), "throw new Error('wrong tree');\n");
  const result = run(root, unrelated);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(root, "vinci", "worker", "worker.mjs"), "utf8"), /run\.mjs/);
});
