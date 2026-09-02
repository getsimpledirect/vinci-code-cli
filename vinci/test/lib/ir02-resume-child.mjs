// IR-02 Lane B — child process for worker-runtime-adapter-resume.mjs.
//
// A resume across PROCESS REPLACEMENT cannot be proven inside one process: the state that must
// survive is exactly the state a process holds. So the parent runs this script twice.
//
//   mode "create": open a PERSISTENT run session, prompt, and hang forever inside the turn. The
//     scripted faux model answers the first request with an `ls` tool call and then never answers
//     again, so the process is still mid-turn when the parent SIGKILLs it. The sink is wrapped so
//     the checkpoint marker is written AFTER the first tool.completed line is durably on disk —
//     the parent's kill is therefore always at a known point in the event log.
//
//   mode "resume": reopen that same session file with resumeRunSession, prompt again (the scripted
//     model calls `ls` once more and finishes), append run.completed, and exit 0.
//
// Offline by construction: the only registered provider is the SDK's faux provider.
import { writeFileSync } from "node:fs";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createJsonlSink } from "../../worker/run-events-sink.mjs";
import { createRunSession, resumeRunSession } from "../../worker/runtime-adapter.mjs";

const config = JSON.parse(process.argv[2]);
const {
  mode,
  cwd,
  sessionDir,
  sinkPath,
  markerPath,
  sessionPathFile,
  resultPath,
  sessionPath,
  sessionId,
  prompt,
  run,
  grantedTools,
} = config;

// Nothing else keeps the loop alive once the scripted model stops answering; an unresolved promise
// does not. The parent kills this process, so the interval is deliberately NOT unref'd.
const keepAlive = setInterval(() => {}, 1000);

const faux = registerFauxProvider();
const model = faux.getModel();
const authStorage = AuthStorage.inMemory();
authStorage.setRuntimeApiKey(model.provider, "faux-key");

const runDefinition = { ...run, provider: model.provider, model: model.id };

if (mode === "create") {
  // Answer once with a tool call, then never answer again: the turn is still open when we are killed.
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("ls", { path: "." }, { id: "call_ls_pre_kill" })], { stopReason: "toolUse" }),
    () => new Promise(() => {}),
  ]);
} else if (mode === "resume") {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("ls", { path: "." }, { id: "call_ls_post_resume" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished after resume."),
  ]);
} else {
  throw new Error(`ir02-resume-child: unknown mode ${JSON.stringify(mode)}`);
}

const base = createJsonlSink(sinkPath);
let marked = false;
const sink = {
  append(event) {
    const sequence = base.append(event);
    // appendFileSync has already returned, so the tool.completed line is on disk before the marker.
    if (!marked && markerPath && event.type === "tool.completed") {
      marked = true;
      writeFileSync(markerPath, `${sequence}\n`, "utf8");
    }
    return sequence;
  },
  replay: (...args) => base.replay(...args),
  close: (...args) => base.close(...args),
};

if (mode === "create") {
  const handle = await createRunSession({
    run: runDefinition,
    grantedTools,
    cwd,
    sessionDir,
    sessionId,
    sink,
    authStorage,
    model,
  });
  // Publish the persisted path immediately: the parent needs it to resume a process it will kill.
  writeFileSync(sessionPathFile, `${handle.sessionPath}\n`, "utf8");
  await handle.prompt(prompt);
  // Unreachable: the scripted model never answers the second request.
  throw new Error("ir02-resume-child: create mode returned from prompt(); it was meant to hang");
}

const handle = await resumeRunSession({
  run: runDefinition,
  grantedTools,
  cwd,
  sessionDir,
  sessionPath,
  sink,
  authStorage,
  model,
});
writeFileSync(
  resultPath,
  `${JSON.stringify({
    sessionPath: handle.sessionPath,
    resumedFromSequence: handle.resumedFromSequence,
    resumedAtSequence: handle.resumedAtSequence,
  })}\n`,
  "utf8",
);
await handle.prompt(prompt);
handle.complete({ outcome: "SUCCEEDED", tierReached: "NONE" });
await handle.dispose();
clearInterval(keepAlive);
faux.unregister();
process.exit(0);
