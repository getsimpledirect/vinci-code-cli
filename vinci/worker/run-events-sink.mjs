// IR-02 embedded runtime: durable append-only JSONL event sink for a single Run.
//
// The embedded adapter (runtime-adapter.mjs) translates native agent-session events into the
// Vinci run-event vocabulary and writes them here. The sink owns three guarantees the run-event
// contract needs:
//
//   * per-run CONTIGUOUS, 1-based `sequence`, assigned here on append and VERIFIED on every open;
//   * `idempotencyKey` dedupe: re-appending the same key with the SAME payload digest is a no-op
//     that returns the already-assigned sequence; the same key with a DIFFERENT payload is an
//     `idempotency_conflict` error and appends nothing.
//     THE CONTRACT IS EXACT ONLY FOR EVENTS WHOSE PAYLOAD IS A FUNCTION OF THEIR IDENTITY. Exactly
//     one event on the current stream is not: `tool.completed` carries `durationMs`, a WALL-CLOCK
//     measurement of the call rather than a property of it. A genuine re-append of the same logical
//     tool completion therefore raises `idempotency_conflict` instead of deduplicating, because the
//     second measurement differs from the first. The field is kept deliberately — the duration is
//     real evidence about the run — so this is a documented exception, not a defect to design away
//     by dropping the measurement;
//   * durable replay: a fresh process that opens the same file rebuilds the sequence counter and
//     the idempotency index from disk, so it continues with no gap and no reuse. That promise
//     covers the process killed MID-WRITE, which is the only way the file can be found torn — see
//     loadFromDisk for the three integrity rules that make a torn tail openable and a gap refused.
//
// SINGLE WRITER, ENFORCED BY NOTHING. The sequence counter lives in ONE sink object's memory, so
// two sink objects open on the same path assign the SAME sequence to two different events; there is
// no file lock and no cross-process coordination, and none is added deliberately (a lock would be a
// second, weaker claim about a design that already has exactly one writer). The design is: one Run,
// one process, one sink object, and each caller that constructs a sink says so at its construction
// site. The collision is demonstrated, not merely asserted, in
// vinci/test/worker-runtime-adapter-events.mjs; the file it leaves behind is refused by the next
// open, because duplicated sequences break the contiguity rule below.
//
// The file is append-only JSONL, one event object per line. `eventId`, `runId`, `workspaceId`,
// `type`, `payload` etc. are supplied by the caller; only `sequence` is assigned here.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname } from "node:path";

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Stable canonical encoding of a payload so the same logical payload always produces the same
// digest regardless of key order. Numbers/booleans/null/strings are JSON.stringify'd; objects are
// emitted with keys sorted; arrays keep order. Used for idempotency conflict detection.
function stableStringify(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "number" || type === "boolean") return String(value);
  if (type === "object" && !Array.isArray(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  return JSON.stringify(String(value));
}

function payloadDigest(payload) {
  return sha256Hex(stableStringify(payload ?? {}));
}

export const RUN_EVENTS_CORRUPT = "run_events_corrupt";
export const RUN_EVENTS_SEQUENCE_GAP = "run_events_sequence_gap";

function integrityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Complete or discard a write that never finished, so the file this reader then parses is
// well-formed JSONL. appendFileSync is not atomic: a process killed mid-append leaves a PREFIX of
// one record with no terminating newline. Two shapes, two repairs, and neither ever rewrites a line
// that was durably recorded:
//
//   * the tail parses as JSON — the record itself landed and only its "\n" did not. Terminate it.
//     Discarding it instead would be worse than useless: the bytes stay in the file, the next
//     append reuses its sequence, and the duplicate then fails the contiguity rule for good.
//   * the tail does not parse — a genuinely torn record. It was NEVER durably a record (no reader
//     ever took a sequence from it), so it is truncated away. Leaving it and appending after it
//     would manufacture exactly the malformed INTERIOR line the next rule refuses.
//
// Returns nothing; the caller re-reads the repaired file.
function repairTornTail(path) {
  const buffer = readFileSync(path);
  if (buffer.length === 0) return;
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === buffer.length - 1) return; // already terminated: nothing was torn
  const tail = buffer.subarray(lastNewline + 1).toString("utf8");
  if (!tail.trim()) return;
  let parsed = true;
  try {
    JSON.parse(tail);
  } catch {
    parsed = false;
  }
  if (parsed) appendFileSync(path, "\n", "utf8");
  else truncateSync(path, lastNewline + 1);
}

// Read every event already on disk so a fresh process picks up exactly where the last one stopped.
//
// Three integrity rules, all enforced here because this is the sink's ONLY reader:
//
//   1. A TORN FINAL LINE is repaired away before parsing (repairTornTail). The header promises that
//      a fresh process rebuilds its state from disk, and a process killed mid-write is exactly that
//      case; raising on the partial line made the file UNOPENABLE, which took the whole task down
//      rather than yielding a failed result.
//   2. A MALFORMED LINE THAT IS NOT THE LAST ONE is an integrity error (code run_events_corrupt),
//      naming the line. No append can produce one — each writes a whole record and its terminator
//      before the next begins — so a broken interior line means the file was edited, interleaved by
//      a second writer, or truncated in the middle. Continuing would silently drop records.
//   3. SEQUENCES MUST BE 1..N CONTIGUOUS IN FILE ORDER (code run_events_sequence_gap, naming the
//      FIRST missing sequence). Taking the maximum instead accepted a file holding 1 and 900 as a
//      run that had reached 900, and continued at 901 — a gap read as truth. ASSUMPTION: a gap
//      means the file is not this run's log (or has lost records), which is an integrity failure
//      rather than something to work around. It is also what makes the single-writer requirement
//      above self-reporting: two sinks on one path duplicate a sequence, and the duplicate fails
//      this rule on the next open.
function loadFromDisk(path) {
  let lastSequence = 0;
  const index = new Map();
  if (!path || !existsSync(path)) return { lastSequence, index };
  repairTornTail(path);
  const lines = readFileSync(path, "utf8").split("\n");
  let expected = 0;
  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
    const line = lines[lineNumber - 1];
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (cause) {
      throw integrityError(
        RUN_EVENTS_CORRUPT,
        `run-events file ${path} is corrupt: line ${lineNumber} of ${lines.length} is not JSON ` +
          `(${cause && cause.message ? cause.message : cause}). Only a TRAILING partial line is a torn ` +
          "write; a malformed line with records after it means the log lost or interleaved records.",
      );
    }
    expected += 1;
    const sequence = event && typeof event.sequence === "number" ? event.sequence : null;
    if (sequence !== expected) {
      throw integrityError(
        RUN_EVENTS_SEQUENCE_GAP,
        `run-events file ${path} is not contiguous from 1: line ${lineNumber} carries sequence ` +
          `${JSON.stringify(sequence)} where ${expected} was required, so the first missing sequence is ` +
          `${expected}. A gap means this file is not this run's log; it is not resumable.`,
      );
    }
    lastSequence = sequence;
    if (event && typeof event.idempotencyKey === "string" && event.idempotencyKey) {
      index.set(event.idempotencyKey, { sequence, digest: payloadDigest(event.payload) });
    }
  }
  return { lastSequence, index };
}

/**
 * Create (or reopen) an append-only JSONL run-event sink.
 *
 * SINGLE WRITER. The returned object owns the only sequence counter for `path`; a second sink
 * object on the same path assigns the same sequences (see the header). Callers must construct
 * exactly one per run-events file, and this constructor can THROW on a file whose integrity rules
 * are broken — so a caller that must not die on a bad log constructs it inside its own error
 * handling (run.mjs's embedded lane does).
 *
 * @param {string} path absolute path to the events file (e.g. `<stateDir>/run-events.jsonl`)
 * @returns {{ append(event): number, replay(): {lastSequence: number, keys: string[]}, close(): void }}
 * @throws {Error} code "run_events_corrupt" when a malformed line is not the trailing torn write
 * @throws {Error} code "run_events_sequence_gap" when the file's sequences are not 1..N contiguous
 */
export function createJsonlSink(path) {
  if (path) mkdirSync(dirname(path), { recursive: true });
  let { lastSequence, index } = loadFromDisk(path);

  function append(event) {
    if (!event || typeof event !== "object") throw new TypeError("append: event must be an object");
    const key = event.idempotencyKey;
    const digest = payloadDigest(event.payload);
    if (key) {
      const existing = index.get(key);
      if (existing) {
        if (existing.digest === digest) return existing.sequence;
        const error = new Error(`idempotency conflict for key ${key}`);
        error.code = "idempotency_conflict";
        throw error;
      }
    }
    const sequence = lastSequence + 1;
    lastSequence = sequence;
    const record = { ...event, sequence };
    if (path) appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    if (key) index.set(key, { sequence, digest });
    return sequence;
  }

  // Rebuild sequence/idempotency state from the file on disk, DISCARDING whatever this object held
  // in memory, and adopt it. This is what lets a resumed process prove continuity: replay() reports
  // the same lastSequence the previous process last durably wrote, and the next append is
  // lastSequence+1. Adopting (not merely reporting) matters when the sink object is behind the file
  // — a stale counter would re-issue sequence numbers that are already on disk, so `replay()` is the
  // step that keeps "contiguous, never reused" true across a process replacement.
  // A pathless (in-memory) sink has no disk to replay from: reporting zero is honest, but adopting
  // zero would silently rewind it, so adoption is confined to the file-backed case.
  function replay() {
    const state = loadFromDisk(path);
    if (path) {
      lastSequence = state.lastSequence;
      index = state.index;
    }
    return { lastSequence: state.lastSequence, keys: [...state.index.keys()] };
  }

  function close() {
    // Append-only: nothing to flush beyond the synchronous appendFileSync writes.
  }

  return { append, replay, close };
}
