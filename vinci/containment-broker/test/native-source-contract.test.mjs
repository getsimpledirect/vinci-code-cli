import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const packageRoot = new URL("../", import.meta.url);

function source(relative) {
  return readFileSync(new URL(relative, packageRoot), "utf8");
}

test("portable native SHA-256 implementation passes an independently compiled vector", () => {
  const directory = mkdtempSync(join(tmpdir(), "vinci-native-sha256-"));
  const output = join(directory, "sha256-selftest");
  const compile = spawnSync("/usr/bin/cc", [
    "-std=c17", "-Wall", "-Wextra", "-Werror",
    new URL("native/sha256.c", packageRoot).pathname,
    new URL("test/sha256-selftest.c", packageRoot).pathname,
    "-o", output,
  ], { encoding: "utf8" });
  assert.equal(compile.status, 0, compile.stderr);
  const execute = spawnSync(output, [], { encoding: "utf8" });
  assert.equal(execute.status, 0, execute.stderr);
});

test("canonical protocol codec is ABI-independent and rejects reserved bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "vinci-native-protocol-"));
  const output = join(directory, "protocol-selftest");
  const compile = spawnSync("/usr/bin/cc", [
    "-std=c17", "-Wall", "-Wextra", "-Werror",
    new URL("native/protocol.c", packageRoot).pathname,
    new URL("test/protocol-selftest.c", packageRoot).pathname,
    "-o", output,
  ], { encoding: "utf8" });
  assert.equal(compile.status, 0, compile.stderr);
  const execute = spawnSync(output, [], { encoding: "utf8" });
  assert.equal(execute.status, 0, execute.stderr);
});

test("launcher has exactly one born-in-domain clone path and preserves the target through the trampoline exec", () => {
  const launcher = source("native/launcher_linux.c");
  assert.match(launcher, /\.flags = CLONE_INTO_CGROUP \| CLONE_PIDFD/);
  assert.match(launcher, /CLONE_CLEAR_SIGHAND/);
  assert.match(launcher, /sigprocmask\(SIG_SETMASK, &blocked, &previous\)/);
  assert.equal((launcher.match(/__NR_clone3/g) ?? []).length, 1);
  assert.match(launcher, /dup3\(source, target, flags\) == target/);
  assert.match(launcher, /remap_fd\(fds->executable, VINCI_BROKER_EXECUTABLE_FD, 0\)/);
  assert.match(launcher, /remap_fd\(fds->trampoline, VINCI_BROKER_TRAMPOLINE_FD, 0\)/);
  assert.match(launcher, /PR_SET_PDEATHSIG, SIGKILL/);
  assert.match(launcher, /getppid\(\) != expected_parent/);
  assert.match(launcher, /--vinci-trampoline-v4/);
  assert.match(launcher, /__NR_execveat, VINCI_BROKER_TRAMPOLINE_FD/);
  assert.doesNotMatch(launcher, /post[_ -]?start|setpgid|setsid|subreaper|pkill|\/proc\//i);
});

test("the admitted target ABI has an explicit first-entry attestation shim", () => {
  const entry = source("native/target_entry_linux.S");
  const bootstrap = source("native/target_bootstrap_linux.c");
  const build = source("test/linux-native-build.sh");
  assert.ok(entry.indexOf("vinci_target_bootstrap_attest") < entry.indexOf("vinci_target_fixture_main"));
  assert.ok(bootstrap.indexOf("__NR_prctl, PR_SET_DUMPABLE") < bootstrap.indexOf("__NR_pread64"));
  assert.match(bootstrap, /VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD/);
  assert.match(bootstrap, /__NR_pread64/);
  assert.match(bootstrap, /__NR_sendmsg/);
  assert.match(build, /-Wl,-e,_start/);
  assert.match(build, /readelf -l/);
  assert.match(build, /vinci-target-fixture/);
});

test("trampoline binds sealed target and trampoline bytes and mediates syscalls across final exec", () => {
  const trampoline = source("native/trampoline_linux.c");
  assert.match(trampoline, /VINCI_BROKER_MAX_RELEASE_BYTES/);
  assert.match(trampoline, /MSG_TRUNC \| MSG_CTRUNC/);
  assert.match(trampoline, /CMSG_FIRSTHDR\(&message\) != NULL/);
  assert.doesNotMatch(trampoline, /ALLOW_SYSCALL\(execveat\)/);
  assert.match(trampoline, /SECCOMP_FILTER_FLAG_NEW_LISTENER/);
  assert.match(trampoline, /SECCOMP_RET_USER_NOTIF/);
  assert.doesNotMatch(trampoline, /SCM_RIGHTS/);
  assert.match(trampoline, /F_GET_SEALS/);
  assert.match(trampoline, /F_SEAL_WRITE \| F_SEAL_GROW \| F_SEAL_SHRINK \| F_SEAL_SEAL/);
  assert.match(trampoline, /memcmp\(hello\.trampoline_sha256, trampoline_digest/);
  assert.match(trampoline, /memcpy\(report\.trampoline_sha256, trampoline_digest/);
  assert.match(trampoline, /receipt_hmac_sha256/);
  assert.match(trampoline, /prelaunch_receipt_sha256, commit->receipt_body_sha256/);
  assert.match(trampoline, /commit\.attempt_identity != hello\.attempt_identity/);
  assert.match(trampoline, /F_SETFD, flags \| FD_CLOEXEC/);
  const cloexecList = trampoline.slice(trampoline.indexOf("const int cloexec_fds[]"), trampoline.indexOf("sigset_t clear"));
  assert.doesNotMatch(cloexecList, /VINCI_BROKER_TARGET_ATTESTATION_FD/);
  assert.match(cloexecList, /VINCI_BROKER_TARGET_ATTESTATION_KEY_FD/);
  assert.match(cloexecList, /VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD/);
  assert.ok(trampoline.indexOf("VINCI_BROKER_TARGET_ATTESTATION_FD") < trampoline.indexOf("__NR_execveat"));
  assert.match(trampoline, /__NR_execveat, VINCI_BROKER_EXECUTABLE_FD/);
  assert.doesNotMatch(trampoline, /execv\(|execve\(|system\(|popen\(|dlopen\(/);
});

test("session source owns pidfd listener acquisition, ordered bootstrap, and terminal publication", () => {
  const launcher = source("native/launcher_linux.c");
  const session = source("native/session_linux.c");
  assert.match(session, /__NR_pidfd_getfd/);
  assert.match(session, /SECCOMP_IOCTL_NOTIF_ID_VALID/);
  assert.match(session, /SECCOMP_IOCTL_NOTIF_ADDFD/);
  assert.match(session, /SECCOMP_ADDFD_FLAG_SETFD/);
  assert.match(session, /target_injection_mask/);
  assert.match(launcher, /task->target_attestation_fd = attestation_pair\[0\]/);
  assert.match(launcher, /task->target_attestation_source_fd = attestation_pair\[1\]/);
  assert.match(session, /vinci_broker_derive_task_attestation_identity/);
  assert.match(session, /session->target_attestation_fd = task->target_attestation_fd/);
  assert.match(session, /session->target_attestation_source_fd = task->target_attestation_source_fd/);
  assert.doesNotMatch(session, /create_target_attestation_pair/);
  assert.ok(session.indexOf("__NR_prctl, 3u, args") < session.indexOf("inject_pending_fd(session"));
  assert.doesNotMatch(session, /SCM_RIGHTS/);
  assert.match(session, /__NR_setgroups/);
  assert.match(session, /__NR_setresgid/);
  assert.match(session, /__NR_setresuid/);
  assert.match(session, /VINCI_SESSION_TERMINAL_STORAGE_COMMITTED/);
  assert.match(session, /cgroup\.kill/);
  assert.match(session, /cgroup\.events/);
  assert.match(session, /O_TMPFILE/);
  const contextRead = "args[0] = VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD;";
  const listenerClose = "args[0] = VINCI_BROKER_NOTIFICATION_FD; result = continue_exact(session, __NR_close";
  const receiveReport = session.slice(session.indexOf("int vinci_broker_session_receive_report"));
  assert.ok(receiveReport.indexOf(contextRead) >= 0);
  assert.ok(receiveReport.indexOf(contextRead) < receiveReport.indexOf(listenerClose));
});

test("launcher and trampoline protocol version mismatch is an exact refusal mutant", () => {
  const launcher = source("native/launcher_linux.c");
  const trampoline = source("native/trampoline_linux.c");
  assert.match(launcher, /--vinci-trampoline-v4/);
  assert.match(trampoline, /strcmp\(argv\[1\], "--vinci-trampoline-v4"\)/);
  assert.doesNotMatch(launcher, /--vinci-trampoline-v3/);
  assert.doesNotMatch(trampoline, /--vinci-trampoline-v3/);
});

test("strict native compilation is mandatory on Linux and explicitly unexecuted elsewhere", () => {
  const admission = JSON.parse(source("native/native-admission.json"));
  if (process.platform !== "linux") {
    assert.equal(admission.admitted, false);
    assert.equal(admission.linux_build_receipt, null);
    assert.equal(admission.linux_test_receipt, null);
    return;
  }
  const build = spawnSync("/bin/sh", [new URL("test/linux-native-build.sh", packageRoot).pathname], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  assert.match(build.stdout, /vinci-trampoline/);
  assert.match(build.stdout, /session_linux\.o/);
  assert.match(build.stdout, /target_bootstrap_linux\.o/);
});
