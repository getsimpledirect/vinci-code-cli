// A custom turn sent with newRequest starts a separate request in the receipt (#170).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } from "../../packages/coding-agent/dist/index.js";
import receipt from "../dist/extensions/vinci-receipt.js";

process.env.VINCI_CODE = "1";
const owned = mkdtempSync(join(tmpdir(), "custom-turn-scope-"));
const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
process.env.GIT_CEILING_DIRECTORIES = owned;

async function fixture(mode, { retry = false } = {}) {
  const cwd = mkdtempSync(join(owned, `${mode}-`));
  const agentDir = join(cwd, "profile");
  mkdirSync(agentDir);
  const faux = registerFauxProvider({ tokensPerSecond: 100_000, api: `faux:custom-turn-scope-${mode}` });
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(faux.getModel().provider, "offline-faux-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: retry, maxRetries: 2, baseDelayMs: 1 }, compaction: { enabled: false } });
  const extensionEvents = [];
  const extensionFactories = [(pi) => {
    pi.on("before_agent_start", (event) => { extensionEvents.push(event); });
    pi.on("agent_start", (event) => { extensionEvents.push(event); });
  }, receipt];
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, extensionFactories,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd, agentDir, authStorage, modelRegistry, settingsManager, resourceLoader,
    model: faux.getModel(), sessionManager: SessionManager.inMemory(cwd),
  });
  await session.bindExtensions({ mode, onError(error) { throw new Error(`Extension error: ${error.error}`); } });
  const outcomes = () => session.sessionManager.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "vinci-task-outcome")
    .map((entry) => entry.data);
  return { session, faux, extensionEvents, outcomes, close() { session.dispose(); faux.unregister(); } };
}

const name = "a custom turn sent as a new request does not inherit the previous request's operations";
let failures = 0;
try {
  for (const mode of ["tui", "print", "json", "rpc"]) {
    for (const row of ["newRequest", "continuation", "newRequest false"]) {
      const f = await fixture(mode);
      try {
        f.faux.setResponses([
          fauxAssistantMessage(fauxToolCall("read", { path: "missing-input.txt" }, { id: "read-missing" }), { stopReason: "toolUse" }),
          fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
          fauxAssistantMessage("The separate read-only request is complete."),
        ]);
        await f.session.prompt("Read missing-input.txt and summarize it.");
        const a = f.outcomes().at(-1);
        assert.equal(a?.state, "BLOCKED");
        assert.ok(a.requiredOperations?.length > 0, "A failed a required read");
        await f.session.sendCustomMessage(
          { customType: "custom-turn-scope-request", content: "Complete a separate read-only request B.", display: true },
          { triggerTurn: true, ...(row === "newRequest" ? { newRequest: true } : row === "newRequest false" ? { newRequest: false } : {}) },
        );
        const b = f.outcomes().at(-1);
        const starts = f.extensionEvents.filter((event) => event.type === "agent_start");
        console.log(`${mode} ${row}: ${JSON.stringify({ states: f.outcomes().map(({ state }) => state), bOps: b?.requiredOperations?.length ?? 0, newRequest: starts.map((event) => event.newRequest ?? null) })}`);
        assert.equal(f.outcomes().length, 2, `${row}: one receipt per request`);
        assert.equal(f.extensionEvents.filter((event) => event.type === "before_agent_start").length, 1, `${row}: a custom turn has no preflight`);
        assert.equal(f.faux.state.callCount, 3);
        assert.equal(Object.hasOwn(starts[0], "newRequest"), false, `${row}: a prompted request's agent_start carries no flag`);
        if (row === "newRequest") {
          assert.equal(starts[1]?.newRequest, true, `${name}: B's agent_start says it is a new request`);
          assert.equal(b.state, "DONE", `${name}: B is decided by its own evidence`);
          assert.deepEqual(b.requiredOperations ?? [], [], `${name}: B does not list A's failed read`);
        } else {
          // Default unchanged: a triggered custom turn (a continuation nudge) still carries the open operations.
          assert.equal(Object.hasOwn(starts[1], "newRequest"), false, `${row}: no flag without the option`);
          assert.equal(b.state, "BLOCKED", `${row}: a continuation keeps the open operations`);
          assert.deepEqual(b.requiredOperations, a.requiredOperations, `${row}: the continuation lists A's operations`);
        }
        console.log(`PASS ${mode} ${row}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${mode} ${row}: ${error.message.split("\n")[0]}`);
      } finally { f.close(); }
    }
  }
  // A retry inside a new-request custom turn continues that request: the flag is consumed once.
  for (const mode of ["tui", "print", "json", "rpc"]) {
    const f = await fixture(mode, { retry: true });
    try {
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read", { path: "missing-input.txt" }, { id: "read-missing" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("I could not read it."),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
        fauxAssistantMessage("The separate read-only request is complete."),
      ]);
      await f.session.prompt("Read missing-input.txt and summarize it.");
      assert.equal(f.outcomes().at(-1)?.state, "BLOCKED");
      const before = f.extensionEvents.filter((event) => event.type === "agent_start").length;
      await f.session.sendCustomMessage(
        { customType: "custom-turn-scope-request", content: "Complete a separate read-only request B.", display: true },
        { triggerTurn: true, newRequest: true },
      );
      const bStarts = f.extensionEvents.filter((event) => event.type === "agent_start").slice(before);
      console.log(`${mode} newRequest retry: ${JSON.stringify({ states: f.outcomes().map(({ state }) => state), starts: bStarts })}`);
      assert.deepEqual(bStarts, [{ type: "agent_start", continuesRetry: false, newRequest: true }, { type: "agent_start", continuesRetry: true }],
        "the retry's agent_start continues B and does not carry newRequest again");
      assert.equal(f.outcomes().at(-1)?.state, "DONE", "B's retry keeps B's fresh scope");
      assert.deepEqual(f.outcomes().at(-1)?.requiredOperations ?? [], [], "B lists none of A's operations after its retry");
      console.log(`PASS ${mode} newRequest retry`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${mode} newRequest retry: ${error.message.split("\n")[0]}`);
    } finally { f.close(); }
  }
} finally {
  if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  rmSync(owned, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
