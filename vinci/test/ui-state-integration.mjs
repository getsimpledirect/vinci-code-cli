import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const source = fileURLToPath(new URL("../extensions/lib/ui-state.ts", import.meta.url));
const firstLoader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const secondLoader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const first = await firstLoader.import(source, { default: false });
const second = await secondLoader.import(source, { default: false });

first.resetVinciUiState();
let notifications = 0;
const unsubscribe = second.subscribeVinciUiState(() => notifications++);
first.setVinciConnection("signed-in");
first.setVinciMode("plan");
first.setVinciContinuationPending(true);

assert.equal(second.getVinciUiState().connection, "signed-in");
assert.equal(second.getVinciUiState().mode, "plan");
assert.equal(second.getVinciUiState().continuationPending, true);
assert.equal(second.getVinciUiState().workingLabel, "Continuing the task…");
assert.equal(second.getVinciUiState().working, true);
assert.equal(notifications, 3);
unsubscribe();

process.stdout.write("  ✓ UI state is shared across isolated extension loaders\n");
