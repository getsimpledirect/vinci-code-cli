// IR-02 embedded runtime: durable append-only JSONL event sink for a single Run.
//
// The embedded adapter (runtime-adapter.mjs) translates native agent-session events into the
// Vinci run-event vocabulary and writes them here. The sink owns three guarantees the run-event
// contract needs:
//
//   * per-run CONTIGUOUS, 1-based `sequence`, assigned here on append;
//   * `idempotencyKey` dedupe: re-appending the same key with the SAME payload digest is a no-op
//     that returns the already-assigned sequence; the same key with a DIFFERENT payload is an
//     `idempotency_conflict` error and appends nothing;
//   * durable replay: a fresh process that opens the same file rebuilds the sequence counter and
//     the idempotency index from disk, so it continues with no gap and no reuse.
//
// The file is append-only JSONL, one event object per line. `eventId`, `runId`, `workspaceId`,
// `type`, `payload` etc. are supplied by the caller; only `sequence` is assigned here.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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

// Read every event already on disk so a fresh process picks up exactly where the last one stopped.
function loadFromDisk(path) {
  let lastSequence = 0;
  const index = new Map();
  if (!path || !existsSync(path)) return { lastSequence, index };
  const lines = readFileSync(path, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    const sequence = event && typeof event.sequence === "number" ? event.sequence : 0;
    if (sequence > lastSequence) lastSequence = sequence;
    if (event && typeof event.idempotencyKey === "string" && event.idempotencyKey) {
      index.set(event.idempotencyKey, { sequence, digest: payloadDigest(event.payload) });
    }
  }
  return { lastSequence, index };
}

/**
 * Create (or reopen) an append-only JSONL run-event sink.
 *
 * @param {string} path absolute path to the events file (e.g. `<stateDir>/run-events.jsonl`)
 * @returns {{ append(event): number, replay(): {lastSequence: number, keys: string[]}, close(): void }}
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
