// Drive the shipped loopbreak hooks without executing tools or making provider requests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createJiti } from "jiti/static";

async function harness() {
  const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const extension = await loader.import(resolve(import.meta.dirname, "../extensions/vinci-loopbreak.ts"), { default: false });
  const verification = await loader.import(resolve(import.meta.dirname, "../extensions/lib/verification-state.ts"), { default: false });
  verification.resetVinciVerificationState();
  const handlers = new Map();
  const controls = [];
  extension.default({
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    sendMessage(message) { controls.push(message); },
    registerCommand() {}, registerTool() {}, appendEntry() {},
  });
  const ctx = { hasUI: false, cwd: resolve(import.meta.dirname, "../.."), ui: { notify() {} }, abort() { assert.fail("The bounded replay must not reach deferred abort; reduce the scenario."); } };
  const emit = async (name, event) => {
    let result;
    for (const handler of handlers.get(name) ?? []) {
      const next = await handler(event, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  };
  const call = (toolName, input) => emit("tool_call", { toolName, input });
  await emit("input", { source: "user", text: "Implement and integrate the two authorized source fixes now." });
  await emit("agent_start", {});
  return { call, emit, controls, ceiling: extension.TURN_CALL_CEILING };
}

async function reachReserve(h) {
  for (let offset = 0; offset < 10; offset++) {
    assert.equal(await h.call("read", { path: "vinci/extensions/vinci-header.ts", offset: offset * 20, limit: 20 }), undefined);
  }
}

const result = (applied) => ({
  toolName: "use_agent_work", input: { agent_id: 1 }, isError: false,
  content: [{ type: "text", text: applied === true ? "Applied the finished agent's work; verify the affected files." : "The finished agent's work was not applied; resolve the recorded refusal before retrying." }],
  details: { tool: "use_agent_work", applied },
});

test("Crew integration remains an owning mutation after investigation reserve, with failed investigation control (3 trials)", async () => {
  for (let trial = 1; trial <= 3; trial++) {
    const h = await harness();
    await reachReserve(h);
    const integration = await h.call("use_agent_work", { agent_id: 1 });
    assert.equal(integration, undefined, `Crew integration must be admitted at the mutation reserve in trial ${trial}.`);
    const inspection = await h.call("bash", { command: `inspect-unrelated-${trial}` });
    assert.equal(inspection?.block, true);
    assert.match(inspection.reason, /reserved the remaining actions for implementation/);
  }
});

test("only applied:true advances mutation pacing; false, missing and string flags leave reserve active (3 trials each)", async () => {
  for (let trial = 1; trial <= 3; trial++) {
    for (const applied of [false, undefined, "true"]) {
      const h = await harness();
      await reachReserve(h);
      assert.equal(await h.call("use_agent_work", { agent_id: 1 }), undefined);
      await h.emit("tool_result", result(applied));
      const inspection = await h.call("bash", { command: `inspect-unapplied-${trial}` });
      assert.equal(inspection?.block, true);
      assert.match(inspection.reason, /reserved the remaining actions for implementation/);
    }
    const h = await harness();
    await reachReserve(h);
    assert.equal(await h.call("use_agent_work", { agent_id: 1 }), undefined);
    await h.emit("tool_result", result(true));
    assert.equal(await h.call("bash", { command: "inspect-applied" }), undefined);
    assert.equal(await h.call("bash", { command: "node --test vinci/test/header-path-boundary.mjs" }), undefined);
  }
});

test("applied Crew work receives the existing bounded post-mutation inspection allowance (3 trials)", async () => {
  for (let trial = 1; trial <= 3; trial++) {
    const h = await harness();
    assert.equal(await h.call("use_agent_work", { agent_id: 1 }), undefined);
    await h.emit("tool_result", result(true));
    for (let inspection = 1; inspection <= 3; inspection++) {
      assert.equal(await h.call("bash", { command: `inspect-applied-${trial}-${inspection}` }), undefined);
    }
    const block = await h.call("bash", { command: `inspect-applied-${trial}-4` });
    assert.equal(block?.block, true);
    assert.match(block.reason, /reserved the remaining actions for verification/);
  }
});

test("Crew coordination is admitted at reserve and still stops identical repeats (3 trials)", async () => {
  for (let trial = 1; trial <= 3; trial++) {
    const h = await harness();
    await reachReserve(h);
    for (const toolName of ["continue_agent", "message_agent"]) {
      const input = { agent_id: 1, instruction: "Finish the existing scoped repair.", message: "Run the named behavioral regression." };
      assert.equal(await h.call(toolName, input), undefined);
      assert.equal(await h.call(toolName, input), undefined);
      const repeat = await h.call(toolName, input);
      assert.equal(repeat?.block, true);
      assert.match(repeat.reason, /paused a repeated action/);
    }
  }
});

test("integration and coordination retain the absolute action ceiling (3 trials each)", async () => {
  for (let trial = 1; trial <= 3; trial++) {
    for (const toolName of ["use_agent_work", "continue_agent", "message_agent"]) {
      const h = await harness();
      for (let action = 0; action < h.ceiling; action++) {
        assert.equal(await h.call("edit", { path: `ceiling-${action}.js`, edits: [] }), undefined);
      }
      const block = await h.call(toolName, { agent_id: 1, instruction: "Finish the repair.", message: "Verify the repair." });
      assert.equal(block?.block, true);
      assert.match(block.reason, /stopped a repeated action/);
    }
  }
});

test("a refused integration cannot reset its repeat budget or masquerade as successful mutation (3 trials)", async () => {
  for (let trial = 1; trial <= 3; trial++) {
    const h = await harness();
    const input = { agent_id: 1 };
    assert.equal(await h.call("use_agent_work", input), undefined);
    await h.emit("tool_result", result(false));
    const repeat = await h.call("use_agent_work", input);
    assert.equal(repeat?.block, true);
    assert.match(repeat.reason, /paused a repeated action/);
  }
});
