// A terminal record that was never delivered is a failure that became invisible.
//
// The worker transitions its lifecycle to a terminal state and THEN announces it
// on the bus. Those two steps are not atomic, and nothing caught a throw between
// them: a transient network failure meant the state was terminal and the
// announcement never happened. On restart the task is terminal and is skipped,
// so the record is lost permanently -- and the whole point of typed terminal
// outcomes (#44) is that a failure stays VISIBLE without becoming an open
// decision. Undelivered, it is neither.
//
// This is the durable half. A terminal record is written to disk BEFORE the post
// is attempted and removed only after it succeeds, so anything left on disk is
// by definition undelivered and is replayed at startup.
//
// WHY AT postTerminal AND NOT AT THE CALL SITES: there are eleven terminal post
// sites in worker.mjs and there will be more. Wrapping the single choke point
// covers them by construction, which is the same reason postTerminal exists at
// all rather than a convention that every site must pass an outcome.
//
// DELIBERATELY NOT A RETRY LOOP IN-PROCESS. A worker whose bus is unreachable
// should not spin against it while holding a lease; it should record the debt
// and let the next start settle it. Retrying in-process also cannot survive the
// case this exists for, which is the process dying.
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const DEFAULT_OUTBOX_DIR =
  process.env.VINCI_WORKER_OUTBOX || join(process.cwd(), ".vinci-worker-outbox");

export function recordPending(entry, dir = DEFAULT_OUTBOX_DIR) {
  mkdirSync(dir, { recursive: true });
  // Time-ordered id so replay runs oldest-first without parsing contents.
  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const tmp = join(dir, `.${id}.tmp`);
  const final = join(dir, `${id}.json`);
  // Write-then-rename: a crash mid-write must not leave a half-parsed record
  // that replay would either skip silently or die on.
  writeFileSync(tmp, JSON.stringify({ id, recorded_at: new Date().toISOString(), ...entry }));
  renameSync(tmp, final);
  return id;
}

export function clearPending(id, dir = DEFAULT_OUTBOX_DIR) {
  const path = join(dir, `${id}.json`);
  if (existsSync(path)) rmSync(path);
}

export function listPending(dir = DEFAULT_OUTBOX_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      try {
        return { path, entry: JSON.parse(readFileSync(path, "utf8")) };
      } catch {
        // A corrupt record is REPORTED, never silently dropped: a record we
        // cannot read is still evidence that something terminal went
        // unannounced, and deleting it would destroy that evidence.
        return { path, entry: null, corrupt: true };
      }
    });
}

// Replay every undelivered terminal record. Returns a summary rather than
// throwing: a bus that is still unreachable must not stop the worker from
// starting, and the records stay on disk for the next attempt.
export async function replayPending(bus, dir = DEFAULT_OUTBOX_DIR, log = console) {
  const pending = listPending(dir);
  const summary = { attempted: 0, delivered: 0, failed: 0, corrupt: 0 };
  for (const { path, entry, corrupt } of pending) {
    if (corrupt || !entry) {
      summary.corrupt += 1;
      log.error(`worker outbox: UNREADABLE undelivered terminal record at ${path} -- a task ended and its announcement cannot be reconstructed`);
      continue;
    }
    summary.attempted += 1;
    try {
      await bus.post(entry.kind, entry.subject, entry.body, entry.options ?? {});
      rmSync(path);
      summary.delivered += 1;
      log.warn(`worker outbox: replayed undelivered terminal record ${entry.id} (${entry.options?.outcome})`);
    } catch (error) {
      summary.failed += 1;
      log.error(`worker outbox: replay FAILED for ${entry.id}, kept on disk: ${error.message}`);
    }
  }
  return summary;
}
