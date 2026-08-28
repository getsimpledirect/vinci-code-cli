/*
 * Fixed Linux trampoline boundary for Vinci containment broker v3.
 *
 * This source is intentionally fail-closed and is not an admitted executable.
 * A separately reviewed Linux successor must add the fixed seccomp program,
 * credential/namespace attestation, canonical release payload decoder and
 * execveat handoff, then bind the resulting binary digest into an admission
 * receipt. Until VINCI_ADMITTED_NATIVE_BUILD is defined by that reviewed build,
 * this translation unit cannot produce an executable.
 */

#ifndef __linux__
#error "the containment trampoline is Linux-only"
#endif

#ifndef VINCI_ADMITTED_NATIVE_BUILD
#error "unadmitted trampoline build refused"
#endif

#include "protocol.h"

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static int read_exact(int fd, void *buffer, size_t length) {
    uint8_t *cursor = buffer;
    size_t read_bytes = 0;
    while (read_bytes < length) {
        ssize_t count = recv(fd, cursor + read_bytes, length - read_bytes, MSG_WAITALL);
        if (count == 0) return -ECONNRESET;
        if (count < 0) return -errno;
        read_bytes += (size_t)count;
    }
    return 0;
}

static int write_exact(int fd, const void *buffer, size_t length) {
    const uint8_t *cursor = buffer;
    size_t written = 0;
    while (written < length) {
        ssize_t count = send(fd, cursor + written, length - written, MSG_NOSIGNAL);
        if (count == 0) return -ECONNRESET;
        if (count < 0) return -errno;
        written += (size_t)count;
    }
    return 0;
}

/*
 * This entry proves only the fixed nonce barrier shape. It deliberately exits
 * without executing episode code because the admitted release-payload decoder,
 * seccomp filter and execveat transition are not yet frozen or Linux-tested.
 */
int vinci_trampoline_fail_closed_entry(void) {
    struct vinci_broker_hello hello;
    struct vinci_trampoline_report report;
    struct vinci_broker_release release;
    struct stat executable;

    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return 125;
    if (fstat(VINCI_BROKER_EXECUTABLE_FD, &executable) != 0 || !S_ISREG(executable.st_mode)) return 125;
    if (read_exact(VINCI_BROKER_CONTROL_FD, &hello, sizeof(hello)) != 0) return 125;
    if (hello.magic != VINCI_BROKER_HELLO_MAGIC || hello.version != VINCI_BROKER_PROTOCOL_VERSION) return 125;

    memset(&report, 0, sizeof(report));
    report.magic = VINCI_BROKER_REPORT_MAGIC;
    report.version = VINCI_BROKER_PROTOCOL_VERSION;
    report.report_bytes = sizeof(report);
    report.pid = (int64_t)getpid();
    report.uid = (uint32_t)getuid();
    report.gid = (uint32_t)getgid();
    memcpy(report.nonce, hello.nonce, sizeof(report.nonce));
    if (write_exact(VINCI_BROKER_CONTROL_FD, &report, sizeof(report)) != 0) return 125;

    if (read_exact(VINCI_BROKER_CONTROL_FD, &release, sizeof(release)) != 0) return 125;
    if (release.magic != VINCI_BROKER_RELEASE_MAGIC || release.version != VINCI_BROKER_PROTOCOL_VERSION) return 125;
    if (memcmp(release.nonce, hello.nonce, sizeof(release.nonce)) != 0) return 125;

    /* No exec until the missing admitted native successor is independently GO. */
    return 126;
}
