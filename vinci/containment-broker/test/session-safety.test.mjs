import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = readFileSync(new URL("../native/session_linux.c", import.meta.url), "utf8");

function productFunction(name) {
  const matches = [...source.matchAll(new RegExp(`^(?:static )?(?:int|void) ${name}\\([^]*?^}`, "gm"))];
  assert.equal(matches.length, 1, `exactly one product definition for ${name}`);
  return matches[0][0];
}

function compileAndRun(code) {
  const directory = mkdtempSync(join(tmpdir(), "vinci-session-safety-"));
  const input = join(directory, "test.c");
  const output = join(directory, "test");
  writeFileSync(input, code);
  const compiled = spawnSync(process.env.CC ?? "cc", ["-std=c17", "-Wall", "-Wextra", "-Werror", "-O2", input, "-o", output],
    { encoding: "utf8", timeout: 30000 });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
  const executed = spawnSync(output, [], { cwd: directory, encoding: "utf8", timeout: 10000 });
  assert.equal(executed.status, 0, executed.stderr || executed.error?.message);
}

test("the actual native clock function refuses successful invalid times independently of errno", () => {
  // Compile the product function's exact bytes with only its clock dependency injected.
  // This is a portable function test, not evidence about a Linux kernel or containment.
  compileAndRun(`
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <time.h>
static struct timespec observed;
static int failure;
static int injected_clock(clockid_t clock, struct timespec *value) {
  assert(clock == CLOCK_MONOTONIC);
  if (failure) { errno = EIO; return -1; }
  *value = observed; return 0;
}
#define clock_gettime injected_clock
${productFunction("monotonic_now")}
int main(void) {
  uint64_t now = 123;
  observed = (struct timespec){ .tv_sec = 2, .tv_nsec = 3 };
  errno = 0; assert(monotonic_now(&now) == 0 && now == UINT64_C(2000000003));
  observed.tv_sec = -1; now = 123;
  errno = 0; assert(monotonic_now(&now) == -EINVAL && now == 123);
  errno = EBUSY; assert(monotonic_now(&now) == -EINVAL && now == 123);
  observed.tv_sec = 0; observed.tv_nsec = -1;
  assert(monotonic_now(&now) == -EINVAL && now == 123);
  observed.tv_nsec = 1000000000L;
  assert(monotonic_now(&now) == -EINVAL && now == 123);
  observed.tv_sec = (time_t)(UINT64_MAX / UINT64_C(1000000000));
  observed.tv_nsec = 999999999L;
  assert(monotonic_now(&now) == -EOVERFLOW && now == 123);
  failure = 1; assert(monotonic_now(&now) == -EIO && now == 123);
  return 0;
}
`);
});

test("terminal freeze and kill refusal paths share the signing-key cleanup label", () => {
  const finalize = productFunction("vinci_broker_session_finalize_terminal");
  const operations = finalize.slice(finalize.indexOf("int freeze_fd"), finalize.indexOf("session->phase = VINCI_SESSION_DOMAIN_KILLED"));
  assert.equal((operations.match(/goto fail;/g) ?? []).length, 5);
  assert.doesNotMatch(operations, /return /);
  assert.match(finalize, /fail: clear_secret\(key, sizeof\(key\)\); session->phase = VINCI_SESSION_UNCONTAINED; return result;/);
  compileAndRun(`
#include <assert.h>
#include <stdint.h>
#include <stddef.h>
${productFunction("clear_secret")}
int main(void) {
  uint8_t key[32];
  for (size_t index = 0; index < sizeof(key); index++) key[index] = 0x5a;
  clear_secret(key, sizeof(key));
  for (size_t index = 0; index < sizeof(key); index++) assert(key[index] == 0);
  return 0;
}
`);
});

test("Linux receipt publication preserves exact bytes, no-replace behavior and unprivileged fallback", {
  skip: process.platform !== "linux" ? "requires a Linux O_TMPFILE filesystem; native admission remains false" : false,
}, () => {
  compileAndRun(`
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#define VINCI_BROKER_TERMINAL_RECEIPT_WIRE_BYTES 768u
static int fallback_errno;
static int fallback_calls;
static int injected_linkat(int source, const char *path, int target, const char *name, int flags) {
  if (flags == AT_EMPTY_PATH && fallback_errno) { errno = fallback_errno; return -1; }
  if (flags == AT_SYMLINK_FOLLOW) fallback_calls++;
  return linkat(source, path, target, name, flags);
}
#define linkat injected_linkat
${productFunction("write_all")}
${productFunction("identical_existing")}
${productFunction("persist_atomic")}
int main(void) {
  char directory[] = "receipt-test.XXXXXX";
  assert(mkdtemp(directory));
  int fd = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC); assert(fd >= 0);
  const uint8_t bytes[] = "exact receipt bytes";
  fallback_errno = EPERM;
  assert(persist_atomic(fd, "receipt", bytes, sizeof(bytes)) == 0);
  assert(fallback_calls == 1);
  fallback_errno = ENOENT;
  assert(persist_atomic(fd, "receipt", bytes, sizeof(bytes)) == 0);
  assert(fallback_calls == 2);
  const uint8_t different[] = "other receipt bytes";
  assert(persist_atomic(fd, "receipt", different, sizeof(different)) != 0);
  assert(identical_existing(fd, "receipt", bytes, sizeof(bytes)) == 0);
  assert(symlinkat("receipt", fd, "symlink") == 0);
  assert(persist_atomic(fd, "symlink", bytes, sizeof(bytes)) != 0);
  fallback_errno = 0;
  assert(persist_atomic(fd, "second", bytes, sizeof(bytes)) == 0);
  assert(unlinkat(fd, "receipt", 0) == 0);
  assert(unlinkat(fd, "symlink", 0) == 0);
  assert(unlinkat(fd, "second", 0) == 0);
  assert(close(fd) == 0 && rmdir(directory) == 0);
  return 0;
}
`);
});
