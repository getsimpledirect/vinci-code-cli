// Offline scope reaches crew helpers (O-a): childLaunch builds a helper's argv from how the main
// process was launched; an offline scope must be passed on as --offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crew from "./vinci-crew.ts";

const MAIN = ["node", "/opt/vinci/cli.js", "--extension", "/x/vinci-search.ts", "--extension", "/x/vinci-crew.ts", "--thinking", "low"];

function launch(argv, env) {
  assert.equal(typeof crew.childLaunch, "function", "childLaunch must be exported");
  return crew.childLaunch(argv, env);
}

test("C1 argv: a main run started with --offline launches helpers with --offline", () => {
  const { args } = launch([...MAIN, "--offline"], {});
  assert.ok(args.includes("--offline"), `C1: helper args must include --offline: ${args.join(" ")}`);
});

test("C2 env: a prompt scope signalled in the environment launches helpers with --offline", () => {
  const { args } = launch(MAIN, { VINCI_OFFLINE_SCOPE: "1" });
  assert.ok(args.includes("--offline"), `C2: helper args must include --offline: ${args.join(" ")}`);
});

test("C3 neither: no scope means no --offline, and extensions and thinking still pass", () => {
  const { cliPath, args } = launch(MAIN, {});
  assert.equal(cliPath, "/opt/vinci/cli.js");
  assert.ok(!args.includes("--offline"), `C3: no --offline expected: ${args.join(" ")}`);
  assert.deepEqual(args, ["--extension", "/x/vinci-search.ts", "--thinking", "low"], "C3: the crew extension is dropped, the rest kept");
});
