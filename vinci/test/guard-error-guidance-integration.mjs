import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createJiti } from "jiti/static";

const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const guard = await loader.import("../extensions/vinci-guard.ts");
const handlers = [];
guard.default({
  on(name, handler) { if (name === "tool_result") handlers.push(handler); },
  registerCommand() {},
});
const originalCode = process.env.VINCI_CODE;
const originalBypass = process.env.VINCI_NO_SANDBOX;
after(() => {
  if (originalCode === undefined) delete process.env.VINCI_CODE;
  else process.env.VINCI_CODE = originalCode;
  if (originalBypass === undefined) delete process.env.VINCI_NO_SANDBOX;
  else process.env.VINCI_NO_SANDBOX = originalBypass;
});

async function result(raw, { toolName = "bash", isError = true, code = "1", bypass, extra = [] } = {}) {
  if (code === null) delete process.env.VINCI_CODE;
  else process.env.VINCI_CODE = code;
  if (bypass === undefined) delete process.env.VINCI_NO_SANDBOX;
  else process.env.VINCI_NO_SANDBOX = bypass;
  const event = {
    type: "tool_result", toolName, toolCallId: "offline-guidance",
    input: { command: "node --test sum.test.mjs" }, isError,
    content: [{ type: "text", text: raw }, ...extra],
    details: { exitCode: 1, fixture: "unchanged" },
  };
  const original = structuredClone(event);
  let current = event;
  for (const handler of handlers) current = { ...current, ...await handler(current) };
  assert.deepEqual(event, original, "the hook must not mutate its input");
  assert.deepEqual(current.content.slice(0, event.content.length), event.content, "raw blocks stay first and intact");
  assert.deepEqual(current.details, event.details);
  assert.equal(current.isError, isError);
  const note = current.content.slice(event.content.length).map((part) => part.text ?? "").join("\n");
  assert.doesNotMatch(note, /VINCI_NO_SANDBOX|sandbox off|disable.*sandbox|OUTSIDE your project|confines writes to your project/i);
  return { current, note };
}

// Exact raw bash tool result captured from signed 0.0.53 during the harmless sum test.
const captured = "bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted\n\nCommand exited with code 1";

for (const raw of [
  captured,
  "bwrap: Creating new namespace failed: Operation not permitted\n\nCommand exited with code 1",
  "bwrap: Can't create network socket: Permission denied",
  "bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.",
  "sandbox-exec: sandbox_apply: Operation not permitted",
  `\r\n${captured.replaceAll("\n", "\r\n")}\r\n`,
]) {
  test(`startup diagnostic receives qualified prerequisite guidance: ${raw.trim().split("\n")[0]}`, async () => {
    const { note } = await result(raw);
    assert.match(note, /sandbox startup/i);
    assert.match(note, /if.*backend/i, "text diagnostics alone cannot prove their origin");
    assert.match(note, /prerequisites/i);
    assert.match(note, /keeping.*sandbox.*enabled/i);
    assert.match(note, /do not.*retry/i);
    assert.doesNotMatch(note, /filesystem access|write outside/i);
  });
}

for (const raw of [
  "EACCES", "EPERM", "Error: EPERM: operation not permitted", "Operation not permitted",
  "Permission denied", "connect EPERM 127.0.0.1:3000", "listen EACCES: permission denied 127.0.0.1:80",
  "bash: connect: Permission denied", "bash: /dev/tcp/127.0.0.1/80: Permission denied",
  "bash: kill: (12345) - Operation not permitted",
]) {
  test(`unattributed permission failure stays qualified: ${raw}`, async () => {
    const { note } = await result(`${raw}\n\nCommand exited with code 1`);
    assert.match(note, /permission-related/i);
    assert.match(note, /does not establish/i);
    assert.doesNotMatch(note, /sandbox startup|filesystem access denial/i);
  });
}

for (const raw of [
  "Error: EACCES: permission denied, open '/project/report.txt'",
  "Error: EPERM: operation not permitted, mkdir '/project/build'",
  "touch: cannot touch '/read-only/report.txt': Read-only file system",
  "bash: line 1: /read-only/report.txt: Read-only file system",
  "cat: /project/report.txt: Permission denied",
  "mkdir: cannot create directory '/project/build': Permission denied",
  "EROFS: read-only file system, open '/project/report.txt'",
]) {
  test(`filesystem diagnostic points to the reported path: ${raw}`, async () => {
    const { note } = await result(`${raw}\n\nCommand exited with code 1`);
    assert.match(note, /filesystem access denial/i);
    assert.match(note, /path.*permissions.*mount/i);
    assert.match(note, /does not establish/i);
    assert.doesNotMatch(note, /sandbox startup/i);
  });
}

for (const raw of [
  "not ok 1 - adds numbers\nAssertionError: Expected values to be strictly equal:\n3 !== 5\n\nCommand exited with code 1",
  "not ok 1 - rejects EPERM and permission denied errors\n1 failed\n\nCommand exited with code 1",
  "Error: Cannot find module './missing.js'\n\nCommand exited with code 1",
  "Command timed out after 10 seconds",
  "The action is not permitted by the application policy",
]) {
  test(`ordinary command/test failure is unchanged: ${raw.split("\n")[0]}`, async () => {
    assert.equal((await result(raw)).note, "");
  });
}

test("mixed command output cannot be asserted to be a startup-only failure", async () => {
  for (const raw of [
    `${captured}\nnot ok 1 - expected 4 but received 5`,
    `README example:\n${captured}\ncat: missing.txt: No such file or directory`,
    `> ${captured}`,
  ]) assert.doesNotMatch((await result(raw)).note, /sandbox startup/i);
});

test("later guidance alone is not raw failure evidence", async () => {
  assert.equal((await result("cat: missing.txt: No such file or directory", {
    extra: [{ type: "text", text: captured }],
  })).note, "");
});

test("successful output stays unchanged even when it prints diagnostics", async () => {
  for (const raw of ["ok 1 - adds numbers\n3 tests passed", captured, "Permission denied", "EACCES"])
    assert.equal((await result(raw, { isError: false })).note, "");
});

test("non-bash errors and explicit existing modes receive no sandbox guidance", async () => {
  for (const options of [{ toolName: "read" }, { code: null }, { code: "0" }, { bypass: "1" }])
    assert.equal((await result(captured, options)).note, "");
});

test("additional content blocks and non-default exit status remain intact", async () => {
  const raw = captured.replace("code 1", "code 42");
  const { current, note } = await result(raw, {
    extra: [{ type: "image", data: "fixture", mimeType: "image/png" }, { type: "text", text: "Existing annotation" }],
  });
  assert.match(current.content[0].text, /code 42$/);
  assert.match(note, /sandbox startup/i);
  assert.equal(current.content.length, 4);
});
