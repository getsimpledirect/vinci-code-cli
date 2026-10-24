// Tiny fixtures drive the canonical checker. Successful graph controls intentionally stop at
// absent identity.json: they qualify static dependency discovery, never a complete release.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(new URL("./packaged-artifact-check.mjs", import.meta.url));
const scratch = mkdtempSync(join(dirname(CHECKER), ".packaged-static-imports-"));
let nextFixture = 0;
function write(root, path, bytes) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
function fixture() {
  const root = join(scratch, String(++nextFixture));
  write(root, "vinci/extensions/entry.ts", "export const extension = 1;\n");
  write(root, "vinci/worker/worker.mjs", "export const worker = 1;\n");
  write(root, "vinci/bin/vinci", '#!/bin/sh\nexec node "${VINCI}/worker/worker.mjs" "$@"\n');
  return root;
}
function check(root) {
  return spawnSync(process.execPath, [CHECKER, root], {
    cwd: scratch, env: { PATH: process.env.PATH, TMPDIR: scratch },
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  });
}
function graphPassed(result, extensionImports, targetImports) {
  assert.equal(result.status, 1, "tiny fixture must stop before full release certification");
  assert.match(result.stdout, new RegExp(`${extensionImports} relative imports in vinci/extensions all resolve`));
  assert.match(result.stdout, new RegExp(`1 static launcher target\\(s\\), ${targetImports} relative imports under their directories resolve`));
  assert.match(result.stderr, /ENOENT[^\n]*identity\.json/, "the next real checker stage owns this intentional failure");
  assert.doesNotMatch(result.stderr, /unresolvable import/);
}
test.after(() => {
  const cleanup = spawnSync("find", [scratch, "-mindepth", "1", "-delete"], { timeout: 10000 });
  assert.equal(cleanup.status, 0, "Remove the owned static-checker fixture directory before retrying.");
  rmdirSync(scratch);
});

for (const [name, source] of [
  ["compact side-effect import", 'import"./missing.mjs";\n'],
  ["compact re-export", 'export{value}from"./missing.mjs";\n'],
  ["multiline value import", 'import\n{ value }\nfrom\n"./missing.mjs";\n'],
  ["escaped module path", 'import "./mis\\u0073ing.mjs";\n'],
  ["value import with a type binding", 'import { type Missing, value } from "./missing.mjs";\nvoid value;\n'],
  ["value export with a type binding", 'export { type Missing, value } from "./missing.mjs";\n'],
]) {
  test(`${name} refuses its missing edge, and the exact decoded file restores graph reachability`, () => {
    const root = fixture();
    write(root, "vinci/extensions/entry.ts", source);
    const absent = check(root);
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /1 unresolvable import\(s\) in the shipped extension layer/, `${name}: the canonical checker must refuse the actual static missing edge`);
    assert.match(absent.stderr, /entry\.ts -> \.\/missing\.mjs/, "report the path the consumer decodes");
    assert.doesNotMatch(absent.stdout, /relative imports in vinci\/extensions all resolve/);
    write(root, "vinci/extensions/missing.mjs", "export const value = 1;\n");
    graphPassed(check(root), 1, 0);
  });
}

test("comment and string text cannot invent executable import edges", () => {
  const root = fixture();
  write(root, "vinci/extensions/entry.ts", `/*
import { phantom } from "./comment-only.mjs";
export { phantom } from "./comment-export.mjs";
*/
const example = 'import"./string-only.mjs"';
export const text = example;
`);
  graphPassed(check(root), 0, 0);
});

test("runtime-erased import type and export type do not require shipped declaration targets", () => {
  const root = fixture();
  write(root, "vinci/extensions/entry.ts", `import type { Missing } from "./not-shipped.d.ts";
export type { Other } from "./also-not-shipped.d.ts";
export type * from "./still-not-shipped.d.ts";
export const value = 1;
`);
  graphPassed(check(root), 0, 0);
  const consumer = spawnSync(process.execPath, [join(root, "vinci/extensions/entry.ts")], {
    cwd: root, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(consumer.status, 0, `The real Node type stripper must erase these edges: ${consumer.stderr}`);
});

test("standalone side-effect imports use the same static contract and restore on the missing sibling", () => {
  const root = fixture();
  write(root, "vinci/worker/worker.mjs", 'import"./sibling.mjs";\n');
  const absent = check(root);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /1 unresolvable import\(s\) under launcher dispatch targets/);
  assert.match(absent.stderr, /worker\/worker\.mjs -> \.\/sibling\.mjs/);
  write(root, "vinci/worker/sibling.mjs", "export const sibling = 1;\n");
  graphPassed(check(root), 0, 1);
});

test("the graph preflight never executes source supplied by the artifact fixture", () => {
  const root = fixture();
  const marker = join(root, "executed");
  write(root, "vinci/extensions/entry.ts", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");\n`);
  write(root, "vinci/worker/worker.mjs", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");\n`);
  graphPassed(check(root), 0, 0);
  assert.equal(existsSync(marker), false, "static graph discovery cannot run unqualified fixture modules");
});
