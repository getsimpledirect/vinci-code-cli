#!/usr/bin/env bash
# Vinci Code test harness. Run: bash vinci/test/run.sh
#
#   UNIT  — pure logic in the extensions/patches (parsers, tier ladder, undo, guard, memory).
#           Fast, offline, always runs.
#   UI    — drives the real interactive mode through a headless xterm + faux model, checking
#           keyboard flows, dialogs, terminal resizing, and reviewed viewport snapshots.
#   SMOKE — runs the REAL CLI headlessly (pi print mode auto-activates with no TTY): proves every
#           extension + core patch LOADS, auth/gateway works, the agent responds, and tools fire
#           end-to-end. Needs a Vinci login (~/.pi/agent/auth.json) + makes ~2 gateway calls;
#           skipped (not failed) if not logged in or VINCI_SKIP_SMOKE=1.
#
# Every group runs under a per-group wall-clock ceiling (VINCI_TEST_GROUP_TIMEOUT, default 300s). A
# group that wedges or leaks a handle is killed — process group and all — and reported by name with
# its elapsed time. This script always terminates.
#
# What this local command CANNOT judge: subjective aesthetics. The optional EC2 lane adds native
# Linux PTY SVG/cast artifacts; a human still reviews the visual feel before release.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VINCI="${ROOT}/vinci/bin/vinci"
fails=0
# Keep every CLI launch below deterministic: never auto-resume a prior session for this repo (that
# would suppress the fresh welcome the visual test asserts, and load stale history into the crew demo).
export VINCI_NO_RESUME=1
# npm may hoist vitest to the root or nest it per-workspace depending on lockfile state (a clean
# `npm ci --ignore-scripts` currently nests it under packages/*). vitest's exports map does not
# expose dist/cli.js, so probe the known filesystem locations directly.
VITEST_CLI=""
for candidate in "${ROOT}/node_modules/vitest/dist/cli.js" "${ROOT}/packages/coding-agent/node_modules/vitest/dist/cli.js"; do
  if [ -f "${candidate}" ]; then
    VITEST_CLI="${candidate}"
    break
  fi
done
if [ -z "${VITEST_CLI}" ]; then
  echo "✗ vitest not found (root or packages/coding-agent) — run npm ci --ignore-scripts first" >&2
  exit 1
fi

terminate_process_group() {
  local process_group_id="$1"
  kill -TERM -- "-${process_group_id}" 2>/dev/null || true
  sleep 2
  kill -KILL -- "-${process_group_id}" 2>/dev/null || true
  # BOUNDED reap: SIGKILL kills any normal process, but a zombie/uninterruptible (D-state) one could
  # keep the group observable forever. Cap the wait at ~5s so an unkillable remnant can't hang the
  # harness — the exact failure this supervisor exists to prevent.
  local reap_attempts=0
  while kill -0 -- "-${process_group_id}" 2>/dev/null; do
    if [ "${reap_attempts}" -ge 50 ]; then
      break
    fi
    kill -KILL -- "-${process_group_id}" 2>/dev/null || true
    sleep 0.1
    reap_attempts=$((reap_attempts + 1))
  done
}

# Bounded run of ONE test group as its own process group, stdio inherited so its output still streams
# live. Returns the group's exit status, or 124 if the ceiling was hit. Same supervision shape as
# run_cli_supervised below, minus the output file: a group writes to the harness's own stdout (an
# inherited fd, not a capture pipe), so a leaked descendant cannot wedge a `$(...)` read here.
supervise_group() (
  local timeout_seconds="$1"
  shift
  local timeout_marker
  timeout_marker="$(mktemp)"
  rm -f "${timeout_marker}"
  local command_pid=""
  local timer_pid=""

  cleanup_supervised_group() {
    if [ -n "${timer_pid}" ]; then
      kill "${timer_pid}" 2>/dev/null || true
      wait "${timer_pid}" 2>/dev/null || true
    fi
    if [ -n "${command_pid}" ]; then
      if kill -0 -- "-${command_pid}" 2>/dev/null; then
        terminate_process_group "${command_pid}"
      fi
      wait "${command_pid}" 2>/dev/null || true
    fi
    rm -f "${timeout_marker}"
  }
  trap cleanup_supervised_group EXIT HUP INT TERM

  perl -MPOSIX=setsid -e 'setsid() or die "setsid failed: $!"; exec @ARGV' "$@" &
  command_pid=$!
  (
    sleep "${timeout_seconds}"
    : >"${timeout_marker}"
    terminate_process_group "${command_pid}"
  ) &
  timer_pid=$!

  local status
  if wait "${command_pid}"; then
    status=0
  else
    status=$?
  fi
  if [ -f "${timeout_marker}" ]; then
    wait "${timer_pid}" 2>/dev/null || true
    status=124
  else
    kill "${timer_pid}" 2>/dev/null || true
    wait "${timer_pid}" 2>/dev/null || true
    # A group that RETURNED but left descendants behind (a leaked `vinci --mode rpc` child) would
    # otherwise outlive the harness. Reap the whole group either way.
    if kill -0 -- "-${command_pid}" 2>/dev/null; then
      terminate_process_group "${command_pid}"
    fi
  fi
  timer_pid=""
  command_pid=""
  rm -f "${timeout_marker}"
  trap - EXIT HUP INT TERM
  return "${status}"
)

# Every group below runs through this. A group that leaks a handle and never exits (crew-integration
# printed "138/138 checks passed" and then sat at 0% CPU forever on an unreleased RPC timer) now costs
# one named, timed red line instead of a harness that never returns — the failure mode that trains
# people to ignore a red result. Raise VINCI_TEST_GROUP_TIMEOUT for a genuinely slow machine.
GROUP_TIMEOUT_SECONDS="${VINCI_TEST_GROUP_TIMEOUT:-300}"

run_group() {
  local label="$1"
  shift
  local started="${SECONDS}"
  supervise_group "${GROUP_TIMEOUT_SECONDS}" "$@"
  local status=$?
  local elapsed=$((SECONDS - started))
  if [ "${status}" -eq 124 ]; then
    echo "  ✗ ${label}: TIMED OUT after ${elapsed}s (ceiling ${GROUP_TIMEOUT_SECONDS}s) — process group killed"
    fails=$((fails + 1))
  elif [ "${status}" -ne 0 ]; then
    fails=$((fails + 1))
  fi
  return "${status}"
}

run_cli_supervised() (
  local timeout_seconds="$1"
  shift
  local output_file
  output_file="$(mktemp)"
  local timeout_marker="${output_file}.timeout"
  local command_pid=""
  local timer_pid=""

  cleanup_supervised_cli() {
    if [ -n "${timer_pid}" ]; then
      kill "${timer_pid}" 2>/dev/null || true
      wait "${timer_pid}" 2>/dev/null || true
    fi
    if [ -n "${command_pid}" ]; then
      if kill -0 -- "-${command_pid}" 2>/dev/null; then
        terminate_process_group "${command_pid}"
      fi
      wait "${command_pid}" 2>/dev/null || true
    fi
    rm -f "${output_file}" "${timeout_marker}"
  }
  trap cleanup_supervised_cli EXIT HUP INT TERM

  # Start the launcher as a process-group leader. If either the launcher or Node wedges, the timer
  # terminates the whole group so no descendant can retain an output pipe and hang this harness.
  perl -MPOSIX=setsid -e 'setsid() or die "setsid failed: $!"; exec @ARGV' "$@" >"${output_file}" 2>&1 &
  command_pid=$!
  (
    sleep "${timeout_seconds}"
    : >"${timeout_marker}"
    terminate_process_group "${command_pid}"
  ) &
  timer_pid=$!

  # The timer terminates the whole group on timeout, so this wait returns for any KILLABLE wedge (the
  # real #12 failure mode — an idle-in-run-loop hang). A SIGKILL-immune process (kernel D-state: stuck
  # NFS/driver I/O) cannot be preempted by any userspace timeout and would block this wait — an OS
  # pathology, accepted as out of scope; the bounded reap above at least stops the KILL-spam loop.
  local status
  if wait "${command_pid}"; then
    status=0
  else
    status=$?
  fi
  if [ -f "${timeout_marker}" ]; then
    wait "${timer_pid}" 2>/dev/null || true
    status=124
  else
    kill "${timer_pid}" 2>/dev/null || true
    wait "${timer_pid}" 2>/dev/null || true
    if kill -0 -- "-${command_pid}" 2>/dev/null; then
      terminate_process_group "${command_pid}"
    fi
  fi
  timer_pid=""
  command_pid=""
  cat "${output_file}"
  rm -f "${output_file}" "${timeout_marker}"
  trap - EXIT HUP INT TERM
  return "${status}"
)

echo "── UNIT ──────────────────────────────────────────────"
run_group identity-contract node "${ROOT}/vinci/test/identity-contract.mjs"
run_group deepinfra-provider-integration node "${ROOT}/vinci/test/deepinfra-provider-integration.mjs"
# BYOK: the launcher's provider-flag matrix, and proof that a BYOK session keeps every VINCI_CODE
# guard. Both existed and passed for a while WITHOUT being listed here, so the aggregate gate was
# green while neither ever ran — an inert guard. Wired in so a failure actually fails the release.
run_group byok-launcher-integration node "${ROOT}/vinci/test/byok-launcher-integration.mjs"
run_group byok-guards-integration env VINCI_CODE=1 node "${ROOT}/vinci/test/byok-guards-integration.mjs"
# Public docs must not teach an obsolete opt-in, link a repo readers cannot open, or pin a version.
# Each of those actually shipped during the open-sourcing work and was caught by eye, not by a gate.
run_group docs-accuracy-integration node "${ROOT}/vinci/test/docs-accuracy-integration.mjs"
run_group priority-integration node "${ROOT}/vinci/test/priority-integration.mjs"
run_group update-integration node "${ROOT}/vinci/test/update-integration.mjs"
# VINCI_ENV=dev: launcher resolution (dev URLs, isolated agent dir, updates off, explicit-env-wins,
# unknown-value rejection), updater dev gate + doctor report, shared vinci-links origin, header badge.
run_group dev-env-integration node "${ROOT}/vinci/test/dev-env-integration.mjs"
run_group tool-bootstrap-integration node "${ROOT}/vinci/test/tool-bootstrap-integration.mjs"
run_group advisor-integration node "${ROOT}/vinci/test/advisor-integration.mjs"
run_group header-hint-integration node "${ROOT}/vinci/test/header-hint-integration.mjs"
# The agent-directory override is DERIVED from piConfig, so a hardcoded upstream "PI_…" spelling reads
# a dead variable: the header then reports "not signed in" and creates ~/.pi/agent on a machine that
# does not use it. Pins every reader/writer of that directory to the configured one.
run_group agent-dir-env-integration node "${ROOT}/vinci/test/agent-dir-env-integration.mjs"
run_group character-shell-hint-integration node "${ROOT}/vinci/test/character-shell-hint-integration.mjs"
run_group vinci-copy-integration node "${ROOT}/vinci/test/vinci-copy-integration.mjs"
run_group ask-checklist-integration node "${ROOT}/vinci/test/ask-checklist-integration.mjs"
run_group issue-integration node "${ROOT}/vinci/test/issue-integration.mjs"
run_group billing-codes-integration node "${ROOT}/vinci/test/billing-codes-integration.mjs"
run_group no-downgrade-integration node "${ROOT}/vinci/test/no-downgrade-integration.mjs"
run_group units node "${ROOT}/vinci/test/units.mjs"
# Print-mode liveness: every prompt gets a fresh idle watchdog, all session activity resets it,
# tool execution suspends it, invalid timeout configuration falls back safely, and cleanup cancels it.
run_group print-mode-liveness node --experimental-strip-types --input-type=module --eval '
  import {
    armPrintModeLivenessWatchdog,
    armStartupLivenessWatchdog,
    printModePrestreamTimeoutMs,
    runPrintMode,
    setPrintModeTerminatingForTest,
  } from "./packages/coding-agent/src/modes/print-mode.ts";

  const createClock = () => {
    let now = 0;
    let nextHandle = 1;
    const pending = new Map();
    return {
      clock: {
        setTimeout: (callback, timeoutMs) => {
          const handle = nextHandle++;
          pending.set(handle, { callback, deadline: now + timeoutMs });
          return handle;
        },
        clearTimeout: (handle) => {
          pending.delete(handle);
        },
      },
      advance: (elapsedMs) => {
        now += elapsedMs;
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.deadline <= now)
          .sort((left, right) => left[1].deadline - right[1].deadline);
        for (const [handle, timer] of due) {
          if (!pending.delete(handle)) continue;
          timer.callback();
        }
      },
      pendingCount: () => pending.size,
    };
  };

  setPrintModeTerminatingForTest(false);
  const previousTimeout = process.env.VINCI_PRESTREAM_TIMEOUT_MS;
  const nativeProcessExit = process.exit;
  try {
    process.env.VINCI_PRESTREAM_TIMEOUT_MS = "100";
    const startupTimeoutClock = createClock();
    let startupTimeoutFires = 0;
    process.exit = (code) => {
      if (code !== 1) throw new Error(`startup watchdog exited with ${code} instead of 1`);
      startupTimeoutFires++;
    };
    armStartupLivenessWatchdog(startupTimeoutClock.clock);
    startupTimeoutClock.advance(101);
    startupTimeoutClock.advance(100);
    if (startupTimeoutFires !== 1 || startupTimeoutClock.pendingCount() !== 0) {
      throw new Error(`startup watchdog deadline fired ${startupTimeoutFires} times instead of once`);
    }

    const startupTerminatingClock = createClock();
    let startupTerminatingFires = 0;
    process.exit = () => {
      startupTerminatingFires++;
    };
    const startupTerminatingWatchdog = armStartupLivenessWatchdog(startupTerminatingClock.clock);
    setPrintModeTerminatingForTest(true);
    startupTerminatingClock.advance(101);
    startupTerminatingWatchdog.cancel();
    startupTerminatingWatchdog.cancel();
    setPrintModeTerminatingForTest(false);
    if (startupTerminatingFires !== 0 || startupTerminatingClock.pendingCount() !== 0) {
      throw new Error("terminating startup watchdog invoked its timeout action or left a timer pending");
    }
  } finally {
    process.exit = nativeProcessExit;
    setPrintModeTerminatingForTest(false);
    if (previousTimeout === undefined) {
      delete process.env.VINCI_PRESTREAM_TIMEOUT_MS;
    } else {
      process.env.VINCI_PRESTREAM_TIMEOUT_MS = previousTimeout;
    }
  }

  const timeoutClock = createClock();
  let timeoutFires = 0;
  armPrintModeLivenessWatchdog(() => timeoutFires++, 100, timeoutClock.clock);
  timeoutClock.advance(101);
  timeoutClock.advance(100);
  if (timeoutFires !== 1) {
    throw new Error(`watchdog deadline fired ${timeoutFires} times instead of once`);
  }

  const activityClock = createClock();
  let activityFires = 0;
  const activityWatchdog = armPrintModeLivenessWatchdog(
    () => activityFires++,
    100,
    activityClock.clock,
  );
  activityClock.advance(90);
  activityWatchdog.activity();
  activityClock.advance(99);
  if (activityFires !== 0) {
    throw new Error("session activity did not reset the watchdog deadline");
  }
  activityClock.advance(1);
  if (activityFires !== 1) {
    throw new Error("reset watchdog did not fire after a full idle timeout");
  }

  const toolClock = createClock();
  let toolFires = 0;
  const toolWatchdog = armPrintModeLivenessWatchdog(() => toolFires++, 100, toolClock.clock);
  toolClock.advance(90);
  toolWatchdog.toolExecutionStart("compat");
  toolClock.advance(1_000);
  if (toolFires !== 0 || toolClock.pendingCount() !== 0) {
    throw new Error("tool execution did not suspend the watchdog");
  }
  toolWatchdog.toolExecutionEnd("compat");
  toolClock.advance(99);
  if (toolFires !== 0) {
    throw new Error("watchdog fired before a full timeout after tool completion");
  }
  toolClock.advance(1);
  if (toolFires !== 1) {
    throw new Error("watchdog did not resume after tool completion");
  }

  const boundaryClock = createClock();
  let boundaryFires = 0;
  const boundaryWatchdog = armPrintModeLivenessWatchdog(
    () => boundaryFires++,
    100,
    boundaryClock.clock,
  );
  boundaryWatchdog.toolExecutionStart("boundary");
  boundaryClock.advance(1_000);
  if (boundaryFires !== 0) {
    throw new Error("unmatched tool start did not suspend the watchdog");
  }
  boundaryWatchdog.turnBoundary();
  boundaryClock.advance(99);
  if (boundaryFires !== 0) {
    throw new Error("turn boundary fired before a full idle timeout");
  }
  boundaryClock.advance(1);
  if (boundaryFires !== 1) {
    throw new Error("turn boundary did not resume a watchdog suspended by an unmatched tool start");
  }

  const hookHangClock = createClock();
  let hookHangFires = 0;
  const hookHangWatchdog = armPrintModeLivenessWatchdog(
    () => hookHangFires++,
    100,
    hookHangClock.clock,
  );
  hookHangWatchdog.toolExecutionStart("t1");
  hookHangClock.advance(1_000);
  if (hookHangFires !== 0 || hookHangClock.pendingCount() !== 0) {
    throw new Error("tool execution did not suspend before hooks started");
  }
  hookHangWatchdog.toolHooksStart("t1");
  if (hookHangClock.pendingCount() !== 1) {
    throw new Error("tool_hooks_start did not arm the watchdog");
  }
  hookHangClock.advance(101);
  if (hookHangFires !== 1) {
    throw new Error("hung afterToolCall hook did not fire the watchdog");
  }

  const overlappingClock = createClock();
  let overlappingFires = 0;
  const overlappingWatchdog = armPrintModeLivenessWatchdog(
    () => overlappingFires++,
    100,
    overlappingClock.clock,
  );
  overlappingWatchdog.toolExecutionStart("A");
  overlappingWatchdog.toolExecutionStart("B");
  overlappingWatchdog.toolHooksStart("A");
  overlappingWatchdog.toolExecutionEnd("A");
  overlappingClock.advance(1_000);
  if (overlappingFires !== 0 || overlappingClock.pendingCount() !== 0) {
    throw new Error("tool A hook/end pairing ignored tool B still executing");
  }
  overlappingWatchdog.toolHooksStart("B");
  if (overlappingClock.pendingCount() !== 1) {
    throw new Error("tool B hook boundary did not arm after all executions settled");
  }
  overlappingWatchdog.toolExecutionEnd("B");
  if (overlappingClock.pendingCount() !== 1) {
    throw new Error("tool B end double-decremented or duplicated the watchdog timer");
  }
  overlappingClock.advance(99);
  if (overlappingFires !== 0) {
    throw new Error("overlapping tool completion did not restart a full timeout");
  }
  overlappingClock.advance(1);
  if (overlappingFires !== 1) {
    throw new Error("overlapping tool completion did not resume the watchdog");
  }

  const duplicateEndClock = createClock();
  let duplicateEndFires = 0;
  const duplicateEndWatchdog = armPrintModeLivenessWatchdog(
    () => duplicateEndFires++,
    100,
    duplicateEndClock.clock,
  );
  duplicateEndWatchdog.toolExecutionStart("X");
  duplicateEndWatchdog.toolExecutionStart("Y");
  duplicateEndWatchdog.toolHooksStart("X");
  duplicateEndWatchdog.toolExecutionEnd("X");
  duplicateEndWatchdog.toolExecutionEnd("X");
  duplicateEndClock.advance(1_000);
  if (duplicateEndFires !== 0 || duplicateEndClock.pendingCount() !== 0) {
    throw new Error("a duplicate tool end broke the suspension of a still-executing sibling");
  }
  duplicateEndWatchdog.toolExecutionEnd("Y");
  duplicateEndClock.advance(101);
  if (duplicateEndFires !== 1) {
    throw new Error("watchdog did not resume after the sibling of a duplicated end completed");
  }

  const unmatchedEndClock = createClock();
  let unmatchedEndFires = 0;
  const unmatchedEndWatchdog = armPrintModeLivenessWatchdog(
    () => unmatchedEndFires++,
    100,
    unmatchedEndClock.clock,
  );
  unmatchedEndWatchdog.toolExecutionEnd("unknown");
  unmatchedEndClock.advance(101);
  if (unmatchedEndFires !== 1) {
    throw new Error("unmatched tool execution end broke the armed watchdog");
  }

  const cancelledClock = createClock();
  let cancelledFires = 0;
  const cancelledWatchdog = armPrintModeLivenessWatchdog(
    () => cancelledFires++,
    100,
    cancelledClock.clock,
  );
  cancelledWatchdog.cancel();
  cancelledWatchdog.activity();
  cancelledClock.advance(101);
  if (cancelledFires !== 0 || cancelledClock.pendingCount() !== 0) {
    throw new Error("late activity re-armed a cancelled watchdog");
  }

  const terminatingClock = createClock();
  let terminatingFires = 0;
  const terminatingWatchdog = armPrintModeLivenessWatchdog(
    () => terminatingFires++,
    100,
    terminatingClock.clock,
  );
  setPrintModeTerminatingForTest(true);
  terminatingClock.advance(101);
  terminatingWatchdog.cancel();
  setPrintModeTerminatingForTest(false);
  if (terminatingFires !== 0) {
    throw new Error("terminating watchdog invoked its timeout callback");
  }

  const sequentialClock = createClock();
  let sequentialFires = 0;
  for (let prompt = 0; prompt < 2; prompt++) {
    const watchdog = armPrintModeLivenessWatchdog(
      () => sequentialFires++,
      100,
      sequentialClock.clock,
    );
    watchdog.activity();
    watchdog.cancel();
    sequentialClock.advance(101);
  }
  if (sequentialFires !== 0 || sequentialClock.pendingCount() !== 0) {
    throw new Error("sequential prompts did not create and cancel fresh watchdogs");
  }

  try {
    for (const invalid of ["NaN", "Infinity", "0", "-1", "1.5", "300001", "999999999999999999999"]) {
      process.env.VINCI_PRESTREAM_TIMEOUT_MS = invalid;
      if (printModePrestreamTimeoutMs() !== 180_000) {
        throw new Error(`invalid timeout ${invalid} did not fall back to 180000ms`);
      }
    }
    process.env.VINCI_PRESTREAM_TIMEOUT_MS = "300000";
    if (printModePrestreamTimeoutMs() !== 300_000) {
      throw new Error("valid maximum timeout was rejected");
    }
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.VINCI_PRESTREAM_TIMEOUT_MS;
    } else {
      process.env.VINCI_PRESTREAM_TIMEOUT_MS = previousTimeout;
    }
  }

  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const promptClock = createClock();
  let startupHandoffFires = 0;
  try {
    process.env.VINCI_PRESTREAM_TIMEOUT_MS = "180000";
    process.exit = () => {
      startupHandoffFires++;
    };
    globalThis.setTimeout = (callback, timeoutMs) => {
      if (timeoutMs !== 180_000) throw new Error(`unexpected prompt timeout ${timeoutMs}`);
      return promptClock.clock.setTimeout(callback, timeoutMs);
    };
    globalThis.clearTimeout = (handle) => {
      promptClock.clock.clearTimeout(handle);
    };

    let subscriber = () => {};
    let promptCount = 0;
    const session = {
      agent: { waitForIdle: async () => {} },
      bindExtensions: async () => {},
      navigateTree: async () => ({ cancelled: false }),
      prompt: async () => {
        promptCount++;
        if (promptCount === 1 && promptClock.pendingCount() !== 1) {
          throw new Error("first per-prompt watchdog did not cancel and replace the startup watchdog");
        }
        subscriber({ type: "message_start", message: { role: "assistant" } });
        // Generic-event activity through the real subscription: let the timer approach its
        // deadline, reset it with a non-message session event, then cross the ORIGINAL deadline —
        // a broken activity() wiring fires the watchdog here (process exit), a working one has a
        // live timer pending against the new deadline.
        promptClock.advance(179_999);
        subscriber({ type: "queue_update", steering: [], followUp: [] });
        promptClock.advance(2);
        if (promptClock.pendingCount() !== 1) {
          throw new Error("a generic session event did not reset the watchdog via session.subscribe");
        }
        subscriber({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
        if (promptClock.pendingCount() !== 0) {
          throw new Error("tool_execution_start did not suspend the watchdog via session.subscribe");
        }
        subscriber({ type: "tool_hooks_start", toolCallId: "t1", toolName: "read" });
        if (promptClock.pendingCount() !== 1) {
          throw new Error("tool_hooks_start did not re-arm via session.subscribe before tool end");
        }
        subscriber({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: {}, isError: false });
        if (promptClock.pendingCount() !== 1) {
          throw new Error("tool_execution_end did not resume the watchdog via session.subscribe");
        }
        // Turn-boundary recovery through the real subscription: each boundary event must rescue
        // a watchdog suspended by a tool start whose end never arrived.
        subscriber({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: {} });
        subscriber({ type: "turn_end", turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
        if (promptClock.pendingCount() !== 1) {
          throw new Error("turn_end did not resume a suspended watchdog via session.subscribe");
        }
        subscriber({ type: "tool_execution_start", toolCallId: "t3", toolName: "read", args: {} });
        subscriber({ type: "agent_end", messages: [] });
        if (promptClock.pendingCount() !== 1) {
          throw new Error("agent_end did not resume a suspended watchdog via session.subscribe");
        }
      },
      reload: async () => {},
      sessionManager: { getHeader: () => undefined },
      state: { messages: [] },
      subscribe: (next) => {
        subscriber = next;
        return () => {};
      },
    };
    const runtimeHost = {
      dispose: async () => {},
      session,
      setRebindSession: () => {},
    };
    armStartupLivenessWatchdog(promptClock.clock);
    const exitCode = await runPrintMode(runtimeHost, {
      mode: "text",
      initialMessage: "first",
      messages: ["/noop"],
    });
    promptClock.advance(180_001);
    if (exitCode !== 0 || startupHandoffFires !== 0 || promptClock.pendingCount() !== 0) {
      throw new Error("runPrintMode did not hand off startup to fresh per-prompt watchdogs cleanly");
    }

    armStartupLivenessWatchdog(promptClock.clock);
    const noPromptExitCode = await runPrintMode(runtimeHost, { mode: "text" });
    promptClock.advance(180_001);
    if (noPromptExitCode !== 2 || startupHandoffFires !== 0 || promptClock.pendingCount() !== 0) {
      throw new Error("runPrintMode no-prompt teardown did not cancel the startup watchdog");
    }
  } finally {
    process.exit = nativeProcessExit;
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
    setPrintModeTerminatingForTest(false);
    if (previousTimeout === undefined) {
      delete process.env.VINCI_PRESTREAM_TIMEOUT_MS;
    } else {
      process.env.VINCI_PRESTREAM_TIMEOUT_MS = previousTimeout;
    }
  }
  console.log("  ✓ print-mode liveness watchdog lifecycle + timeout validation");
'
# Production loads every extension through an isolated jiti instance; prove their shared shell state
# remains one store instead of leaving the composer stuck on "checking".
run_group ui-state-integration node "${ROOT}/vinci/test/ui-state-integration.mjs"
# User messages submitted mid-run remain visibly queued until the agent receives them.
run_group queue-integration node "${ROOT}/vinci/test/queue-integration.mjs"
# Requested/resolved model identity and route pins survive session resume; route drift is visible.
run_group model-provenance-integration node "${ROOT}/vinci/test/model-provenance-integration.mjs"
# Dirty-tree grounding: current changes are injected as bounded data before coding work starts.
run_group workspace-integration node "${ROOT}/vinci/test/workspace-integration.mjs"
# Failed/stale verification is sticky across edits and cannot be narrated away as success.
run_group verification-state-integration node "${ROOT}/vinci/test/verification-state-integration.mjs"
# The latch LIFECYCLE: every shape is driven fail -> exact rerun -> clear. Two rounds of #56/#66
# shipped a latch that formed correctly and could never resolve, because every test asserted the
# latch FORMS and none asserted it RESOLVES (VERIFICATION_LATCH_DESIGN.md, guarantee 8).
run_group verification-latch-lifecycle node "${ROOT}/vinci/test/verification-latch-lifecycle.mjs"
run_group print-mode-exit-code node "${ROOT}/vinci/test/print-mode-exit-code.mjs"
# Phase-2 model-graded completion gate (verification ENABLED, grader stubbed): a needs-work/risky
# review reopens or pauses instead of letting a false "all done" through; grader errors are fail-safe.
run_group verification-review-integration node "${ROOT}/vinci/test/verification-review-integration.mjs"
# Interrupted mutations recover from durable session checkpoints and are not blindly replayed.
run_group checkpoint-integration node "${ROOT}/vinci/test/checkpoint-integration.mjs"
# Real process-death lane: kill after a write lands but before its tool result, then resume by task ID.
run_group checkpoint-process-integration node "${ROOT}/vinci/test/checkpoint-process-integration.mjs"
# Current/version-sensitive claims require live evidence, visible attribution, and semantic support.
run_group fact-grounding-integration node "${ROOT}/vinci/test/fact-grounding-integration.mjs"
# Completion cards render the verifier state rather than inferring success from tool exit alone.
run_group receipt-integration node "${ROOT}/vinci/test/receipt-integration.mjs"
run_group completion-receipt-integration node "${ROOT}/vinci/test/completion-receipt-integration.mjs"
# Durable project memory never changes a repository unless the user explicitly requested it.
run_group memory-integration node "${ROOT}/vinci/test/memory-integration.mjs"
# User-reported false completions append one idempotent local task event without starting the agent.
run_group report-wrong-integration node "${ROOT}/vinci/test/report-wrong-integration.mjs"
run_group verify-routing-integration node "${ROOT}/vinci/test/verify-routing-integration.mjs"
run_group acceptance-packaged-integration node "${ROOT}/vinci/test/acceptance-packaged-integration.mjs"
run_group remote-verdict-integration node "${ROOT}/vinci/test/remote-verdict-integration.mjs"
run_group accept-tool-integration node "${ROOT}/vinci/test/accept-tool-integration.mjs"
run_group receipt-remote-verdict node "${ROOT}/vinci/test/receipt-remote-verdict.mjs"
run_group accept-config-precedence node "${ROOT}/vinci/test/accept-config-precedence.mjs"
# /feedback keeps transcripts local, redacts both paths, and tolerates network failure.
run_group feedback-integration node "${ROOT}/vinci/test/feedback-integration.mjs"
# /support prints a terminal-safe URL and tolerates browser opener failures.
run_group support-command node "${ROOT}/vinci/test/support-command.mjs"
# /help lists the Vinci commands and the cross-surface ecosystem links.
run_group help-command node "${ROOT}/vinci/test/help-command.mjs"
# Every autonomous continuation layer honors one shared bounded-stop latch.
run_group automation-stop-integration node "${ROOT}/vinci/test/automation-stop-integration.mjs"
# Stalled plans (e.g. a user-cancelled step) stop paying for keep-working reminders.
run_group todo-stall-integration node "${ROOT}/vinci/test/todo-stall-integration.mjs"
# Structural loop/safety regressions use jiti so they run on the Node 22 CI floor too.
run_group loopbreak-integration node "${ROOT}/vinci/test/loopbreak-integration.mjs"
run_group guard-integration node "${ROOT}/vinci/test/guard-integration.mjs"
# Masked content (<vinci-secret>) can never match or overwrite raw file bytes.
run_group mask-edit-integration node "${ROOT}/vinci/test/mask-edit-integration.mjs"
# A network action never bundles local mutations under one approval.
run_group network-bundle-integration node "${ROOT}/vinci/test/network-bundle-integration.mjs"
run_group scope-integration node "${ROOT}/vinci/test/scope-integration.mjs"
# Mid-run steering amends the scope task; it never shrinks it to just the adjustment.
run_group scope-amendment-integration node "${ROOT}/vinci/test/scope-amendment-integration.mjs"
run_group shell-integration node "${ROOT}/vinci/test/shell-integration.mjs"
run_group repo-corpus-unit node "${ROOT}/vinci/test/ec2/repo-corpus-unit.mjs"
run_group aggregate-corpus-unit node "${ROOT}/vinci/test/ec2/aggregate-corpus-unit.mjs"
run_group verify-holdout-corpus-unit node "${ROOT}/vinci/test/ec2/verify-holdout-corpus-unit.mjs"
run_group aggregate-holdout-unit node "${ROOT}/vinci/test/ec2/aggregate-holdout-unit.mjs"
# Real fix commits become validated corpus fixtures (reverse-code patch, focused verify, staging).
run_group mine-fixtures-unit node "${ROOT}/vinci/test/mine-fixtures-unit.mjs"
# Core CLI boundaries keep the managed model surface closed; shorthand approvals retain reviewer context.
run_group coding-agent-cli-units node "${VITEST_CLI}" \
  --root "${ROOT}/packages/coding-agent" --run \
  "test/args.test.ts" "test/list-models.test.ts" "test/vinci-grader.test.ts"
# Remaining integrations drive the REAL modules directly (Node 23+ strips TS types at load).
if node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>=23?0:1)'; then
  # bashIntent: the real "what it's doing" labels shown next to each shell command.
  run_group render-integration node --experimental-strip-types "${ROOT}/vinci/test/render-integration.mjs"
  # tool-name normalization: hallucinated synonyms (editor→edit) fold onto the real tool, guard-safe.
  run_group toolname-integration node --experimental-strip-types "${ROOT}/vinci/test/toolname-integration.mjs"
  # secret masking: API keys never painted across the screen in an edit diff / write preview.
  run_group mask-integration node --experimental-strip-types "${ROOT}/vinci/test/mask-integration.mjs"
  # prompt-injection boundary: untrusted web content fenced so a page can't hijack the agent.
  run_group search-integration node --experimental-strip-types "${ROOT}/vinci/test/search-integration.mjs"
  # command sandbox: real write confinement through macOS sandbox-exec or Linux bubblewrap.
  run_group sandbox-integration node --experimental-strip-types "${ROOT}/vinci/test/sandbox-integration.mjs"
  # session auto-naming: model title reply → tidy session name for the resume picker.
  run_group autoname-integration node --experimental-strip-types "${ROOT}/vinci/test/autoname-integration.mjs"
  # graduated trust: "always allow" persists per-project, exact-match only.
  run_group trust-integration node --experimental-strip-types "${ROOT}/vinci/test/trust-integration.mjs"
  # /preview: what to open (static site / dev app / nothing) so the user can see their result.
  run_group preview-integration node --experimental-strip-types "${ROOT}/vinci/test/preview-integration.mjs"
  # cachewatch: prefix-cache hygiene diagnostic — snapshot/analyze + never mutates the request.
  run_group cachewatch-integration node --experimental-strip-types "${ROOT}/vinci/test/cachewatch-integration.mjs"
  # toolload: deferred tool schemas — deferred-set resolution, active-set filter, load_tools activation.
  run_group toolload-integration node --experimental-strip-types "${ROOT}/vinci/test/toolload-integration.mjs"
  # outcome: the "did it work?" layer — /check registration + the non-programmer OUTCOME contract.
  run_group outcome-integration node --experimental-strip-types "${ROOT}/vinci/test/outcome-integration.mjs"
else
  echo "  ⚠ type-stripping integrations skipped — needs Node 23+"
fi
# Integration: vinci-crew git mechanic — worktree isolation + diff + apply (real git, no gateway).
run_group crew-integration node "${ROOT}/vinci/test/crew-integration.mjs"
# Integration: per-result context budget — read/grep/find keep tool output bounded (real modules).
run_group resultbudget-integration node "${ROOT}/vinci/test/resultbudget-integration.mjs"

echo
echo "── UI (headless xterm + faux model) ──────────────────"
# The trailing path is a filter, not a file: vitest still globs the whole root, and background
# Agents keep their git worktrees at .claude/worktrees/ INSIDE the repo. Those copies have no
# node_modules, so vitest collects them, fails to resolve their imports, and the run exits non-zero
# even though every real test passed. Exclude them — and restate the defaults, since --exclude
# replaces the built-in list rather than adding to it.
run_group ui-scenarios node "${VITEST_CLI}" \
  --root "${ROOT}" --run \
  --exclude '**/node_modules/**' --exclude '**/dist/**' --exclude '**/.claude/**' \
  "vinci/test/ui/scenarios.test.mjs"

run_group ui-crew-view node "${VITEST_CLI}" \
  --root "${ROOT}" --run \
  --exclude '**/node_modules/**' --exclude '**/dist/**' --exclude '**/.claude/**' \
  "vinci/test/ui/crew-view.test.mjs"

echo
echo "── VISUAL (rendered TUI header via PTY) ──────────────"
# The native recorder drives a delayed local faux provider through script(1), so this verifies both
# active animation and the completed composer without paid calls or terminal-specific input races.
if command -v script >/dev/null 2>&1; then
  visual_dir="$(mktemp -d)"
  # supervise_group, not run_group: this branch already owns its own pass/fail reporting below, so a
  # timeout must come back as a plain non-zero status (124) instead of being counted twice. The PTY
  # recorder drives a real CLI through script(1) and is exactly the kind of group that can wedge.
  if supervise_group "${GROUP_TIMEOUT_SECONDS}" node "${ROOT}/vinci/test/ec2/capture-terminal.mjs" --output "${visual_dir}" --columns 80 --rows 24 >"${visual_dir}/capture.log" 2>&1; then
    startup="$(sed -n '1,80p' "${visual_dir}/80x24-startup.txt" 2>/dev/null)"
    continuing="$(sed -n '1,80p' "${visual_dir}/80x24-continuing.txt" 2>/dev/null)"
    complete="$(sed -n '1,80p' "${visual_dir}/80x24-complete.txt" 2>/dev/null)"
    vfail=0
    # "Vinci" not "Vinci Forte": the startup header names the account-resolved class, which is the
    # auto sentinel until the gateway resolves it, so pinning a class name here would fail for
    # anyone not on Forte.
    for needle in "Vinci" "% full"; do
      echo "${startup}" | grep -qF "${needle}" || { echo "  ✗ startup render missing: ${needle}"; vfail=1; }
    done
    echo "${continuing}" | grep -qF "Continuing the task" || { echo "  ✗ continuation render missing active handoff"; vfail=1; }
    for needle in "Ask Vinci" "Visual test complete." "changed · +1 −1" "quiet" "lively"; do
      echo "${complete}" | grep -qF "${needle}" || { echo "  ✗ completion render missing: ${needle}"; vfail=1; }
    done
    # Engineer telemetry must NOT leak into the consumer footer.
    for banned in "(sub)" "(auto)"; do
      printf '%s\n%s\n%s\n' "${startup}" "${continuing}" "${complete}" | grep -qF "${banned}" && { echo "  ✗ footer leaks telemetry: ${banned}"; vfail=1; }
    done
    [ "${vfail}" -eq 0 ] && echo "  ✓ native PTY renders working + completed Vinci frames cleanly" || fails=$((fails + 1))
  else
    echo "  ✗ native PTY capture failed:"
    sed -n '1,12p' "${visual_dir}/capture.log" | sed 's/^/      /'
    fails=$((fails + 1))
  fi
  rm -rf "${visual_dir}"
else
  echo "  ⚠ skipped — 'script' (PTY) not available on this system"
fi

echo
echo "── SMOKE (real CLI, headless) ────────────────────────"
if [ "${VINCI_SKIP_SMOKE:-0}" = "1" ]; then
  echo "  ⚠ skipped — VINCI_SKIP_SMOKE=1 (offline validation)."
elif [ ! -f "${HOME}/.pi/agent/auth.json" ] || ! grep -q '"vinci"' "${HOME}/.pi/agent/auth.json" 2>/dev/null; then
  echo "  ⚠ skipped — not signed in (run 'vinci' then /login). Units still ran."
else
  # 1. Load + respond: exercises all extensions/patches + the provider/auth path.
  out="$(run_cli_supervised 90 bash "${VINCI}" -p "Reply with exactly this token and nothing else: SMOKE-OK")"
  smoke_status=$?
  if [ "${smoke_status}" -eq 0 ] && echo "${out}" | grep -q "SMOKE-OK"; then echo "  ✓ loads + agent responds"; else echo "  ✗ load/respond failed (exit ${smoke_status}):"; echo "${out}" | tail -5 | sed 's/^/      /'; fails=$((fails + 1)); fi

  # 2. Tool use end-to-end: force a real tool call and assert BOTH that a tool executed AND the answer
  #    lands. The probe names the `ls` tool explicitly and asks about README.md (present verbatim in
  #    the listing): models may answer curt yes/no prompts WITHOUT tools unless told which tool to run, and
  #    connects a terse listing to the answer only when the asked name appears verbatim in the result
  #    (the old probe failed when `ls vinci/bin` returned just "vinci").
  toolok=0
  for _ in 1 2 3; do
    out="$(run_cli_supervised 90 bash "${VINCI}" --mode json -p "Run the ls tool on the directory . now. Then, based on the tool result, reply with only YES or NO: does README.md exist in this project?")"
    smoke_status=$?
    if [ "${smoke_status}" -eq 0 ] && echo "${out}" | grep -q '"type":"tool_execution_end"' && echo "${out}" | grep -qi '"text":"yes'; then toolok=1; break; fi
  done
  if [ "${toolok}" -eq 1 ]; then echo "  ✓ tools fire end-to-end (tool executed + correct answer)"; else echo "  ✗ tool-use failed 3× (last exit ${smoke_status}):"; echo "${out}" | tail -5 | sed 's/^/      /'; fails=$((fails + 1)); fi
fi

echo
if [ "${fails}" -eq 0 ]; then echo "✅ all test groups passed"; else echo "❌ ${fails} test group(s) failed"; fi
exit "${fails}"
