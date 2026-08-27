export class BusClient {
  constructor(serverUrl, token) {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("server must use http or https");
    if (url.username || url.password) throw new Error("server URL must not contain credentials");
    this.serverUrl = url.href.replace(/\/$/, "");
    this.token = token;
  }

  async poll(workerId, cursor = "") {
    const url = `${this.serverUrl}/v1/messages`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
    if (!response.ok) throw new Error(`bus GET ${url} failed: ${response.status} ${await response.text()}`);
    const payload = await response.json();
    const messages = Array.isArray(payload) ? payload : payload?.messages;
    if (!Array.isArray(messages)) throw new Error("bus GET response must be an array or contain messages");
    return messages
      .filter(
        (message) =>
          message?.kind === "handoff" &&
          message.to === `worker:${workerId}` &&
          String(message.id) > String(cursor),
      )
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  async post(kind, subject, body, options = {}) {
    if (kind !== "status" && kind !== "finding" && kind !== "blocker") {
      throw new Error(`worker cannot post message kind ${kind}`);
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
