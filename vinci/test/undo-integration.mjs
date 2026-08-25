// Integration checks for /undo honesty (round-2 session-lifecycle audit P2-5/6/7): the report
// names what could NOT be rolled back (shell mutations, unrestorable files) instead of
// overclaiming, a mid-turn undo can't leak the next undo onto the previous turn, and a restore
// marks verification stale + drops checkpoint recovery records for the reverted paths.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const undo = await loader.import(resolve(here, "../extensions/vinci-undo.ts"), { default: false });
const verification = await loader.import(resolve(here, "../extensions/lib/verification-state.ts"), { default: false });
const checkpoint = await loader.import(resolve(here, "../extensions/vinci-checkpoint.ts"), { default: false });
const control = await loader.import(resolve(here, "../extensions/lib/control.ts"), { default: false });

// ── undo extension harness ────────────────────────────────────────────────────────────────────
const handlers = {};
const commands = {};
const pi = {
  on(name, handler) {
    (handlers[name] ??= []).push(handler);
  },
  registerCommand(name, definition) {
    commands[name] = definition;
  },
};
undo.default(pi);

const notifications = [];
const widgets = [];
function makeCtx(cwd) {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setWidget(key, content, options) {
        widgets.push({ key, content, options });
      },
    },
  };
}

async function turnStart(ctx) {
  for (const handler of handlers.turn_start ?? []) await handler({ type: "turn_start" }, ctx);
}

async function toolCall(ctx, toolName, input) {
  for (const handler of handlers.tool_call ?? []) {
    const result = await handler({ type: "tool_call", toolCallId: `tc-${Math.random()}`, toolName, input }, ctx);
    if (result !== undefined) return result;
  }
  return undefined;
}

async function runUndo(ctx) {
  await commands.undo.handler("", ctx);
  return notifications.at(-1);
}

function latestTurnDir(cwd) {
  const root = join(cwd, ".vinci", "undo");
  const dirs = readdirSync(root).filter((d) => /^\d+$/.test(d)).sort();
  return join(root, dirs[dirs.length - 1]);
}

let pass = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  pass++;
}

const workspaces = [];
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "vinci-undo-it-"));
  workspaces.push(dir);
  return dir;
}

try {
  // ── 1. write+edit turn → /undo restores and reports both ─────────────────────────────────────
  {
    const ws = workspace();
    const ctx = makeCtx(ws);
    writeFileSync(join(ws, "b.txt"), "original b contents\n");
    await turnStart(ctx);
    await toolCall(ctx, "write", { path: "a.txt", content: "created by vinci\n" });
    writeFileSync(join(ws, "a.txt"), "created by vinci\n");
    await toolCall(ctx, "edit", { path: "b.txt", oldText: "original", newText: "changed" });
    writeFileSync(join(ws, "b.txt"), "changed b contents\n");
    await toolCall(ctx, "write", { path: "nested/deep/c.txt", content: "nested\n" });
    mkdirSync(join(ws, "nested", "deep"), { recursive: true });
    writeFileSync(join(ws, "nested", "deep", "c.txt"), "nested\n");

    const note = await runUndo(ctx);
    check("undo restores the edited file's previous contents", readFileSync(join(ws, "b.txt"), "utf8") === "original b contents\n");
    check("undo removes the file the turn created", !existsSync(join(ws, "a.txt")));
    check("undo reports the restored file by name", /restored b\.txt/.test(note.message));
    check("undo reports the removed files by name", /removed a\.txt, c\.txt/.test(note.message));
    check("a clean full restore carries no caveats", !/Careful:|couldn't restore|shell commands/.test(note.message) && note.level === "info");
    check("directories left empty by an undone creation are cleaned up", !existsSync(join(ws, "nested")));
    // #155: a clean restore replaces the stale completion receipt with an undone-state widget.
    const receipt = widgets.at(-1);
    check("a clean undo replaces the completion receipt widget", receipt?.key === "vinci-receipt");
    check("the undone receipt says Undone and counts the files", /↺ Undone/.test(receipt?.content?.[0] ?? "") && /3 files put back/.test(receipt?.content?.[0] ?? ""));
    check("the undone receipt names the files and states they're out", /b\.txt/.test(receipt?.content?.[1] ?? "") && /no longer in your files/.test(receipt?.content?.[1] ?? ""));
    check("the undone receipt sits above the editor", receipt?.options?.placement === "aboveEditor");
  }

  // ── [#187] the undo recorder answers the warranted question from what was actually reverted ──
  // Review of #205 left this filter behaviorally unpinned: forcing warranted=true here shipped
  // green. A doc-only revert bumps staleness but records no warranted-fact; a source revert does.
  {
    const ws = workspace();
    const ctx = makeCtx(ws);
    verification.resetVinciVerificationState();
    writeFileSync(join(ws, "README.md"), "docs v1\n");
    await turnStart(ctx);
    await toolCall(ctx, "edit", { path: "README.md", oldText: "v1", newText: "v2" });
    writeFileSync(join(ws, "README.md"), "docs v2\n");
    await runUndo(ctx);
    const afterDocs = verification.getVinciVerificationState();
    check("#187 a doc-only undo still bumps staleness", afterDocs.mutationRevision > 0);
    check("#187 a doc-only undo records no warranted-fact", (afterDocs.checkWarrantedRevision ?? -1) === -1);

    verification.resetVinciVerificationState();
    writeFileSync(join(ws, "app.ts"), "export const v = 1;\n");
    await turnStart(ctx);
    await toolCall(ctx, "edit", { path: "app.ts", oldText: "1", newText: "2" });
    writeFileSync(join(ws, "app.ts"), "export const v = 2;\n");
    await runUndo(ctx);
    const afterSource = verification.getVinciVerificationState();
    check(
      "#187 a source undo records the warranted-fact at the new revision",
      afterSource.checkWarrantedRevision === afterSource.mutationRevision && afterSource.mutationRevision > 0,
    );
    verification.resetVinciVerificationState();
  }

  // ── 2. turn with mutating bash → the report admits shell changes weren't rolled back ────────
  {
    check("output redirection is classified as mutating shell", undo.bashLooksMutating("echo hi > out.txt"));
    check("rm is classified as mutating shell", undo.bashLooksMutating("rm -rf build"));
    check("in-place sed is classified as mutating shell", undo.bashLooksMutating("sed -i '' 's/a/b/' src/app.ts"));
    check("a read-only pipeline is not classified as mutating", !undo.bashLooksMutating("cat src/app.ts | grep -n TODO"));
    check("read-only git commands are not classified as mutating", !undo.bashLooksMutating("git status && git diff"));
    check("discarding output to /dev/null is not a file write", !undo.bashLooksMutating("ls src 2>/dev/null"));
    check("env-wrapped mutations are classified as mutating", undo.bashLooksMutating("env NODE_ENV=test rm -rf build"));
    check("sudo-wrapped mutations are classified as mutating", undo.bashLooksMutating("sudo -u builder rm -rf build"));
    check("nice-wrapped mutations are classified as mutating", undo.bashLooksMutating("nice -n 10 rm -rf build"));
    check("time-wrapped mutations are classified as mutating", undo.bashLooksMutating("time rm -rf build"));
    check("xargs-wrapped mutations are classified as mutating", undo.bashLooksMutating("printf 'build\\n' | xargs rm -rf"));
    check("dollar command substitutions are classified as mutating", undo.bashLooksMutating("echo $(rm -rf build)"));
    check("backtick command substitutions are classified as mutating", undo.bashLooksMutating("echo `rm -rf build`"));

    const ws = workspace();
    const ctx = makeCtx(ws);
    writeFileSync(join(ws, "d.txt"), "original d\n");
    await turnStart(ctx);
    await toolCall(ctx, "edit", { path: "d.txt", oldText: "original", newText: "changed" });
    writeFileSync(join(ws, "d.txt"), "changed d\n");
    await toolCall(ctx, "bash", { command: "rm -rf build && npm run build" });

    const widgetsBefore = widgets.length;
    const note = await runUndo(ctx);
    check("the tracked file edit is still restored", readFileSync(join(ws, "d.txt"), "utf8") === "original d\n");
    check("the undo report includes the shell-changes caveat", /changes made through shell commands weren't rolled back/.test(note.message));
    check("a partially honest undo is a warning, not a clean success", note.level === "warning");
    // #155: a caveated (shell-mutation) restore must NOT claim the undone state in the receipt.
    check("a partial undo never replaces the receipt widget", widgets.length === widgetsBefore);

    // A shell-only turn: /undo must own up instead of silently restoring an older turn.
    await turnStart(ctx);
    await toolCall(ctx, "bash", { command: "mv d.txt d2.txt" });
    const shellOnly = await runUndo(ctx);
    check("a shell-only turn's undo admits it couldn't roll anything back", /Undo couldn't finish/.test(shellOnly.message) && /shell commands/.test(shellOnly.message));
    check("a shell-only turn's undo never claims 'Nothing to change back'", !/Nothing to change back/.test(shellOnly.message));
  }

  // ── 3. unrestorable file → named in the report, not silent ──────────────────────────────────
  {
    const ws = workspace();
    const ctx = makeCtx(ws);
    writeFileSync(join(ws, "f1.txt"), "keep f1\n");
    writeFileSync(join(ws, "f2.txt"), "keep f2\n");
    await turnStart(ctx);
    await toolCall(ctx, "edit", { path: "f1.txt", oldText: "keep", newText: "broken" });
    writeFileSync(join(ws, "f1.txt"), "broken f1\n");
    await toolCall(ctx, "edit", { path: "f2.txt", oldText: "keep", newText: "broken" });
    writeFileSync(join(ws, "f2.txt"), "broken f2\n");
    // Sabotage f1's snapshot (simulates an unreadable/unwritable restore source).
    unlinkSync(join(latestTurnDir(ws), "0.bak"));

    const note = await runUndo(ctx);
    check("the restorable file is still put back", readFileSync(join(ws, "f2.txt"), "utf8") === "keep f2\n");
    check("the unrestorable file is named in the report", /couldn't restore f1\.txt/.test(note.message));
    check("a partial restore failure is a warning", note.level === "warning");

    // Fully failed restore: every snapshot is gone.
    await turnStart(ctx);
    await toolCall(ctx, "edit", { path: "f1.txt", oldText: "broken", newText: "worse" });
    writeFileSync(join(ws, "f1.txt"), "worse f1\n");
    unlinkSync(join(latestTurnDir(ws), "0.bak"));
    const failedNote = await runUndo(ctx);
    check("a fully failed restore never says 'Nothing to change back'", !/Nothing to change back/.test(failedNote.message));
    check("a fully failed restore names the file it couldn't put back", /Undo couldn't finish/.test(failedNote.message) && /f1\.txt/.test(failedNote.message));
  }

  // ── 4. mid-turn undo, new edit, second undo → restores the NEW edit, not the prior turn ─────
  {
    const ws = workspace();
    const ctx = makeCtx(ws);
    writeFileSync(join(ws, "e.txt"), "v0\n");
    await turnStart(ctx);
    await toolCall(ctx, "edit", { path: "e.txt", oldText: "v0", newText: "v1" });
    writeFileSync(join(ws, "e.txt"), "v1\n");

    await turnStart(ctx);
    await toolCall(ctx, "edit", { path: "e.txt", oldText: "v1", newText: "v2" });
    writeFileSync(join(ws, "e.txt"), "v2\n");
    await runUndo(ctx);
    check("the mid-turn undo restores the current turn's edit", readFileSync(join(ws, "e.txt"), "utf8") === "v1\n");

    // Same turn continues: this edit MUST be snapshotted again (backedUp was consumed with the dir).
    await toolCall(ctx, "edit", { path: "e.txt", oldText: "v1", newText: "v3" });
    writeFileSync(join(ws, "e.txt"), "v3\n");
    const second = await runUndo(ctx);
    check("the second undo restores the NEW edit, not the prior turn", readFileSync(join(ws, "e.txt"), "utf8") === "v1\n");
    check("the second undo names the re-edited file", /restored e\.txt/.test(second.message));

    const third = await runUndo(ctx);
    check("a further undo then steps back to the prior turn", readFileSync(join(ws, "e.txt"), "utf8") === "v0\n" && /restored e\.txt/.test(third.message));
  }

  // ── 5. after undo, verification status is stale, not passed ─────────────────────────────────
  {
    const ws = workspace();
    const ctx = makeCtx(ws);
    writeFileSync(join(ws, "g.txt"), "verified contents\n");
    verification.resetVinciVerificationState();
    verification.recordVinciVerification("npm test", true, "all green");
    assert.equal(verification.getVinciVerificationState().status, "passed");

    await turnStart(ctx);
    await toolCall(ctx, "edit", { path: "g.txt", oldText: "verified", newText: "reverted-soon" });
    writeFileSync(join(ws, "g.txt"), "reverted-soon contents\n");
    // The demotion must ALSO be persisted to the session branch via the control bridge, or a hard kill
    // before the next event lets resume restore the pre-undo "passed" and re-bless the reverted tree.
    let persistCalls = 0;
    control.setVinciPersistVerification(() => {
      persistCalls++;
    });
    await runUndo(ctx);
    check("a successful undo demotes 'passed' verification to stale", verification.getVinciVerificationState().status === "stale");
    check("the stale summary says the change is unverified", /not been verified|code changed/i.test(verification.getVinciVerificationState().summary));
    check("undo persists the stale state via the control bridge (survives kill+resume)", persistCalls > 0);
    control.setVinciPersistVerification(null);
    verification.resetVinciVerificationState();
  }

  // ── 6. after undo, checkpoint recovery records for the restored path are dropped ────────────
  {
    const ws = workspace();
    const ctx = makeCtx(ws);
    const writeInput = { path: "f.txt", content: "X" };
    writeFileSync(join(ws, "f.txt"), "X"); // postcondition holds → recovered as already completed
    const branch = [
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: "cp-1", name: "write", arguments: writeInput }] },
      },
      {
        type: "custom",
        customType: "vinci-tool-checkpoint",
        data: {
          schemaVersion: 1,
          event: "started",
          toolCallId: "cp-1",
          toolName: "write",
          fingerprint: checkpoint.mutationFingerprint("write", writeInput),
          path: "f.txt",
        },
      },
    ];
    const cpHandlers = {};
    const cpPi = {
      on(name, handler) {
        (cpHandlers[name] ??= []).push(handler);
      },
      appendEntry(customType, data) {
        branch.push({ type: "custom", customType, data });
      },
      registerCommand() {},
    };
    checkpoint.default(cpPi);
    const cpCtx = {
      ...ctx,
      sessionManager: {
        getBranch: () => [...branch],
        getSessionId: () => "task-undo-crosstalk",
      },
    };
    const cpCall = async (input) => {
      for (const handler of cpHandlers.tool_call ?? []) {
        const result = await handler({ type: "tool_call", toolCallId: "cp-retry", toolName: "write", input }, cpCtx);
        if (result !== undefined) return result;
      }
      return undefined;
    };
    for (const handler of cpHandlers.session_start ?? []) await handler({ type: "session_start", reason: "resume" }, cpCtx);
    const blocked = await cpCall(writeInput);
    check("before undo, the recovered mutation replay is blocked", blocked?.block === true && /already completed/.test(blocked.reason));

    await turnStart(ctx);
    await toolCall(ctx, "edit", { path: "f.txt", oldText: "X", newText: "Y" });
    writeFileSync(join(ws, "f.txt"), "Y");
    await runUndo(ctx);
    check("undo restored the checkpointed file", readFileSync(join(ws, "f.txt"), "utf8") === "X");
    check("after undo, the stale 'already completed' record no longer blocks the redo", (await cpCall(writeInput)) === undefined);
  }

  // ── 7. /undo that restores a CORRUPT backup flags it honestly, never a clean "✓ restored" ──────
  {
    // A backup can capture a mid-edit / interrupted state; /undo restores it faithfully, so the close
    // must not claim a clean success on a broken file (breaker P0).
    const ws = workspace();
    const ctx = makeCtx(ws);
    const BROKEN = "module.exports = {\nyaml\n  port: 4000,\n};\n"; // invalid JS — a leaked code-fence token
    writeFileSync(join(ws, "config.js"), "module.exports = {\n  port: 4000,\n};\n");
    await turnStart(ctx); // turn A: records a clean backup, then the edit is interrupted -> file left BROKEN
    await toolCall(ctx, "edit", { path: "config.js", oldText: "port: 4000", newText: "port: 3000" });
    writeFileSync(join(ws, "config.js"), BROKEN);
    await turnStart(ctx); // turn B: a later edit snapshots the BROKEN current state as its backup
    await toolCall(ctx, "edit", { path: "config.js", oldText: "port", newText: "PORT" });
    writeFileSync(join(ws, "config.js"), BROKEN.replace("port", "PORT"));
    const brokenMsg = await runUndo(ctx); // reverts turn B -> restores the BROKEN backup
    check("a corrupt restore is flagged as broken/incomplete, not a clean success", /broken or incomplete/.test(brokenMsg?.message ?? ""));
    check("the corrupt-restore notice is a warning, not an info tick", brokenMsg?.level === "warning");

    // …but a genuinely clean restore must NOT cry wolf.
    const ws2 = workspace();
    const ctx2 = makeCtx(ws2);
    writeFileSync(join(ws2, "ok.js"), "module.exports = { a: 1 };\n");
    await turnStart(ctx2);
    await toolCall(ctx2, "edit", { path: "ok.js", oldText: "a: 1", newText: "a: 2" });
    writeFileSync(join(ws2, "ok.js"), "module.exports = { a: 2 };\n");
    const okMsg = await runUndo(ctx2);
    check(
      "a clean, valid restore does NOT get a broken/incomplete caveat",
      !/broken or incomplete/.test(okMsg?.message ?? "") && okMsg?.level === "info",
    );

    // JSON variant of the P0 (found by the live cli-breaker pass): an INVALID-JSON restore must be
    // flagged just like broken JS. The first fix swallowed JSON.parse's throw and never flagged it.
    const ws3 = workspace();
    const ctx3 = makeCtx(ws3);
    const BROKEN_JSON = '{\n  "debug": fal\n'; // invalid JSON: bare `fal`, no closing brace
    writeFileSync(join(ws3, "config.json"), '{\n  "debug": false\n}\n');
    await turnStart(ctx3); // turn A: clean backup, then interrupted -> file left as invalid JSON
    await toolCall(ctx3, "edit", { path: "config.json", oldText: "false", newText: "true" });
    writeFileSync(join(ws3, "config.json"), BROKEN_JSON);
    await turnStart(ctx3); // turn B: later edit snapshots the BROKEN json as its backup
    await toolCall(ctx3, "edit", { path: "config.json", oldText: "debug", newText: "DEBUG" });
    writeFileSync(join(ws3, "config.json"), BROKEN_JSON.replace("debug", "DEBUG"));
    const brokenJsonMsg = await runUndo(ctx3); // reverts turn B -> restores the invalid-JSON backup
    check(
      "a corrupt .json restore is flagged as broken/incomplete (JSON P0 regression)",
      /broken or incomplete/.test(brokenJsonMsg?.message ?? "") && brokenJsonMsg?.level === "warning",
    );

    // …and a clean .json restore must NOT cry wolf either.
    const ws4 = workspace();
    const ctx4 = makeCtx(ws4);
    writeFileSync(join(ws4, "ok.json"), '{\n  "a": 1\n}\n');
    await turnStart(ctx4);
    await toolCall(ctx4, "edit", { path: "ok.json", oldText: '"a": 1', newText: '"a": 2' });
    writeFileSync(join(ws4, "ok.json"), '{\n  "a": 2\n}\n');
    const okJsonMsg = await runUndo(ctx4);
    check(
      "a clean, valid .json restore does NOT get a broken/incomplete caveat",
      !/broken or incomplete/.test(okJsonMsg?.message ?? "") && okJsonMsg?.level === "info",
    );
  }
} finally {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
}

console.log(`\nundo-integration: ${pass}/${pass} checks passed (honest /undo reports, mid-turn state reset, verifier/checkpoint crosstalk)`);
