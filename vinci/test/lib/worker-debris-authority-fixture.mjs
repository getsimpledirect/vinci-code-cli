import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { canonicalize } from "../../worker/contracts/canonical.mjs";
import { describeDebrisRootAnchor } from "../../worker/run.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonicalBytes = (value) => Buffer.from(`${canonicalize(value)}\n`, "utf8");

export function provisionWorkerDebrisAuthority(stateDir, lineageId) {
  mkdirSync(`${stateDir}/debris/.task-identities-v1`, { recursive: true, mode: 0o700 });
  const anchorPath = `${stateDir}-deployment-debris-root.json`;
  writeFileSync(anchorPath, `${canonicalize(describeDebrisRootAnchor(stateDir, lineageId))}\n`, { mode: 0o400 });

  const statePath = `${stateDir}-deployment-debris-authority-state.json`;
  const responseLossPath = `${statePath}.lose-response`;
  const failGetPath = `${statePath}.fail-get`;
  const adapterPath = `${stateDir}-deployment-debris-authority-adapter.mjs`;
  const channelToken = "a".repeat(64);
  const source = `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
const responseLossPath = ${JSON.stringify(responseLossPath)};
const failGetPath = ${JSON.stringify(failGetPath)};
const channelToken = ${JSON.stringify(channelToken)};
const stable = (value) => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? \`[\${value.map(stable).join(",")}]\` : \`{\${Object.keys(value).sort().map((key) => \`\${JSON.stringify(key)}:\${stable(value[key])}\`).join(",")}}\`;
const bytes = (value) => Buffer.from(\`\${stable(value)}\\n\`, "utf8");
const digest = (value) => createHash("sha256").update(bytes(value)).digest("hex");
const request = JSON.parse(readFileSync(0, "utf8"));
if (request.channel_token !== channelToken) process.exit(77);
if (request.operation === "GET" && existsSync(failGetPath)) {
  unlinkSync(failGetPath);
  process.exit(74);
}
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const current = state[request.task_id] ?? null;
let response;
if (request.operation === "GET") {
  response = { schema: "vinci.worker-debris-authority-response/1", status: current ? "FOUND" : "NOT_FOUND", task_id: request.task_id, head: current, head_sha256: current ? digest(current) : null };
} else if (request.operation === "CAS") {
  const currentDigest = current ? digest(current) : null;
  if (currentDigest !== request.expected_head_sha256) {
    response = { schema: "vinci.worker-debris-authority-response/1", status: "CONFLICT", task_id: request.task_id, head: current, head_sha256: currentDigest };
  } else {
    state[request.task_id] = request.next_head;
    const temporary = \`\${statePath}.\${process.pid}.tmp\`;
    writeFileSync(temporary, bytes(state), { mode: 0o600 });
    renameSync(temporary, statePath);
    if (existsSync(responseLossPath)) {
      unlinkSync(responseLossPath);
      process.exit(75);
    }
    response = { schema: "vinci.worker-debris-authority-response/1", status: "COMMITTED", task_id: request.task_id, head: request.next_head, head_sha256: digest(request.next_head) };
  }
} else {
  process.exit(64);
}
process.stdout.write(bytes(response));
`;
  writeFileSync(adapterPath, source, { mode: 0o500 });
  chmodSync(adapterPath, 0o500);

  process.env.VINCI_WORKER_DEBRIS_ROOT_ANCHOR = anchorPath;
  process.env.VINCI_WORKER_DEBRIS_ROOT_ANCHOR_SHA256 = sha256(readFileSync(anchorPath));
  process.env.VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER = adapterPath;
  process.env.VINCI_WORKER_DEBRIS_AUTHORITY_ADAPTER_SHA256 = sha256(readFileSync(adapterPath));
  process.env.VINCI_WORKER_DEBRIS_AUTHORITY_CHANNEL_TOKEN = channelToken;

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
    writeFileSync(taskAnchorPath, `${canonicalize({ schema: "vinci.worker-debris-task-identity/1", task_id: taskId, storage })}\n`, { mode: 0o400, flag: "wx" });
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
    statePath,
    responseLossPath,
    failGetPath,
    reserveTask,
    cleanup() {
      for (const path of [anchorPath, adapterPath, statePath, responseLossPath, failGetPath]) if (existsSync(path)) unlinkSync(path);
    },
  };
}
