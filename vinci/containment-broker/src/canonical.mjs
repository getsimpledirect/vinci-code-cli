import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const RECEIPT_SCHEMA = "vinci.containment-broker.receipt/v3";

const RESERVED_BYTES_FIELD = "$bytes_base64";

function plainObjectEntries(value) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("canonical values must contain only plain objects");
  }
  if (RESERVED_BYTES_FIELD in value) {
    throw new TypeError(`reserved canonical field: ${RESERVED_BYTES_FIELD}`);
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`inherited canonical field: ${key}`);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("symbol canonical fields are not supported");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) throw new TypeError(`non-enumerable canonical field: ${key}`);
    if (!("value" in descriptor)) throw new TypeError(`accessor canonical field: ${key}`);
    entries.push([key, descriptor.value]);
  }
  return entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

function denseArrayValues(value) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("canonical values must contain only plain arrays");
  }
  if (RESERVED_BYTES_FIELD in value) {
    throw new TypeError(`reserved canonical field: ${RESERVED_BYTES_FIELD}`);
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`inherited canonical field: ${key}`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new TypeError("symbol canonical fields are not supported");
  }
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    throw new TypeError("canonical arrays must be dense and contain no extra fields");
  }
  const values = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`canonical array index must be an enumerable data field: ${index}`);
    }
    values.push(descriptor.value);
  }
  return values;
}

function normalize(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical values require finite numbers");
    if (Object.is(value, -0)) throw new TypeError("canonical values do not support negative zero");
    return value;
  }
  if (Buffer.isBuffer(value)) {
    throw new TypeError("binary Buffer values are not canonical; bind their digest and length instead");
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("canonical values must not contain cycles or duplicate object references");
    seen.add(value);
    const output = denseArrayValues(value).map((item) => normalize(item, seen));
    return output;
  }
  if (typeof value !== "object") throw new TypeError(`unsupported canonical value: ${typeof value}`);
  if (seen.has(value)) throw new TypeError("canonical values must not contain cycles or duplicate object references");
  seen.add(value);
  const output = Object.create(null);
  for (const [key, child] of plainObjectEntries(value)) {
    if (child === undefined) throw new TypeError(`undefined canonical field: ${key}`);
    output[key] = normalize(child, seen);
  }
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

export function decodeCanonicalBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("canonical input must be a Buffer");
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("canonical input must be valid UTF-8 JSON");
  }
  let encoded;
  try {
    encoded = canonicalBytes(value);
  } catch {
    throw new TypeError("canonical input contains an unsupported or reserved value");
  }
  if (!encoded.equals(bytes)) {
    throw new TypeError("canonical input must use the unique canonical JSON encoding");
  }
  return deepFreeze(value);
}

function hasExactPlainFields(value, expectedKeys) {
  try {
    return JSON.stringify(plainObjectEntries(value).map(([key]) => key)) === JSON.stringify(expectedKeys);
  } catch {
    return false;
  }
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
  if (Buffer.isBuffer(receipt)) {
    try {
      receipt = decodeCanonicalBytes(receipt);
    } catch {
      return false;
    }
  }
  const receiptKeys = ["authentication", "body_sha256", "key_id", "kind", "payload", "schema"];
  if (!hasExactPlainFields(receipt, receiptKeys)
    || !hasExactPlainFields(receipt.authentication, ["algorithm", "mac"])) {
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
  let bodyBytes;
  try {
    bodyBytes = canonicalBytes(body);
  } catch {
    return false;
  }
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
