import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });

test.beforeEach(async () => {
  delete globalThis.__vinciVeroPresentationSources;
  delete globalThis.__vinciAutomationStopStore;
  delete globalThis.__vinciTaskOutcomeStore;
  const ui = await loader.import(resolve(here, "../extensions/lib/ui-state.ts"), { default: false });
  ui.resetVinciUiState();
});

test("unregistered sources give the default presentation", async () => {
  const vero = await loader.import(resolve(here, "../extensions/lib/vero-presentation.ts"), { default: false });
  assert.deepEqual(vero.getVeroPresentation(), { label: "Ready", token: "muted" },
    "Expected Ready from vero-presentation.ts with no sources registered.");
});

test("control.ts registers the automation stop source", async () => {
  const vero = await loader.import(resolve(here, "../extensions/lib/vero-presentation.ts"), { default: false });
  const control = await loader.import(resolve(here, "../extensions/lib/control.ts"), { default: false });
  control.requestVinciAutomationStop("test stop");
  const presentation = vero.getVeroPresentation();
  assert.equal(presentation.label, "Blocked", "Expected Blocked after control.ts registers the automation stop source.");
  assert.equal(presentation.token, "error",
    "Expected Blocked with the error token after control.ts registers the automation stop source.");
});

test("task-outcome.ts registers the task outcome source", async () => {
  const vero = await loader.import(resolve(here, "../extensions/lib/vero-presentation.ts"), { default: false });
  const outcomes = await loader.import(resolve(here, "../extensions/lib/task-outcome.ts"), { default: false });
  outcomes.setVinciTaskOutcome({
    schemaVersion: 1,
    taskId: "t",
    state: "DONE",
    reason: "",
    changedFiles: [],
    verificationStatus: "passed",
    verificationCommand: "",
    usage: {},
  });
  assert.deepEqual(vero.getVeroPresentation(), { label: "Done", token: "success" },
    "Expected Done after task-outcome.ts registers the task outcome source.");
});
