import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { canonicalBytes, sha256 } from "./canonical.mjs";

export const EPISODE_STATES = Object.freeze([
  "ALLOCATING",
  "OPEN",
  "LAUNCH_ARMED",
  "TASK_CREATED",
  "PRELAUNCH_COMMITTED",
  "RELEASE_ARMED",
  "RUNNING",
  "CLOSING",
  "ZEROED",
  "CAPTURE_SEALED",
  "SEALED",
  "UNCONTAINED",
]);

const NEXT_STATE = Object.freeze({
  ALLOCATING: "OPEN",
  OPEN: "LAUNCH_ARMED",
  LAUNCH_ARMED: "TASK_CREATED",
  TASK_CREATED: "PRELAUNCH_COMMITTED",
  PRELAUNCH_COMMITTED: "RELEASE_ARMED",
  RELEASE_ARMED: "RUNNING",
  RUNNING: "CLOSING",
  CLOSING: "ZEROED",
  ZEROED: "CAPTURE_SEALED",
  CAPTURE_SEALED: "SEALED",
});

export class JournalError extends Error {
  constructor(message, code = "JOURNAL_INVALID") {
    super(message);
    this.code = code;
  }
}

function validateId(episodeId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(episodeId)) {
    throw new JournalError("invalid episode id", "EPISODE_ID_INVALID");
  }
}

function directoryFlags() {
  return constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
}

function fsyncDirectory(path) {
  const fd = openSync(path, directoryFlags());
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new JournalError("short journal write", "JOURNAL_SHORT_WRITE");
    offset += written;
  }
}

function validUtcTime(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function parseRecords(bytes, episodeId) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new JournalError("torn journal tail", "JOURNAL_TORN");
  const records = [];
  let predecessor = null;
  let identityDigest = null;
  for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new JournalError(`invalid journal JSON at record ${index + 1}`, "JOURNAL_CORRUPT");
    }
    const expectedKeys = [
      "episode_id",
      "identity_digest",
      "payload",
      "predecessor_digest",
      "record_digest",
      "recorded_at",
      "schema",
      "sequence",
      "state",
    ];
    if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)) {
      throw new JournalError(`journal field set mismatch at ${index + 1}`, "JOURNAL_CORRUPT");
    }
    if (canonicalBytes(record).toString("utf8") !== line) {
      throw new JournalError(`non-canonical journal record at ${index + 1}`, "JOURNAL_CORRUPT");
    }
    const { record_digest: actual, ...unsigned } = record;
    const expected = sha256(unsigned);
    if (actual !== expected) throw new JournalError(`record digest mismatch at ${index + 1}`, "JOURNAL_CORRUPT");
    if (record.schema !== "vinci.containment-broker.journal/v3") throw new JournalError("journal schema mismatch");
    if (!validUtcTime(record.recorded_at)) {
      throw new JournalError("journal UTC time invalid", "JOURNAL_CORRUPT");
    }
    if (record.episode_id !== episodeId || record.sequence !== index + 1) throw new JournalError("forked journal sequence");
    if (record.predecessor_digest !== predecessor) throw new JournalError("journal predecessor mismatch");
    if (!EPISODE_STATES.includes(record.state)) throw new JournalError("unknown journal state");
    if (index === 0) identityDigest = record.identity_digest;
    if (!identityDigest || record.identity_digest !== identityDigest) throw new JournalError("journal identity fork");
    records.push(Object.freeze(record));
    predecessor = actual;
  }
  if (records.length === 0) throw new JournalError("empty journal");
  return records;
}

export class EpisodeJournal {
  static create({ rootDir, episodeId, identity, clock = () => new Date().toISOString() }) {
    validateId(episodeId);
    const rootStat = lstatSync(rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new JournalError("state root must be a non-symlink directory");
    const episodeDir = join(rootDir, episodeId);
    mkdirSync(episodeDir, { mode: 0o700 });
    fsyncDirectory(rootDir);
    const journalPath = join(episodeDir, "journal.jsonl");
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    const fd = openSync(journalPath, flags, 0o600);
    const journal = new EpisodeJournal({
      rootDir,
      episodeDir,
      journalPath,
      episodeId,
      fd,
      clock,
      records: [],
      identityDigest: sha256(identity),
    });
    journal.#appendUnchecked("ALLOCATING", { identity, launch_armed: false, tombstone: true });
    return journal;
  }

  static inspect({ rootDir, episodeId }) {
    validateId(episodeId);
    const journalPath = join(rootDir, episodeId, "journal.jsonl");
    return parseRecords(readFileSync(journalPath), episodeId);
  }

  static recoverToUncontained({ rootDir, episodeId, reason, cleanup = null, clock = () => new Date().toISOString() }) {
    validateId(episodeId);
    const episodeDir = join(rootDir, episodeId);
    const journalPath = join(episodeDir, "journal.jsonl");
    let records;
    try {
      records = parseRecords(readFileSync(journalPath), episodeId);
    } catch (error) {
      const tombstone = {
        schema: "vinci.containment-broker.recovery-tombstone/v3",
        episode_id: episodeId,
        state: "UNCONTAINED",
        reason: `journal_ambiguity:${error.code ?? "unknown"}`,
        cleanup,
        trusted_output: false,
        authority: false,
        observed_at: clock(),
      };
      const target = join(episodeDir, "UNCONTAINED.json");
      if (existsSync(target)) {
        const existing = JSON.parse(readFileSync(target, "utf8"));
        if (existing?.schema !== tombstone.schema || existing?.episode_id !== episodeId
          || existing?.state !== "UNCONTAINED" || existing?.authority !== false
          || existing?.trusted_output !== false) {
          throw new JournalError("existing recovery tombstone is invalid", "RECOVERY_TOMBSTONE_INVALID");
        }
        return Object.freeze(existing);
      }
      writeFileSync(target, canonicalBytes(tombstone), { flag: "wx", mode: 0o600 });
      const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(episodeDir);
      return Object.freeze(tombstone);
    }
    const current = records.at(-1);
    if (current.state === "SEALED" || current.state === "UNCONTAINED") return current;
    const fd = openSync(journalPath, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    const journal = new EpisodeJournal({
      rootDir,
      episodeDir,
      journalPath,
      episodeId,
      fd,
      clock,
      records,
      identityDigest: records[0].identity_digest,
    });
    try {
      return journal.markUncontained(reason, { cleanup, recovered_after_restart: true, descriptor_continuity: false });
    } finally {
      journal.close();
    }
  }

  constructor({ rootDir, episodeDir, journalPath, episodeId, fd, clock, records, identityDigest }) {
    this.rootDir = rootDir;
    this.episodeDir = episodeDir;
    this.journalPath = journalPath;
    this.episodeId = episodeId;
    this.fd = fd;
    this.clock = clock;
    this.records = records;
    this.identityDigest = identityDigest;
    this.closed = false;
    this.faulted = false;
  }

  current() {
    return this.records.at(-1);
  }

  transition(nextState, payload) {
    if (this.closed || this.faulted) throw new JournalError("journal is closed or faulted", "JOURNAL_FAULTED");
    const current = this.current();
    if (current.state === "SEALED" || current.state === "UNCONTAINED") {
      throw new JournalError(`${current.state} is absorbing`, "JOURNAL_ABSORBING");
    }
    if (nextState !== "UNCONTAINED" && NEXT_STATE[current.state] !== nextState) {
      throw new JournalError(`invalid transition ${current.state} -> ${nextState}`, "JOURNAL_TRANSITION");
    }
    return this.#appendUnchecked(nextState, payload);
  }

  markUncontained(reason, detail = {}) {
    if (!reason || typeof reason !== "string") throw new JournalError("UNCONTAINED requires a reason");
    return this.transition("UNCONTAINED", {
      reason,
      ...detail,
      trusted_output: false,
      authority: false,
    });
  }

  close() {
    if (!this.closed) closeSync(this.fd);
    this.closed = true;
  }

  #appendUnchecked(state, payload) {
    const previous = this.records.at(-1) ?? null;
    const unsigned = {
      schema: "vinci.containment-broker.journal/v3",
      episode_id: this.episodeId,
      identity_digest: this.identityDigest,
      sequence: this.records.length + 1,
      predecessor_digest: previous?.record_digest ?? null,
      state,
      recorded_at: this.clock(),
      payload,
    };
    const record = Object.freeze({ ...unsigned, record_digest: sha256(unsigned) });
    try {
      writeAll(this.fd, Buffer.concat([canonicalBytes(record), Buffer.from("\n")]));
      fsyncSync(this.fd);
      fsyncDirectory(this.episodeDir);
    } catch (cause) {
      this.faulted = true;
      try {
        this.close();
      } catch {
        this.closed = true;
      }
      throw new JournalError(`journal durability ambiguity: ${cause.message}`, "JOURNAL_DURABILITY_AMBIGUOUS");
    }
    this.records.push(record);
    return record;
  }
}

export function episodeExists(rootDir, episodeId) {
  validateId(episodeId);
  return existsSync(join(rootDir, episodeId));
}
