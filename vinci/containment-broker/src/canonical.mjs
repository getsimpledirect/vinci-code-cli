import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";

export const RECEIPT_SCHEMA = "vinci.containment-broker.receipt/v3";

const { isProxy } = utilTypes;
const RESERVED_BYTES_FIELD = "$bytes_base64";
const VERIFY_OPTION_KEYS = ["key", "keyId", "kind"];
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength").get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;

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
  if (isProxy(value)) throw new TypeError("Proxy values are not canonical");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical values require finite numbers");
    if (Object.is(value, -0)) throw new TypeError("canonical values do not support negative zero");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError("canonical values require safe integers");
    }
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

function snapshotCanonicalValue(value) {
  return deepFreeze(normalize(value, new Set()));
}

export function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(snapshotCanonicalValue(value)), "utf8");
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : canonicalBytes(value);
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotKey(key) {
  if (isProxy(key) || !Buffer.isBuffer(key)) {
    throw new TypeError("receipt authentication key must be at least 32 bytes");
  }
  const byteLength = TYPED_ARRAY_BYTE_LENGTH.call(key);
  if (byteLength < 32) throw new TypeError("receipt authentication key must be at least 32 bytes");
  const snapshot = Buffer.allocUnsafe(byteLength);
  TYPED_ARRAY_SET.call(snapshot, key);
  return snapshot;
}

function snapshotVerifyOptions(options) {
  if (isProxy(options)) throw new TypeError("Proxy verification options are not supported");
  if (options === null || typeof options !== "object") {
    throw new TypeError("verification options must be a plain object");
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("verification options must be a plain object");
  }
  const keys = Reflect.ownKeys(options);
  if (keys.some((key) => typeof key !== "string")
    || JSON.stringify([...keys].sort()) !== JSON.stringify(VERIFY_OPTION_KEYS)) {
    throw new TypeError("verification options must contain exactly kind, keyId, and key");
  }
  const snapshot = Object.create(null);
  for (const key of VERIFY_OPTION_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`verification option must be an enumerable data field: ${key}`);
    }
    snapshot[key] = descriptor.value;
  }
  if (isProxy(snapshot.key)) throw new TypeError("Proxy verification keys are not supported");
  return Object.freeze(snapshot);
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
  key = snapshotKey(key);
  const body = {
    schema: RECEIPT_SCHEMA,
    kind,
    key_id: keyId,
    payload: snapshotCanonicalValue(payload),
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

function verifyReceiptUnchecked(receipt, { kind, keyId, key }) {
  key = snapshotKey(key);
  if (Buffer.isBuffer(receipt)) {
    receipt = decodeCanonicalBytes(receipt);
  } else {
    receipt = snapshotCanonicalValue(receipt);
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

export function verifyReceipt(receipt, options) {
  try {
    if (isProxy(receipt)) return false;
    options = snapshotVerifyOptions(options);
    return verifyReceiptUnchecked(receipt, options);
  } catch {
    return false;
  }
}
