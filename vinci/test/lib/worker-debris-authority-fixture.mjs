import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { canonicalize } from "../../worker/contracts/canonical.mjs";
import { describeDebrisRootAnchor } from "../../worker/run.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonicalBytes = (value) => Buffer.from(`${canonicalize(value)}\n`, "utf8");

export function provisionWorkerDebrisAuthority(stateDir, lineageId) {
  mkdirSync(`${stateDir}/debris/.task-identities-v1`, { recursive: true, mode: 0o700 });
  const anchorPath = `${stateDir}-deployment-debris-root.json`;
  writeFileSync(anchorPath, canonicalBytes(describeDebrisRootAnchor(stateDir, lineageId)), { mode: 0o400 });

  const statePath = `${stateDir}-deployment-debris-authority-state.json`;
  const responseLossPath = `${statePath}.lose-response`;
  const failGetPath = `${statePath}.fail-get`;
  const delayResponsePath = `${statePath}.delay-response`;
  const neverResponsePath = `${statePath}.never-response`;
  const partialResponsePath = `${statePath}.partial-response`;
  const adapterPath = `${stateDir}-deployment-debris-authority-adapter.mjs`;
  const servicePath = `${stateDir}-deployment-debris-authority-service.mjs`;
  const readyPath = `${stateDir}-deployment-debris-authority-service.ready`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");

  const adapterSource = `#!/usr/bin/env node
import { fstatSync, readFileSync, readSync, writeSync } from "node:fs";
const stat = fstatSync(3);
if (!stat.isSocket()) process.exit(77);
const input = readFileSync(0);
let written = 0;
while (written < input.length) {
  try { written += writeSync(3, input, written, input.length - written); }
  catch (error) { if (error?.code !== "EAGAIN") throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); }
}
const chunks = [];
let length = 0;
while (length <= 1048576) {
  const chunk = Buffer.alloc(8192);
  let count;
  try { count = readSync(3, chunk, 0, chunk.length); }
  catch (error) { if (error?.code !== "EAGAIN") throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); continue; }
  if (count === 0) process.exit(76);
  const used = chunk.subarray(0, count);
  const newline = used.indexOf(0x0a);
  if (newline >= 0) {
    chunks.push(used.subarray(0, newline + 1));
    process.stdout.write(Buffer.concat(chunks));
    process.exit(0);
  }
  chunks.push(used);
  length += used.length;
}
process.exit(75);
`;
  writeFileSync(adapterPath, adapterSource, { mode: 0o500 });
  chmodSync(adapterPath, 0o500);
  const adapterSha256 = sha256(readFileSync(adapterPath));
  const privateKeyPkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  const serviceSource = `#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
const statePath = ${JSON.stringify(statePath)};
const responseLossPath = ${JSON.stringify(responseLossPath)};
const failGetPath = ${JSON.stringify(failGetPath)};
const delayResponsePath = ${JSON.stringify(delayResponsePath)};
const neverResponsePath = ${JSON.stringify(neverResponsePath)};
const partialResponsePath = ${JSON.stringify(partialResponsePath)};
const readyPath = ${JSON.stringify(readyPath)};
const adapterSha256 = ${JSON.stringify(adapterSha256)};
const rootAnchorSha256 = ${JSON.stringify(sha256(readFileSync(anchorPath)))};
const lineageId = ${JSON.stringify(lineageId)};
const serviceSha256 = process.env.VINCI_TEST_SERVICE_SHA256;
const privateKey = createPrivateKey({ key: Buffer.from(${JSON.stringify(privateKeyPkcs8)}, "base64url"), format: "der", type: "pkcs8" });
const stable = (value) => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? \`[\${value.map(stable).join(",")}]\` : \`{\${Object.keys(value).sort().map((key) => \`\${JSON.stringify(key)}:\${stable(value[key])}\`).join(",")}}\`;
const bytes = (value) => Buffer.from(\`\${stable(value)}\\n\`, "utf8");
const digest = (value) => createHash("sha256").update(bytes(value)).digest("hex");
const same = (left, right) => stable(left) === stable(right);
const mapPreserved = (before, after, key) => {
  if (!Array.isArray(before) || !Array.isArray(after) || after.length < before.length) return false;
  const byKey = new Map(after.map((entry) => [entry[key], entry]));
  return byKey.size === after.length && before.every((entry) => byKey.has(entry[key]) && same(entry, byKey.get(entry[key])));
};
const validTransition = (request, before, next) => {
  if (!before || !next || next.schema !== "vinci.worker-debris-authority-head/1" || next.task_id !== request.task_id) return false;
  if (next.sequence !== before.sequence + 1 || next.predecessor_head_sha256 !== digest(before)) return false;
  for (const key of ["root_anchor_sha256", "lineage_id", "task_id", "storage"]) if (!same(before[key], next[key])) return false;
  if (!mapPreserved(before.generations, next.generations, "generation") || !mapPreserved(before.attempts, next.attempts, "attempt")) return false;
  const generationDelta = next.generations.length - before.generations.length;
  const attemptDelta = next.attempts.length - before.attempts.length;
  return generationDelta >= 1 && generationDelta === attemptDelta && next.index_sha256 !== before.index_sha256;
};
const admission = {
  schema: "vinci.worker-debris-authority-admission/2",
  authority_admitted: true,
  authority_epoch: "4".repeat(64),
  key_id: "test-deployment-ed25519-2",
  service_principal: "test:deployment-owned-debris-authority",
  service_implementation_sha256: serviceSha256,
  adapter_sha256: adapterSha256,
  root_anchor_sha256: rootAnchorSha256,
  lineage_id: lineageId,
  peer_credentials_verified: true,
  service_storage_isolated: true,
  channel_origin: "SUPERVISOR_PREOPENED_UNNAMED_SOCKET",
  task_fd_inheritance: "DENIED",
  parent_fd_exfiltration: "DENIED_BY_DEPLOYMENT",
  direct_endpoint_policy: "NO_LISTENER_CAPABILITY_ONLY",
};
const socket = new Socket({ fd: 3, readable: true, writable: true });
let pending = Buffer.alloc(0);
socket.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (true) {
    const newline = pending.indexOf(0x0a);
    if (newline < 0) break;
    const requestBytes = pending.subarray(0, newline + 1);
    pending = pending.subarray(newline + 1);
    let channelRequest;
    try { channelRequest = JSON.parse(requestBytes.toString("utf8")); } catch { process.exit(64); }
    if (!bytes(channelRequest).equals(requestBytes) || channelRequest?.schema !== "vinci.worker-debris-authority-channel-request/1") process.exit(64);
    const request = channelRequest.request;
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
    const current = state[request.task_id] ?? null;
    let response;
    if (request.operation === "GET") {
      if (existsSync(failGetPath)) {
        unlinkSync(failGetPath);
        response = { schema: "vinci.test-debris-authority-transient-error/1" };
      } else {
        response = { schema: "vinci.worker-debris-authority-response/1", status: current ? "FOUND" : "NOT_FOUND", task_id: request.task_id, head: current, head_sha256: current ? digest(current) : null };
      }
    } else if (request.operation === "CAS") {
      const currentDigest = current ? digest(current) : null;
      if (currentDigest !== request.expected_head_sha256) {
        response = { schema: "vinci.worker-debris-authority-response/1", status: "CONFLICT", task_id: request.task_id, head: current, head_sha256: currentDigest };
      } else if (!validTransition(request, current, request.next_head)) {
        response = { schema: "vinci.worker-debris-authority-response/1", status: "REFUSED", task_id: request.task_id, head: current, head_sha256: currentDigest };
      } else {
        state[request.task_id] = request.next_head;
        const temporary = \`\${statePath}.\${process.pid}.tmp\`;
        writeFileSync(temporary, bytes(state), { mode: 0o600 });
        renameSync(temporary, statePath);
        if (existsSync(responseLossPath)) {
          unlinkSync(responseLossPath);
          response = { schema: "vinci.test-debris-authority-response-lost/1" };
        } else {
          response = { schema: "vinci.worker-debris-authority-response/1", status: "COMMITTED", task_id: request.task_id, head: request.next_head, head_sha256: digest(request.next_head) };
        }
      }
    } else {
      response = { schema: "vinci.test-debris-authority-invalid-operation/1" };
    }
    const payload = {
      schema: "vinci.worker-debris-authority-signed-payload/1",
      nonce: channelRequest.nonce,
      request_sha256: createHash("sha256").update(requestBytes).digest("hex"),
      channel_identity: channelRequest.channel_identity,
      admission,
      response,
    };
    const envelope = {
      schema: "vinci.worker-debris-authority-signed-response/1",
      payload,
      signature: sign(null, bytes(payload), privateKey).toString("base64url"),
    };
    const responseBytes = bytes(envelope);
    if (existsSync(neverResponsePath)) {
      unlinkSync(neverResponsePath);
    } else if (existsSync(partialResponsePath)) {
      unlinkSync(partialResponsePath);
      socket.write(responseBytes.subarray(0, Math.max(1, Math.floor(responseBytes.length / 2))));
    } else if (existsSync(delayResponsePath)) {
      const delayMs = Number(readFileSync(delayResponsePath, "utf8"));
      unlinkSync(delayResponsePath);
      setTimeout(() => socket.write(responseBytes), delayMs);
    } else {
      socket.write(responseBytes);
    }
  }
});
writeFileSync(readyPath, bytes({ schema: "vinci.test-debris-authority-ready/1", pid: process.pid }), { mode: 0o400 });
`;
  writeFileSync(servicePath, serviceSource, { mode: 0o500 });
  chmodSync(servicePath, 0o500);
  const serviceSha256 = sha256(readFileSync(servicePath));
  let service;
  let serviceError = "";
  let capabilityFd;
  const startService = () => {
    if (existsSync(readyPath)) unlinkSync(readyPath);
    serviceError = "";
    service = spawn(process.execPath, [servicePath], {
      env: { LANG: "C", LC_ALL: "C", VINCI_TEST_SERVICE_SHA256: serviceSha256 },
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    service.stderr.setEncoding("utf8");
    service.stderr.on("data", (chunk) => { serviceError += chunk; });
    service.stdio[3].pause();
    service.stdio[3]._handle?.readStop();
    capabilityFd = service.stdio[3]?._handle?.fd;
    if (!Number.isInteger(capabilityFd)) throw new Error(`test debris authority service failed to expose its socket: ${serviceError}`);
    const readyDeadline = Date.now() + 10_000;
    while (!existsSync(readyPath) && Date.now() < readyDeadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    if (!existsSync(readyPath)) throw new Error(`test debris authority service failed to become ready: ${serviceError}`);
    process.env.VINCI_WORKER_DEBRIS_AUTHORITY_CAPABILITY_FD = String(capabilityFd);
  };
  startService();

  process.env.VINCI_WORKER_DEBRIS_ROOT_ANCHOR = anchorPath;
  process.env.VINCI_WORKER_DEBRIS_ROOT_ANCHOR_SHA256 = sha256(readFileSync(anchorPath));
  process.env.VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER = adapterPath;
  process.env.VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER_SHA256 = adapterSha256;
  process.env.VINCI_WORKER_DEBRIS_AUTHORITY_PUBLIC_KEY_SPKI = publicKeySpki;
  process.env.VINCI_WORKER_DEBRIS_AUTHORITY_SERVICE_SHA256 = serviceSha256;

  const directoryIdentity = (path) => {
    const stat = lstatSync(path);
    return { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
  };
  const reserveTask = (taskId) => {
    const taskOwnerRoot = `${stateDir}/debris/${taskId}`;
    const taskRoot = `${taskOwnerRoot}/ledger-v1`;
    const generationsRoot = `${taskRoot}/generations`;
    const attemptsRoot = `${taskRoot}/attempts`;
    for (const path of [taskOwnerRoot, taskRoot, generationsRoot, attemptsRoot]) mkdirSync(path, { recursive: true, mode: 0o700 });
    const storage = {
      task_root: directoryIdentity(taskOwnerRoot),
      ledger_root: directoryIdentity(taskRoot),
      generations_root: directoryIdentity(generationsRoot),
      attempts_root: directoryIdentity(attemptsRoot),
    };
    const taskAnchorPath = `${stateDir}/debris/.task-identities-v1/${taskId}.json`;
    writeFileSync(taskAnchorPath, canonicalBytes({ schema: "vinci.worker-debris-task-identity/1", task_id: taskId, storage }), { mode: 0o400, flag: "wx" });
    const emptyIndex = { schema: "vinci.worker-debris-index/1", task_id: taskId, generations: [] };
    const head = {
      schema: "vinci.worker-debris-authority-head/1",
      sequence: 0,
      predecessor_head_sha256: null,
      root_anchor_sha256: sha256(readFileSync(anchorPath)),
      lineage_id: lineageId,
      task_id: taskId,
      storage,
      index_sha256: sha256(canonicalBytes(emptyIndex)),
      generations: [],
      attempts: [],
      current_sha256: null,
    };
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
    if (Object.hasOwn(state, taskId)) throw new Error(`test debris authority: task already reserved: ${taskId}`);
    state[taskId] = head;
    writeFileSync(statePath, canonicalBytes(state), { mode: 0o600 });
    return head;
  };

  return {
    anchorPath,
    adapterPath,
    servicePath,
    statePath,
    responseLossPath,
    failGetPath,
    delayResponsePath,
    neverResponsePath,
    partialResponsePath,
    get capabilityFd() { return capabilityFd; },
    publicKeySpki,
    serviceSha256,
    reserveTask,
    releaseCapabilityToChild() {
      service.stdio[3].destroy();
      capabilityFd = null;
    },
    reopenCapability() {
      service.stdio[3]?.destroy();
      if (service.exitCode === null && service.signalCode === null) service.kill();
      startService();
    },
    cleanup() {
      service.stdio[3]?.destroy();
      if (service.exitCode === null && service.signalCode === null) service.kill();
      for (const path of [anchorPath, adapterPath, servicePath, readyPath, statePath, responseLossPath, failGetPath, delayResponsePath, neverResponsePath, partialResponsePath]) if (existsSync(path)) unlinkSync(path);
    },
  };
}
