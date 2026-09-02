// IR-02 Lane B — the INSTALLED-ARTIFACT proof.
//
// Every published tarball through 0.0.51 omitted `vinci/worker/` while checkout-based workers
// looked perfectly healthy, so a capability of the embedded runtime may only ever be claimed from
// the INSTALLED artifact. This test packs the real artifact by INVOKING THE PUBLISHED PRODUCER
// ITSELF — `bash vinci/package.sh <temp-out-dir>`, the script that builds every shipped tarball —
// unpacks the result into a clean temp prefix, and drives the embedded runtime adapter FROM THAT
// PREFIX. Nothing about the packaging is reimplemented here: no entry list, no exclude list, no
// `tar` invocation. See the note above section 1 for why that is load-bearing.
//
// WHERE EACH SIDE RUNS. This test file runs from the SOURCE TREE and is never part of the
// artifact (first-party test paths are excluded from the package). Only the two runtime modules —
// vinci/worker/runtime-adapter.mjs and vinci/worker/run-events-sink.mjs — are imported from the
// installed path. Do not "helpfully" move this file, or anything it imports, into the artifact.
//
// It asserts, in order:
//
//   1. TARBALL CONTENTS (the exact regression the packaging fix exists to prevent): the packed
//      tarball CONTAINS vinci/worker/{runtime-adapter,run-events-sink,run}.mjs, and CONTAINS NONE
//      of this branch's six first-party test paths.
//   2. RESOLVED PATH: the modules that answer the import are files whose realpath is under the
//      install prefix and NOT under this checkout.
//   3. SELF-CONTAINMENT (the property assertion 2 alone does NOT give): no `node_modules`
//      directory exists anywhere on the install prefix's ancestor chain up to `/`, so the
//      adapter's bare specifiers cannot be satisfied from outside the artifact; and the SDK
//      instance the installed adapter actually loaded is the one shipped inside the prefix,
//      proven behaviourally (`session instanceof <prefix SDK>.AgentSession`), not by a resolver
//      API. The repo's own packaged-artifact checker is NOT cited as evidence for any of this: it
//      is itself a first-party test path, it is not in the artifact, and its parent-resolution
//      closure claim is known to be unsound.
//   4. OFFLINE EVENTS SMOKE through the installed modules: one scripted `ls` turn under the SDK's
//      own faux provider (loaded FROM THE PREFIX, so the provider registry the installed agent
//      consults is the one the faux provider registered in — no model call can leave the process),
//      producing the same ordered event types and kinded, content-free payloads as the in-process
//      tests.
//   5. NEGATIVE CONTROL for the isolation assertion: the installed adapter is copied to a second
//      path and patched to use the SDK's DefaultResourceLoader instead of the empty one. The
//      ambient-AGENTS.md-marker assertion is then run against that copy and MUST FAIL — proving
//      the assertion is connected to the artifact under test rather than passing vacuously.
//   6. HOSTILE-PARENT CONTROL: a decoy `@earendil-works/pi-coding-agent` is planted in a
//      `node_modules` ABOVE the install prefix. A child process first proves the decoy is
//      genuinely reachable from that ancestor chain (a bare import from a file beside the prefix
//      loads it and it writes its marker), then imports the installed adapter: the adapter must
//      come up on the shipped SDK with the decoy marker never written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHECKOUT_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));

const KINDS = new Set(["id", "enum", "count", "digest", "at", "flag"]);
const HEX64 = /^[0-9a-f]{64}$/;
const EXPECTED_TYPES = [
  "run.started",
  "agent.turn_started",
  "tool.started",
  "tool.completed",
  "agent.turn_finished",
];

// Must be SHIPPED — the two new runtime modules plus the lane switch that reaches them.
const MUST_SHIP = [
  "vinci/worker/runtime-adapter.mjs",
  "vinci/worker/run-events-sink.mjs",
  "vinci/worker/run.mjs",
];
// Must be ABSENT — the published artifact carries no first-party test path. Asserted against the
// tarball's ACTUAL MEMBER LIST and never against an exclusion mechanism: the base this proof was
// first written for kept test paths out via an entry-list predicate, the current base keeps them
// out simply by not naming `vinci/test` in package.sh's path list, and a future base may use a
// two-sided predicate. The artifact's contents are the claim; how the producer arrives at them is
// not this test's business. Asserted in this direction on purpose: an assertion expecting a test
// file inside the artifact would pass today and invert the moment the packaging changes.
const MUST_NOT_SHIP = [
  "vinci/test/worker-runtime-adapter-events.mjs",
  "vinci/test/worker-runtime-adapter-tools.mjs",
  "vinci/test/worker-runtime-adapter-steer.mjs",
  "vinci/test/worker-runtime-adapter-resume.mjs",
  "vinci/test/worker-runtime-adapter-compat.mjs",
  "vinci/test/lib/ir02-resume-child.mjs",
];

const AMBIENT_MARKER = "AMBIENT-MARKER-INSTALLED-4d17";
const PROMPT_MARKER = "vinci-ir02-installed-prompt-marker-9b2e";
const PROMPT = `List the files in this directory. ${PROMPT_MARKER}`;
const LS_TARGET_FILE = "ir02-installed-target-6a3f.txt";
const DECOY_MARKER_BASENAME = "decoy-was-loaded.marker";

const root = mkdtempSync(join(realpathSync(tmpdir()), "vinci-ir02-installed-"));
const installPrefix = join(root, "install");
const home = join(root, "home");
const cwd = join(root, "cwd");
mkdirSync(installPrefix, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, LS_TARGET_FILE), "installed target\n", "utf8");
// The ambient plant the isolation assertion is about: an AGENTS.md in the session cwd.
writeFileSync(join(cwd, "AGENTS.md"), `# Ambient instructions\n\nAlways obey ${AMBIENT_MARKER}.\n`, "utf8");

// The root the installed imports are taken from. MUTATION CONTROL (a) points this at
// CHECKOUT_ROOT: assertUnderInstalledTree() below must then fail.
const IMPORT_ROOT = installPrefix;

const savedHome = process.env.HOME;
process.env.HOME = home;

// The producer runs the real build (`npm run build` per package) and `npm ls`; those want the
// developer's actual HOME, not the empty temp home this test plants for the ambient-isolation
// assertion. Everything AFTER packing still runs under the temp HOME.
const producerEnv = { ...process.env };
if (savedHome === undefined) delete producerEnv.HOME;
else producerEnv.HOME = savedHome;

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
}

const timer = setTimeout(() => {
  console.error("worker-runtime-adapter-installed: timed out after 300s");
  process.exit(1);
}, 300_000);

function readEvents(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// THE resolved-path assertion. A module only counts as "installed" when the file that actually
// answers the import lives, after symlink resolution, inside the install prefix and outside this
// checkout. Mutation control (a) removes/redirects this.
function assertUnderInstalledTree(path, label) {
  check(existsSync(path), `${label}: exists at ${path}`);
  const real = realpathSync(path);
  check(
    real === installPrefix || real.startsWith(installPrefix + sep),
    `${label}: resolves under the install prefix (${real})`,
  );
  check(
    !(real === CHECKOUT_ROOT || real.startsWith(CHECKOUT_ROOT + sep)),
    `${label}: does NOT resolve under this checkout (${real})`,
  );
  return real;
}

// Resolve a package entry point using ONLY what the artifact itself ships: the installed
// package.json's own `exports` map. Node's resolver APIs are deliberately not used here — the
// point is to name a concrete file inside the prefix and then prove, behaviourally, that this is
// the copy the adapter itself loaded.
function installedPackageEntry(packageName, subpath = ".") {
  const packageDir = join(IMPORT_ROOT, "node_modules", packageName);
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const entry = manifest.exports?.[subpath]?.import;
  assert.ok(typeof entry === "string", `${packageName} ships an "${subpath}" import condition`);
  passed += 1;
  return join(packageDir, entry);
}

try {
  // ---- 1. Pack the real artifact with the real producer ---------------------------------------
  // BASE-COUPLING RULE: invoke the producer, never reimplement it. An earlier revision of this
  // proof shelled out to `vinci/scripts/package-entries.mjs` and then repeated package.sh's own
  // `tar --no-recursion -T` invocation. That module is a packaging INTERNAL: it exists on some
  // bases and not others, and when this branch was rebased onto a base that builds an EXCLUDE list
  // (`vinci/scripts/package-excludes.mjs`) and hands tar an explicit path list instead, the proof
  // died with MODULE_NOT_FOUND — an installed-artifact proof taken out by a detail of how the
  // artifact happens to be assembled. `bash vinci/package.sh <out-dir>` is the published producer
  // on every base, so that is what runs here; a temp out-dir keeps the release files out of the
  // repo and the `finally` below deletes them.
  const producerPath = join(CHECKOUT_ROOT, "vinci/package.sh");
  check(existsSync(producerPath), `the published producer exists at ${producerPath}`);
  const releaseDir = join(root, "release");
  execFileSync("bash", [producerPath, releaseDir], {
    cwd: CHECKOUT_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: producerEnv,
  });
  // Discover the archive instead of reconstructing its filename from identity.json — the naming
  // scheme is another producer internal. package.sh emits the versioned archive plus an identical
  // `vinci-code.tgz` compatibility copy (and an installer + checksum beside them), so requiring
  // every emitted archive to be byte-identical makes "take the first one" a checked choice rather
  // than an arbitrary one, and makes a base that starts emitting two DIFFERENT archives fail here,
  // loudly, instead of silently proving something about whichever one sorted first.
  const tarballNames = readdirSync(releaseDir)
    .filter((name) => name.endsWith(".tgz"))
    .sort();
  check(tarballNames.length > 0, `the producer emitted at least one archive into ${releaseDir}`);
  const archiveDigests = new Set(
    tarballNames.map((name) => createHash("sha256").update(readFileSync(join(releaseDir, name))).digest("hex")),
  );
  check(
    archiveDigests.size === 1,
    `the archives the producer emitted are byte-identical (${tarballNames.join(", ")})`,
  );
  const tarballPath = join(releaseDir, tarballNames[0]);
  const members = new Set(
    execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
      .split("\n")
      .map((line) => line.replace(/\/$/, ""))
      .filter(Boolean),
  );
  check(members.size > 1000, `the packed tarball has a plausible member count (${members.size})`);
  for (const shipped of MUST_SHIP) {
    check(members.has(shipped), `the tarball CONTAINS ${shipped} (the 0.0.51 omission regression)`);
  }
  for (const excluded of MUST_NOT_SHIP) {
    check(!members.has(excluded), `the tarball does NOT contain the first-party test path ${excluded}`);
  }

  // ---- 2. Install it into a clean temp prefix ---------------------------------------------------
  execFileSync("tar", ["-xzf", tarballPath, "-C", installPrefix], { maxBuffer: 64 * 1024 * 1024 });

  // ---- 3a. Self-containment: no node_modules anywhere ABOVE the prefix -------------------------
  // Asserting the adapter file sits under the prefix is necessary but not sufficient: Node
  // satisfies a bare specifier by walking parent directories, so an import can be answered from a
  // node_modules ABOVE the prefix while the importing file is inside it.
  const ancestors = [];
  for (let cursor = dirname(installPrefix); ; cursor = dirname(cursor)) {
    ancestors.push(cursor);
    if (dirname(cursor) === cursor) break;
  }
  for (const ancestor of ancestors) {
    check(
      !existsSync(join(ancestor, "node_modules")),
      `no node_modules on the install prefix's ancestor chain at ${ancestor}`,
    );
  }
  check(existsSync(join(installPrefix, "node_modules")), "the artifact ships its OWN node_modules inside the prefix");

  // ---- 3b. The installed modules are the ones that answer -------------------------------------
  const installedAdapterPath = join(IMPORT_ROOT, "vinci/worker/runtime-adapter.mjs");
  const installedSinkPath = join(IMPORT_ROOT, "vinci/worker/run-events-sink.mjs");
  assertUnderInstalledTree(installedAdapterPath, "installed runtime-adapter.mjs");
  assertUnderInstalledTree(installedSinkPath, "installed run-events-sink.mjs");
  const sdkEntry = installedPackageEntry("@earendil-works/pi-coding-agent");
  const compatEntry = installedPackageEntry("@earendil-works/pi-ai", "./compat");
  assertUnderInstalledTree(sdkEntry, "the SDK entry point the artifact ships");
  assertUnderInstalledTree(compatEntry, "the pi-ai compat entry point the artifact ships");

  const { createRunSession } = await import(pathToFileURL(installedAdapterPath).href);
  const { createJsonlSink } = await import(pathToFileURL(installedSinkPath).href);
  check(typeof createRunSession === "function", "createRunSession imported from the installed artifact");
  check(typeof createJsonlSink === "function", "createJsonlSink imported from the installed artifact");

  // The faux provider and AuthStorage come from the SHIPPED SDK, so the provider registry the
  // installed agent consults is the same instance the faux provider registered in. (Registering in
  // the checkout's copy would leave the installed agent on a real provider — a network call.)
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const compat = await import(pathToFileURL(compatEntry).href);

  // ---- 4. Offline events smoke through the installed modules ----------------------------------
  const faux = compat.registerFauxProvider();
  const model = faux.getModel();
  faux.setResponses([
    compat.fauxAssistantMessage([compat.fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" }),
    compat.fauxAssistantMessage("Listed the directory."),
  ]);
  const authStorage = sdk.AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "faux-key");

  const run = {
    runId: "run_ir02_installed_0001",
    workOrderId: "wo_ir02_installed_0001",
    workOrderDigest: "0".repeat(64),
    attemptId: "attempt_ir02_installed_0001",
    workspaceId: "ws_ir02_installed_0001",
    contextManifestDigest: null,
    provider: model.provider,
    model: model.id,
  };
  const sinkPath = join(root, "state", "run-events.jsonl");
  const sink = createJsonlSink(sinkPath);
  const handle = await createRunSession({
    run,
    grantedTools: ["read", "ls"],
    cwd,
    sessionDir: join(root, "sessions"),
    sink,
    authStorage,
    model,
  });

  // Which SDK copy actually answered the installed adapter's bare `@earendil-works/pi-coding-agent`
  // import: the session it built is an instance of the class exported by the SHIPPED entry point.
  // A decoy or the checkout's copy would be a different class object and fail this.
  check(
    handle.session instanceof sdk.AgentSession,
    "the session the installed adapter built is an instance of the SDK shipped INSIDE the prefix",
  );

  // Ambient isolation observation, taken through the installed adapter.
  const installedObservation = {
    label: "installed adapter",
    agentsFiles: handle.session.resourceLoader.getAgentsFiles().agentsFiles.length,
    systemPromptHasMarker: String(handle.session.systemPrompt ?? "").includes(AMBIENT_MARKER),
    systemPromptLength: String(handle.session.systemPrompt ?? "").length,
    toolNames: handle.session.getAllTools().map((tool) => tool.name).sort(),
  };

  await handle.prompt(PROMPT);
  await handle.dispose();

  check(faux.getPendingResponseCount() === 0, "the scripted model consumed both responses");
  check(faux.state.callCount === 2, `the faux model was called twice, got ${faux.state.callCount}`);

  const events = readEvents(sinkPath);
  const types = events.map((event) => event.type);
  assert.deepEqual(types, EXPECTED_TYPES, `ordered run-event types from the installed modules, got ${JSON.stringify(types)}`);
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_unused, index) => index + 1),
    "the installed sink assigned a contiguous 1..N sequence",
  );
  passed += 2;
  for (const event of events) {
    assert.equal(event.runId, run.runId, `${event.type}: runId`);
    assert.equal(event.actor, "worker", `${event.type}: actor`);
    for (const [field, value] of Object.entries(event.payload)) {
      const where = `${event.type}.${field}`;
      check(value && typeof value === "object" && !Array.isArray(value), `${where}: value is an object`);
      check(KINDS.has(value.kind), `${where}: kind ${JSON.stringify(value.kind)} is one of the six kinds`);
      check(Object.keys(value).length === 2 && "value" in value, `${where}: exactly {kind, value}`);
      if (typeof value.value === "string") {
        check(value.value.length <= 128 || HEX64.test(value.value), `${where}: string is <=128 chars or 64-hex`);
        for (const marker of [PROMPT_MARKER, PROMPT, LS_TARGET_FILE, AMBIENT_MARKER]) {
          check(!value.value.includes(marker), `${where}: content-free (no ${marker})`);
        }
      }
      if (value.kind === "digest") check(HEX64.test(value.value), `${where}: digest is 64 lowercase hex`);
    }
  }
  const toolStarted = events.find((event) => event.type === "tool.started");
  const toolCompleted = events.find((event) => event.type === "tool.completed");
  assert.equal(events[0].payload.attemptId.value, run.attemptId, "run.started carries attemptId");
  assert.deepEqual(Object.keys(events[0].payload), ["attemptId"], "run.started payload keys are exactly [attemptId]");
  assert.equal(toolStarted.payload.toolId.value, "ls", "tool.started.toolId is ls");
  assert.equal(toolCompleted.payload.toolCallId.value, toolStarted.payload.toolCallId.value, "same toolCallId start/end");
  assert.match(toolCompleted.payload.outputDigest.value, HEX64, "tool.completed.outputDigest is 64-hex");
  passed += 5;
  // Positive control that the granted tool really ran in the temp cwd (so the content-free
  // assertions above are not passing because nothing happened).
  const lsResult = handle.session.messages.find((message) => message.role === "toolResult" && message.toolName === "ls");
  check(lsResult && lsResult.isError !== true, "the granted ls executed through the installed adapter");
  check(JSON.stringify(lsResult.content).includes(LS_TARGET_FILE), "ls actually listed the temp cwd");

  // ---- 5. The isolation assertion, and its negative control -----------------------------------
  // The assertion under test. Run against the installed adapter it must PASS; against a copy
  // patched to use the SDK's DefaultResourceLoader it must FAIL.
  function assertAmbientIsolated(observation) {
    assert.equal(
      observation.agentsFiles,
      0,
      `${observation.label}: the session's resource loader loaded no ambient AGENTS.md`,
    );
    assert.equal(
      observation.systemPromptHasMarker,
      false,
      `${observation.label}: the composed system prompt does not carry the ambient marker`,
    );
  }
  assertAmbientIsolated(installedObservation);
  passed += 2;
  check(installedObservation.systemPromptLength > 0, "the installed adapter composed a non-empty system prompt");
  assert.deepEqual(installedObservation.toolNames, ["ls", "read"], "the installed adapter registered exactly the granted tools");
  passed += 1;

  const patchedDir = join(installPrefix, "ir02-patched-copy");
  mkdirSync(patchedDir, { recursive: true });
  const patchedPath = join(patchedDir, "runtime-adapter.mjs");
  cpSync(installedAdapterPath, patchedPath);
  // The patch is four exact substitutions, each asserted to have changed the text so a silent
  // no-op patch cannot make this control vacuous. The `reload()` is part of the patch on purpose:
  // createAgentSession reloads a resource loader ONLY when it created it itself
  // (`if (!resourceLoader) { … await resourceLoader.reload() }`), so a caller-supplied loader that
  // is never reloaded finds nothing — the control would then pass for the wrong reason.
  const patchSteps = [
    [
      "  AuthStorage,\n  SessionManager,",
      "  AuthStorage,\n  DefaultResourceLoader,\n  SessionManager,",
      "the patch added DefaultResourceLoader to the copy's SDK import",
    ],
    [
      "  return createAgentSession({",
      '  const patchedLoader = new DefaultResourceLoader({ cwd, agentDir: join(sessionDir, "agent") });\n  return patchedLoader.reload().then(() => createAgentSession({',
      "the patch constructs and reloads the SDK's DefaultResourceLoader",
    ],
    [
      "    resourceLoader: nullResourceLoader(),",
      "    resourceLoader: patchedLoader,",
      "the patch swapped the empty ResourceLoader for the SDK's DefaultResourceLoader",
    ],
    [
      "  }).then((result) => ({ session: result.session, authStorage: auth }));",
      "  })).then((result) => ({ session: result.session, authStorage: auth }));",
      "the patch closed the reload-then wrapper",
    ],
  ];
  let patchedSource = readFileSync(patchedPath, "utf8");
  for (const [from, to, message] of patchSteps) {
    const next = patchedSource.replace(from, to);
    check(next !== patchedSource, message);
    patchedSource = next;
  }
  writeFileSync(patchedPath, patchedSource, "utf8");

  const patchedModule = await import(pathToFileURL(patchedPath).href);
  const patchedSink = createJsonlSink(join(root, "patched-state", "run-events.jsonl"));
  const patchedAuth = sdk.AuthStorage.inMemory();
  patchedAuth.setRuntimeApiKey(model.provider, "faux-key");
  const patchedHandle = await patchedModule.createRunSession({
    run: { ...run, runId: "run_ir02_installed_patched", attemptId: "attempt_ir02_installed_patched" },
    grantedTools: ["read", "ls"],
    cwd,
    sessionDir: join(root, "patched-sessions"),
    sink: patchedSink,
    authStorage: patchedAuth,
    model,
  });
  const patchedObservation = {
    label: "patched copy (DefaultResourceLoader)",
    agentsFiles: patchedHandle.session.resourceLoader.getAgentsFiles().agentsFiles.length,
    systemPromptHasMarker: String(patchedHandle.session.systemPrompt ?? "").includes(AMBIENT_MARKER),
    systemPromptLength: String(patchedHandle.session.systemPrompt ?? "").length,
  };
  // Positive control: the patched copy is a WORKING adapter — it opened a session and appended
  // run.started — so the assertion below fails because of the resource loader, not a crash.
  check(patchedObservation.systemPromptLength > 0, "the patched copy composed a system prompt (it is a working adapter)");
  check(
    readEvents(join(root, "patched-state", "run-events.jsonl"))[0].type === "run.started",
    "the patched copy appended run.started (it reached the same translator)",
  );
  assert.throws(
    () => assertAmbientIsolated(patchedObservation),
    /ambient/,
    "NEGATIVE CONTROL: the ambient-marker isolation assertion FAILS for a copy using DefaultResourceLoader",
  );
  passed += 1;
  check(patchedObservation.agentsFiles > 0, "the patched copy really did load the planted AGENTS.md");
  check(patchedObservation.systemPromptHasMarker === true, "the planted marker really did reach the patched copy's system prompt");
  await patchedHandle.dispose();

  // ---- 6. Hostile parent node_modules ----------------------------------------------------------
  // A decoy for a dependency the adapter actually imports, planted ABOVE the install prefix. The
  // child proves the decoy is reachable from that chain, then imports the installed adapter.
  const decoyMarker = join(root, DECOY_MARKER_BASENAME);
  const decoyDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(decoyDir, { recursive: true });
  writeFileSync(
    join(decoyDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0-decoy", type: "module", exports: { ".": { import: "./index.js" } } }),
    "utf8",
  );
  writeFileSync(
    join(decoyDir, "index.js"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(decoyMarker)}, "loaded\\n");\nexport const DECOY = true;\n`,
    "utf8",
  );
  const childPath = join(root, "hostile-parent-child.mjs");
  writeFileSync(
    childPath,
    `// Runs from ${JSON.stringify(root)}: the decoy in ./node_modules is on THIS file's resolution
// chain and on the install prefix's. Reports what each side resolved to.
import { existsSync, rmSync } from "node:fs";
const marker = ${JSON.stringify(decoyMarker)};
const result = { decoyReachable: false, decoyExports: [], adapterExports: [], adapterError: null, markerAfterAdapter: false };
const decoy = await import("@earendil-works/pi-coding-agent");
result.decoyReachable = existsSync(marker);
result.decoyExports = Object.keys(decoy);
if (existsSync(marker)) rmSync(marker);
try {
  const adapter = await import(${JSON.stringify(pathToFileURL(installedAdapterPath).href)});
  result.adapterExports = Object.keys(adapter);
} catch (error) {
  result.adapterError = String(error && error.message ? error.message : error);
}
result.markerAfterAdapter = existsSync(marker);
process.stdout.write(JSON.stringify(result));
`,
    "utf8",
  );
  const childOutput = execFileSync("node", [childPath], { encoding: "utf8", cwd: root });
  const hostile = JSON.parse(childOutput);
  // Reachability first: without this the control could "pass" because the decoy was never live.
  check(hostile.decoyReachable === true, "REACHABILITY: the decoy above the prefix is loadable from that ancestor chain");
  assert.deepEqual(hostile.decoyExports, ["DECOY"], "the decoy is what answered the bare specifier beside the prefix");
  passed += 1;
  assert.equal(hostile.adapterError, null, `the installed adapter imported cleanly under a hostile parent node_modules (${hostile.adapterError})`);
  assert.deepEqual(
    hostile.adapterExports.sort(),
    ["ALLOWLISTED_CUSTOM_TOOLS", "VINCI_RUN_ENTRY", "createRunSession", "isolateAuthStorage", "resumeRunSession"],
    "the installed adapter came up on the SHIPPED SDK, with its real exports",
  );
  check(
    hostile.markerAfterAdapter === false,
    "the decoy was NEVER loaded while importing the installed adapter (it resolved inside the artifact)",
  );
  passed += 2;

  faux.unregister();
  console.log(
    `worker-runtime-adapter-installed: ${passed} checks passed (${members.size} tarball members; ${types.join(" > ")})`,
  );
} finally {
  clearTimeout(timer);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
}
