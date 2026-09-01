import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { fstatSync, lstatSync, readFileSync } from "node:fs";
import { Socket } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";

import { canonicalize } from "./contracts/canonical.mjs";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CHANNEL_TIMEOUT_MS = 10_000;
const channels = new Map();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalize(value)}\n`, "utf8");
}

function parseCanonical(bytes, label) {
  let value;
  try {
    value = JSON.parse(utf8Decoder.decode(bytes));
  } catch (error) {
    throw new Error(`${label}: invalid canonical JSON: ${error.message}`);
  }
  if (!canonicalBytes(value).equals(bytes)) throw new Error(`${label}: bytes are not canonical JSON`);
  return value;
}

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected object`);
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([...keys].sort())) throw new Error(`${label}: unexpected fields`);
}

function decodeBase64Url(value, length, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label}: invalid base64url`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value) throw new Error(`${label}: noncanonical base64url or invalid length`);
  return bytes;
}

function socketIdentity(fd) {
  const stat = fstatSync(fd);
  // Socketpair link counts are kernel-specific (Darwin reports zero while Linux
  // commonly reports one).  The signed deployment admission proves that this is
  // the supervisor-preopened, unnamed endpoint; locally we prove and pin only
  // the descriptor's observable socket identity.
  if (!stat.isSocket()) throw new Error("debris authority channel: expected a supervisor-preopened socket descriptor");
  return { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777, nlink: stat.nlink };
}

function asyncChannel(fd, identity) {
  const key = `${fd}:${identity.dev}:${identity.ino}`;
  const existing = channels.get(key);
  if (existing) return existing;

  const socket = new Socket({ fd, readable: true, writable: true });
  socket.unref();
  let active = null;
  let invalid = null;
  const fail = (error) => {
    if (!invalid) invalid = error instanceof Error ? error : new Error(String(error));
    if (active) {
      clearTimeout(active.timer);
      const { reject } = active;
      active = null;
      reject(invalid);
    }
    if (!socket.destroyed) socket.destroy();
  };
  socket.on("error", (error) => fail(new Error(`debris authority channel: ${error.message}`)));
  socket.on("close", () => fail(new Error("debris authority channel: closed")));
  socket.on("data", (chunk) => {
    if (!active) {
      fail(new Error("debris authority channel: unsolicited or stale response"));
      return;
    }
    active.chunks.push(Buffer.from(chunk));
    active.length += chunk.length;
    if (active.length > MAX_RESPONSE_BYTES) {
      fail(new Error("debris authority channel: response exceeds the byte limit"));
      return;
    }
    const bytes = Buffer.concat(active.chunks);
    const newline = bytes.indexOf(0x0a);
    if (newline < 0) return;
    if (newline !== bytes.length - 1) {
      fail(new Error("debris authority channel: multiple or trailing responses"));
      return;
    }
    clearTimeout(active.timer);
    const { resolve } = active;
    active = null;
    resolve(bytes);
  });

  const channel = {
    invalidate(error) { fail(error); },
    async transact(input) {
      if (invalid) throw invalid;
      if (active) throw new Error("debris authority channel: concurrent request refused");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error("debris authority channel: end-to-end deadline exceeded")), CHANNEL_TIMEOUT_MS);
        active = { resolve, reject, timer, chunks: [], length: 0 };
        socket.write(input, (error) => {
          if (error) fail(new Error(`debris authority channel: write failed: ${error.message}`));
        });
      });
    },
  };
  channels.set(key, channel);
  return channel;
}

export function createDebrisAuthorityClient(stateDir, expected) {
  const configured = process.env.VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER;
  const configuredSha256 = process.env.VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER_SHA256;
  const capabilityFdText = process.env.VINCI_WORKER_DEBRIS_AUTHORITY_CAPABILITY_FD;
  const publicKeySpki = process.env.VINCI_WORKER_DEBRIS_AUTHORITY_PUBLIC_KEY_SPKI;
  const serviceSha256 = process.env.VINCI_WORKER_DEBRIS_AUTHORITY_SERVICE_SHA256;
  if (!configured || !isAbsolute(configured)) {
    throw new Error("debris authority adapter: VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER must name an absolute deployment-owned executable");
  }
  if (!/^[0-9a-f]{64}$/.test(configuredSha256 ?? "") || !/^[0-9a-f]{64}$/.test(serviceSha256 ?? "")) {
    throw new Error("debris authority adapter: deployment must pin exact adapter and service implementation digests");
  }
  if (!/^(?:[3-9]|[1-9][0-9]{1,5})$/.test(capabilityFdText ?? "")) {
    throw new Error("debris authority adapter: deployment must pass a supervisor-preopened authority socket descriptor");
  }
  const capabilityFd = Number(capabilityFdText);
  const initialChannelIdentity = socketIdentity(capabilityFd);
  const channel = asyncChannel(capabilityFd, initialChannelIdentity);
  const executable = resolve(configured);
  const fromState = relative(resolve(stateDir), executable);
  if (fromState === "" || (!fromState.startsWith("..") && !isAbsolute(fromState))) {
    throw new Error("debris authority adapter: executable must be outside the replaceable worker state directory");
  }
  const initialStat = lstatSync(executable);
  if (!initialStat.isFile() || initialStat.isSymbolicLink() || initialStat.nlink !== 1 || (initialStat.mode & 0o022) !== 0 || (initialStat.mode & 0o111) === 0) {
    throw new Error("debris authority adapter: unsafe executable identity");
  }
  const initialBytes = readFileSync(executable);
  if (sha256(initialBytes) !== configuredSha256) throw new Error("debris authority adapter: executable digest mismatch");
  const executableIdentity = {
    dev: String(initialStat.dev),
    ino: String(initialStat.ino),
    uid: initialStat.uid,
    gid: initialStat.gid,
    mode: initialStat.mode & 0o777,
    nlink: initialStat.nlink,
  };
  let publicKey;
  try {
    publicKey = createPublicKey({ key: decodeBase64Url(publicKeySpki, 44, "debris authority public key"), format: "der", type: "spki" });
  } catch (error) {
    throw new Error(`debris authority adapter: invalid trust key: ${error.message}`);
  }
  const verifyBoundaries = () => {
    const stat = lstatSync(executable);
    const currentExecutable = { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777, nlink: stat.nlink };
    if (!stat.isFile() || stat.isSymbolicLink() || canonicalize(currentExecutable) !== canonicalize(executableIdentity)) {
      throw new Error("debris authority adapter: executable identity changed");
    }
    if (sha256(readFileSync(executable)) !== configuredSha256) throw new Error("debris authority adapter: executable digest mismatch");
    if (canonicalize(socketIdentity(capabilityFd)) !== canonicalize(initialChannelIdentity)) throw new Error("debris authority channel: descriptor identity changed");
  };

  return async function requestDebrisAuthority(request) {
    verifyBoundaries();
    const nonce = randomBytes(32).toString("hex");
    const channelRequest = {
      schema: "vinci.worker-debris-authority-channel-request/1",
      nonce,
      channel_identity: initialChannelIdentity,
      request,
    };
    const input = canonicalBytes(channelRequest);
    const responseBytes = await channel.transact(input);
    try {
      verifyBoundaries();
      const envelope = parseCanonical(responseBytes, "debris authority signed response");
      requireExactKeys(envelope, ["schema", "payload", "signature"], "debris authority signed response");
      if (envelope.schema !== "vinci.worker-debris-authority-signed-response/1") throw new Error("debris authority signed response: invalid schema");
      const payload = envelope.payload;
      requireExactKeys(payload, ["schema", "nonce", "request_sha256", "channel_identity", "admission", "response"], "debris authority signed payload");
      if (payload.schema !== "vinci.worker-debris-authority-signed-payload/1" || payload.nonce !== nonce
          || payload.request_sha256 !== sha256(input) || canonicalize(payload.channel_identity) !== canonicalize(initialChannelIdentity)) {
        throw new Error("debris authority signed response: request or channel binding mismatch");
      }
      requireExactKeys(
        payload.admission,
      [
        "schema",
        "authority_admitted",
        "authority_epoch",
        "key_id",
        "service_principal",
        "service_implementation_sha256",
        "adapter_sha256",
        "root_anchor_sha256",
        "lineage_id",
        "peer_credentials_verified",
        "service_storage_isolated",
        "channel_origin",
        "task_fd_inheritance",
        "parent_fd_exfiltration",
        "direct_endpoint_policy",
      ],
        "debris authority admission",
      );
      const admission = payload.admission;
      if (admission.schema !== "vinci.worker-debris-authority-admission/2" || admission.authority_admitted !== true
          || !/^[0-9a-f]{64}$/.test(admission.authority_epoch) || !/^[A-Za-z0-9._-]{1,128}$/.test(admission.key_id)
          || !/^[A-Za-z0-9._:-]{1,256}$/.test(admission.service_principal)
          || admission.service_implementation_sha256 !== serviceSha256 || admission.adapter_sha256 !== configuredSha256
          || admission.root_anchor_sha256 !== expected.rootAnchorSha256 || admission.lineage_id !== expected.lineageId
          || admission.peer_credentials_verified !== true || admission.service_storage_isolated !== true
          || admission.channel_origin !== "SUPERVISOR_PREOPENED_UNNAMED_SOCKET" || admission.task_fd_inheritance !== "DENIED"
          || admission.parent_fd_exfiltration !== "DENIED_BY_DEPLOYMENT" || admission.direct_endpoint_policy !== "NO_LISTENER_CAPABILITY_ONLY") {
        throw new Error("debris authority signed response: incomplete or mismatched admission");
      }
      const signature = decodeBase64Url(envelope.signature, 64, "debris authority signed response signature");
      if (!verify(null, canonicalBytes(payload), publicKey, signature)) throw new Error("debris authority signed response: invalid signature");
      return payload.response;
    } catch (error) {
      channel.invalidate(error);
      throw error;
    }
  };
}
