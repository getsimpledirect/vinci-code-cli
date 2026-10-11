// Real local-tool entrypoints with a fresh, credential-free environment and one owned fixture tree.
// Backend qualification is a positive command: a sandbox startup failure must not count as a denial.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const here = dirname(script);
if (!process.env.VINCI_SANDBOX_TEST_ROOT) {
  const root = mkdtempSync(join(here, ".sandbox-integration-"));
  for (const path of ["home", "temp", "project", "sibling", "other"]) mkdirSync(join(root, path));
  try {
    execFileSync(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: join(root, "temp"), VINCI_SANDBOX_TEST_ROOT: root },
      timeout: 90_000, stdio: "inherit",
    });
  } finally {
    execFileSync("/usr/bin/find", [root, "-mindepth", "1", "-delete"], { timeout: 10_000 });
    rmdirSync(root);
  }
  process.exit(0);
}
const root = realpathSync(process.env.VINCI_SANDBOX_TEST_ROOT);
const home = join(root, "home");
const cwd = join(root, "project");
const sibling = join(root, "sibling");
const other = join(root, "other");
const backend = process.platform === "darwin" ? "/usr/bin/sandbox-exec" : ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].find(existsSync);
if (!backend || !existsSync(backend)) throw new Error("Sandbox runtime verification unavailable. Install a supported backend before counting this test as verified.");
process.env.VINCI_CODE = "1";
process.env.VINCI_SECURITY_NONCE = "inert-test-signing-material";
const sbx = await import(resolve(here, "../../packages/coding-agent/dist/core/vinci-sandbox.js"));
const tools = await import(resolve(here, "../../packages/coding-agent/dist/index.js"));
let pass = 0;
const check = (name, condition) => { assert.ok(condition, name); console.log(`  ✓ ${name}`); pass++; };
const bash = (command, options) => tools.createBashToolDefinition(cwd, options).execute("sandbox-fixture", { command, timeout: 5 });
const text = (result) => result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
const write = tools.createWriteToolDefinition(cwd);
const edit = tools.createEditToolDefinition(cwd);
const sq = (value) => `'${value.replaceAll("'", "'\\''")}'`;
let grantIndex = 0;
const grant = (command, scopes) => {
  const id = (++grantIndex).toString(16).padStart(32, "0");
  const normalized = [...scopes].sort().join(",");
  const signature = createHmac("sha256", process.env.VINCI_SECURITY_NONCE).update(`${cwd}\0${id}\0${normalized}\0${command}`).digest("hex");
  return `# vinci-security-grant:${id}:${normalized}:${signature}\n${command}`;
};

check("native backend starts an ordinary real bash tool command", text(await bash("printf sandbox-ready")) === "sandbox-ready");
const roots = sbx.vinciWritableRoots(cwd);
check("default roots contain the project without HOME, siblings, shared temp or Volumes", roots.includes(cwd) && !roots.includes(home) && !roots.includes(dirname(cwd)) && !roots.includes(process.env.TMPDIR) && !roots.includes("/Volumes"));
check("HOME, Volumes, shared-temp and filesystem-root cwd need explicit scope", !sbx.vinciWritableRoots(home).includes(home) && !sbx.vinciWritableRoots("/").includes("/") && !sbx.vinciWritableRoots("/Volumes").includes("/Volumes") && !sbx.vinciWritableRoots(process.env.TMPDIR).includes(process.env.TMPDIR));
await write.execute("local-write", { path: "nested/file.txt", content: "before\n" });
await edit.execute("local-edit", { path: "nested/file.txt", edits: [{ oldText: "before", newText: "after" }] });
check("real structured write/edit creates parents and preserves actual content", readFileSync(join(cwd, "nested/file.txt"), "utf8") === "after\n");
for (const target of [join(sibling, "not-approved"), join(other, "not-approved")]) {
  await assert.rejects(write.execute("outside-denied", { path: target, content: "inert" }), /scoped sandbox/);
  check("unapproved structured sibling writes leave no bytes", !existsSync(target));
}
sbx.vinciGrantWriteDirectory(cwd, sibling);
await write.execute("approved-sibling", { path: join(sibling, "approved"), content: "approved bytes" });
check("an explicit directory grant preserves cross-project structured writes", readFileSync(join(sibling, "approved"), "utf8") === "approved bytes");
await assert.rejects(write.execute("other-still-denied", { path: join(other, "still-denied"), content: "inert" }), /scoped sandbox/);
check("one directory grant does not grant another directory", !existsSync(join(other, "still-denied")));
symlinkSync(other, join(cwd, "outside-link"));
await assert.rejects(write.execute("symlink-denied", { path: "outside-link/link-file", content: "inert" }), /scoped sandbox/);
check("native structured writes resolve a symlink at the real consumer", !existsSync(join(other, "link-file")));
const startup = join(home, ".zshenv");
writeFileSync(startup, "# inert startup fixture\n");
sbx.vinciGrantWriteDirectory(cwd, home);
if (process.platform === "darwin") {
  await assert.rejects(write.execute("protected-startup", { path: startup, content: "inert replacement" }), /scoped sandbox/);
  check("a broad explicit HOME grant leaves startup bytes protected", readFileSync(startup, "utf8") === "# inert startup fixture\n");
  sbx.vinciGrantWriteFile(cwd, startup);
  await write.execute("explicit-startup", { path: startup, content: "# deliberate fixture edit\n" });
  check("an explicit exact-file grant preserves deliberate protected-file edits", readFileSync(startup, "utf8") === "# deliberate fixture edit\n");
} else {
  assert.throws(() => sbx.vinciSandboxWrap("printf local", cwd), /absent sensitive path/);
  check("Linux fails closed for broad scope with absent protected paths", true);
}
sbx.vinciResetSandboxPermissions();
await assert.rejects(write.execute("grant-reset", { path: join(sibling, "after-reset"), content: "inert" }), /scoped sandbox/);
check("session reset revokes additional directory grants", !existsSync(join(sibling, "after-reset")));
process.env.VINCI_SANDBOX_WRITE_ROOTS = JSON.stringify([sibling]);
await write.execute("configured-root", { path: join(sibling, "configured"), content: "configured scope" });
check("explicit launch configuration preserves directory workflow", readFileSync(join(sibling, "configured"), "utf8") === "configured scope");
delete process.env.VINCI_SANDBOX_WRITE_ROOTS;
const envResult = await bash(`node -e 'process.stdout.write(String(["VINCI_SECURITY_NONCE","VINCI_SANDBOX_WRITE_ROOTS","BASH_ENV","ENV","LD_PRELOAD"].every(k=>process.env[k]===undefined)&&process.env.USER_AUTHORIZED_API_KEY==="inert-credential-delivery"))'`, {
  spawnHook: (context) => ({ ...context, env: { ...context.env, VINCI_SECURITY_NONCE: "inert-hook-value", VINCI_SANDBOX_WRITE_ROOTS: JSON.stringify([other]), BASH_ENV: join(home, "inert-hook"), ENV: join(home, "inert-hook"), LD_PRELOAD: "inert-hook", USER_AUTHORIZED_API_KEY: "inert-credential-delivery" } }),
});
check("the final real child strips controls while preserving trusted-hook credential delivery", text(envResult) === "true");
if (existsSync("/bin/zsh")) check("a configured custom shell runs inside the native wrapper", text(await bash('printf "%s" "$0"', { shellPath: "/bin/zsh" })) === "/bin/zsh");
check("ordinary pipes and local project reads still work", text(await bash("printf 'one two' | wc -w")).trim() === "2");
mkdirSync(join(home, ".ssh"));
writeFileSync(join(home, ".ssh", "fixture"), "inert credential fixture");
const protectedProject = join(home, ".ssh", "fixture-project");
mkdirSync(protectedProject);
await assert.rejects(tools.createWriteToolDefinition(protectedProject).execute("protected-project", { path: "fixture", content: "inert" }));
check("a workspace inside a protected store does not remove its independent protection", !existsSync(join(protectedProject, "fixture")) && sbx.vinciSensitiveNoWrite(protectedProject).includes(join(home, ".ssh")));
const readCommand = `cat ${sq(join(home, ".ssh", "fixture"))} > /dev/null`;
await assert.rejects(bash(readCommand));
check("default locked-store read is denied", true);
const approvedRead = grant(readCommand, ["read"]);
await bash(approvedRead);
check("an exact signed read grant still works with sanitized child env", true);
await assert.rejects(bash(approvedRead));
check("a consumed exact read grant cannot be replayed", true);
const previousSessionGrant = grant(readCommand, ["read"]);
sbx.vinciResetSandboxPermissions();
await assert.rejects(bash(previousSessionGrant));
check("resetting permissions invalidates previous-session signing material", true);
sbx.vinciGrantWriteFile(cwd, join(home, ".ssh", "fixture"));
await write.execute("deliberate-locked-file", { path: join(home, ".ssh", "fixture"), content: "deliberate fixture bytes" });
check("the fixed structured writer preserves an exact locked-file edit", readFileSync(join(home, ".ssh", "fixture"), "utf8") === "deliberate fixture bytes");
await assert.rejects(bash(readCommand));
check("the fixed writer does not grant later arbitrary shell reads", true);
sbx.vinciResetSandboxPermissions();
const offline = sbx.vinciSandboxWrap("printf local", cwd);
const online = sbx.vinciSandboxWrap(grant("printf local", ["network"]), cwd);
const deny = process.platform === "darwin" ? "deny network" : "--unshare-net";
check("signed one-command network scope survives child env sanitization", offline.includes(deny) && !online.includes(deny));
check("a signed network invocation starts through the real sanitized Bash consumer", text(await bash(grant("printf network-scope-ready", ["network"]))) === "network-scope-ready");
const cloud = join(home, ".config", "gcloud");
mkdirSync(cloud, { recursive: true });
for (const name of ["application_default_credentials.json", "credentials.db"]) writeFileSync(join(cloud, name), "inert configuration fixture");
const cloudCommand = `printf 'operational fixture' > ${sq(join(cloud, "active_config"))}`;
await assert.rejects(bash(cloudCommand));
await bash(grant(cloudCommand, ["gcloud", "network"]));
check("a signed cloud configuration scope preserves operational writes without a default root", readFileSync(join(cloud, "active_config"), "utf8") === "operational fixture" && !sbx.vinciWritableRoots(cwd).includes(cloud));
console.log(`sandbox-integration: ${pass}/${pass} checks passed on ${process.platform}; Linux runtime evidence requires a Linux run.`);
