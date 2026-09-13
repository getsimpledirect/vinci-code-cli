import { DEFAULT_OUTBOX_DIR, clearPending, recordPending } from "./outbox.mjs";

const LEDGER_REF = /^(?:job|exp|bk)_[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A terminal record says the task is OVER. The consumer keys human attention on
// `outcome !== "COMPLETED"`, so this field is load-bearing: it is what lets a failure be
// VISIBLE without being an open decision. Posting a terminal record without one is a hard
// error rather than a default, because an unclassified terminal that posts anyway is the
// same fail-open the typed outcome exists to remove.
// UNVERIFIED is finalState's DEFAULT fall-through -- "produced, unassessed" -- not an edge
// case, so leaving it untyped left the most COMMON non-success terminal with a null outcome
// and therefore invisible to a consumer that keys attention on `outcome !== "COMPLETED"`.
const TERMINAL_OUTCOMES = new Set(["COMPLETED", "FAILED", "BLOCKED", "REFUSED", "UNVERIFIED"]);
const WORKER_PRINCIPAL = /^worker:[A-Za-z0-9][A-Za-z0-9._-]{0,56}$/;
const SERVER_STRIP_EDGE = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
const SERVER_MAX_SUBJECT_CODE_POINTS = 200;
const SERVER_MAX_BODY_CODE_POINTS = 8_000;
const DEFAULT_IDENTITY_TIMEOUT_MS = 10_000;

export class WorkerIdentityRefusal extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "WorkerIdentityRefusal";
    this.code = code;
    this.refused = true;
  }
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function serverStrip(value) {
  return value.replace(SERVER_STRIP_EDGE, "");
}

function canonicalTerminalEntry(entry) {
  if (typeof entry?.subject !== "string") {
    throw new Error("terminal subject must be a non-empty string");
  }
  const subject = serverStrip(entry.subject);
  if (subject.length === 0) throw new Error("terminal subject must be a non-empty string");
  if ([...subject].length > SERVER_MAX_SUBJECT_CODE_POINTS) {
    throw new Error(`terminal subject must be <= ${SERVER_MAX_SUBJECT_CODE_POINTS} characters`);
  }
  if (entry.body !== null && entry.body !== undefined && typeof entry.body !== "string") {
    throw new Error("terminal body must be a string");
  }
  if (typeof entry.body === "string" && entry.body.length > 0 && [...entry.body].length > SERVER_MAX_BODY_CODE_POINTS) {
    throw new Error(`terminal body must be <= ${SERVER_MAX_BODY_CODE_POINTS} characters before canonical storage`);
  }
  return {
    ...entry,
    subject,
    body: typeof entry.body === "string" ? serverStrip(entry.body) : "",
  };
}

function isExactTerminalDelivery(message, entry, expectedPostedBy) {
  const options = entry.options ?? {};
  const expectedRefs = options.refs ?? [];
  return message.posted_by === expectedPostedBy
    && message.to_agent === null
    && message.kind === entry.kind
    && message.subject === entry.subject
    && message.body === entry.body
    && (message.outcome ?? null) === (options.outcome ?? null)
    && (message.in_reply_to ?? null) === (options.inReplyTo ?? null)
    && Array.isArray(message.refs)
    && sameStrings(message.refs, expectedRefs);
}

export function isLedgerRef(value) {
  return typeof value === "string" && LEDGER_REF.test(value);
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
  #authenticatedPostingPrincipal;
  #expectedPostingPrincipal;
  #token;

  constructor(
    serverUrl,
    token,
    pageSize = 100,
    outboxDir = null,
    expectedPostingPrincipal = null,
    identityTimeoutMs = DEFAULT_IDENTITY_TIMEOUT_MS,
  ) {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("server must use http or https");
    if (url.username || url.password) throw new Error("server URL must not contain credentials");
    if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error("bus page size must be a positive integer");
    this.serverUrl = url.href.replace(/\/$/, "");
    this.#token = token;
    this.pageSize = pageSize;
    if (
      expectedPostingPrincipal !== null
      && (typeof expectedPostingPrincipal !== "string" || !WORKER_PRINCIPAL.test(expectedPostingPrincipal))
    ) {
      throw new Error("expected posting principal must be a worker:<id> principal");
    }
    if (!Number.isInteger(identityTimeoutMs) || identityTimeoutMs <= 0) {
      throw new Error("worker identity timeout must be a positive integer");
    }
    // A configured expectation is not authenticated identity. Only the server's worker-only
    // identity endpoint can assign authenticatedPostingPrincipal.
    this.#expectedPostingPrincipal = expectedPostingPrincipal;
    this.identityTimeoutMs = identityTimeoutMs;
    this.#authenticatedPostingPrincipal = null;
    // Where undelivered terminal records are parked. Settable because the
    // worker keeps its durable state under --state-dir, and a default that
    // wrote to the process cwd would park records somewhere the replay at
    // startup does not read -- an outbox written to one place and replayed
    // from another is an inert fix that looks like a working one.
    this.outboxDir = outboxDir ?? DEFAULT_OUTBOX_DIR;
  }

  get authenticatedPostingPrincipal() {
    return this.#authenticatedPostingPrincipal;
  }

  get expectedPostingPrincipal() {
    return this.#expectedPostingPrincipal;
  }

  get token() {
    return this.#token;
  }

  async poll(workerId, cursor = null) {
    const messagesById = new Map();
    let offset = 0;
    while (true) {
      const url = new URL(`${this.serverUrl}/v1/messages`);
      url.searchParams.set("limit", String(this.pageSize));
      url.searchParams.set("offset", String(offset));
      const response = await fetch(url, { headers: { authorization: `Bearer ${this.#token}` } });
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

  // Establish which worker principal the server authenticated for this bearer. The endpoint is
  // worker-only and resolves the bearer at the server boundary; no client identity field is sent.
  // No terminal publication or replay is allowed until this exact value matches --id.
  async #requireAuthenticatedPostingPrincipal() {
    const expected = this.#expectedPostingPrincipal;
    this.#authenticatedPostingPrincipal = null;
    if (typeof expected !== "string") {
      throw new WorkerIdentityRefusal(
        "worker_identity_unconfigured",
        "worker principal authentication requires an expected worker:<id> principal",
      );
    }

    const url = `${this.serverUrl}/v1/worker-principal`;
    const token = this.#token;
    let response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.identityTimeoutMs),
      });
    } catch (error) {
      throw new WorkerIdentityRefusal(
        "worker_identity_unavailable",
        `worker identity GET ${url} failed: ${error.message}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch (error) {
        throw new WorkerIdentityRefusal(
          "worker_identity_unavailable",
          `worker identity GET ${url} failed while reading ${response.status}: ${error.message}`,
          { cause: error },
        );
      }
      throw new WorkerIdentityRefusal(
        response.status === 401 || response.status === 403
          ? "worker_identity_forbidden"
          : "worker_identity_unavailable",
        `worker identity GET ${url} failed: ${response.status} ${detail}`,
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new WorkerIdentityRefusal(
        "worker_identity_malformed",
        `worker identity GET ${url} returned invalid JSON: ${error.message}`,
        { cause: error },
      );
    }
    if (
      !payload
      || typeof payload !== "object"
      || Array.isArray(payload)
      || Object.keys(payload).length !== 1
      || !Object.hasOwn(payload, "worker_principal")
    ) {
      throw new WorkerIdentityRefusal(
        "worker_identity_malformed",
        "worker identity GET response must be exactly {worker_principal: string}",
      );
    }
    const principal = payload.worker_principal;
    if (typeof principal !== "string") {
      throw new WorkerIdentityRefusal(
        "worker_identity_malformed",
        "worker identity GET response must contain a string worker_principal",
      );
    }
    if (!WORKER_PRINCIPAL.test(principal)) {
      throw new WorkerIdentityRefusal(
        "worker_identity_malformed",
        `worker identity GET returned invalid worker principal ${principal}`,
      );
    }
    if (principal !== expected) {
      throw new WorkerIdentityRefusal(
        "worker_identity_mismatch",
        `worker bearer authenticates as ${principal}, but --id requires ${expected}`,
      );
    }
    this.#authenticatedPostingPrincipal = principal;
    return { principal, token };
  }

  async establishAuthenticatedPostingPrincipal() {
    return (await this.#requireAuthenticatedPostingPrincipal()).principal;
  }

  #configuredPrincipalForEntry(entry) {
    const configured = entry?.configured_worker_principal;
    if (typeof configured !== "string" || !WORKER_PRINCIPAL.test(configured)) {
      throw new WorkerIdentityRefusal(
        "worker_identity_outbox_unbound",
        "pending terminal record has no configured worker-principal binding",
      );
    }
    if (configured !== this.#expectedPostingPrincipal) {
      throw new WorkerIdentityRefusal(
        "worker_identity_outbox_mismatch",
        `pending terminal record belongs to ${configured}, configured worker is ${this.#expectedPostingPrincipal ?? "unbound"}`,
      );
    }
    if (entry?.expected_posted_by !== undefined && entry.expected_posted_by !== configured) {
      throw new WorkerIdentityRefusal(
        "worker_identity_outbox_mismatch",
        `pending terminal record has conflicting configured and authenticated principals (${configured} != ${entry.expected_posted_by})`,
      );
    }
    return configured;
  }

  // Classify whether the exact terminal effect represented by an outbox entry is already visible
  // on the bus. Every page is read before the caller is allowed to POST. A partial or shifting
  // offset scan is not evidence of absence, so response-shape, total, offset and duplicate-id
  // inconsistencies are hard errors; replay retains the entry and posts nothing on any such error.
  async findTerminalDeliveries(entry) {
    const expectedPostedBy = this.#configuredPrincipalForEntry(entry);
    const canonicalEntry = canonicalTerminalEntry(entry);
    const { token } = await this.#requireAuthenticatedPostingPrincipal();

    const messages = [];
    const messageIds = new Set();
    let expectedTotal = null;
    let offset = 0;
    while (true) {
      const url = new URL(`${this.serverUrl}/v1/messages`);
      url.searchParams.set("posted_by", expectedPostedBy);
      url.searchParams.set("kind", canonicalEntry.kind);
      url.searchParams.set("limit", String(this.pageSize));
      url.searchParams.set("offset", String(offset));
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`terminal reconciliation GET ${url} failed: ${response.status} ${await response.text()}`);
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error(`terminal reconciliation GET ${url} returned invalid JSON: ${error.message}`);
      }
      if (
        !payload
        || !Array.isArray(payload.messages)
        || !Number.isInteger(payload.total)
        || payload.total < 0
        || !Number.isInteger(payload.limit)
        || payload.limit !== this.pageSize
        || !Number.isInteger(payload.offset)
        || payload.offset !== offset
        || payload.messages.length > payload.limit
      ) {
        throw new Error("terminal reconciliation GET response has an invalid or incomplete pagination shape");
      }
      if (expectedTotal === null) expectedTotal = payload.total;
      else if (payload.total !== expectedTotal) {
        throw new Error(`terminal reconciliation GET total changed during pagination (${expectedTotal} -> ${payload.total})`);
      }

      for (const raw of payload.messages) {
        const message = normaliseMessage(raw);
        if (
          message === null
          || !Object.hasOwn(raw, "posted_by")
          || !Object.hasOwn(raw, "to_agent")
          || !Object.hasOwn(raw, "subject")
          || !Object.hasOwn(raw, "body")
          || !Object.hasOwn(raw, "outcome")
          || !Object.hasOwn(raw, "in_reply_to")
          || !Object.hasOwn(raw, "refs")
          || message.posted_by !== expectedPostedBy
          || message.kind !== canonicalEntry.kind
          || typeof message.subject !== "string"
          || typeof message.body !== "string"
          || !Array.isArray(message.refs)
          || message.refs.some((ref) => typeof ref !== "string")
          || (message.outcome !== null && message.outcome !== undefined && typeof message.outcome !== "string")
          || (message.in_reply_to !== null && message.in_reply_to !== undefined && typeof message.in_reply_to !== "string")
        ) {
          throw new Error("terminal reconciliation GET returned a malformed or filter-inconsistent message");
        }
        if (messageIds.has(message.message_id)) {
          throw new Error(`terminal reconciliation GET repeated message ${message.message_id}; pagination is incomplete`);
        }
        messageIds.add(message.message_id);
        messages.push(message);
      }

      offset += payload.messages.length;
      if (offset === expectedTotal) break;
      if (offset > expectedTotal || payload.messages.length === 0) {
        throw new Error(`terminal reconciliation GET ended at ${offset} of ${expectedTotal} messages`);
      }
    }

    if (messages.length !== expectedTotal) {
      throw new Error(`terminal reconciliation GET returned ${messages.length} unique messages for total ${expectedTotal}`);
    }
    return messages
      .filter((message) => isExactTerminalDelivery(message, canonicalEntry, expectedPostedBy))
      .map((message) => message.message_id);
  }

  async #post(kind, subject, body, options, token, postingPrincipal) {
    if (kind !== "status" && kind !== "finding" && kind !== "blocker") {
      throw new Error(`worker cannot post message kind ${kind}`);
    }
    if (options.outcome !== undefined && !TERMINAL_OUTCOMES.has(options.outcome)) {
      throw new Error(`worker outcome must be one of ${[...TERMINAL_OUTCOMES].join(", ")} (got ${options.outcome})`);
    }
    if (options.refs !== undefined && (!Array.isArray(options.refs) || options.refs.some((ref) => !isLedgerRef(ref)))) {
      throw new Error("worker refs must be job_, exp_, or bk_ ledger refs");
    }
    if (kind === "finding" && (!Array.isArray(options.refs) || options.refs.length === 0)) {
      throw new Error("finding messages require refs");
    }
    const url = `${this.serverUrl}/v1/messages`;
    const payload = { kind, subject, body };
    if (postingPrincipal !== null && this.#expectedPostingPrincipal === null) {
      payload.from_agent = postingPrincipal;
    }
    if (options.outcome !== undefined) payload.outcome = options.outcome;
    if (options.refs !== undefined) payload.refs = options.refs;
    if (options.inReplyTo !== undefined) payload.in_reply_to = options.inReplyTo;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    if (this.#expectedPostingPrincipal !== null) {
      // This is an opt-in, same-request server precondition. Its value comes only from the
      // configured worker binding: neither from_agent nor any prior identity discovery is
      // authorization for the POST that follows.
      headers["X-VGC-Expected-Worker-Principal"] = this.#expectedPostingPrincipal;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = await response.text();
      if (this.#expectedPostingPrincipal !== null && [401, 403, 412, 422].includes(response.status)) {
        const code = response.status === 412
          ? "worker_publication_precondition_refused"
          : response.status === 422
            ? "worker_publication_precondition_malformed"
            : "worker_publication_forbidden";
        throw new WorkerIdentityRefusal(code, `bound worker bus POST ${url} failed: ${response.status} ${detail}`);
      }
      throw new Error(`bus POST ${url} failed: ${response.status} ${detail}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  async post(kind, subject, body, options = {}) {
    return this.#post(kind, subject, body, options, this.#token, this.#authenticatedPostingPrincipal);
  }

  async deliverPendingTerminal(entry) {
    this.#configuredPrincipalForEntry(entry);
    if (!TERMINAL_OUTCOMES.has(entry?.options?.outcome)) {
      throw new Error(
        `a pending terminal record must carry a typed outcome (${[...TERMINAL_OUTCOMES].join(", ")}); got ${entry?.options?.outcome}`,
      );
    }
    const canonicalEntry = canonicalTerminalEntry(entry);
    const { principal, token } = await this.#requireAuthenticatedPostingPrincipal();
    return this.#post(
      canonicalEntry.kind,
      canonicalEntry.subject,
      canonicalEntry.body,
      canonicalEntry.options ?? {},
      token,
      principal,
    );
  }

  // The ONLY sanctioned way to announce that a task has ended. Requires the typed outcome, so a
  // terminal record cannot be posted without one by construction rather than by convention.
  async postTerminal(kind, subject, body, options = {}) {
    if (!TERMINAL_OUTCOMES.has(options.outcome)) {
      throw new Error(
        `a terminal record must carry a typed outcome (${[...TERMINAL_OUTCOMES].join(", ")}); got ${options.outcome}`,
      );
    }
    if (typeof this.#expectedPostingPrincipal !== "string") {
      throw new WorkerIdentityRefusal(
        "worker_identity_unconfigured",
        "terminal posts require a configured worker-principal binding",
      );
    }
    // RECORDED BEFORE THE ATTEMPT, cleared only after it succeeds or an exact
    // server-stamped delivery is reconciled. The worker transitions its
    // lifecycle to terminal and THEN announces it, and those two steps are not
    // atomic: without this, a transient bus failure left the task terminal and
    // unannounced, and a restart skipped it precisely because it was already
    // terminal. A typed terminal outcome exists so a failure is VISIBLE without
    // being an open decision -- undelivered, it is neither.
    const entry = {
      kind,
      subject,
      body,
      options,
      configured_worker_principal: this.#expectedPostingPrincipal,
    };
    const pendingId = recordPending(entry, this.outboxDir);
    const canonicalEntry = canonicalTerminalEntry(entry);
    const { principal, token } = await this.#requireAuthenticatedPostingPrincipal();
    const result = await this.#post(
      canonicalEntry.kind,
      canonicalEntry.subject,
      canonicalEntry.body,
      canonicalEntry.options,
      token,
      principal,
    );
    clearPending(pendingId, this.outboxDir);
    return result;
  }
}
