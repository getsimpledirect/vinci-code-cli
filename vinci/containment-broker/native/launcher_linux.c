#define _GNU_SOURCE

#ifndef __linux__
#error "the containment launcher is Linux-only"
#endif

#include "launcher_linux.h"
#include "protocol.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/sched.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef CLOSE_RANGE_UNSHARE
#define CLOSE_RANGE_UNSHARE (1u << 1u)
#endif

static int valid_fd(int fd) {
    return fd >= 0 && fcntl(fd, F_GETFD) >= 0;
}

static void reset_task(struct vinci_broker_task *task) {
    task->pid = -1; task->pidfd = -1; task->expected_parent = -1; task->target_uid = 0; task->target_gid = 0; task->cgroup_fd = -1;
    task->control_fd = -1; task->target_attestation_fd = -1; task->target_attestation_source_fd = -1;
    task->target_attestation_key_fd = -1; task->target_attestation_context_fd = -1;
}

int vinci_broker_task_close(struct vinci_broker_task *task) {
    if (task == NULL) return -EINVAL;
    const int descriptors[] = { task->pidfd, task->cgroup_fd, task->control_fd, task->target_attestation_fd,
        task->target_attestation_source_fd, task->target_attestation_key_fd,
        task->target_attestation_context_fd };
    int result = 0;
    for (size_t index = 0; index < sizeof(descriptors) / sizeof(descriptors[0]); index++) {
        if (descriptors[index] >= 0 && close(descriptors[index]) != 0 && result == 0) result = -errno;
    }
    reset_task(task); return result;
}

static int remap_fd(int source, int target, int flags) {
    if (source == target) {
        int current = fcntl(target, F_GETFD);
        if (current < 0) return -errno;
        int desired = flags == O_CLOEXEC ? current | FD_CLOEXEC : current & ~FD_CLOEXEC;
        return fcntl(target, F_SETFD, desired) == 0 ? 0 : -errno;
    }
    return dup3(source, target, flags) == target ? 0 : -errno;
}

static int socketpair_above_fixed(int pair[2]) {
    int raw[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, raw) != 0) return -errno;
    pair[0] = fcntl(raw[0], F_DUPFD_CLOEXEC, VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD + 1);
    pair[1] = fcntl(raw[1], F_DUPFD_CLOEXEC, VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD + 1);
    int saved = errno; close(raw[0]); close(raw[1]);
    if (pair[0] < 0 || pair[1] < 0) {
        if (pair[0] >= 0) close(pair[0]);
        if (pair[1] >= 0) close(pair[1]);
        return -saved;
    }
    return 0;
}

static void child_fail(void) {
    _exit(125);
}

static int kill_and_reap_exact(struct vinci_broker_task *task) {
#ifndef __NR_pidfd_send_signal
    (void)task; return -ENOSYS;
#else
    if (syscall(__NR_pidfd_send_signal, task->pidfd, SIGKILL, NULL, 0) != 0 && errno != ESRCH) return -errno;
    struct pollfd descriptor = { .fd = task->pidfd, .events = POLLIN };
    int ready = poll(&descriptor, 1, 5000); if (ready <= 0 || (descriptor.revents & POLLIN) == 0) return ready == 0 ? -ETIMEDOUT : -EIO;
    siginfo_t info; memset(&info, 0, sizeof(info));
    if (waitid(P_PIDFD, (id_t)task->pidfd, &info, WEXITED) != 0 || info.si_pid != task->pid) return -ECHILD;
    return 0;
#endif
}

static void enter_fixed_trampoline(const struct vinci_broker_launch_fds *fds,
                                   const struct vinci_broker_launch_identity *identity,
                                   int control_child_fd, pid_t expected_parent) {
    (void)identity;
    if (remap_fd(fds->standard_input, STDIN_FILENO, 0) != 0
        || remap_fd(fds->standard_output, STDOUT_FILENO, 0) != 0
        || remap_fd(fds->standard_error, STDERR_FILENO, 0) != 0
        || remap_fd(control_child_fd, VINCI_BROKER_CONTROL_FD, 0) != 0
        || remap_fd(fds->executable, VINCI_BROKER_EXECUTABLE_FD, 0) != 0
        || remap_fd(fds->trampoline, VINCI_BROKER_TRAMPOLINE_FD, 0) != 0
        || remap_fd(fds->receipt_verifier, VINCI_BROKER_RECEIPT_VERIFIER_FD, 0) != 0
        || remap_fd(fds->executable_provenance, VINCI_BROKER_EXECUTABLE_PROVENANCE_FD, 0) != 0
        || remap_fd(fds->trampoline_build_receipt, VINCI_BROKER_TRAMPOLINE_BUILD_RECEIPT_FD, 0) != 0
        || remap_fd(fds->target_attestation_key, VINCI_BROKER_TARGET_ATTESTATION_KEY_FD, 0) != 0
        || remap_fd(fds->target_attestation_context, VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD, 0) != 0) child_fail();
    if ((close(VINCI_BROKER_NOTIFICATION_FD) != 0 && errno != EBADF)
        || (close(VINCI_BROKER_TARGET_ATTESTATION_FD) != 0 && errno != EBADF)) child_fail();
#ifdef __NR_close_range
    if (syscall(__NR_close_range, VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD + 1u, UINT_MAX, CLOSE_RANGE_UNSHARE) != 0) child_fail();
#else
    child_fail();
#endif
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != expected_parent) child_fail();
    char *const argv[] = { (char *)"vinci-containment-trampoline", (char *)"--vinci-trampoline-v4", NULL };
    char *const environment[] = { NULL };
    syscall(__NR_execveat, VINCI_BROKER_TRAMPOLINE_FD, "", argv, environment, AT_EMPTY_PATH);
    child_fail();
}

int vinci_clone_into_cgroup(const struct vinci_broker_launch_fds *fds,
                            const struct vinci_broker_launch_identity *identity,
                            struct vinci_broker_task *task) {
    if (fds == NULL || identity == NULL || task == NULL || identity->uid == 0 || identity->gid == 0) return -EINVAL;
    reset_task(task);
    const int descriptors[] = {
        fds->cgroup, fds->executable, fds->trampoline, fds->receipt_verifier,
        fds->executable_provenance, fds->trampoline_build_receipt,
        fds->target_attestation_key, fds->target_attestation_context,
        fds->standard_input, fds->standard_output, fds->standard_error,
    };
    for (size_t index = 0; index < sizeof(descriptors) / sizeof(descriptors[0]); index++) {
        if (!valid_fd(descriptors[index]) || descriptors[index] <= VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD) return -EBADF;
        for (size_t prior = 0; prior < index; prior++) if (descriptors[prior] == descriptors[index]) return -EINVAL;
    }
    pid_t expected_parent = getpid();
    if (expected_parent <= 1) return -EPERM;
    int control_pair[2] = { -1, -1 }, attestation_pair[2] = { -1, -1 };
    int pair_result = socketpair_above_fixed(control_pair);
    if (pair_result == 0) pair_result = socketpair_above_fixed(attestation_pair);
    if (pair_result != 0) {
        if (control_pair[0] >= 0) close(control_pair[0]);
        if (control_pair[1] >= 0) close(control_pair[1]);
        if (attestation_pair[0] >= 0) close(attestation_pair[0]);
        if (attestation_pair[1] >= 0) close(attestation_pair[1]);
        return pair_result;
    }
    task->cgroup_fd = fcntl(fds->cgroup, F_DUPFD_CLOEXEC, 13);
    task->control_fd = control_pair[0]; task->target_attestation_fd = attestation_pair[0];
    task->target_attestation_source_fd = attestation_pair[1];
    task->target_attestation_key_fd = fcntl(fds->target_attestation_key, F_DUPFD_CLOEXEC, 13);
    task->target_attestation_context_fd = fcntl(fds->target_attestation_context, F_DUPFD_CLOEXEC, 13);
    if (task->cgroup_fd < 0
        || task->target_attestation_key_fd < 0 || task->target_attestation_context_fd < 0) {
        int saved = errno; close(control_pair[1]); vinci_broker_task_close(task); return -saved;
    }
    int pidfd = -1;
    sigset_t blocked, previous;
    if (sigfillset(&blocked) != 0 || sigprocmask(SIG_SETMASK, &blocked, &previous) != 0) {
        int saved = errno; close(control_pair[1]); vinci_broker_task_close(task); return -saved;
    }
    struct clone_args arguments = {
        .flags = CLONE_INTO_CGROUP | CLONE_PIDFD | CLONE_CLEAR_SIGHAND,
        .pidfd = (uintptr_t)&pidfd,
        .exit_signal = SIGCHLD,
        .cgroup = (uint64_t)fds->cgroup,
    };
    long result = syscall(__NR_clone3, &arguments, sizeof(arguments));
    if (result < 0) { int saved = errno; sigprocmask(SIG_SETMASK, &previous, NULL); close(control_pair[1]); vinci_broker_task_close(task); return -saved; }
    if (result == 0) enter_fixed_trampoline(fds, identity, control_pair[1], expected_parent);
    close(control_pair[1]);
    task->pid = (pid_t)result; task->pidfd = pidfd; task->expected_parent = expected_parent;
    task->target_uid = identity->uid; task->target_gid = identity->gid;
    if (sigprocmask(SIG_SETMASK, &previous, NULL) != 0) {
        int saved = errno;
        if (kill_and_reap_exact(task) != 0) return -EOWNERDEAD;
        vinci_broker_task_close(task); return -saved;
    }
    return 0;
}
