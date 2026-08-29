#define _GNU_SOURCE

#ifndef __linux__
#error "the containment trampoline is Linux-only"
#endif

#include "protocol.h"
#include "sha256.h"
#include "trampoline_runtime_linux.h"

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__)
#define VINCI_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define VINCI_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "unsupported Linux architecture"
#endif

static int receive_packet(int fd, void *buffer, size_t capacity, size_t *received) {
    struct iovec vector = { .iov_base = buffer, .iov_len = capacity };
    uint8_t control[CMSG_SPACE(sizeof(int))];
    struct msghdr message = { .msg_iov = &vector, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof(control) };
    ssize_t count = recvmsg(fd, &message, MSG_CMSG_CLOEXEC);
    if (count < 0) return -errno;
    if ((message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) != 0 || CMSG_FIRSTHDR(&message) != NULL) return -EPROTO;
    *received = (size_t)count;
    return 0;
}

static int send_packet(int fd, const void *buffer, size_t length) {
    struct iovec vector = { .iov_base = (void *)buffer, .iov_len = length };
    struct msghdr message = { .msg_iov = &vector, .msg_iovlen = 1 };
    ssize_t count = sendmsg(fd, &message, MSG_NOSIGNAL);
    if (count < 0) return -errno;
    return (size_t)count == length ? 0 : -EIO;
}

/* Every nonterminal syscall is mediated. Only process termination and signal return are intrinsically safe. */
static int install_release_mediator(void) {
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, VINCI_AUDIT_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_exit, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_exit_group, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_rt_sigreturn, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
    };
    struct sock_fprog program = { .len = (unsigned short)(sizeof(instructions) / sizeof(instructions[0])), .filter = instructions };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -errno;
    int listener = (int)vinci_raw_syscall6(__NR_seccomp, SECCOMP_SET_MODE_FILTER,
                                           SECCOMP_FILTER_FLAG_NEW_LISTENER, (long)&program, 0, 0, 0);
    /* vinci_raw_syscall6 is the bare stub: it RETURNS the negative errno and never
     * sets the shim's errno storage, which only checked() does. `return -errno`
     * here therefore returned -0 == 0 on failure, the caller's `< 0` test read
     * that as success, and the trampoline continued with NO user-notification
     * filter installed. Fail-open. Return the raw result, which is already -errno. */
    if (listener < 0) return listener;
    if (listener != VINCI_BROKER_NOTIFICATION_FD) { close(listener); return -EBUSY; }
    return listener;
}

static int sealed_immutable_memfd(int fd, struct stat *metadata, int executable_object) {
    if (fstat(fd, metadata) != 0 || !S_ISREG(metadata->st_mode) || metadata->st_nlink != 0
        || (metadata->st_mode & (S_ISUID | S_ISGID)) != 0) return 0;
    int seals = fcntl(fd, F_GET_SEALS);
    int required = F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL;
#ifdef F_SEAL_EXEC
    if (executable_object) required |= F_SEAL_EXEC;
#else
    if (executable_object) return 0;
#endif
    return seals >= 0 && (seals & required) == required;
}

static uint32_t load_u32(const uint8_t *input) {
    return ((uint32_t)input[0] << 24u) | ((uint32_t)input[1] << 16u)
        | ((uint32_t)input[2] << 8u) | (uint32_t)input[3];
}

static uint64_t load_u64(const uint8_t *input) {
    uint64_t value = 0; for (size_t index = 0; index < 8u; index++) value = (value << 8u) | input[index]; return value;
}

static int valid_object_receipt(int fd, uint32_t object_type, const uint8_t object_digest[32], const uint8_t key[32]) {
    uint8_t wire[VINCI_BROKER_OBJECT_RECEIPT_WIRE_BYTES], expected[32], reserved = 0;
    if (pread(fd, wire, sizeof(wire), 0) != (ssize_t)sizeof(wire)) return 0;
    for (size_t index = 120u; index < sizeof(wire); index++) reserved |= wire[index];
    if (reserved != 0 || load_u64(wire) != UINT64_C(0x56494e434f424a52) || load_u32(wire + 8u) != 4u
        || load_u32(wire + 12u) != sizeof(wire) || load_u32(wire + 16u) != object_type || load_u32(wire + 20u) != 0
        || memcmp(wire + 24u, object_digest, 32u) != 0
        || vinci_hmac_sha256(key, 32u, wire, 88u, expected) != 0 || memcmp(expected, wire + 88u, 32u) != 0) return 0;
    return 1;
}

static int valid_target_context(int fd, const struct vinci_broker_hello *hello, const uint8_t key[32]) {
    uint8_t wire[VINCI_BROKER_TARGET_CONTEXT_WIRE_BYTES], expected[32], reserved = 0;
    if (pread(fd, wire, sizeof(wire), 0) != (ssize_t)sizeof(wire)) return 0;
    for (size_t index = 184u; index < sizeof(wire); index++) reserved |= wire[index];
    return reserved == 0 && load_u64(wire) == UINT64_C(0x56494e4354435458) && load_u32(wire + 8u) == 4u
        && load_u32(wire + 12u) == sizeof(wire) && load_u64(wire + 16u) == hello->attempt_identity
        && memcmp(wire + 24u, hello->nonce, 32u) == 0 && memcmp(wire + 56u, hello->session_identity_sha256, 32u) == 0
        && memcmp(wire + 88u, hello->executable_sha256, 32u) == 0 && memcmp(wire + 120u, hello->target_attestation_key_id, 32u) == 0
        && vinci_hmac_sha256(key, 32u, wire, 152u, expected) == 0 && memcmp(expected, wire + 152u, 32u) == 0;
}

static int nonzero(const uint8_t *bytes, size_t length) {
    uint8_t aggregate = 0;
    for (size_t index = 0; index < length; index++) aggregate |= bytes[index];
    return aggregate != 0;
}

static int valid_env_name(const uint8_t *bytes, size_t length) {
    if (length == 0 || !((bytes[0] >= 'A' && bytes[0] <= 'Z') || (bytes[0] >= 'a' && bytes[0] <= 'z') || bytes[0] == '_')) return 0;
    for (size_t index = 1; index < length; index++) {
        uint8_t value = bytes[index];
        if (!((value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
            || (value >= '0' && value <= '9') || value == '_')) return 0;
    }
    return 1;
}

static int dangerous_environment_name(const uint8_t *name, size_t length) {
    static const char *const exact[] = {
        "BASH_ENV", "ENV", "GCONV_PATH", "GLIBC_TUNABLES", "MALLOC_TRACE", "NODE_OPTIONS",
        "PERL5OPT", "PYTHONHOME", "PYTHONPATH", "RUBYOPT",
    };
    if ((length >= 3u && memcmp(name, "LD_", 3u) == 0) || (length >= 5u && memcmp(name, "DYLD_", 5u) == 0)) return 1;
    for (size_t index = 0; index < sizeof(exact) / sizeof(exact[0]); index++) {
        size_t expected = strlen(exact[index]);
        if (length == expected && memcmp(name, exact[index], length) == 0) return 1;
    }
    return 0;
}

static int parse_release(const uint8_t *packet, size_t packet_bytes, const struct vinci_broker_hello *hello,
                         const struct vinci_broker_prelaunch_commit *commit,
                         char *argv[VINCI_BROKER_MAX_ARGC + 1u], char *environment[VINCI_BROKER_MAX_ENVC + 1u],
                         char storage[VINCI_BROKER_MAX_RELEASE_BYTES + VINCI_BROKER_MAX_ARGC + VINCI_BROKER_MAX_ENVC]) {
    struct vinci_broker_release release;
    if (packet_bytes < VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES
        || vinci_protocol_decode_release_header(&release, packet, VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES) != 0
        || release.payload_bytes != packet_bytes - VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES
        || release.payload_bytes > hello->max_release_bytes || release.argc == 0 || release.argc > VINCI_BROKER_MAX_ARGC
        || release.envc > VINCI_BROKER_MAX_ENVC || memcmp(release.nonce, hello->nonce, 32u) != 0
        || memcmp(release.session_identity_sha256, hello->session_identity_sha256, 32u) != 0
        || memcmp(release.prelaunch_receipt_sha256, commit->receipt_body_sha256, 32u) != 0
        || memcmp(release.argv_environment_sha256, hello->argv_environment_sha256, 32u) != 0) return -EPROTO;
    const uint8_t *payload = packet + VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES;
    uint8_t payload_digest[32]; struct vinci_sha256_context context;
    vinci_sha256_init(&context); vinci_sha256_update(&context, payload, release.payload_bytes); vinci_sha256_final(&context, payload_digest);
    if (memcmp(payload_digest, release.argv_environment_sha256, 32u) != 0) return -EPROTO;
    uint32_t count = release.argc + release.envc;
    size_t table_bytes = (size_t)count * VINCI_BROKER_SLICE_WIRE_BYTES;
    if (count < release.argc || table_bytes > release.payload_bytes) return -EPROTO;
    const uint8_t *strings = payload + table_bytes; size_t strings_bytes = release.payload_bytes - table_bytes;
    size_t expected_offset = 0, storage_offset = 0;
    const uint8_t *env_names[VINCI_BROKER_MAX_ENVC]; size_t env_name_lengths[VINCI_BROKER_MAX_ENVC];
    for (uint32_t index = 0; index < count; index++) {
        struct vinci_broker_slice slice;
        if (vinci_protocol_decode_slice(&slice, payload + (size_t)index * VINCI_BROKER_SLICE_WIRE_BYTES,
                                        VINCI_BROKER_SLICE_WIRE_BYTES) != 0
            || slice.length == 0 || slice.offset != expected_offset || slice.length > strings_bytes - expected_offset
            || memchr(strings + slice.offset, '\0', slice.length) != NULL
            || storage_offset > sizeof(char) * (VINCI_BROKER_MAX_RELEASE_BYTES + VINCI_BROKER_MAX_ARGC + VINCI_BROKER_MAX_ENVC)
                - ((size_t)slice.length + 1u)) return -EPROTO;
        const uint8_t *source = strings + slice.offset;
        char *value = storage + storage_offset; memcpy(value, source, slice.length); value[slice.length] = '\0';
        if (index < release.argc) argv[index] = value;
        else {
            const uint8_t *equals = memchr(source, '=', slice.length);
            size_t name_length = equals == NULL ? 0u : (size_t)(equals - source);
            if (equals == NULL || !valid_env_name(source, name_length) || dangerous_environment_name(source, name_length)) return -EPROTO;
            size_t env_index = index - release.argc;
            for (size_t prior = 0; prior < env_index; prior++) {
                if (env_name_lengths[prior] == name_length && memcmp(env_names[prior], source, name_length) == 0) return -EPROTO;
            }
            env_names[env_index] = source; env_name_lengths[env_index] = name_length; environment[env_index] = value;
        }
        expected_offset += slice.length; storage_offset += (size_t)slice.length + 1u;
    }
    if (expected_offset != strings_bytes || argv[0][0] == '\0') return -EPROTO;
    argv[release.argc] = NULL; environment[release.envc] = NULL; return 0;
}

int vinci_trampoline_main(int argc, char **argv) {
    if (argc != 2 || strcmp(argv[1], "--vinci-trampoline-v4") != 0) return 125;
    struct stat executable, trampoline, verifier, executable_provenance, trampoline_build, target_key, target_context;
    uint8_t executable_digest[32], trampoline_digest[32], verifier_digest[32], executable_provenance_digest[32], trampoline_build_digest[32];
    uint8_t target_key_digest[32], target_context_digest[32], target_attestation_key[32];
    uint8_t verifier_key[32]; pid_t own_pid = getpid(); pid_t expected_parent = getppid();
    if (expected_parent <= 1) return 125;
    if (!sealed_immutable_memfd(VINCI_BROKER_EXECUTABLE_FD, &executable, 1)
        || !sealed_immutable_memfd(VINCI_BROKER_TRAMPOLINE_FD, &trampoline, 1)
        || !sealed_immutable_memfd(VINCI_BROKER_RECEIPT_VERIFIER_FD, &verifier, 0)
        || !sealed_immutable_memfd(VINCI_BROKER_EXECUTABLE_PROVENANCE_FD, &executable_provenance, 0)
        || !sealed_immutable_memfd(VINCI_BROKER_TRAMPOLINE_BUILD_RECEIPT_FD, &trampoline_build, 0)
        || !sealed_immutable_memfd(VINCI_BROKER_TARGET_ATTESTATION_KEY_FD, &target_key, 0)
        || !sealed_immutable_memfd(VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD, &target_context, 0)
        || vinci_sha256_fd(VINCI_BROKER_EXECUTABLE_FD, executable_digest) != 0
        || vinci_sha256_fd(VINCI_BROKER_TRAMPOLINE_FD, trampoline_digest) != 0
        || vinci_sha256_fd(VINCI_BROKER_RECEIPT_VERIFIER_FD, verifier_digest) != 0
        || vinci_sha256_fd(VINCI_BROKER_EXECUTABLE_PROVENANCE_FD, executable_provenance_digest) != 0
        || vinci_sha256_fd(VINCI_BROKER_TRAMPOLINE_BUILD_RECEIPT_FD, trampoline_build_digest) != 0
        || vinci_sha256_fd(VINCI_BROKER_TARGET_ATTESTATION_KEY_FD, target_key_digest) != 0
        || vinci_sha256_fd(VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD, target_context_digest) != 0
        || pread(VINCI_BROKER_RECEIPT_VERIFIER_FD, verifier_key, sizeof(verifier_key), 0) != (ssize_t)sizeof(verifier_key)
        || pread(VINCI_BROKER_TARGET_ATTESTATION_KEY_FD, target_attestation_key, sizeof(target_attestation_key), 0)
            != (ssize_t)sizeof(target_attestation_key)) return 125;
    if (!valid_object_receipt(VINCI_BROKER_EXECUTABLE_PROVENANCE_FD, 1u, executable_digest, verifier_key)
        || !valid_object_receipt(VINCI_BROKER_TRAMPOLINE_BUILD_RECEIPT_FD, 2u, trampoline_digest, verifier_key)) return 125;
    sigset_t blocked; if (sigfillset(&blocked) != 0 || sigprocmask(SIG_SETMASK, &blocked, NULL) != 0) return 125;
    int notification_listener = install_release_mediator(); if (notification_listener < 0) return 125;

    uint8_t hello_wire[VINCI_BROKER_HELLO_WIRE_BYTES]; size_t hello_bytes = 0; struct vinci_broker_hello hello;
    /* First post-filter syscall: the broker copies fd6 while this recvmsg is blocked. */
    if (receive_packet(VINCI_BROKER_CONTROL_FD, hello_wire, sizeof(hello_wire), &hello_bytes) != 0
        || vinci_protocol_decode_hello(&hello, hello_wire, hello_bytes) != 0 || hello.max_release_bytes == 0
        || hello.max_release_bytes > VINCI_BROKER_MAX_RELEASE_BYTES
        || hello.target_uid == 0 || hello.target_gid == 0 || hello.expected_parent_pid != expected_parent
        || memcmp(hello.receipt_key_id, verifier_digest, sizeof(verifier_digest)) != 0
        || memcmp(hello.executable_provenance_sha256, executable_provenance_digest, 32u) != 0
        || memcmp(hello.trampoline_build_receipt_sha256, trampoline_build_digest, 32u) != 0
        || memcmp(hello.target_attestation_key_id, target_key_digest, 32u) != 0
        || memcmp(hello.target_attestation_context_sha256, target_context_digest, 32u) != 0
        || memcmp(hello.trampoline_sha256, trampoline_digest, 32u) != 0
        || memcmp(hello.executable_sha256, executable_digest, 32u) != 0) return 125;
    if (!valid_target_context(VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD, &hello, target_attestation_key)) return 125;
    memset(target_attestation_key, 0, sizeof(target_attestation_key));

    /* The broker copy is now authoritative; the child must prove fd6 cannot be reused before credential drop. */
    if (close(notification_listener) != 0 || setgroups(0, NULL) != 0
        || setresgid((gid_t)hello.target_gid, (gid_t)hello.target_gid, (gid_t)hello.target_gid) != 0
        || setresuid((uid_t)hello.target_uid, (uid_t)hello.target_uid, (uid_t)hello.target_uid) != 0
        || prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0 || getppid() != expected_parent
        || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) return 125;

    struct vinci_trampoline_report report; memset(&report, 0, sizeof(report)); report.pid = own_pid;
    report.uid = hello.target_uid; report.gid = hello.target_gid; report.no_new_privs = 1;
    memcpy(report.nonce, hello.nonce, 32u); memcpy(report.session_identity_sha256, hello.session_identity_sha256, 32u);
    memcpy(report.trampoline_sha256, trampoline_digest, 32u); memcpy(report.executable_sha256, executable_digest, 32u);
    uint8_t report_wire[VINCI_BROKER_REPORT_WIRE_BYTES];
    if (vinci_protocol_encode_report(report_wire, &report) != 0 || send_packet(VINCI_BROKER_CONTROL_FD, report_wire, sizeof(report_wire)) != 0) return 125;

    uint8_t commit_wire[VINCI_BROKER_COMMIT_WIRE_BYTES]; size_t commit_bytes = 0; struct vinci_broker_prelaunch_commit commit;
    if (receive_packet(VINCI_BROKER_CONTROL_FD, commit_wire, sizeof(commit_wire), &commit_bytes) != 0
        || vinci_protocol_decode_commit(&commit, commit_wire, commit_bytes) != 0
        || commit.monotonic_deadline_ns != hello.monotonic_deadline_ns || commit.attempt_identity != hello.attempt_identity
        || memcmp(commit.nonce, hello.nonce, 32u) != 0
        || memcmp(commit.session_identity_sha256, hello.session_identity_sha256, 32u) != 0
        || memcmp(commit.receipt_key_id, hello.receipt_key_id, 32u) != 0
        || !nonzero(commit.receipt_body_sha256, 32u) || !nonzero(commit.receipt_hmac_sha256, 32u)) return 125;
    struct vinci_broker_prelaunch_commit authenticated_commit = commit;
    memset(authenticated_commit.receipt_hmac_sha256, 0, sizeof(authenticated_commit.receipt_hmac_sha256));
    uint8_t authenticated_wire[VINCI_BROKER_COMMIT_WIRE_BYTES], expected_hmac[32];
    if (vinci_protocol_encode_commit(authenticated_wire, &authenticated_commit) != 0
        || vinci_hmac_sha256(verifier_key, sizeof(verifier_key), authenticated_wire, sizeof(authenticated_wire), expected_hmac) != 0
        || memcmp(expected_hmac, commit.receipt_hmac_sha256, sizeof(expected_hmac)) != 0) return 125;
    memset(verifier_key, 0, sizeof(verifier_key));

    static uint8_t packet[VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES + VINCI_BROKER_MAX_RELEASE_BYTES];
    static char storage[VINCI_BROKER_MAX_RELEASE_BYTES + VINCI_BROKER_MAX_ARGC + VINCI_BROKER_MAX_ENVC];
    size_t packet_bytes = 0; char *episode_argv[VINCI_BROKER_MAX_ARGC + 1u]; char *episode_environment[VINCI_BROKER_MAX_ENVC + 1u];
    if (receive_packet(VINCI_BROKER_CONTROL_FD, packet, sizeof(packet), &packet_bytes) != 0
        || packet_bytes > VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES + hello.max_release_bytes
        || parse_release(packet, packet_bytes, &hello, &commit, episode_argv, episode_environment, storage) != 0) return 125;
    const int cloexec_fds[] = { VINCI_BROKER_CONTROL_FD, VINCI_BROKER_EXECUTABLE_FD,
        VINCI_BROKER_TRAMPOLINE_FD, VINCI_BROKER_RECEIPT_VERIFIER_FD,
        VINCI_BROKER_EXECUTABLE_PROVENANCE_FD, VINCI_BROKER_TRAMPOLINE_BUILD_RECEIPT_FD,
        VINCI_BROKER_TARGET_ATTESTATION_KEY_FD,
        VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD };
    for (size_t index = 0; index < sizeof(cloexec_fds) / sizeof(cloexec_fds[0]); index++) {
        int fd = cloexec_fds[index];
        int flags = fcntl(fd, F_GETFD); if (flags < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) != 0) return 125;
    }
    sigset_t clear; if (sigemptyset(&clear) != 0 || sigprocmask(SIG_SETMASK, &clear, NULL) != 0) return 125;
    vinci_raw_syscall6(__NR_execveat, VINCI_BROKER_EXECUTABLE_FD, (long)"", (long)episode_argv,
                       (long)episode_environment, AT_EMPTY_PATH, 0);
    return 125;
}
