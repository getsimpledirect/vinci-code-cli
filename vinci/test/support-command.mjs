import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const supportUrl = "https://vinci.getsimpledirect.com/support?source=code";
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const supportExtension = await loader.import(resolve(root, "vinci/extensions/vinci-support.ts"), {
  default: true,
});

let command;
let spawnAttempt;
let errorHandler;
let unrefCalled = false;
const child = {
  on(event, handler) {
    assert.equal(event, "error");
    errorHandler = handler;
    return this;
  },
  unref() {
    unrefCalled = true;
  },
};

supportExtension(
  {
    registerCommand(name, options) {
      assert.equal(name, "support");
      command = options;
    },
  },
  (executable, args, options) => {
    spawnAttempt = { executable, args, options };
    return child;
  },
);

assert.equal(command?.description, "Get help and support");
assert.equal(typeof command?.handler, "function");

const originalWrite = process.stdout.write;
let stdout = "";
process.stdout.write = (chunk) => {
  stdout += chunk.toString();
  return true;
};

try {
  const result = command.handler("", {});
  assert.ok(result instanceof Promise, "support handler must return a Promise");
  await result;
} finally {
  process.stdout.write = originalWrite;
}

const linkedUrl = `\x1b]8;;${supportUrl}\x07${supportUrl}\x1b]8;;\x07`;
assert.equal(stdout, `${linkedUrl}\n${supportUrl}\n`);

const expectedOpener =
  process.platform === "darwin"
    ? { executable: "open", args: [supportUrl] }
    : process.platform === "win32"
      ? { executable: "rundll32", args: ["url.dll,FileProtocolHandler", supportUrl] }
      : { executable: "xdg-open", args: [supportUrl] };
assert.deepEqual(spawnAttempt, {
  ...expectedOpener,
  options: { stdio: "ignore", detached: true },
});
assert.equal(unrefCalled, true);
assert.doesNotThrow(() => errorHandler(new Error("opener unavailable")));

let throwingCommand;
supportExtension(
  {
    registerCommand(_name, options) {
      throwingCommand = options;
    },
  },
  () => {
    throw new Error("spawn failed");
  },
);
process.stdout.write = () => true;
try {
  await assert.doesNotReject(() => throwingCommand.handler("", {}));
} finally {
  process.stdout.write = originalWrite;
}

const previousPath = process.env.PATH;
process.env.PATH = "";
let missingOpenerCommand;
supportExtension({
  registerCommand(_name, options) {
    missingOpenerCommand = options;
  },
});
process.stdout.write = () => true;
try {
  await assert.doesNotReject(() => missingOpenerCommand.handler("", {}));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
} finally {
  process.stdout.write = originalWrite;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
}

console.log("  support-command: 9 checks passed");
