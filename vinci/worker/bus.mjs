const LEDGER_REF = /^(?:job|exp|bk)_[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isLedgerRef(value) {
  return typeof value === "string" && LEDGER_REF.test(value);
}

function assertMessage(message) {
  if (
    !message ||
    typeof message.message_id !== "string" ||
    (message.to_agent !== null && typeof message.to_agent !== "string") ||
    typeof message.kind !== "string" ||
    typeof message.subject !== "string" ||
    typeof message.body !== "string" ||
    typeof message.ts !== "string" ||
    Number.isNaN(Date.parse(message.ts)) ||
    typeof message.posted_by !== "string"
  ) {
    throw new Error("bus GET response contains an invalid message row");
  }
}

export class BusClient {
  constructor(serverUrl, token, pageSize = 100) {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("server must use http or https");
    if (url.username || url.password) throw new Error("server URL must not contain credentials");
    if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error("bus page size must be a positive integer");
    this.serverUrl = url.href.replace(/\/$/, "");
    this.token = token;
    this.pageSize = pageSize;
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
      for (const message of payload.messages) {
        assertMessage(message);
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
        if (message.to_agent !== null && message.to_agent !== workerId) return false;
        if (cursorTs === null || message.ts > cursorTs) return true;
        return message.ts === cursorTs && !seenAtCursor.has(message.message_id);
      })
      .sort((left, right) => left.ts.localeCompare(right.ts) || left.message_id.localeCompare(right.message_id));
  }

  async post(kind, subject, body, options = {}) {
    if (kind !== "status" && kind !== "finding" && kind !== "blocker") {
      throw new Error(`worker cannot post message kind ${kind}`);
    }
    if (options.refs !== undefined && (!Array.isArray(options.refs) || options.refs.some((ref) => !isLedgerRef(ref)))) {
      throw new Error("worker refs must be job_, exp_, or bk_ ledger refs");
    }
    if (kind === "finding" && (!Array.isArray(options.refs) || options.refs.length === 0)) {
      throw new Error("finding messages require refs");
    }
    const url = `${this.serverUrl}/v1/messages`;
    const payload = { kind, subject, body };
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
}
