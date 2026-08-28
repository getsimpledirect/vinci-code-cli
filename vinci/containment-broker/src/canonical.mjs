import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const RECEIPT_SCHEMA = "vinci.containment-broker.receipt/v3";

function normalize(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical values require finite numbers");
    return value;
  }
  if (Buffer.isBuffer(value)) return { "$bytes_base64": value.toString("base64") };
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("canonical values must not contain cycles");
    seen.add(value);
    const output = value.map((item) => normalize(item, seen));
    seen.delete(value);
    return output;
  }
  if (typeof value !== "object") throw new TypeError(`unsupported canonical value: ${typeof value}`);
  if (seen.has(value)) throw new TypeError("canonical values must not contain cycles");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("canonical values must contain only plain objects");
  }
  seen.add(value);
  const output = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError(`undefined canonical field: ${key}`);
    output[key] = normalize(value[key], seen);
  }
  seen.delete(value);
  return output;
}

export function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(normalize(value, new Set())), "utf8");
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : canonicalBytes(value);
  return createHash("sha256").update(bytes).digest("hex");
}

function requireKey(key) {
  if (!Buffer.isBuffer(key) || key.length < 32) {
    throw new TypeError("receipt authentication key must be at least 32 bytes");
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function authenticateReceipt({ kind, keyId, key, payload }) {
  if (!/^[a-z][a-z0-9_.-]{2,63}$/.test(kind)) throw new TypeError("invalid receipt kind");
  if (!/^[A-Za-z0-9_.:-]{3,128}$/.test(keyId)) throw new TypeError("invalid receipt key id");
  requireKey(key);
  const body = {
    schema: RECEIPT_SCHEMA,
    kind,
    key_id: keyId,
    payload: normalize(payload, new Set()),
  };
  const bodyBytes = canonicalBytes(body);
  return deepFreeze({
    ...body,
    body_sha256: sha256(bodyBytes),
    authentication: Object.freeze({
      algorithm: "hmac-sha256",
      mac: createHmac("sha256", key).update(bodyBytes).digest("hex"),
    }),
  });
}

export function verifyReceipt(receipt, { kind, keyId, key }) {
  requireKey(key);
  const receiptKeys = ["authentication", "body_sha256", "key_id", "kind", "payload", "schema"];
  if (!receipt || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(receiptKeys)
    || JSON.stringify(Object.keys(receipt.authentication ?? {}).sort()) !== JSON.stringify(["algorithm", "mac"])) {
    return false;
  }
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA || receipt.kind !== kind || receipt.key_id !== keyId) {
    return false;
  }
  if (receipt.authentication?.algorithm !== "hmac-sha256") return false;
  const body = {
    schema: receipt.schema,
    kind: receipt.kind,
    key_id: receipt.key_id,
    payload: receipt.payload,
  };
  const bodyBytes = canonicalBytes(body);
  if (receipt.body_sha256 !== sha256(bodyBytes)) return false;
  const expected = createHmac("sha256", key).update(bodyBytes).digest();
  let actual;
  try {
    if (!/^[0-9a-f]{64}$/.test(receipt.authentication.mac ?? "")) return false;
    actual = Buffer.from(receipt.authentication.mac, "hex");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
