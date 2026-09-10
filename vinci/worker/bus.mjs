import { DEFAULT_OUTBOX_DIR, clearPending, recordPending } from "./outbox.mjs";

const LEDGER_REF = /^(?:job|exp|bk)_[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Option 1 of vinci-gpu-control#295: a WorkOrder remains the canonical identity. `wo-` is
// therefore an evidence/message ref only after the caller has resolved it from a validated
// contract. This predicate is syntax only; existence and program binding stay server-side.
const WORK_ORDER_EVIDENCE_REF = /^wo-[A-Za-z0-9][A-Za-z0-9._:-]{0,124}$/;

// A terminal record says the task is OVER. The consumer keys human attention on
// `outcome !== "COMPLETED"`, so this field is load-bearing: it is what lets a failure be
// VISIBLE without being an open decision. Posting a terminal record without one is a hard
// error rather than a default, because an unclassified terminal that posts anyway is the
// same fail-open the typed outcome exists to remove.
// UNVERIFIED is finalState's DEFAULT fall-through -- "produced, unassessed" -- not an edge
// case, so leaving it untyped left the most COMMON non-success terminal with a null outcome
// and therefore invisible to a consumer that keys attention on `outcome !== "COMPLETED"`.
const TERMINAL_OUTCOMES = new Set(["COMPLETED", "FAILED", "BLOCKED", "REFUSED", "UNVERIFIED"]);

export function isLedgerRef(value) {
  return typeof value === "string" && LEDGER_REF.test(value);
}

export function isWorkOrderEvidenceRef(value) {
  return typeof value === "string" && WORK_ORDER_EVIDENCE_REF.test(value);
}

export function isEvidenceRef(value) {
  return isLedgerRef(value) || isWorkOrderEvidenceRef(value);
}

// Production rows are not all shaped like the fixtures: rows older than the server-recorded
// `posted_by` (bus PR #70) carry null there, and `body` can be null. Tolerate nulls for
// optional text; reject only rows that cannot be routed (no id, no kind, no ts, or a
// non-string to_agent). Returns the normalised row, or null for an unusable one — the caller
// skips it and logs once per id, so one malformed row can never stall the whole poll
// (measured on the first live start: one bad row of 100 made every poll exit 1).
const warnedRows = new Set();

export function normaliseMessage(message) {
  if (
    !message ||
    typeof message.message_id !== "string" ||
    (message.to_agent !== null && message.to_agent !== undefined && typeof message.to_agent !== "string") ||
    typeof message.kind !== "string" ||
    typeof message.ts !== "string" ||
    Number.isNaN(Date.parse(message.ts))
  ) {
    return null;
  }
  return {
    ...message,
    to_agent: message.to_agent ?? null,
    subject: typeof message.subject === "string" ? message.subject : "",
    body: typeof message.body === "string" ? message.body : "",
    posted_by: typeof message.posted_by === "string" ? message.posted_by : "",
  };
}

export class BusClient {
  constructor(serverUrl, token, pageSize = 100, outboxDir = null) {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("server must use http or https");
    if (url.username || url.password) throw new Error("server URL must not contain credentials");
    if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error("bus page size must be a positive integer");
    this.serverUrl = url.href.replace(/\/$/, "");
    this.token = token;
    this.pageSize = pageSize;
    // Where undelivered terminal records are parked. Settable because the
    // worker keeps its durable state under --state-dir, and a default that
    // wrote to the process cwd would park records somewhere the replay at
    // startup does not read -- an outbox written to one place and replayed
    // from another is an inert fix that looks like a working one.
    this.outboxDir = outboxDir ?? DEFAULT_OUTBOX_DIR;
  }

  async poll(workerId, cursor = null) {
    const messagesById = new Map();
    let offset = 0;
    while (true) {
      const url = new URL(`${this.serverUrl}/v1/messages`);
      url.searchParams.set("limit", String(this.pageSize));
      url.searchParams.set("offset", String(offset));
      const response = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
      if (!response.ok) throw new Error(`bus GET ${url} failed: ${response.status} ${await response.text()}`);
      const payload = await response.json();
      if (
        !payload ||
        !Array.isArray(payload.messages) ||
        !Number.isInteger(payload.total) ||
        !Number.isInteger(payload.limit) ||
        !Number.isInteger(payload.offset)
      ) {
        throw new Error("bus GET response must contain messages, total, limit, and offset");
      }
      for (const raw of payload.messages) {
        const message = normaliseMessage(raw);
        if (message === null) {
          const key = raw && typeof raw.message_id === "string" ? raw.message_id : "<no id>";
          if (!warnedRows.has(key)) {
            warnedRows.add(key);
            console.error(`vinci worker: skipping unroutable bus row ${key}`);
          }
          continue;
        }
        messagesById.set(message.message_id, message);
      }
      offset += payload.messages.length;
      if (offset >= payload.total) break;
      if (payload.messages.length === 0) throw new Error("bus GET pagination ended before total messages were returned");
    }

    const cursorTs = typeof cursor?.ts === "string" ? cursor.ts : null;
    const seenAtCursor = new Set(Array.isArray(cursor?.message_ids) ? cursor.message_ids : []);
    return [...messagesById.values()]
      .filter((message) => {
        if (message.kind !== "handoff") return false;
        // Only handoffs ADDRESSED to this worker. A broadcast handoff (to_agent null) is not a
        // task for every worker that can see it: on the first live start the daemon claimed 56
        // historical broadcasts and posted a blocker for each (2026-08-27 11:16Z).
        // The bus principal is `worker:<id>`; --id is the bare id. Match the principal, not the
        // bare id (the first live run matched nothing: to_agent "worker:box-1" vs "box-1").
        if (message.to_agent !== `worker:${workerId}`) return false;
        if (cursorTs === null || message.ts > cursorTs) return true;
        return message.ts === cursorTs && !seenAtCursor.has(message.message_id);
      })
      .sort((left, right) => left.ts.localeCompare(right.ts) || left.message_id.localeCompare(right.message_id));
  }

  async post(kind, subject, body, options = {}) {
    if (kind !== "status" && kind !== "finding" && kind !== "blocker") {
      throw new Error(`worker cannot post message kind ${kind}`);
    }
    if (options.outcome !== undefined && !TERMINAL_OUTCOMES.has(options.outcome)) {
      throw new Error(`worker outcome must be one of ${[...TERMINAL_OUTCOMES].join(", ")} (got ${options.outcome})`);
    }
    if (options.refs !== undefined && (!Array.isArray(options.refs) || options.refs.some((ref) => !isEvidenceRef(ref)))) {
      throw new Error("worker refs must be job_, exp_, bk_, or validated wo- evidence refs");
    }
    if (kind === "finding" && (!Array.isArray(options.refs) || options.refs.length === 0)) {
      throw new Error("finding messages require refs");
    }
    const url = `${this.serverUrl}/v1/messages`;
    const payload = { kind, subject, body };
    if (options.outcome !== undefined) payload.outcome = options.outcome;
    if (options.refs !== undefined) payload.refs = options.refs;
    if (options.inReplyTo !== undefined) payload.in_reply_to = options.inReplyTo;
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`bus POST ${url} failed: ${response.status} ${await response.text()}`);
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  // The ONLY sanctioned way to announce that a task has ended. Requires the typed outcome, so a
  // terminal record cannot be posted without one by construction rather than by convention.
  async postTerminal(kind, subject, body, options = {}) {
    if (!TERMINAL_OUTCOMES.has(options.outcome)) {
      throw new Error(
        `a terminal record must carry a typed outcome (${[...TERMINAL_OUTCOMES].join(", ")}); got ${options.outcome}`,
      );
    }
    // RECORDED BEFORE THE ATTEMPT, cleared only after it succeeds, so anything
    // left on disk is by definition undelivered. The worker transitions its
    // lifecycle to terminal and THEN announces it, and those two steps are not
    // atomic: without this, a transient bus failure left the task terminal and
    // unannounced, and a restart skipped it precisely because it was already
    // terminal. A typed terminal outcome exists so a failure is VISIBLE without
    // being an open decision -- undelivered, it is neither.
    const pendingId = recordPending({ kind, subject, body, options }, this.outboxDir);
    const result = await this.post(kind, subject, body, options);
    clearPending(pendingId, this.outboxDir);
    return result;
  }
}
