/* Runtime known-answer test for the freestanding trampoline shim.
 *
 * This is the hermetic half: it links exactly like the real trampoline
 * (-nostdlib against trampoline_entry_linux.S + trampoline_runtime_linux.c) and
 * so exercises the SAME _start argc/argv marshalling, the SAME
 * vinci_raw_syscall6 register marshalling and the SAME wrappers the trampoline
 * relies on. Source review cannot establish these: a wrong register or a wrong
 * __NR_ produces a plausible wrong ANSWER, not a crash.
 *
 * The hosted harness passes this process's pid and ppid, both obtained from
 * glibc BEFORE exec, so the raw-syscall results are checked against an
 * independent implementation rather than against themselves. Exit status is 0,
 * or the number of the first failing check. */

#define _GNU_SOURCE

#include "../native/trampoline_runtime_linux.h"

#include <errno.h>
#include <fcntl.h>
#include <sys/prctl.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/uio.h>

#define VINCI_SELFTEST_FD 7
#define VINCI_SELFTEST_LENGTH 64
#define VINCI_SELFTEST_SEND_FD 8
#define VINCI_SELFTEST_RECV_FD 9

static void report(const char *text) {
    size_t length = 0;
    while (text[length] != '\0') length++;
    (void)vinci_raw_syscall6(__NR_write, 2, (long)text, (long)length, 0, 0, 0);
}

static int parse_unsigned(const char *text, long *out) {
    long value = 0;
    if (text[0] == '\0') return -1;
    for (size_t index = 0; text[index] != '\0'; index++) {
        if (text[index] < '0' || text[index] > '9') return -1;
        value = value * 10 + (text[index] - '0');
    }
    *out = value;
    return 0;
}

int vinci_trampoline_main(int argc, char **argv);

int vinci_trampoline_main(int argc, char **argv) {
    /* 1. the entry stub marshalled argc/argv off the initial stack */
    if (argc != 3) { report("check 1: argc\n"); return 1; }

    long expected_pid = 0;
    long expected_ppid = 0;
    if (parse_unsigned(argv[1], &expected_pid) != 0) { report("check 2: pid argument\n"); return 2; }
    if (parse_unsigned(argv[2], &expected_ppid) != 0) { report("check 3: ppid argument\n"); return 3; }

    /* 4/5. raw getpid/getppid must agree with glibc's answer from before exec */
    if ((long)getpid() != expected_pid) { report("check 4: getpid disagrees with glibc\n"); return 4; }
    if ((long)getppid() != expected_ppid) { report("check 5: getppid disagrees with glibc\n"); return 5; }

    /* 6. errno convention: -4095..-1 becomes -1 with errno set */
    if (close(999) != -1) { report("check 6: close(999) did not fail\n"); return 6; }
    if (errno != EBADF) { report("check 7: close(999) errno is not EBADF\n"); return 7; }

    /* 8. fcntl varargs path on an inherited descriptor */
    if (fcntl(VINCI_SELFTEST_FD, F_GETFD) < 0) { report("check 8: fcntl F_GETFD\n"); return 8; }

    /* 9/10. fstat: kernel struct layout and size agreement */
    struct stat metadata;
    memset(&metadata, 0, sizeof(metadata));
    if (fstat(VINCI_SELFTEST_FD, &metadata) != 0) { report("check 9: fstat\n"); return 9; }
    if (metadata.st_size != VINCI_SELFTEST_LENGTH) { report("check 10: fstat st_size\n"); return 10; }

    /* 11/12. pread's fourth argument is the OFFSET: a register-order error here
       reads the right bytes from the wrong place and is otherwise silent. */
    uint8_t buffer[16];
    memset(buffer, 0, sizeof(buffer));
    if (pread(VINCI_SELFTEST_FD, buffer, sizeof(buffer), 8) != (ssize_t)sizeof(buffer)) {
        report("check 11: pread short read\n");
        return 11;
    }
    for (size_t index = 0; index < sizeof(buffer); index++) {
        if (buffer[index] != (uint8_t)(8 + index)) { report("check 12: pread offset\n"); return 12; }
    }

    /* 13. sigprocmask with the kernel's 8-byte sigsetsize */
    sigset_t blocked;
    sigset_t previous;
    sigfillset(&blocked);
    if (sigprocmask(SIG_SETMASK, &blocked, &previous) != 0) { report("check 13: sigprocmask\n"); return 13; }
    if (sigprocmask(SIG_SETMASK, &previous, NULL) != 0) { report("check 14: sigprocmask restore\n"); return 14; }

    /* 15-18. the freestanding mem/str replacements */
    uint8_t source[8] = { 1, 2, 3, 4, 5, 6, 7, 8 };
    uint8_t destination[8];
    memset(destination, 0, sizeof(destination));
    memcpy(destination, source, sizeof(source));
    if (memcmp(destination, source, sizeof(source)) != 0) { report("check 15: memcpy/memcmp\n"); return 15; }
    memset(destination, 0xab, sizeof(destination));
    for (size_t index = 0; index < sizeof(destination); index++) {
        if (destination[index] != 0xab) { report("check 16: memset\n"); return 16; }
    }
    if (strlen("vinci") != 5) { report("check 17: strlen\n"); return 17; }
    if (strcmp("vinci", "vinci") != 0 || strcmp("vinci", "vincj") >= 0) { report("check 18: strcmp\n"); return 18; }

    /* 19/20. fcntl's ARG-READING variadic branch. Every other check uses the
       no-arg F_GETFD path, so without this a regression in the va_arg branch
       the trampoline actually relies on for F_SETFD would pass silently. */
    if (fcntl(VINCI_SELFTEST_FD, F_SETFD, FD_CLOEXEC) != 0) { report("check 19: fcntl F_SETFD\n"); return 19; }
    if ((fcntl(VINCI_SELFTEST_FD, F_GETFD) & FD_CLOEXEC) != FD_CLOEXEC) { report("check 20: F_SETFD did not take\n"); return 20; }

    /* 21. prctl, with all four option arguments as the wrapper's contract requires. */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) { report("check 21: prctl PR_SET_NO_NEW_PRIVS\n"); return 21; }

    /* 22-24. sendmsg/recvmsg over the harness's SOCK_SEQPACKET pair - the exact
       transport the trampoline's protocol uses. A wrong register or __NR_ here
       would corrupt every mediated message rather than fail loudly. */
    uint8_t outgoing[12];
    for (size_t index = 0; index < sizeof(outgoing); index++) outgoing[index] = (uint8_t)(0x40 + index);
    struct iovec send_vector = { .iov_base = outgoing, .iov_len = sizeof(outgoing) };
    struct msghdr send_message;
    memset(&send_message, 0, sizeof(send_message));
    send_message.msg_iov = &send_vector;
    send_message.msg_iovlen = 1;
    if (sendmsg(VINCI_SELFTEST_SEND_FD, &send_message, 0) != (ssize_t)sizeof(outgoing)) {
        report("check 22: sendmsg\n");
        return 22;
    }
    uint8_t incoming[12];
    memset(incoming, 0, sizeof(incoming));
    struct iovec receive_vector = { .iov_base = incoming, .iov_len = sizeof(incoming) };
    struct msghdr receive_message;
    memset(&receive_message, 0, sizeof(receive_message));
    receive_message.msg_iov = &receive_vector;
    receive_message.msg_iovlen = 1;
    if (recvmsg(VINCI_SELFTEST_RECV_FD, &receive_message, 0) != (ssize_t)sizeof(incoming)) {
        report("check 23: recvmsg\n");
        return 23;
    }
    if (memcmp(incoming, outgoing, sizeof(outgoing)) != 0) { report("check 24: payload mismatch\n"); return 24; }

    report("trampoline runtime selftest: all checks passed\n");
    return 0;
}
