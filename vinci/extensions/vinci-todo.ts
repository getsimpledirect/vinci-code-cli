/**
 * Vinci todo — legibility for multi-step work. The North Star is a tool that "takes charge and
 * informs the user when it does"; a live checklist is exactly that. Vinci lays out its plan for a
 * multi-step task and ticks items off as it goes, so a non-programmer can watch what's happening
 * instead of staring at a wall of tool calls.
 *
 *   • todo tool → the model sets/updates the plan (pass the FULL list each time). Tool traffic stays
 *     hidden; one stateful widget shows progress, the current step, and the next step.
 *   • /todos    → show the current full plan any time.
 *
 * Additive — no core edits. In-memory for the session (simple + fork-safe enough for v1).
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
// [verification system] auto-run the independent grader when the plan is marked all-done — trust the
// check, not the claim. See lib/grader.ts and vinci/docs/verification.md.
import { gradeChanges } from "./lib/grader.ts";
import { getVinciAutomationStop, sendVinciControl } from "./lib/control.ts";
import { clearVinciHardStop, recordVinciHardStop, refuseFinalization, vinciTaskIdOf } from "./lib/hard-stop.ts";
import { isVinciFinalizationCommand, isVinciUnattended } from "./lib/unattended.ts";
import { getVinciUiState, setVinciPlan } from "./lib/ui-state.ts";
import { installVinciUsageAccumulator } from "./lib/usage-accumulator.ts";
import {
  getVinciVerificationState,
  hasIncompleteVinciBehavioralAttempt,
} from "./lib/verification-state.ts";
import { planCommandMutates } from "./vinci-plan.ts";

type Status = "todo" | "doing" | "done";
type Step = { title: string; status: Status };
type GradeResult = { text: string; verdict: "ships" | "needs-work" | "risky" | "none" } | null;
type GradePlan = (ctx: ExtensionContext) => Promise<GradeResult>;

let currentPlan: Step[] = [];
let automaticContinues = 0;
let stalledAutoContinues = 0;
let stallNoticeSent = false;
let reviewReopens = 0;
let reviewPaused = false;
const MAX_AUTOMATIC_CONTINUES = 6;
const MAX_STALLED_CONTINUES = 3;
const MAX_REVIEW_REOPENS = 1;
const REVIEW_MUTATING_TOOLS = new Set(["edit", "todo", "write"]);
// A composite step that also names a human action ("Run tests and verify the fix manually",
// "…then deploy") is not a pure verifier step and never auto-closes on a pass.
const VERIFICATION_STEP =
  /\b(?:re-?run|run|execute)\b[^.\n]{0,80}\b(?:checks?|tests?|suites?|verifiers?)\b/i;
const HUMAN_ACTION_STEP = /\b(?:manual(?:ly)?|by\s+hand|deploy|release|publish|document|announce|review\s+with|ask)\b/i;
// Conjunction-bearing composites ("Run tests and update the changelog") bundle other work;
// only a title that is purely the verification action may auto-close.
const COMPOSITE_STEP = /\b(?:and|then|also|plus)\b|[;,&]/i;
const isPureVerificationStep = (title: string) =>
  VERIFICATION_STEP.test(title) && !HUMAN_ACTION_STEP.test(title) && !COMPOSITE_STEP.test(title);

function assistantText(message: { role: string; content?: readonly { type: string; text?: string }[] }): string {
  if (message.role !== "assistant" || !message.content) return "";
  return message.content
    .filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function asksUser(message: { role: string; content?: readonly { type: string; text?: string }[] }): boolean {
  return /\?\s*$/.test(assistantText(message));
}

class HiddenToolUi implements Component {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}

function planWidget(steps: readonly Step[]): (_tui: unknown, theme: Theme) => Component {
  return (_tui, theme) => ({
    render(width: number): string[] {
      const explicitDone = steps.filter((step) => step.status === "done").length;
      // "Complete" requires every step truly finished (the verification gate marks them), never the
      // effective count below.
      if (explicitDone === steps.length) {
        return [
          truncateToWidth(
            theme.fg("success", theme.bold("  ✓ Plan complete")) + theme.fg("dim", `  ·  ${explicitDone} steps`),
            width,
            theme.fg("dim", "…"),
          ),
        ];
      }

      const active = steps.find((step) => step.status === "doing");
      const activeIndex = steps.findIndex((step) => step.status === "doing");
      // In a sequential plan (exactly one 'doing'), the steps BEFORE the active one are finished even if
      // the model advanced without ticking them — count them so the tracker never reads a stale 0/N
      // while a later step is clearly in progress (the "Plan 0/8 while step 1 is done" bug).
      const done = activeIndex > explicitDone ? activeIndex : explicitDone;
      const next = steps.find((step) => step.status === "todo");
      const barWidth = Math.max(5, Math.min(14, Math.floor(width / 6)));
      const filled = steps.length ? Math.round((done / steps.length) * barWidth) : 0;
      const head =
        theme.fg("accent", theme.bold("  Plan")) +
        theme.fg("muted", `  ${done}/${steps.length}  `) +
        theme.fg("success", "━".repeat(filled)) +
        theme.fg("borderMuted", "━".repeat(barWidth - filled));
      const current = active
        ? theme.fg("accent", "  ● ") + theme.fg("mdHeading", active.title)
        : theme.fg("muted", "  ◌ Waiting for the next step");
      const upcoming = next ? theme.fg("dim", `  ·  next: ${next.title}`) : "";
      return [
        truncateToWidth(head, width, theme.fg("dim", "…")),
        truncateToWidth(current + upcoming, width, theme.fg("dim", "…")),
      ];
    },
    invalidate(): void {},
  });
}

function updatePlanUi(ctx: ExtensionContext, steps: readonly Step[]): void {
  setVinciPlan(steps);
  if (!ctx.hasUI) return;
  if (!steps.length) {
    ctx.ui.setWidget("vinci-plan", undefined);
    return;
  }
  ctx.ui.setWidget("vinci-plan", planWidget(steps), { placement: "aboveEditor" });
}

function renderPlan(steps: Step[]): string {
  // A step before the single active 'doing' step in a sequential plan is finished even if the model
  // didn't tick it — treat it as done so the count and the tick marks don't read a stale 0/N.
  const activeIndex = steps.findIndex((s) => s.status === "doing");
  const isDone = (s: Step, i: number) => s.status === "done" || (activeIndex > 0 && i < activeIndex);
  const mark = (s: Step, i: number) => (isDone(s, i) ? "✓" : s.status === "doing" ? "→" : "○");
  const done = steps.filter((s, i) => isDone(s, i)).length;
  const head = `Plan · ${done}/${steps.length} done`;
  const body = steps.map((s, i) => `  ${mark(s, i)} ${s.title}`).join("\n");
  return `${head}\n${body}`;
}

const TODO_PARAMS = Type.Object({
  steps: Type.Array(
    Type.Object({
      title: Type.String({ description: "Short, plain-language description of this step." }),
      status: Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("done")], {
        description: "todo = not started, doing = in progress (keep exactly one), done = finished.",
      }),
    }),
    { description: "The FULL current plan — include every step each time, updating each step's status." },
  ),
});

export default function (pi: ExtensionAPI, gradePlan: GradePlan = gradeChanges) {
  installVinciUsageAccumulator(pi);
  pi.registerTool({
    name: "todo",
    label: "Plan",
    description:
      "Lay out and update a live checklist for a MULTI-STEP task, so the user can watch your progress. " +
      "Call it once at the start with your plan (all steps 'todo', the first 'doing'), then again after " +
      "each step to mark it 'done' and the next 'doing'. Always pass the FULL plan. Skip it for a single " +
      "quick task.",
    promptSnippet: "Show a live checklist for multi-step work and tick items off as you finish them.",
    promptGuidelines: ["For a multi-step task, lay out a plan with the todo tool and update it as you complete each step."],
    parameters: TODO_PARAMS,
    renderShell: "self",
    renderCall: () => new HiddenToolUi(),
    renderResult: () => new HiddenToolUi(),
    async execute(_toolCallId, params: { steps: Step[] }, _signal, _onUpdate, ctx: ExtensionContext) {
      const requested = Array.isArray(params.steps) ? params.steps : [];
      const verificationState = getVinciVerificationState();
      const verificationBlocksCompletion =
        verificationState.variant !== "normal" ||
        hasIncompleteVinciBehavioralAttempt(verificationState);
      const next =
        requested.length > 0 &&
        requested.every((step) => step.status === "done") &&
        verificationBlocksCompletion
          ? requested.map((step, index) =>
              index === requested.length - 1 ? { ...step, status: "doing" as const } : step,
            )
          : requested;
      const prev = currentPlan;
      const sameShape = prev.length === next.length && prev.every((step, index) => step.title === next[index]?.title);
      currentPlan = next;
      if (!sameShape) {
        reviewReopens = 0;
        reviewPaused = false;
      }
      if (
        prev.length !== next.length ||
        next.some((step, index) => step.title !== prev[index]?.title || step.status !== prev[index]?.status)
      ) {
        automaticContinues = 0;
        stalledAutoContinues = 0;
        stallNoticeSent = false;
      }
      updatePlanUi(ctx, next);
      if (!next.length) return { content: [{ type: "text", text: "Plan cleared." }], details: { tool: "todo", steps: 0 } };
      // Show the FULL checklist only when the plan is new or restructured. A status-only update
      // renders as one delta line — re-printing ten items per tick was a wall on screen AND in the
      // model's context (the replayed plan was the groove the todo-loop locked into). An unchanged
      // resend gets a corrective instead of an echo.
      let text: string;
      if (!sameShape) {
        const doing = next.find((step) => step.status === "doing")?.title;
        text = `Plan created · ${next.length} steps${doing ? ` · current: ${doing}` : ""}.`;
      } else {
        const done = next.filter((s) => s.status === "done").length;
        const doing = next.find((s) => s.status === "doing")?.title;
        const doneNow = next.filter((s, i) => s.status === "done" && prev[i].status !== "done").map((s) => s.title);
        // A latched automation stop means loopbreak/verification just told the model to STOP — a
        // keep-going plan steer in the same context is a direct contradiction (round-2 audit P2-8).
        const automationStopped = getVinciAutomationStop().stopped;
        if (next.every((s, i) => s.status === prev[i].status)) {
          text = `Plan unchanged · ${done}/${next.length} done${doing ? ` · current: ${doing}` : ""}.`;
          if (!automationStopped) {
            sendVinciControl(
              pi,
              "vinci-plan-unchanged",
              `The plan is unchanged. Do not send the same todo state again; continue the current step${doing ? `: ${doing}` : ""}.`,
            );
          }
        } else {
          const bits = [`Plan · ${done}/${next.length} done`];
          if (doneNow.length) bits.push(`✓ ${doneNow.join("  ✓ ")}`);
          if (doing) bits.push(`→ ${doing}`);
          text = bits.join("   ");
          // Keep the approved plan moving. This instruction is deliberately direct and contains no
          // user-facing script for a small model to echo into the transcript.
          if (doneNow.length && doing && !automationStopped) {
            sendVinciControl(
              pi,
              "vinci-plan-step",
              `Continue the approved plan now. The current step is "${doing}". Do not pause for another approval.`,
            );
          }
        }
      }
      // The overclaiming gate (verification system): "done" is where a small model's self-assessment
      // is least reliable (observed live: "all actions up to date" while two were majors stale; a
      // dismissed grader). Don't trust the claim — RUN the check. On the TRANSITION to all-done, the
      // system itself grades the real state (untracked files included) and REOPENS on "needs work",
      // so the model can't just declare done. Fires once per transition; bounded + fail-safe (a grader
      // error/timeout degrades to the plain "verify it yourself" note, never breaks the todo tool).
      const isAllDone = next.every((s) => s.status === "done");
      const wasAllDone = prev.length > 0 && prev.every((s) => s.status === "done");
      if (isAllDone && !wasAllDone) {
        let graded: { text: string; verdict: string } | null = null;
        try {
          graded = await Promise.race([
            gradePlan(ctx),
            new Promise<null>((r) => setTimeout(() => r(null), 30000)),
          ]);
        } catch {
          graded = null;
        }
        if (graded && (graded.verdict === "needs-work" || graded.verdict === "risky")) {
          // Reopen the last step — the task is NOT actually done — and hand the model the concrete
          // findings. One repair pass is useful; a second failed review is a structural loop, so pause
          // mutations and return control instead of reopening forever. Risky findings pause at once.
          const reopened = next.map((s, i) => (i === next.length - 1 ? { ...s, status: "doing" as const } : s));
          currentPlan = reopened;
          updatePlanUi(ctx, reopened);
          const shouldPause = graded.verdict === "risky" || reviewReopens >= MAX_REVIEW_REOPENS;
          reviewReopens++;
          if (shouldPause) {
            reviewPaused = true;
            automaticContinues = MAX_AUTOMATIC_CONTINUES;
            if (ctx.hasUI) ctx.ui.notify("Independent review still finds issues — automation paused.", "warning");
            sendVinciControl(
              pi,
              "vinci-plan-review-stop",
              `Stop making changes. Independent review still found unresolved issues after the repair pass. Explain these findings plainly, state what remains uncertain, and return control to the user:\n\n${graded.text}`,
            );
            return {
              content: [{ type: "text", text: "Independent review still found issues · automation paused for the user." }],
              details: { tool: "todo", steps: reopened.length, reviewed: true, paused: true },
            };
          }
          if (ctx.hasUI) ctx.ui.notify("Independent review flagged issues — reopening the last step.", "warning");
          sendVinciControl(
            pi,
            "vinci-plan-review",
            `The task is not done. An independent review reopened the last step. Fix these findings, then mark it done again:\n\n${graded.text}`,
          );
          return {
            content: [{ type: "text", text: "Independent review found issues · last step reopened." }],
            details: { tool: "todo", steps: reopened.length, reviewed: true },
          };
        }
        // Grader passed, found no changes, or was unavailable → still nudge a real check.
        if (graded && graded.verdict === "ships") {
          reviewReopens = 0;
          reviewPaused = false;
          text += "   ✓ Independent review passed.";
          sendVinciControl(
            pi,
            "vinci-plan-verify",
            "Independent review passed. Confirm the relevant build or tests actually run before telling the user the task is complete.",
          );
        } else {
          text += "   Verification still required.";
          sendVinciControl(
            pi,
            "vinci-plan-verify",
            "All plan steps are marked done, but completion still needs evidence. Run the relevant focused check directly, then finish; the completion gate will run the independent review automatically.",
          );
        }
      }
      return { content: [{ type: "text", text }], details: { tool: "todo", steps: next.length } };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    clearVinciHardStop(vinciTaskIdOf(ctx));
    currentPlan = [];
    automaticContinues = 0;
    stalledAutoContinues = 0;
    stallNoticeSent = false;
    reviewReopens = 0;
    reviewPaused = false;
    updatePlanUi(ctx, currentPlan);
  });

  pi.on("input", async (event, ctx) => {
    // A mid-stream keystroke or another extension's steer is not the user answering the pause:
    // resetting reviewPaused on those silently voided the "automation paused" promise (round-2 P1-4).
    if (event?.source === "extension" || event?.streamingBehavior) return undefined;
    clearVinciHardStop(vinciTaskIdOf(ctx));
    automaticContinues = 0;
    reviewReopens = 0;
    reviewPaused = false;
    return undefined;
  });

  // A failed repair review is a user-visible stop state, not another autonomous retry state. Keep
  // reads available so Vinci can explain the evidence, but freeze mutations until the user responds.
  pi.on("tool_call", async (event, ctx) => {
    const command = event.toolName === "bash" ? String((event.input as { command?: unknown }).command ?? "") : "";
    // [#6] The loopbreak ceiling latches the automation stop, and this latch then refused the commit
    // the ceiling had just let through (found by the full-stack test, not by either module alone).
    // Unattended, a finalization step is not the "autonomous change" the latch exists to stop: the
    // work already made may land locally; the hard stop already recorded (if any) still closes the
    // record as BLOCKED, and the daemon decides publishing. Interactively the latch is unchanged.
    const finalizationExempt = Boolean(command) && isVinciUnattended(ctx) && isVinciFinalizationCommand(command);
    if (
      getVinciAutomationStop().stopped &&
      event.toolName !== "todo" &&
      !finalizationExempt &&
      (REVIEW_MUTATING_TOOLS.has(event.toolName) || (Boolean(command) && planCommandMutates(command)))
    ) {
      // [#5] "Wait for the user's next instruction" is a contradiction in an unattended run: nobody
      // can answer, and the model — locked out of every mutation — went on to narrate completion
      // over uncommitted work. Say what is actually happening, and record the stop so the outcome
      // record closes as BLOCKED no matter what the closing message claims (lib/hard-stop.ts).
      const reason = isVinciUnattended(ctx)
        ? "Vinci stopped autonomous changes after repeated no-progress attempts (unattended run: ending the task as BLOCKED)."
        : "Vinci stopped autonomous changes after repeated no-progress attempts. Wait for the user's next instruction.";
      recordVinciHardStop(vinciTaskIdOf(ctx), "latch", reason);
      return { block: true, reason };
    }
    if (
      reviewPaused &&
      event.toolName === "bash" &&
      planCommandMutates(String((event.input as { command?: unknown }).command ?? ""))
    ) {
      sendVinciControl(
        pi,
        "vinci-plan-review-paused",
        "Automation is paused after a repeated review failure. Do not make more changes. Read-only diagnostics and direct verification remain available so you can explain the evidence accurately.",
      );
      // [#6, review BLOCK-3] Refusing the commit here is a hard stop like any other refusal.
      return refuseFinalization(
        ctx,
        "review-pause",
        String((event.input as { command?: unknown }).command ?? ""),
        "Vinci paused further changes after independent review still found unresolved issues.",
      );
    }
    if (!reviewPaused || !REVIEW_MUTATING_TOOLS.has(event.toolName)) return undefined;
    sendVinciControl(
      pi,
      "vinci-plan-review-paused",
      "Automation is paused after a repeated review failure. Do not call more tools. Explain the unresolved findings and wait for the user.",
    );
    return { block: true, reason: "Vinci paused further changes after independent review still found unresolved issues." };
  });

  // A plain-text response normally ends Pi's agent loop. In Auto mode that is wrong while the live
  // plan still has work: queue a private follow-up before the loop settles, so implementation keeps
  // moving without making the user type "continue". Questions, errors, aborts, and completed plans
  // still stop normally. The cap hands a genuinely stuck model one final chance to ask for help
  // instead of creating an unbounded paid loop.
  pi.on("turn_end", async (event, ctx) => {
    if (process.env.VINCI_NO_AUTOCONTINUE === "1") return;
    if (getVinciAutomationStop().stopped) return;
    // Another extension (verification recovery) already queued a followUp for this boundary: adding
    // plan-auto-continue alongside it puts two CONTRADICTORY instructions in one injection and burns
    // recovery attempts on plan work → false BLOCKED (round-2 audit P1-2).
    if (ctx.hasPendingMessages()) return;
    if (reviewPaused) return;
    if (getVinciUiState().mode !== "auto" || !currentPlan.some((step) => step.status !== "done")) return;
    if (event.message.role !== "assistant") return;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
    if (event.message.content.some((part) => part.type === "toolCall") || asksUser(event.message)) {
      // Real progress or an explicit question — not a stall.
      stalledAutoContinues = 0;
      return;
    }
    const verificationState = getVinciVerificationState();
    const verificationFinished =
      verificationState.variant === "normal" &&
      verificationState.status === "passed" &&
      verificationState.mutationRevision > 0 &&
      verificationState.verifiedRevision === verificationState.mutationRevision &&
      !hasIncompleteVinciBehavioralAttempt(verificationState);
    if (verificationFinished) {
      currentPlan = currentPlan.map((step) =>
        isPureVerificationStep(step.title) ? { ...step, status: "done" } : step,
      );
      automaticContinues = 0;
      updatePlanUi(ctx, currentPlan);
      return;
    }
    if (automaticContinues >= MAX_AUTOMATIC_CONTINUES) return;
    // Repeated text-only, question-free replies to "keep working" mean the model will not act on
    // the open steps (observed live: a user-cancelled step kept the plan open and the reminder
    // looped, burning paid calls while the model protested). Unlike automaticContinues, this
    // counter does NOT reset on user input — only real progress (a tool call, a question, or a
    // plan update) re-arms continuation. One reconciliation nudge, then silence until the plan
    // actually changes.
    if (stalledAutoContinues >= MAX_STALLED_CONTINUES) {
      if (!stallNoticeSent) {
        stallNoticeSent = true;
        if (ctx.hasUI) {
          ctx.ui.notify("The plan still shows open steps but work has stalled — automatic continuation is paused until the plan changes.", "warning");
        }
        pi.sendMessage(
          {
            customType: "vinci-plan-stalled",
            display: false,
            content:
              "Automatic continuation is paused: the plan still shows open steps, but your replies are not advancing them. Reconcile the plan now with the todo tool — mark steps that are finished or that the user cancelled as done — or ask the user one specific question.",
          },
          { deliverAs: "followUp" },
        );
      }
      return;
    }
    stalledAutoContinues++;

    automaticContinues++;
    const current = currentPlan.find((step) => step.status === "doing") ?? currentPlan.find((step) => step.status === "todo");
    const finalRecovery = automaticContinues === MAX_AUTOMATIC_CONTINUES;
    pi.sendMessage(
      {
        customType: "vinci-plan-auto-continue",
        display: false,
        content: finalRecovery
          ? `The approved plan is still unfinished${current ? ` at "${current.title}"` : ""}. Finish it now, or ask the user one specific question if a real decision blocks you.`
          : `Keep working on the approved plan${current ? `, starting with "${current.title}"` : ""}. Do not wait for the user to say continue. Stop only when the work is complete or you need a specific answer from them.`,
      },
      { deliverAs: "followUp" },
    );
  });

  pi.registerCommand("todos", {
    description: "Show Vinci's current plan for this task",
    handler: async (_args, ctx) => {
      if (!currentPlan.length) {
        return void ctx.ui.notify("No plan yet — Vinci lays one out when a task has several steps.", "info");
      }
      ctx.ui.notify(renderPlan(currentPlan), "info");
    },
  });
}
