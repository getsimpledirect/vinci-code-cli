/* Hosted half of the freestanding-runtime known-answer test.
 *
 * Builds a 64-byte file whose byte at offset N is N, hands it to the hermetic
 * selftest on a fixed descriptor, and passes the child's pid and ppid as
 * GLIBC reported them before exec. The child recomputes both through
 * vinci_raw_syscall6, so the raw path is checked against an independent
 * implementation. Exit status is the child's: 0, or the first failing check. */

#define _GNU_SOURCE

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#define VINCI_SELFTEST_FD 7
#define VINCI_SELFTEST_LENGTH 64
#define VINCI_SELFTEST_SEND_FD 8
#define VINCI_SELFTEST_RECV_FD 9

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s <path-to-hermetic-selftest>\n", argv[0]);
        return 2;
    }

    char path[] = "/tmp/vinci-runtime-selftest.XXXXXX";
    int fd = mkstemp(path);
    if (fd < 0) { perror("mkstemp"); return 2; }
    if (unlink(path) != 0) { perror("unlink"); return 2; }

    unsigned char bytes[VINCI_SELFTEST_LENGTH];
    for (int index = 0; index < VINCI_SELFTEST_LENGTH; index++) bytes[index] = (unsigned char)index;
    if (write(fd, bytes, sizeof(bytes)) != (ssize_t)sizeof(bytes)) { perror("write"); return 2; }

    /* SOCK_SEQPACKET is the transport the trampoline protocol actually uses. */
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET, 0, pair) != 0) { perror("socketpair"); return 2; }

    pid_t child = fork();
    if (child < 0) { perror("fork"); return 2; }

    if (child == 0) {
        if (dup2(fd, VINCI_SELFTEST_FD) != VINCI_SELFTEST_FD) { perror("dup2"); _exit(2); }
        if (dup2(pair[0], VINCI_SELFTEST_SEND_FD) != VINCI_SELFTEST_SEND_FD) { perror("dup2 send"); _exit(2); }
        if (dup2(pair[1], VINCI_SELFTEST_RECV_FD) != VINCI_SELFTEST_RECV_FD) { perror("dup2 recv"); _exit(2); }
        char pid_text[32];
        char ppid_text[32];
        snprintf(pid_text, sizeof(pid_text), "%ld", (long)getpid());
        snprintf(ppid_text, sizeof(ppid_text), "%ld", (long)getppid());
        char *child_argv[] = { argv[1], pid_text, ppid_text, NULL };
        execv(argv[1], child_argv);
        perror("execv");
        _exit(2);
    }

    /* Hard ceiling. This gate runs in CI, so a child that blocks must fail the
       build rather than wedge it: a broken sendmsg wrapper once left the child
       waiting on a receive that could never arrive. */
    int status = 0;
    alarm(30);
    pid_t waited = waitpid(child, &status, 0);
    if (waited != child) {
        kill(child, SIGKILL);
        waitpid(child, NULL, 0);
        fprintf(stderr, "hermetic selftest did not finish within 30s\n");
        return 2;
    }
    alarm(0);
    if (!WIFEXITED(status)) {
        fprintf(stderr, "hermetic selftest did not exit normally (status %d)\n", status);
        return 2;
    }
    if (WEXITSTATUS(status) != 0) {
        fprintf(stderr, "hermetic selftest failed at check %d\n", WEXITSTATUS(status));
        return 1;
    }
    return 0;
}
