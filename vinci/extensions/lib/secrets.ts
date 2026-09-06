import { randomBytes } from "node:crypto";
import { vinciMaskSecrets } from "@earendil-works/pi-coding-agent";

const MODEL_SECRET = "<vinci-secret>";
const MODEL_PRIVATE_KEY = "<vinci-private-key>";

const renderForModel = (_value: string, kind: "secret" | "private-key"): string =>
  kind === "private-key" ? MODEL_PRIVATE_KEY : MODEL_SECRET;

export function redactSecrets(text: string): string {
  return vinciMaskSecrets(text, { render: renderForModel });
}

export function redactSecretsDeep(value: unknown, propertyName = ""): unknown {
  if (typeof value === "string") {
    return vinciMaskSecrets(value, { propertyName, render: renderForModel });
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    if (!propertyName || value === null || value === undefined) return value;
    const source = String(value);
    const masked = vinciMaskSecrets(source, { propertyName, render: renderForModel });
    return masked === source ? value : masked;
  }
  if (Array.isArray(value)) return value.map((entry) => redactSecretsDeep(entry));
  if (typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) redacted[key] = redactSecretsDeep(entry, key);
    return redacted;
  }
  return value;
}

// ── The user's own credentials: vaulted, not merely erased ───────────────────────────────────────
// A secret Vinci found by READING something — a .env, a diff, tool output — is redacted and stays
// redacted. The model has no business round-tripping a value it only saw because it opened the
// user's file, so those keep the bare `<vinci-secret>` and nothing can turn one back into a value.
//
// A secret the USER TYPED is a different object. They typed it so that Vinci would USE it, and
// erasing it to the same bare sentinel is what produced the reported defect: the model shipped the
// literal string `<vinci-secret>` to a real endpoint and got a 401 that reads as a broken API rather
// than a masked view. So user input mints a HANDLE — `<vinci-secret-a1b2c3d4>` — instead. The model
// still never sees the value; it sees a name it can carry around, and the shell channel swaps the
// value back in at the moment of execution (vinci-guard, bash only).
//
// The vault is per-process and never written to disk. Handles are random, not derived from the
// value: deriving them would make a handle a verifiable oracle for a low-entropy secret.
//
// The id is joined with `-`, not `:`. A colon put the substring `secret:` inside the sentinel, which
// the masker's own assignment matcher reads as a secret assignment — it then masked the id, nesting
// one sentinel inside another and destroying the handle on the very next redaction pass.
const HANDLE_BODY = String.raw`<vinci-(?:secret|private-key)-([0-9a-f]{8})>`;

/** Fresh matcher per call — a shared /g regex carries lastIndex between callers. */
const handleMatcher = (): RegExp => new RegExp(HANDLE_BODY, "g");

/** True when the text carries at least one handle. */
export function hasSecretHandle(text: string): boolean {
  return new RegExp(HANDLE_BODY).test(text);
}

// A session that mints handles without bound is a session leaking memory on a hostile paste. Past
// the cap, user input degrades to exactly the old behaviour — a bare sentinel, which the shell guard
// refuses — rather than to a handle that silently resolves to the wrong secret.
const MAX_VAULTED_SECRETS = 256;

const valueByHandleId = new Map<string, string>();
const handleByValue = new Map<string, string>();

function mintHandle(value: string, kind: "secret" | "private-key"): string {
  const existing = handleByValue.get(value);
  if (existing) return existing;
  if (valueByHandleId.size >= MAX_VAULTED_SECRETS) return renderForModel(value, kind);

  let id = randomBytes(4).toString("hex");
  while (valueByHandleId.has(id)) id = randomBytes(4).toString("hex");

  const handle = `<vinci-${kind === "private-key" ? "private-key" : "secret"}-${id}>`;
  valueByHandleId.set(id, value);
  handleByValue.set(value, handle);
  return handle;
}

/**
 * Redact the user's own input, minting a rehydratable handle for each secret. Use this ONLY for text
 * the user themselves typed — everything Vinci reads goes through {@link redactSecrets}.
 */
export function redactUserInput(text: string): string {
  return vinciMaskSecrets(text, { render: mintHandle });
}

export interface Rehydration {
  /** The text with every live handle replaced by the value it stands for. */
  text: string;
  /** Handles that resolved, as they appeared in the text. Safe to show: they carry no value. */
  resolved: string[];
  /** Handles with no entry in this session's vault — stale, or invented by the model. */
  unresolved: string[];
}

/** Swap live handles back to the values the user supplied. */
export function rehydrateSecrets(text: string): Rehydration {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const rehydrated = text.replace(handleMatcher(), (handle: string, id: string) => {
    const value = valueByHandleId.get(id);
    if (value === undefined) {
      unresolved.push(handle);
      return handle;
    }
    resolved.push(handle);
    return value;
  });
  return { text: rehydrated, resolved, unresolved };
}

/** Drop every vaulted secret. The vault is scoped to one session and must not outlive it. */
export function resetSecretVault(): void {
  valueByHandleId.clear();
  handleByValue.clear();
}
