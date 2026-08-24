// Integration check: the REAL vinci-sandbox against a REAL OS sandbox. Confines bash filesystem
// writes to the workspace (cwd + parent) so a runaway command can't escape to damage the machine.
// macOS uses the built-in sandbox-exec. Linux runs the same contract when bubblewrap is installed;
// the disposable EC2 lane installs it specifically so this path can no longer remain best-effort.
import assert from "node:assert";
import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const sandboxExecutable = platform() === "darwin"
  ? "/usr/bin/sandbox-exec"
  : platform() === "linux"
    ? ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].find((path) => existsSync(path))
    : undefined;

if (!sandboxExecutable || !existsSync(sandboxExecutable)) {
  console.log("sandbox-integration: skipped (sandbox-exec or bubblewrap is not available)");
  process.exit(0);
}

process.env.VINCI_CODE = "1";
delete process.env.VINCI_NO_SANDBOX;
const sbx = await import(resolve(here, "../../packages/coding-agent/src/core/vinci-sandbox.ts"));

// Temp workspace under $HOME: <root>/workspace/proj is cwd, parent=<root>/workspace (a sibling
// project lives there), <root>/outside is beyond the workspace and must be unwritable.
const root = `${homedir()}/.vinci-sbx-it`;
const cwd = `${root}/workspace/proj`;
rmSync(root, { recursive: true, force: true });
for (const d of [`${root}/workspace/proj`, `${root}/workspace/sibling`, `${root}/outside`]) mkdirSync(d, { recursive: true });
const canonicalRoot = realpathSync(root);
const canonicalWorkspace = realpathSync(`${root}/workspace`);
const canonicalCwd = realpathSync(cwd);
const fakeSecret = `${homedir()}/.vinci-sbx-it-fakekey`;
// Probe inside a genuinely locked credential store. Nothing is created while the sandbox holds; the
// finally block removes it either way so a regression can never leave a stray file in ~/.ssh.
const sshProbe = `${homedir()}/.ssh/.vinci-sbx-it-probe`;

let pass = 0;
const check = (name, cond) => { assert.ok(cond, name); console.log(`  ✓ ${name}`); pass++; };
const runs = (cmd) => {
  try { execSync(sbx.vinciSandboxWrap(cmd, cwd), { cwd, stdio: "pipe" }); return true; } catch { return false; }
};
let grantIndex = 0;
const grant = (command, scopes) => {
  const grantId = (++grantIndex).toString(16).padStart(32, "0");
  const normalized = [...scopes].sort().join(",");
  const signature = createHmac("sha256", process.env.VINCI_SECURITY_NONCE)
    .update(`${cwd}\0${grantId}\0${normalized}\0${command}`)
    .digest("hex");
  return `# vinci-security-grant:${grantId}:${normalized}:${signature}\n${command}`;
};

try {
  // Writable roots include the project and its workspace parent, not the grandparent.
  const roots = sbx.vinciWritableRoots(cwd);
  check("writable roots include the project (cwd)", roots.includes(canonicalCwd));
  check("writable roots include the workspace parent (siblings work)", roots.includes(canonicalWorkspace));
  // Writes are intentionally NOT confined to the project: Vinci works anywhere the user keeps files
  // (Desktop, Documents, a sibling folder), matching Claude Code and Codex. Confining to the launch
  // cwd meant files could land where nothing could ever be built. "/" is still never a root.
  check("$HOME is a writable root (Vinci can work anywhere you keep files)", roots.includes(realpathSync(homedir())));
  check("the filesystem root is NEVER writable", !roots.includes("/"));

  // Enforcement against the platform's real OS sandbox.
  check("write INSIDE the project is allowed", runs(`echo hi > ${cwd}/inside.txt`));
  check("write to a SIBLING project (workspace parent) is allowed", runs(`echo hi > ${root}/workspace/sibling/s.txt`));
  check("write OUTSIDE the project but under $HOME is ALLOWED", runs(`echo hi > ${root}/outside/ok.txt`));
  check("write to a system path outside $HOME is BLOCKED", !runs(`echo leak > /etc/vinci-sbx-it-leak`));
  // The protection that actually matters now that $HOME is writable: credential stores stay locked.
  // (~/.ssh is re-denied LAST, so it wins over the writable $HOME root.) Nothing is created if the
  // sandbox holds; the probe path is cleaned up in the finally block regardless.
  check("write into ~/.ssh is BLOCKED even though $HOME is writable", !runs(`echo leak > ${sshProbe}`));
  check("reading ~/.ssh is BLOCKED even though $HOME is writable", !runs(`cat ${homedir()}/.ssh/. > /dev/null`));
  check("reading a system file is allowed", runs(`cat /etc/hosts > /dev/null`));
  // A project's own .env must be READABLE so its commands (dotenv, vite, next…) can load config; the
  // model still never sees raw values (the model-channel redaction masks them in tool output).
  writeFileSync(`${cwd}/.env`, "API_KEY=some-real-value\n");
  check("a project .env IS readable so dotenv / project commands work", runs(`cat ${cwd}/.env > /dev/null`));
  // But a pure credential-token STORE (.npmrc) stays unreadable — a runaway command can't slurp a token.
  writeFileSync(`${cwd}/.npmrc`, "//registry.npmjs.org/:_authToken=should-not-be-readable\n");
  check("a project credential-token store (.npmrc) is still BLOCKED", !runs(`cat ${cwd}/.npmrc > /dev/null`));
  process.env.VINCI_SECURITY_NONCE = "sandbox-integration-nonce";
  const readGrant = grant(`cat ${cwd}/.npmrc > /dev/null`, ["read"]);
  check("a signed one-command read grant exposes only that invocation", runs(readGrant));
  check("the same signed read grant cannot be replayed", !runs(readGrant));
  check("altering a signed read command invalidates its grant", !runs(`${grant(`cat ${cwd}/.npmrc > /dev/null`, ["read"])} && cat ${cwd}/.npmrc`));
  const wrappedOffline = sbx.vinciSandboxWrap("printf local", cwd);
  check(
    "ordinary shell commands have external network disabled",
    platform() === "darwin" ? wrappedOffline.includes("deny network") : wrappedOffline.includes("--unshare-net"),
  );
  const wrappedOnline = sbx.vinciSandboxWrap(grant("printf network-approved", ["network"]), cwd);
  check("a signed one-command network grant removes the network deny", !wrappedOnline.includes(platform() === "darwin" ? "deny network" : "--unshare-net"));
  check("a normal pipe/cd command still works", runs(`cd ${cwd} && echo one two three | wc -w > out.txt`));

  // Local IPC must work (tsx's ESM loader, vitest workers, dev tools all open a local unix socket) while
  // the internet stays blocked. A blanket network deny broke every such tool (EPERM on listen).
  const sock = `${cwd}/ipc.sock`;
  const sockCmd = `node -e 'const net=require("node:net");const s=net.createServer(c=>c.end()).listen(${JSON.stringify(sock)},()=>{s.close();process.exit(0)});s.on("error",()=>process.exit(1))'`;
  check("a LOCAL unix-domain socket bind is allowed (tsx / vitest IPC works)", runs(sockCmd));
  check(
    "the seatbelt profile still denies remote network while allowing local IPC",
    platform() !== "darwin" ||
      (wrappedOffline.includes("deny network") && wrappedOffline.includes("local unix-socket")),
  );

  // review finding (HIGH): launching from $HOME (a non-programmer's default cwd) must NOT make the whole
  // home tree writable — ~/.ssh, ~/.aws etc. stay read-only even then. Exercised against a FAKE $HOME so
  // we never touch the real one.
  check("'/' is never added as a writable root", !sbx.vinciWritableRoots("/").includes("/"));
  {
    const origHome = process.env.HOME;
    const fakeHome = `${root}/fakehome`;
    mkdirSync(`${fakeHome}/.ssh`, { recursive: true });
    process.env.HOME = fakeHome;
    try {
      check("$HOME-as-cwd: home IS writable (real work isn't broken)", sbx.vinciWritableRoots(fakeHome).includes(realpathSync(fakeHome)));
      check("$HOME-as-cwd: ~/.ssh is on the re-deny list", sbx.vinciSensitiveNoWrite(fakeHome).some((p) => p.endsWith("/.ssh")));
      const runsIn = (cmd, wd) => { try { execSync(sbx.vinciSandboxWrap(cmd, wd), { cwd: wd, stdio: "pipe" }); return true; } catch { return false; } };
      check("$HOME-as-cwd: a normal write in home is allowed", runsIn(`echo hi > ${fakeHome}/note.txt`, fakeHome));
      check("$HOME-as-cwd: writing ~/.ssh/authorized_keys is STILL BLOCKED", !runsIn(`echo pwned >> ${fakeHome}/.ssh/authorized_keys`, fakeHome));
    } finally {
      if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    }
  }

  // Tool-config dirs (gcloud/aws/kube/docker) must be READABLE + WRITABLE so the CLI can run — locking
  // them bricked the tool and forced a manual handoff (the customer's gcloud dead-end). Verified against
  // a FAKE $HOME so the real ~/.config/gcloud is never touched.
  {
    const origHome = process.env.HOME;
    const fakeHome = `${root}/toolhome`;
    const proj = `${fakeHome}/proj`;
    mkdirSync(`${fakeHome}/.config/gcloud`, { recursive: true });
    mkdirSync(`${fakeHome}/.aws`, { recursive: true });
    mkdirSync(`${fakeHome}/.ssh`, { recursive: true });
    mkdirSync(proj, { recursive: true });
    writeFileSync(`${fakeHome}/.aws/credentials`, "[default]\naws_secret_access_key=nope\n");
    writeFileSync(`${fakeHome}/.ssh/id_rsa`, "PRIVATE\n");
    process.env.HOME = fakeHome;
    try {
      const roots2 = sbx.vinciWritableRoots(proj);
      check("tool dir ~/.config/gcloud is a writable root (gcloud can run)", roots2.includes(realpathSync(`${fakeHome}/.config/gcloud`)));
      check("~/.aws/credentials stays on the re-deny list (integrity)", sbx.vinciSensitiveNoWrite(proj).some((p) => p.endsWith("/.aws/credentials")));
      check("a whole tool dir is NOT blanket write-denied", !sbx.vinciSensitiveNoWrite(proj).some((p) => p.endsWith("/.config/gcloud")));
      check("~/.config/gcloud is NOT read-denied (auth needs it)", !sbx.vinciSensitiveNoRead(proj).some((p) => p.endsWith("/.config/gcloud")));
      check("~/.ssh IS still read-denied", sbx.vinciSensitiveNoRead(proj).some((p) => p.endsWith("/.ssh")));
      const runsIn = (cmd, wd) => { try { execSync(sbx.vinciSandboxWrap(cmd, wd), { cwd: wd, stdio: "pipe" }); return true; } catch { return false; } };
      check("writing inside ~/.config/gcloud is ALLOWED (the fix)", runsIn(`echo cfg > ${fakeHome}/.config/gcloud/active_config`, proj));
      check("writing a NEW file in ~/.aws is allowed (cli caches work)", runsIn(`echo x > ${fakeHome}/.aws/cli-cache.json`, proj));
      check("overwriting ~/.aws/credentials is STILL BLOCKED", !runsIn(`echo pwned > ${fakeHome}/.aws/credentials`, proj));
      check("reading a private key in ~/.ssh is STILL BLOCKED", !runsIn(`cat ${fakeHome}/.ssh/id_rsa > /dev/null`, proj));
    } finally {
      if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    }
  }

  // Opt-out: VINCI_NO_SANDBOX=1 returns the command unwrapped (fail open).
  process.env.VINCI_NO_SANDBOX = "1";
  check("VINCI_NO_SANDBOX=1 disables the wrap", sbx.vinciSandboxWrap("echo x", cwd) === "echo x");
  delete process.env.VINCI_NO_SANDBOX;
  check("re-enabled: wrap is applied again", sbx.vinciSandboxWrap("echo x", cwd).includes(sandboxExecutable));
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeSecret, { force: true });
}

console.log(`\nsandbox-integration: ${pass}/${pass} checks passed (real ${platform() === "darwin" ? "sandbox-exec" : "bubblewrap"} write-confinement)`);
