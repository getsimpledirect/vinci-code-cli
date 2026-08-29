#define _GNU_SOURCE
#ifndef __linux__
#error "the containment broker session is Linux-only"
#endif

#include "session_linux.h"
#include "sha256.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/magic.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <sys/vfs.h>
#include <time.h>
#include <unistd.h>

#if defined(__x86_64__)
#define VINCI_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define VINCI_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "unsupported Linux architecture"
#endif

_Static_assert(sizeof(struct seccomp_notif) <= 256u, "pending notification storage is too small");

static void put32(uint8_t *output, uint32_t value) {
    output[0] = (uint8_t)(value >> 24u); output[1] = (uint8_t)(value >> 16u);
    output[2] = (uint8_t)(value >> 8u); output[3] = (uint8_t)value;
}

static void put64(uint8_t *output, uint64_t value) {
    for (size_t index = 0; index < 8u; index++) output[index] = (uint8_t)(value >> (56u - index * 8u));
}

static uint32_t get32(const uint8_t *input) {
    return ((uint32_t)input[0] << 24u) | ((uint32_t)input[1] << 16u) | ((uint32_t)input[2] << 8u) | input[3];
}

static uint64_t get64(const uint8_t *input) {
    uint64_t value = 0; for (size_t index = 0; index < 8u; index++) value = (value << 8u) | input[index]; return value;
}

static int nonzero(const uint8_t *bytes, size_t length) {
    uint8_t aggregate = 0; for (size_t index = 0; index < length; index++) aggregate |= bytes[index];
    return aggregate != 0;
}

static int zero_region(const uint8_t *bytes, size_t length) {
    uint8_t aggregate = 0; for (size_t index = 0; index < length; index++) aggregate |= bytes[index]; return aggregate == 0;
}

static int monotonic_now(uint64_t *now) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0 || value.tv_sec < 0) return -errno;
    if ((uint64_t)value.tv_sec > UINT64_MAX / UINT64_C(1000000000)) return -EOVERFLOW;
    *now = (uint64_t)value.tv_sec * UINT64_C(1000000000) + (uint64_t)value.tv_nsec;
    return 0;
}

static int remaining_milliseconds(const struct vinci_broker_session *session) {
    uint64_t now; int result = monotonic_now(&now);
    if (result != 0 || now >= session->hello.monotonic_deadline_ns) return 0;
    uint64_t remaining = session->hello.monotonic_deadline_ns - now;
    uint64_t rounded = (remaining + UINT64_C(999999)) / UINT64_C(1000000);
    return rounded > INT32_MAX ? INT32_MAX : (int)rounded;
}

static int pidfd_alive(const struct vinci_broker_session *session) {
#ifdef __NR_pidfd_send_signal
    if (syscall(__NR_pidfd_send_signal, session->pidfd, 0, NULL, 0) == 0) return 1;
    return errno == EPERM ? -EPERM : 0;
#else
    (void)session; return -ENOSYS;
#endif
}

static int wait_ready(const struct vinci_broker_session *session, int fd, short events) {
    int timeout = remaining_milliseconds(session); if (timeout <= 0) return -ETIMEDOUT;
    struct pollfd descriptors[2] = { { .fd = fd, .events = events }, { .fd = session->pidfd, .events = POLLIN } };
    int result = poll(descriptors, 2, timeout);
    if (result < 0) return -errno;
    if (result == 0) return -ETIMEDOUT;
    if (descriptors[1].revents != 0) return -ESRCH;
    if ((descriptors[0].revents & events) == 0) return -EIO;
    return 0;
}

static int send_deadline(struct vinci_broker_session *session, const void *buffer, size_t length) {
    for (;;) {
        struct iovec vector = { .iov_base = (void *)buffer, .iov_len = length };
        struct msghdr message = { .msg_iov = &vector, .msg_iovlen = 1 };
        ssize_t count = sendmsg(session->control_fd, &message, MSG_NOSIGNAL | MSG_DONTWAIT);
        if (count >= 0) return (size_t)count == length ? 0 : -EIO;
        if (errno != EAGAIN && errno != EWOULDBLOCK) return -errno;
        int result = wait_ready(session, session->control_fd, POLLOUT); if (result != 0) return result;
    }
}

static int receive_fd_deadline(struct vinci_broker_session *session, int fd, void *buffer, size_t exact_length) {
    for (;;) {
        uint8_t ancillary[32]; struct iovec vector = { .iov_base = buffer, .iov_len = exact_length };
        struct msghdr message = { .msg_iov = &vector, .msg_iovlen = 1, .msg_control = ancillary, .msg_controllen = sizeof(ancillary) };
        ssize_t count = recvmsg(fd, &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
        if (count >= 0) {
            return count == (ssize_t)exact_length && message.msg_flags == 0 && CMSG_FIRSTHDR(&message) == NULL ? 0 : -EPROTO;
        }
        if (errno != EAGAIN && errno != EWOULDBLOCK) return -errno;
        int result = wait_ready(session, fd, POLLIN); if (result != 0) return result;
    }
}

static int notification_seen(struct vinci_broker_session *session, uint64_t id) {
    if (session->has_last_notification_id && session->last_notification_id == id) return 1;
    session->last_notification_id = id; session->has_last_notification_id = 1; return 0;
}

static int receive_notification(struct vinci_broker_session *session) {
    if (session->pending_notification) return 0;
    int result = wait_ready(session, session->notification_fd, POLLIN); if (result != 0) return result;
    struct seccomp_notif request; memset(&request, 0, sizeof(request));
    if (ioctl(session->notification_fd, SECCOMP_IOCTL_NOTIF_RECV, &request) != 0) return -errno;
    if (request.pid != (uint32_t)session->pid || request.data.arch != VINCI_AUDIT_ARCH
        || notification_seen(session, request.id) != 0) return -ESTALE;
    memcpy(session->pending_notification_storage, &request, sizeof(request)); session->pending_notification = 1; return 0;
}

static int answer_pending(struct vinci_broker_session *session, uint32_t flags, int32_t error, int64_t value) {
    struct seccomp_notif request; memcpy(&request, session->pending_notification_storage, sizeof(request));
    if (!session->pending_notification || ioctl(session->notification_fd, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id) != 0) return -ESTALE;
    struct seccomp_notif_resp response = { .id = request.id, .val = value, .error = error, .flags = flags };
    if (ioctl(session->notification_fd, SECCOMP_IOCTL_NOTIF_SEND, &response) != 0) return -errno;
    session->pending_notification = 0; memset(session->pending_notification_storage, 0, sizeof(session->pending_notification_storage));
    return 0;
}

static int continue_exact(struct vinci_broker_session *session, int number, uint8_t argument_mask,
                          const uint64_t expected[6]) {
    int result = receive_notification(session); if (result != 0) return result;
    struct seccomp_notif request; memcpy(&request, session->pending_notification_storage, sizeof(request));
    if (request.data.nr != number) return -EPROTO;
    for (size_t index = 0; index < 6u; index++) if ((argument_mask & (1u << index)) != 0 && request.data.args[index] != expected[index]) return -EPROTO;
    return answer_pending(session, SECCOMP_USER_NOTIF_FLAG_CONTINUE, 0, 0);
}

static int classified_output_pointer_mask(int syscall_number) {
    switch (syscall_number) {
        case __NR_read: return 1u << 1u;
        case __NR_pread64: return 1u << 1u;
        case __NR_clock_gettime: return 1u << 1u;
#ifdef __NR_getrandom
        case __NR_getrandom: return 1u;
#endif
        default: return 0;
    }
}

static int classified_scalar_syscall(int syscall_number) {
    switch (syscall_number) {
        case __NR_getpid: case __NR_getppid: case __NR_getuid: case __NR_getgid: case __NR_close:
#ifdef __NR_geteuid
        case __NR_geteuid:
#endif
#ifdef __NR_getegid
        case __NR_getegid:
#endif
            return 1;
        default: return 0;
    }
}

static int validate_target_rules(const struct vinci_broker_target_rule *rules, size_t count) {
    if (rules == NULL || count == 0 || count > VINCI_BROKER_MAX_TARGET_RULES) return 0;
    for (size_t index = 0; index < count; index++) {
        const struct vinci_broker_target_rule *rule = &rules[index];
        if (rule->syscall_number < 0 || rule->reserved != 0 || rule->scalar_argument_mask > 63u
            || rule->output_pointer_mask > 63u || (rule->scalar_argument_mask & rule->output_pointer_mask) != 0
            || (index > 0 && rules[index - 1].syscall_number >= rule->syscall_number)) return 0;
        if (rule->action == VINCI_TARGET_CONTINUE_SCALAR
            && (rule->output_pointer_mask != 0 || !classified_scalar_syscall(rule->syscall_number))) return 0;
        if (rule->action == VINCI_TARGET_CONTINUE_OUTPUT_POINTER
            && rule->output_pointer_mask != classified_output_pointer_mask(rule->syscall_number)) return 0;
        if (rule->action == VINCI_TARGET_EMULATE_ERRNO && (rule->emulated_errno <= 0 || rule->emulated_errno > 4095)) return 0;
        if (rule->action < VINCI_TARGET_DENY || rule->action > VINCI_TARGET_EMULATE_ERRNO) return 0;
        switch (rule->syscall_number) {
#ifdef __NR_execve
            case __NR_execve:
#endif
            case __NR_execveat:
#ifdef __NR_open
            case __NR_open:
#endif
            case __NR_openat:
#ifdef __NR_openat2
            case __NR_openat2:
#endif
            case __NR_ioctl: case __NR_ptrace: case __NR_mount:
#ifdef __NR_bpf
            case __NR_bpf:
#endif
#ifdef __NR_clone3
            case __NR_clone3:
#endif
                if (rule->action == VINCI_TARGET_CONTINUE_SCALAR || rule->action == VINCI_TARGET_CONTINUE_OUTPUT_POINTER) return 0;
                break;
            default: break;
        }
    }
    return 1;
}

static int validate_key_fd(const struct vinci_broker_key_policy *policy, int fd, uint8_t key[32]) {
    struct stat metadata; uint8_t digest[32]; uint64_t now;
    if (policy->revoked || policy->generation == 0 || !nonzero(policy->provenance_sha256, 32u)
        || fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_nlink != 0
        || metadata.st_uid != policy->owner_uid || (metadata.st_mode & 0777u) != 0400u) return -EPERM;
    int required = F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL; int seals = fcntl(fd, F_GET_SEALS);
    if (seals < 0 || (seals & required) != required || pread(fd, key, 32, 0) != 32) return -EPERM;
    uint8_t extra; if (pread(fd, &extra, 1, 32) != 0) return -EINVAL;
    struct vinci_sha256_context context; vinci_sha256_init(&context); vinci_sha256_update(&context, key, 32u); vinci_sha256_final(&context, digest);
    if (memcmp(digest, policy->key_id, 32u) != 0 || monotonic_now(&now) != 0
        || now < policy->not_before_monotonic_ns || now >= policy->not_after_monotonic_ns) return -EKEYREJECTED;
    return 0;
}

int vinci_broker_build_target_context(const struct vinci_broker_session_policy *policy, int sealed_attestation_key_fd,
                                      uint8_t context_wire[VINCI_BROKER_TARGET_CONTEXT_WIRE_BYTES]) {
    if (policy == NULL || context_wire == NULL || policy->attempt_identity == 0
        || !nonzero(policy->nonce, 32u) || !nonzero(policy->session_identity_sha256, 32u)
        || !nonzero(policy->executable_sha256, 32u)) return -EINVAL;
    uint8_t key[32]; int result = validate_key_fd(&policy->target_attestation_key, sealed_attestation_key_fd, key);
    if (result != 0) return result;
    memset(context_wire, 0, VINCI_BROKER_TARGET_CONTEXT_WIRE_BYTES); put64(context_wire, UINT64_C(0x56494e4354435458));
    put32(context_wire + 8u, 4u); put32(context_wire + 12u, VINCI_BROKER_TARGET_CONTEXT_WIRE_BYTES);
    put64(context_wire + 16u, policy->attempt_identity); memcpy(context_wire + 24u, policy->nonce, 32u);
    memcpy(context_wire + 56u, policy->session_identity_sha256, 32u); memcpy(context_wire + 88u, policy->executable_sha256, 32u);
    memcpy(context_wire + 120u, policy->target_attestation_key.key_id, 32u);
    result = vinci_hmac_sha256(key, 32u, context_wire, 152u, context_wire + 152u); memset(key, 0, sizeof(key)); return result;
}

static int write_all(int fd, const uint8_t *bytes, size_t length) {
    size_t offset = 0; while (offset < length) { ssize_t count = write(fd, bytes + offset, length - offset);
        if (count <= 0) return count < 0 ? -errno : -EIO;
        offset += (size_t)count; }
    return 0;
}

static int identical_existing(int directory_fd, const char *name, const uint8_t *bytes, size_t length) {
    int fd = openat(directory_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); if (fd < 0) return -errno;
    struct stat metadata; int result = fstat(fd, &metadata) == 0 && S_ISREG(metadata.st_mode) && metadata.st_nlink == 1
        && (metadata.st_mode & 0777u) == 0400u && metadata.st_size == (off_t)length ? 0 : -EPROTO;
    uint8_t buffer[VINCI_BROKER_TERMINAL_RECEIPT_WIRE_BYTES];
    if (result == 0 && (length > sizeof(buffer) || pread(fd, buffer, length, 0) != (ssize_t)length
        || memcmp(buffer, bytes, length) != 0)) result = -EEXIST;
    if (result == 0 && fsync(fd) != 0) result = -errno;
    if (close(fd) != 0 && result == 0) result = -errno;
    if (result == 0 && fsync(directory_fd) != 0) result = -errno;
    return result;
}

static int persist_atomic(int directory_fd, const char *name, const uint8_t *bytes, size_t length) {
#ifndef O_TMPFILE
    (void)directory_fd; (void)name; (void)bytes; (void)length; return -ENOTSUP;
#else
    int fd = openat(directory_fd, ".", O_WRONLY | O_TMPFILE | O_CLOEXEC, 0400); if (fd < 0) return -errno;
    int result = write_all(fd, bytes, length);
    if (result == 0 && fsync(fd) != 0) result = -errno;
    if (result == 0 && linkat(fd, "", directory_fd, name, AT_EMPTY_PATH) != 0) {
        int saved = errno; result = saved == EEXIST ? identical_existing(directory_fd, name, bytes, length) : -saved;
    }
    if (result == 0 && fsync(directory_fd) != 0) result = -errno;
    close(fd); return result;
#endif
}

static void hex32(char output[65], const uint8_t bytes[32]) {
    static const char alphabet[] = "0123456789abcdef";
    for (size_t index = 0; index < 32u; index++) { output[index * 2u] = alphabet[bytes[index] >> 4u]; output[index * 2u + 1u] = alphabet[bytes[index] & 15u]; }
    output[64] = '\0';
}

static int validate_control_socket(int fd, const uint8_t expected_identity[32]) {
    int type = 0; socklen_t type_bytes = sizeof(type); struct sockaddr_storage peer; socklen_t peer_bytes = sizeof(peer);
    struct stat metadata; uint8_t canonical[160], digest[32];
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &type_bytes) != 0 || type != SOCK_SEQPACKET
        || getpeername(fd, (struct sockaddr *)&peer, &peer_bytes) != 0 || peer_bytes == 0 || peer_bytes > sizeof(peer)
        || fstat(fd, &metadata) != 0 || !S_ISSOCK(metadata.st_mode)) return -EPROTO;
    memset(canonical, 0, sizeof(canonical)); put64(canonical, (uint64_t)metadata.st_dev); put64(canonical + 8u, (uint64_t)metadata.st_ino);
    put32(canonical + 16u, (uint32_t)metadata.st_uid); put32(canonical + 20u, (uint32_t)metadata.st_gid);
    put32(canonical + 24u, (uint32_t)peer_bytes); memcpy(canonical + 32u, &peer, peer_bytes);
    struct vinci_sha256_context context; vinci_sha256_init(&context); vinci_sha256_update(&context, canonical, sizeof(canonical));
    vinci_sha256_final(&context, digest); return memcmp(digest, expected_identity, 32u) == 0 ? 0 : -EKEYREJECTED;
}

static int socket_endpoint_metadata(int fd, uint8_t canonical[32]) {
    struct stat metadata;
    int socket_type = 0;
    socklen_t socket_type_bytes = sizeof(socket_type);
    if (fd < 0 || fstat(fd, &metadata) != 0 || !S_ISSOCK(metadata.st_mode)
        || getsockopt(fd, SOL_SOCKET, SO_TYPE, &socket_type, &socket_type_bytes) != 0
        || socket_type_bytes != sizeof(socket_type) || socket_type != SOCK_SEQPACKET) return -EPROTO;
    memset(canonical, 0, 32u);
    put64(canonical, (uint64_t)metadata.st_dev); put64(canonical + 8u, (uint64_t)metadata.st_ino);
    put32(canonical + 16u, (uint32_t)metadata.st_uid); put32(canonical + 20u, (uint32_t)metadata.st_gid);
    put32(canonical + 24u, (uint32_t)socket_type);
    return 0;
}

int vinci_broker_derive_task_attestation_identity(const struct vinci_broker_task *task, uint8_t digest[32]) {
    static const uint8_t domain[] = "VINCI-BROKER-V4-TASK-ATTESTATION-PAIR\0";
    uint8_t parent[32], source[32], probe[32], received[32];
    if (task == NULL || digest == NULL || task->target_attestation_fd < 0
        || task->target_attestation_source_fd < 0
        || task->target_attestation_fd == task->target_attestation_source_fd
        || socket_endpoint_metadata(task->target_attestation_fd, parent) != 0
        || socket_endpoint_metadata(task->target_attestation_source_fd, source) != 0) return -EINVAL;
    struct vinci_sha256_context context;
    vinci_sha256_init(&context); vinci_sha256_update(&context, domain, sizeof(domain));
    vinci_sha256_update(&context, parent, sizeof(parent)); vinci_sha256_update(&context, source, sizeof(source));
    vinci_sha256_final(&context, probe);
    errno = 0;
    if (recv(task->target_attestation_fd, received, sizeof(received), MSG_PEEK | MSG_DONTWAIT) >= 0 || errno != EAGAIN) return -EBUSY;
    errno = 0;
    if (recv(task->target_attestation_source_fd, received, sizeof(received), MSG_PEEK | MSG_DONTWAIT) >= 0 || errno != EAGAIN) return -EBUSY;
    if (send(task->target_attestation_source_fd, probe, sizeof(probe), MSG_NOSIGNAL | MSG_DONTWAIT) != (ssize_t)sizeof(probe)
        || recv(task->target_attestation_fd, received, sizeof(received), MSG_DONTWAIT) != (ssize_t)sizeof(received)
        || memcmp(received, probe, sizeof(probe)) != 0
        || send(task->target_attestation_fd, probe, sizeof(probe), MSG_NOSIGNAL | MSG_DONTWAIT) != (ssize_t)sizeof(probe)
        || recv(task->target_attestation_source_fd, received, sizeof(received), MSG_DONTWAIT) != (ssize_t)sizeof(received)
        || memcmp(received, probe, sizeof(probe)) != 0) return -ENOTCONN;
    vinci_sha256_init(&context); vinci_sha256_update(&context, domain, sizeof(domain));
    vinci_sha256_update(&context, parent, sizeof(parent)); vinci_sha256_update(&context, source, sizeof(source));
    vinci_sha256_final(&context, digest);
    memset(probe, 0, sizeof(probe)); memset(received, 0, sizeof(received));
    return 0;
}

static int derive_cgroup_identity(int fd, uid_t expected_uid, gid_t expected_gid, uint8_t digest[32]) {
    struct stat metadata; struct statfs filesystem; uint8_t canonical[64];
    if (fstat(fd, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || metadata.st_uid != expected_uid
        || metadata.st_gid != expected_gid || fstatfs(fd, &filesystem) != 0
        || (uint64_t)filesystem.f_type != (uint64_t)CGROUP2_SUPER_MAGIC) return -EPROTO;
    memset(canonical, 0, sizeof(canonical)); put64(canonical, UINT64_C(0x56494e4343474944));
    put64(canonical + 8u, (uint64_t)metadata.st_dev); put64(canonical + 16u, (uint64_t)metadata.st_ino);
    put32(canonical + 24u, (uint32_t)metadata.st_uid); put32(canonical + 28u, (uint32_t)metadata.st_gid);
    put32(canonical + 32u, (uint32_t)(metadata.st_mode & 07777u)); put64(canonical + 40u, (uint64_t)filesystem.f_type);
    struct vinci_sha256_context context; vinci_sha256_init(&context); vinci_sha256_update(&context, canonical, sizeof(canonical));
    vinci_sha256_final(&context, digest); return 0;
}

static int derive_directory_identity(int fd, uint8_t digest[32]) {
    struct stat metadata; uint8_t canonical[48];
    if (fstat(fd, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || (metadata.st_mode & 0022u) != 0) return -EPROTO;
    memset(canonical, 0, sizeof(canonical)); put64(canonical, UINT64_C(0x56494e4352444952));
    put64(canonical + 8u, (uint64_t)metadata.st_dev); put64(canonical + 16u, (uint64_t)metadata.st_ino);
    put32(canonical + 24u, (uint32_t)metadata.st_uid); put32(canonical + 28u, (uint32_t)metadata.st_gid);
    put32(canonical + 32u, (uint32_t)(metadata.st_mode & 07777u)); struct vinci_sha256_context context;
    vinci_sha256_init(&context); vinci_sha256_update(&context, canonical, sizeof(canonical)); vinci_sha256_final(&context, digest); return 0;
}

static int distinct_key_ids(const struct vinci_broker_session_policy *policy) {
    const uint8_t *ids[] = { policy->receipt_key.key_id, policy->target_attestation_key.key_id,
        policy->attach_audit_key.key_id, policy->capture_key.key_id, policy->cgroup_policy_key.key_id,
        policy->ingress_authority_key.key_id };
    for (size_t index = 0; index < sizeof(ids) / sizeof(ids[0]); index++) {
        if (!nonzero(ids[index], 32u)) return 0;
        for (size_t prior = 0; prior < index; prior++) if (memcmp(ids[prior], ids[index], 32u) == 0) return 0;
    }
    return 1;
}

static void policy_u32(struct vinci_sha256_context *context, uint32_t value) {
    uint8_t wire[4]; put32(wire, value); vinci_sha256_update(context, wire, sizeof(wire));
}

static void policy_u64(struct vinci_sha256_context *context, uint64_t value) {
    uint8_t wire[8]; put64(wire, value); vinci_sha256_update(context, wire, sizeof(wire));
}

static void policy_key(struct vinci_sha256_context *context, const struct vinci_broker_key_policy *key) {
    vinci_sha256_update(context, key->key_id, 32u); vinci_sha256_update(context, key->provenance_sha256, 32u);
    policy_u64(context, key->generation); policy_u64(context, key->not_before_monotonic_ns);
    policy_u64(context, key->not_after_monotonic_ns); policy_u32(context, (uint32_t)key->owner_uid);
    policy_u32(context, (uint32_t)(key->revoked != 0));
}

int vinci_broker_derive_policy_identity(const struct vinci_broker_session_policy *policy, uint8_t digest[32]) {
    static const uint8_t domain[] = "VINCI-BROKER-V4-POLICY\0";
    if (policy == NULL || digest == NULL || !validate_target_rules(policy->target_rules, policy->target_rule_count)) return -EINVAL;
    struct vinci_sha256_context context; vinci_sha256_init(&context);
    vinci_sha256_update(&context, domain, sizeof(domain));
    policy_u32(&context, (uint32_t)policy->uid); policy_u32(&context, (uint32_t)policy->gid);
    policy_u64(&context, (uint64_t)policy->expected_parent); policy_u64(&context, policy->monotonic_deadline_ns);
    policy_u64(&context, policy->attempt_identity); policy_u32(&context, policy->max_release_bytes);
    vinci_sha256_update(&context, policy->nonce, 32u); vinci_sha256_update(&context, policy->trampoline_sha256, 32u);
    vinci_sha256_update(&context, policy->executable_sha256, 32u); vinci_sha256_update(&context, policy->argv_environment_sha256, 32u);
    vinci_sha256_update(&context, policy->executable_provenance_sha256, 32u);
    vinci_sha256_update(&context, policy->trampoline_build_receipt_sha256, 32u);
    vinci_sha256_update(&context, policy->cgroup_identity_sha256, 32u); vinci_sha256_update(&context, policy->broker_identity_sha256, 32u);
    vinci_sha256_update(&context, policy->control_socket_identity_sha256, 32u);
    vinci_sha256_update(&context, policy->target_attestation_socket_identity_sha256, 32u);
    vinci_sha256_update(&context, policy->receipt_directory_identity_sha256, 32u);
    policy_u32(&context, (uint32_t)policy->cgroup_owner_uid); policy_u32(&context, (uint32_t)policy->cgroup_owner_gid);
    policy_u64(&context, policy->zero_stability_ns); policy_u32(&context, (uint32_t)(policy->single_thread_only != 0));
    policy_key(&context, &policy->receipt_key); policy_key(&context, &policy->target_attestation_key);
    policy_key(&context, &policy->attach_audit_key); policy_key(&context, &policy->capture_key);
    policy_key(&context, &policy->cgroup_policy_key); policy_key(&context, &policy->ingress_authority_key);
    policy_u64(&context, (uint64_t)policy->target_rule_count);
    for (size_t index = 0; index < policy->target_rule_count; index++) {
        const struct vinci_broker_target_rule *rule = &policy->target_rules[index];
        policy_u32(&context, (uint32_t)rule->syscall_number); policy_u32(&context, (uint32_t)rule->action);
        policy_u32(&context, rule->scalar_argument_mask); policy_u32(&context, rule->output_pointer_mask);
        for (size_t argument = 0; argument < 6u; argument++) policy_u64(&context, rule->argument_values[argument]);
        for (size_t argument = 0; argument < 6u; argument++) policy_u64(&context, rule->argument_maximums[argument]);
        policy_u32(&context, (uint32_t)rule->emulated_errno);
    }
    vinci_sha256_final(&context, digest); return 0;
}

static int validate_target_context_fd(const struct vinci_broker_session_policy *policy, int key_fd, int context_fd) {
    struct stat metadata; uint8_t expected[VINCI_BROKER_TARGET_CONTEXT_WIRE_BYTES];
    uint8_t actual[VINCI_BROKER_TARGET_CONTEXT_WIRE_BYTES], digest[32];
    int required = F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL;
    int seals = fcntl(context_fd, F_GET_SEALS);
    if (context_fd < 0 || fstat(context_fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_nlink != 0
        || (metadata.st_mode & 0777u) != 0400u || metadata.st_size != VINCI_BROKER_TARGET_CONTEXT_WIRE_BYTES
        || seals < 0 || (seals & required) != required
        || vinci_broker_build_target_context(policy, key_fd, expected) != 0
        || pread(context_fd, actual, sizeof(actual), 0) != (ssize_t)sizeof(actual)
        || memcmp(actual, expected, sizeof(actual)) != 0) return -EKEYREJECTED;
    struct vinci_sha256_context context; vinci_sha256_init(&context);
    vinci_sha256_update(&context, actual, sizeof(actual)); vinci_sha256_final(&context, digest);
    return memcmp(digest, policy->target_attestation_context_sha256, 32u) == 0 ? 0 : -EKEYREJECTED;
}

int vinci_broker_session_initialize(struct vinci_broker_session *session, int receipt_directory_fd,
                                    struct vinci_broker_task *task,
                                    const struct vinci_broker_session_policy *policy) {
    uint8_t cgroup_identity[32], receipt_directory_identity[32], task_attestation_identity[32], policy_identity[32];
    if (session == NULL || policy == NULL || task == NULL || receipt_directory_fd < 0
        || task->control_fd < 0 || task->pidfd < 0 || task->pid <= 0 || task->cgroup_fd < 0
        || task->target_attestation_fd < 0 || task->target_attestation_source_fd < 0
        || task->target_attestation_key_fd < 0
        || task->target_attestation_context_fd < 0 || policy->uid == 0
        || policy->gid == 0 || policy->expected_parent <= 1 || policy->attempt_identity == 0
        || task->expected_parent != policy->expected_parent || task->target_uid != policy->uid || task->target_gid != policy->gid
        || policy->monotonic_deadline_ns == 0 || policy->max_release_bytes == 0
        || policy->max_release_bytes > VINCI_BROKER_MAX_RELEASE_BYTES || !validate_target_rules(policy->target_rules, policy->target_rule_count)
        || !nonzero(policy->nonce, 32u) || !nonzero(policy->session_identity_sha256, 32u)
        || !nonzero(policy->trampoline_sha256, 32u) || !nonzero(policy->executable_sha256, 32u)
        || !nonzero(policy->argv_environment_sha256, 32u) || !nonzero(policy->executable_provenance_sha256, 32u)
        || !nonzero(policy->trampoline_build_receipt_sha256, 32u) || !nonzero(policy->broker_identity_sha256, 32u)
        || !nonzero(policy->target_attestation_socket_identity_sha256, 32u)
        || !nonzero(policy->target_attestation_context_sha256, 32u)
        || !distinct_key_ids(policy)
        || !policy->single_thread_only || policy->zero_stability_ns < UINT64_C(100000000)
        || policy->zero_stability_ns > UINT64_C(5000000000)
        || validate_control_socket(task->control_fd, policy->control_socket_identity_sha256) != 0
        || vinci_broker_derive_task_attestation_identity(task, task_attestation_identity) != 0
        || memcmp(task_attestation_identity, policy->target_attestation_socket_identity_sha256, 32u) != 0
        || derive_cgroup_identity(task->cgroup_fd, policy->cgroup_owner_uid, policy->cgroup_owner_gid, cgroup_identity) != 0
        || memcmp(cgroup_identity, policy->cgroup_identity_sha256, 32u) != 0
        || derive_directory_identity(receipt_directory_fd, receipt_directory_identity) != 0
        || memcmp(receipt_directory_identity, policy->receipt_directory_identity_sha256, 32u) != 0
        || vinci_broker_derive_policy_identity(policy, policy_identity) != 0
        || memcmp(policy_identity, policy->session_identity_sha256, 32u) != 0
        || validate_target_context_fd(policy, task->target_attestation_key_fd, task->target_attestation_context_fd) != 0
        || pidfd_alive(&(struct vinci_broker_session){ .pidfd = task->pidfd }) != 1) return -EINVAL;
    int held_receipts = fcntl(receipt_directory_fd, F_DUPFD_CLOEXEC, 13);
    if (held_receipts < 0) return -errno;
    memset(session, 0, sizeof(*session)); session->control_fd = task->control_fd; session->notification_fd = -1;
    session->target_attestation_fd = task->target_attestation_fd;
    session->target_attestation_source_fd = task->target_attestation_source_fd;
    session->receipt_directory_fd = held_receipts;
    session->pid = task->pid; session->pidfd = task->pidfd; session->cgroup_directory_fd = task->cgroup_fd;
    session->target_attestation_key_fd = task->target_attestation_key_fd;
    session->target_attestation_context_fd = task->target_attestation_context_fd;
    task->pid = -1; task->pidfd = -1; task->expected_parent = -1; task->target_uid = 0; task->target_gid = 0;
    task->cgroup_fd = -1; task->control_fd = -1;
    task->target_attestation_fd = -1; task->target_attestation_source_fd = -1;
    task->target_attestation_key_fd = -1; task->target_attestation_context_fd = -1;
    session->phase = VINCI_SESSION_CREATED;
    session->policy = *policy; session->policy.target_rules = NULL;
    session->target_rule_count = policy->target_rule_count; memcpy(session->target_rules, policy->target_rules, policy->target_rule_count * sizeof(*policy->target_rules));
    session->hello.monotonic_deadline_ns = policy->monotonic_deadline_ns; session->hello.attempt_identity = policy->attempt_identity;
    session->hello.max_release_bytes = policy->max_release_bytes;
    session->hello.target_uid = policy->uid; session->hello.target_gid = policy->gid; session->hello.expected_parent_pid = policy->expected_parent;
    memcpy(session->hello.nonce, policy->nonce, 32u); memcpy(session->hello.session_identity_sha256, policy->session_identity_sha256, 32u);
    memcpy(session->hello.trampoline_sha256, policy->trampoline_sha256, 32u); memcpy(session->hello.executable_sha256, policy->executable_sha256, 32u);
    memcpy(session->hello.argv_environment_sha256, policy->argv_environment_sha256, 32u); memcpy(session->hello.receipt_key_id, policy->receipt_key.key_id, 32u);
    memcpy(session->hello.executable_provenance_sha256, policy->executable_provenance_sha256, 32u);
    memcpy(session->hello.trampoline_build_receipt_sha256, policy->trampoline_build_receipt_sha256, 32u);
    memcpy(session->hello.target_attestation_key_id, policy->target_attestation_key.key_id, 32u);
    memcpy(session->hello.target_attestation_context_sha256, policy->target_attestation_context_sha256, 32u);
    return 0;
}

int vinci_broker_session_send_hello(struct vinci_broker_session *session) {
    if (session == NULL || session->phase != VINCI_SESSION_CREATED) return -EPERM;
    uint8_t wire[VINCI_BROKER_HELLO_WIRE_BYTES]; int result = vinci_protocol_encode_hello(wire, &session->hello);
    if (result == 0) result = send_deadline(session, wire, sizeof(wire));
    session->phase = result == 0 ? VINCI_SESSION_HELLO_SENT : VINCI_SESSION_UNCONTAINED; return result;
}

int vinci_broker_session_acquire_listener(struct vinci_broker_session *session) {
    if (session == NULL || session->phase != VINCI_SESSION_HELLO_SENT) return -EPERM;
#ifndef __NR_pidfd_getfd
    session->phase = VINCI_SESSION_UNCONTAINED; return -ENOSYS;
#else
    for (;;) {
        if (remaining_milliseconds(session) <= 0) { session->phase = VINCI_SESSION_UNCONTAINED; return -ETIMEDOUT; }
        int listener = (int)syscall(__NR_pidfd_getfd, session->pidfd, VINCI_BROKER_NOTIFICATION_FD, 0);
        if (listener >= 0) { session->notification_fd = listener; break; }
        if (errno == EPERM || errno == EACCES || errno == ENOSYS || errno == ESRCH) { session->phase = VINCI_SESSION_UNCONTAINED; return -errno; }
        if (errno != EBADF) { session->phase = VINCI_SESSION_UNCONTAINED; return -errno; }
        struct pollfd descriptor = { .fd = session->pidfd, .events = POLLIN }; int pause = poll(&descriptor, 1, 1);
        if (pause < 0) { session->phase = VINCI_SESSION_UNCONTAINED; return -errno; }
        if (descriptor.revents != 0 || pidfd_alive(session) != 1) { session->phase = VINCI_SESSION_UNCONTAINED; return -ESRCH; }
    }
    int flags = fcntl(session->notification_fd, F_GETFD); if (flags < 0 || fcntl(session->notification_fd, F_SETFD, flags | FD_CLOEXEC) != 0
        || receive_notification(session) != 0) { session->phase = VINCI_SESSION_UNCONTAINED; return -EPROTO; }
    struct seccomp_notif request; memcpy(&request, session->pending_notification_storage, sizeof(request));
    if (request.data.nr != __NR_recvmsg || request.data.args[0] != VINCI_BROKER_CONTROL_FD
        || request.data.args[2] != MSG_CMSG_CLOEXEC) { session->phase = VINCI_SESSION_UNCONTAINED; return -EPROTO; }
    session->phase = VINCI_SESSION_LISTENER_ACQUIRED; return 0;
#endif
}

int vinci_broker_session_receive_report(struct vinci_broker_session *session) {
    if (session == NULL || session->phase != VINCI_SESSION_LISTENER_ACQUIRED) return -EPERM;
    uint64_t args[6] = { VINCI_BROKER_CONTROL_FD, 0, MSG_CMSG_CLOEXEC, 0, 0, 0 };
    int result = answer_pending(session, SECCOMP_USER_NOTIF_FLAG_CONTINUE, 0, 0);
    if (result != 0) goto fail;
    /* valid_target_context() is the trampoline's first operation after decoding
       hello.  Mediate that exact read before allowing fd6 to be closed. */
    memset(args, 0, sizeof(args)); args[0] = VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD;
    args[2] = VINCI_BROKER_TARGET_CONTEXT_WIRE_BYTES;
    result = continue_exact(session, __NR_pread64, 13u, args); if (result != 0) goto fail;
    args[0] = VINCI_BROKER_NOTIFICATION_FD; result = continue_exact(session, __NR_close, 1u, args); if (result != 0) goto fail;
    /* The next blocked syscall proves the continued close completed in the
       child before pidfd_getfd is used to establish fd6 absence. */
    result = receive_notification(session); if (result != 0) goto fail;
#ifdef __NR_pidfd_getfd
    errno = 0; int probe = (int)syscall(__NR_pidfd_getfd, session->pidfd, VINCI_BROKER_NOTIFICATION_FD, 0);
    if (probe >= 0) { close(probe); result = -EBUSY; goto fail; }
    if (errno != EBADF) { result = -errno; goto fail; }
#endif
    memset(args, 0, sizeof(args)); result = continue_exact(session, __NR_setgroups, 3u, args); if (result != 0) goto fail;
    args[0] = args[1] = args[2] = session->hello.target_gid; result = continue_exact(session, __NR_setresgid, 7u, args); if (result != 0) goto fail;
    args[0] = args[1] = args[2] = session->hello.target_uid; result = continue_exact(session, __NR_setresuid, 7u, args); if (result != 0) goto fail;
    memset(args, 0, sizeof(args)); args[0] = PR_SET_PDEATHSIG; args[1] = SIGKILL; result = continue_exact(session, __NR_prctl, 3u, args); if (result != 0) goto fail;
    memset(args, 0, sizeof(args)); result = continue_exact(session, __NR_getppid, 0u, args); if (result != 0) goto fail;
    args[0] = PR_SET_DUMPABLE; result = continue_exact(session, __NR_prctl, 3u, args); if (result != 0) goto fail;
    args[0] = VINCI_BROKER_CONTROL_FD; args[2] = MSG_NOSIGNAL; result = continue_exact(session, __NR_sendmsg, 5u, args); if (result != 0) goto fail;
    uint8_t wire[VINCI_BROKER_REPORT_WIRE_BYTES]; result = receive_fd_deadline(session, session->control_fd, wire, sizeof(wire));
    if (result != 0 || vinci_protocol_decode_report(&session->report, wire, sizeof(wire)) != 0
        || session->report.pid != session->pid || session->report.uid != session->hello.target_uid
        || session->report.gid != session->hello.target_gid || session->report.no_new_privs != 1
        || memcmp(session->report.nonce, session->hello.nonce, 32u) != 0
        || memcmp(session->report.session_identity_sha256, session->hello.session_identity_sha256, 32u) != 0
        || memcmp(session->report.trampoline_sha256, session->hello.trampoline_sha256, 32u) != 0
        || memcmp(session->report.executable_sha256, session->hello.executable_sha256, 32u) != 0) { result = -EPROTO; goto fail; }
    session->phase = VINCI_SESSION_REPORT_VERIFIED; return 0;
fail: session->phase = VINCI_SESSION_UNCONTAINED; return result;
}

static void encode_prelaunch(struct vinci_broker_session *session, const uint8_t journal[32], uint8_t wire[VINCI_BROKER_RECEIPT_WIRE_BYTES]) {
    memset(wire, 0, VINCI_BROKER_RECEIPT_WIRE_BYTES); put64(wire, UINT64_C(0x56494e4350524543)); put32(wire + 8u, 4u);
    put32(wire + 12u, VINCI_BROKER_RECEIPT_WIRE_BYTES); put32(wire + 16u, 1u); put64(wire + 24u, session->policy.attempt_identity);
    put64(wire + 32u, session->hello.monotonic_deadline_ns); put64(wire + 40u, (uint64_t)session->pid);
    put32(wire + 48u, session->hello.target_uid); put32(wire + 52u, session->hello.target_gid); put64(wire + 56u, session->policy.receipt_key.generation);
    memcpy(wire + 64u, session->hello.nonce, 32u); memcpy(wire + 96u, session->hello.session_identity_sha256, 32u);
    memcpy(wire + 128u, session->hello.trampoline_sha256, 32u); memcpy(wire + 160u, session->hello.executable_sha256, 32u);
    memcpy(wire + 192u, session->hello.argv_environment_sha256, 32u); memcpy(wire + 224u, journal, 32u);
    memcpy(wire + 256u, session->policy.receipt_key.key_id, 32u); memcpy(wire + 288u, session->policy.receipt_key.provenance_sha256, 32u);
    memcpy(wire + 320u, session->policy.executable_provenance_sha256, 32u); memcpy(wire + 352u, session->policy.trampoline_build_receipt_sha256, 32u);
    memcpy(wire + 384u, session->policy.cgroup_identity_sha256, 32u); memcpy(wire + 416u, session->policy.broker_identity_sha256, 32u);
    memcpy(wire + 448u, session->policy.target_attestation_key.key_id, 32u);
    memcpy(wire + 480u, session->policy.target_attestation_context_sha256, 32u);
}

int vinci_broker_session_commit_prelaunch(struct vinci_broker_session *session, int sealed_key_fd,
                                          const uint8_t journal_sha256[32],
                                          uint8_t receipt_wire[VINCI_BROKER_RECEIPT_WIRE_BYTES]) {
    if (session == NULL || journal_sha256 == NULL || receipt_wire == NULL
        || (session->phase != VINCI_SESSION_REPORT_VERIFIED && session->phase != VINCI_SESSION_PRELAUNCH_STORAGE_COMMITTED)) return -EPERM;
    int resumed = session->phase == VINCI_SESSION_PRELAUNCH_STORAGE_COMMITTED;
    uint8_t key[32]; int result = validate_key_fd(&session->policy.receipt_key, sealed_key_fd, key); if (result != 0) return result;
    struct vinci_sha256_context context;
    if (resumed) {
        if (memcmp(journal_sha256, session->prelaunch_receipt_wire + 224u, 32u) != 0) {
            session->phase = VINCI_SESSION_UNCONTAINED; result = -EKEYREJECTED; goto out;
        }
        memcpy(receipt_wire, session->prelaunch_receipt_wire, VINCI_BROKER_RECEIPT_WIRE_BYTES);
    } else {
        encode_prelaunch(session, journal_sha256, receipt_wire);
        vinci_sha256_init(&context); vinci_sha256_update(&context, receipt_wire, 512u); vinci_sha256_final(&context, receipt_wire + 512u);
        result = vinci_hmac_sha256(key, 32u, receipt_wire, 544u, receipt_wire + 544u); if (result != 0) goto out;
    }
    session->phase = VINCI_SESSION_PRELAUNCH_BODY_COMMITTED;
    char digest_hex[65], name[128]; hex32(digest_hex, receipt_wire + 512u);
    int name_bytes = snprintf(name, sizeof(name), "prelaunch-%016llx-%s.receipt", (unsigned long long)session->policy.attempt_identity, digest_hex);
    if (name_bytes <= 0 || (size_t)name_bytes >= sizeof(name)) { result = -EOVERFLOW; goto fail; }
    result = persist_atomic(session->receipt_directory_fd, name, receipt_wire, VINCI_BROKER_RECEIPT_WIRE_BYTES);
    if (result != 0) { session->reconcile_stage = 1u; session->phase = VINCI_SESSION_RECONCILE_ONLY; goto out; }
    memcpy(session->prelaunch_receipt_sha256, receipt_wire + 512u, 32u);
    memcpy(session->prelaunch_receipt_wire, receipt_wire, VINCI_BROKER_RECEIPT_WIRE_BYTES);
    vinci_sha256_init(&context); vinci_sha256_update(&context, receipt_wire, VINCI_BROKER_RECEIPT_WIRE_BYTES);
    vinci_sha256_final(&context, session->prelaunch_storage_sha256); session->phase = VINCI_SESSION_PRELAUNCH_STORAGE_COMMITTED;
    struct vinci_broker_prelaunch_commit commit; memset(&commit, 0, sizeof(commit));
    commit.monotonic_deadline_ns = session->hello.monotonic_deadline_ns; commit.attempt_identity = session->policy.attempt_identity;
    memcpy(commit.nonce, session->hello.nonce, 32u); memcpy(commit.session_identity_sha256, session->hello.session_identity_sha256, 32u);
    memcpy(commit.receipt_body_sha256, session->prelaunch_receipt_sha256, 32u); memcpy(commit.receipt_key_id, session->policy.receipt_key.key_id, 32u);
    uint8_t commit_wire[VINCI_BROKER_COMMIT_WIRE_BYTES]; vinci_protocol_encode_commit(commit_wire, &commit);
    result = vinci_hmac_sha256(key, 32u, commit_wire, sizeof(commit_wire), commit.receipt_hmac_sha256); if (result != 0) goto fail;
    vinci_protocol_encode_commit(commit_wire, &commit); result = send_deadline(session, commit_wire, sizeof(commit_wire)); if (result != 0) goto fail;
    uint64_t args[6] = { VINCI_BROKER_CONTROL_FD, 0, MSG_CMSG_CLOEXEC, 0, 0, 0 };
    result = continue_exact(session, __NR_recvmsg, 5u, args); if (result != 0) goto fail;
    result = receive_notification(session); if (result != 0) goto fail;
    struct seccomp_notif request; memcpy(&request, session->pending_notification_storage, sizeof(request));
    if (request.data.nr != __NR_recvmsg || request.data.args[0] != VINCI_BROKER_CONTROL_FD || request.data.args[2] != MSG_CMSG_CLOEXEC) { result = -EPROTO; goto fail; }
    session->phase = VINCI_SESSION_COMMIT_TASK_VERIFIED; goto out;
fail: session->phase = VINCI_SESSION_UNCONTAINED;
out: memset(key, 0, sizeof(key)); return result;
}

int vinci_broker_session_release(struct vinci_broker_session *session, const void *payload, size_t payload_bytes,
                                 uint32_t argc, uint32_t envc) {
    if (session == NULL || payload == NULL || session->phase != VINCI_SESSION_COMMIT_TASK_VERIFIED || payload_bytes == 0
        || payload_bytes > session->hello.max_release_bytes || argc == 0 || argc > VINCI_BROKER_MAX_ARGC || envc > VINCI_BROKER_MAX_ENVC) return -EPERM;
    uint8_t packet[VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES + VINCI_BROKER_MAX_RELEASE_BYTES]; struct vinci_broker_release release;
    memset(&release, 0, sizeof(release)); release.payload_bytes = (uint32_t)payload_bytes; release.argc = argc; release.envc = envc;
    memcpy(release.nonce, session->hello.nonce, 32u); memcpy(release.session_identity_sha256, session->hello.session_identity_sha256, 32u);
    memcpy(release.prelaunch_receipt_sha256, session->prelaunch_receipt_sha256, 32u);
    struct vinci_sha256_context context; vinci_sha256_init(&context); vinci_sha256_update(&context, payload, payload_bytes);
    vinci_sha256_final(&context, release.argv_environment_sha256);
    if (memcmp(release.argv_environment_sha256, session->hello.argv_environment_sha256, 32u) != 0) return -EINVAL;
    vinci_protocol_encode_release_header(packet, &release); memcpy(packet + VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES, payload, payload_bytes);
    int result = send_deadline(session, packet, VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES + payload_bytes);
    if (result == 0) result = answer_pending(session, SECCOMP_USER_NOTIF_FLAG_CONTINUE, 0, 0);
    memset(packet, 0, sizeof(packet)); session->phase = result == 0 ? VINCI_SESSION_RELEASE_ARMED : VINCI_SESSION_UNCONTAINED; return result;
}

static const struct vinci_broker_target_rule *find_rule(const struct vinci_broker_session *session, int syscall_number) {
    size_t lower = 0, upper = session->target_rule_count;
    while (lower < upper) { size_t middle = lower + (upper - lower) / 2u; int value = session->target_rules[middle].syscall_number;
        if (value == syscall_number) return &session->target_rules[middle];
        if (value < syscall_number) lower = middle + 1u; else upper = middle; }
    return NULL;
}

int vinci_broker_session_mediate_once(struct vinci_broker_session *session) {
    if (session == NULL || session->notification_fd < 0 || session->phase == VINCI_SESSION_UNCONTAINED) return -EPERM;
    int result = receive_notification(session); if (result != 0) goto fail;
    struct seccomp_notif request; memcpy(&request, session->pending_notification_storage, sizeof(request));
    if (session->phase == VINCI_SESSION_RELEASE_ARMED) {
        static const int fds[] = { 3, 3, 4, 4, 5, 5, 7, 7, 8, 8, 9, 9, 11, 11, 12, 12 };
        static const int commands[] = { F_GETFD, F_SETFD, F_GETFD, F_SETFD, F_GETFD, F_SETFD,
            F_GETFD, F_SETFD, F_GETFD, F_SETFD, F_GETFD, F_SETFD, F_GETFD, F_SETFD,
            F_GETFD, F_SETFD };
        if (session->cloexec_step < 16u) {
            if (request.data.nr != __NR_fcntl || request.data.args[0] != (uint64_t)fds[session->cloexec_step]
                || request.data.args[1] != (uint64_t)commands[session->cloexec_step]
                || ((session->cloexec_step & 1u) != 0u && (request.data.args[2] & FD_CLOEXEC) == 0)) goto protocol;
            result = answer_pending(session, SECCOMP_USER_NOTIF_FLAG_CONTINUE, 0, 0);
            if (result != 0) goto fail;
            session->cloexec_step++; return 0;
        }
        if (session->cloexec_step == 16u) {
            if (request.data.nr != __NR_rt_sigprocmask || request.data.args[0] != SIG_SETMASK) goto protocol;
            result = answer_pending(session, SECCOMP_USER_NOTIF_FLAG_CONTINUE, 0, 0);
            if (result != 0) goto fail;
            session->cloexec_step++; return 0;
        }
        if (request.data.nr != __NR_execveat || request.data.args[0] != VINCI_BROKER_EXECUTABLE_FD || request.data.args[4] != AT_EMPTY_PATH
            || session->exec_consumed) goto protocol;
        result = answer_pending(session, SECCOMP_USER_NOTIF_FLAG_CONTINUE, 0, 0); if (result != 0) goto fail;
        session->exec_consumed = 1; session->phase = VINCI_SESSION_EXEC_PERMITTED; return 0;
    }
    if (session->phase == VINCI_SESSION_RUNNING_ATTESTED) {
        const struct vinci_broker_target_rule *rule = find_rule(session, request.data.nr);
        if (rule == NULL || rule->action == VINCI_TARGET_DENY) {
            result = answer_pending(session, 0, -EPERM, 0); if (result != 0) goto fail; return 0;
        }
        for (size_t index = 0; index < 6u; index++) {
            uint8_t bit = (uint8_t)(1u << index);
            if ((rule->scalar_argument_mask & bit) != 0 && (request.data.args[index] < rule->argument_values[index]
                || request.data.args[index] > rule->argument_maximums[index])) {
                result = answer_pending(session, 0, -EPERM, 0); if (result != 0) goto fail; return 0;
            }
            if (((rule->scalar_argument_mask | rule->output_pointer_mask) & bit) == 0 && request.data.args[index] != 0) {
                result = answer_pending(session, 0, -EPERM, 0); if (result != 0) goto fail; return 0;
            }
        }
        if (rule->action == VINCI_TARGET_EMULATE_ERRNO) result = answer_pending(session, 0, -rule->emulated_errno, 0);
        else result = answer_pending(session, SECCOMP_USER_NOTIF_FLAG_CONTINUE, 0, 0);
        if (result != 0) goto fail;
        return 0;
    }
protocol: result = -EPROTO;
fail: session->phase = VINCI_SESSION_UNCONTAINED; return result;
}

static int inject_pending_fd(struct vinci_broker_session *session, int source_fd, int target_fd, unsigned mask_bit) {
    if (!session->pending_notification || source_fd < 0 || !session->exec_consumed || session->cloexec_step != 17u
        || target_fd < VINCI_BROKER_TARGET_ATTESTATION_FD || target_fd > VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD
        || (session->target_injection_mask & mask_bit) != 0) return -EPERM;
    struct seccomp_notif request; memcpy(&request, session->pending_notification_storage, sizeof(request));
    if (ioctl(session->notification_fd, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id) != 0) return -ESTALE;
    /* The launcher closes fd10 before the trampoline. Exact trampoline fcntl
       steps 12..15 set CLOEXEC on fd11..12; exec then consumed step 17. The
       pinned target's only completed syscall is mediated PR_SET_DUMPABLE, so
       no target attestation fd can have been opened or replaced. */
    struct seccomp_notif_addfd add = { .id = request.id, .flags = SECCOMP_ADDFD_FLAG_SETFD,
        .srcfd = (uint32_t)source_fd, .newfd = (uint32_t)target_fd, .newfd_flags = O_CLOEXEC };
    int installed = ioctl(session->notification_fd, SECCOMP_IOCTL_NOTIF_ADDFD, &add);
    if (installed != target_fd) return installed < 0 ? -errno : -EPROTO;
    session->target_injection_mask |= mask_bit; return 0;
}

static int commit_target_injection_transcript(struct vinci_broker_session *session) {
    static const uint8_t domain[] = "VINCI-BROKER-V4-TARGET-INJECTION\0";
    uint8_t canonical[224];
    struct seccomp_notif request;
    if (session == NULL || !session->pending_notification || session->target_injection_mask != 7u) return -EPERM;
    memcpy(&request, session->pending_notification_storage, sizeof(request));
    memset(canonical, 0, sizeof(canonical));
    memcpy(canonical, domain, sizeof(domain));
    memcpy(canonical + 40u, session->hello.session_identity_sha256, 32u);
    memcpy(canonical + 72u, session->policy.target_attestation_socket_identity_sha256, 32u);
    memcpy(canonical + 104u, session->policy.target_attestation_key.key_id, 32u);
    memcpy(canonical + 136u, session->policy.target_attestation_context_sha256, 32u);
    put64(canonical + 168u, request.id); put32(canonical + 176u, VINCI_BROKER_TARGET_ATTESTATION_FD);
    put32(canonical + 180u, VINCI_BROKER_TARGET_ATTESTATION_KEY_FD);
    put32(canonical + 184u, VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD);
    put32(canonical + 188u, session->target_injection_mask);
    put64(canonical + 192u, session->policy.attempt_identity); put64(canonical + 200u, (uint64_t)session->pid);
    struct vinci_sha256_context context; vinci_sha256_init(&context);
    vinci_sha256_update(&context, canonical, sizeof(canonical));
    vinci_sha256_final(&context, session->target_injection_transcript_sha256);
    return 0;
}

int vinci_broker_session_confirm_running(struct vinci_broker_session *session) {
    if (session == NULL || session->phase != VINCI_SESSION_EXEC_PERMITTED) return -EPERM;
    uint8_t key[32]; int result = validate_key_fd(&session->policy.target_attestation_key, session->target_attestation_key_fd, key);
    if (result != 0) return result;
    uint64_t args[6] = { PR_SET_DUMPABLE, 0, 0, 0, 0, 0 };
    result = continue_exact(session, __NR_prctl, 3u, args); if (result != 0) goto fail;
    /* The next blocked syscall proves PR_SET_DUMPABLE returned before any
       attestation descriptor exists in the target. */
    result = receive_notification(session); if (result != 0) goto fail;
    struct seccomp_notif request; memcpy(&request, session->pending_notification_storage, sizeof(request));
    if (request.data.nr != __NR_pread64 || request.data.args[0] != VINCI_BROKER_TARGET_ATTESTATION_KEY_FD
        || request.data.args[2] != 32u || request.data.args[3] != 0) { result = -EPROTO; goto fail; }
    if (inject_pending_fd(session, session->target_attestation_source_fd, VINCI_BROKER_TARGET_ATTESTATION_FD, 1u) != 0
        || inject_pending_fd(session, session->target_attestation_key_fd, VINCI_BROKER_TARGET_ATTESTATION_KEY_FD, 2u) != 0
        || inject_pending_fd(session, session->target_attestation_context_fd, VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD, 4u) != 0
        || commit_target_injection_transcript(session) != 0) {
        result = -EKEYREJECTED; goto fail;
    }
    close(session->target_attestation_source_fd); session->target_attestation_source_fd = -1;
    memset(args, 0, sizeof(args)); args[0] = VINCI_BROKER_TARGET_ATTESTATION_KEY_FD; args[2] = 32u;
    result = continue_exact(session, __NR_pread64, 13u, args); if (result != 0) goto fail;
    args[0] = VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD; args[2] = VINCI_BROKER_TARGET_CONTEXT_WIRE_BYTES;
    result = continue_exact(session, __NR_pread64, 13u, args); if (result != 0) goto fail;
    memset(args, 0, sizeof(args)); result = continue_exact(session, __NR_getpid, 0u, args); if (result != 0) goto fail;
    args[0] = VINCI_BROKER_TARGET_ATTESTATION_FD; args[2] = MSG_NOSIGNAL;
    result = continue_exact(session, __NR_sendmsg, 5u, args); if (result != 0) goto fail;
    uint8_t wire[VINCI_BROKER_TARGET_ATTESTATION_WIRE_BYTES], expected[32];
    result = receive_fd_deadline(session, session->target_attestation_fd, wire, sizeof(wire)); if (result != 0) goto fail;
    uint8_t reserved = 0; for (size_t index = 192u; index < sizeof(wire); index++) reserved |= wire[index];
    if (reserved != 0 || get64(wire) != UINT64_C(0x56494e4354415454) || get32(wire + 8u) != 4u
        || get32(wire + 12u) != sizeof(wire) || get64(wire + 16u) != (uint64_t)session->pid
        || get64(wire + 24u) != session->policy.attempt_identity || memcmp(wire + 32u, session->hello.nonce, 32u) != 0
        || memcmp(wire + 64u, session->hello.session_identity_sha256, 32u) != 0
        || memcmp(wire + 96u, session->hello.executable_sha256, 32u) != 0
        || memcmp(wire + 128u, session->hello.target_attestation_key_id, 32u) != 0
        || vinci_hmac_sha256(key, 32u, wire, 160u, expected) != 0 || memcmp(expected, wire + 160u, 32u) != 0) { result = -EKEYREJECTED; goto fail; }
    memset(args, 0, sizeof(args)); args[0] = VINCI_BROKER_TARGET_ATTESTATION_FD;
    result = continue_exact(session, __NR_close, 1u, args); if (result != 0) goto fail;
    args[0] = VINCI_BROKER_TARGET_ATTESTATION_KEY_FD; result = continue_exact(session, __NR_close, 1u, args); if (result != 0) goto fail;
    args[0] = VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD; result = continue_exact(session, __NR_close, 1u, args); if (result != 0) goto fail;
    memset(key, 0, sizeof(key)); session->phase = VINCI_SESSION_RUNNING_ATTESTED; return 0;
fail: memset(key, 0, sizeof(key)); session->phase = VINCI_SESSION_UNCONTAINED; return result;
}

int vinci_broker_session_begin_closing(struct vinci_broker_session *session, int sealed_key_fd,
                                       const uint8_t journal_sha256[32],
                                       uint8_t receipt_wire[VINCI_BROKER_CLOSING_RECEIPT_WIRE_BYTES]) {
    if (session == NULL || journal_sha256 == NULL || receipt_wire == NULL
        || session->phase != VINCI_SESSION_RUNNING_ATTESTED || !nonzero(journal_sha256, 32u)) return -EPERM;
    uint8_t key[32]; int result = validate_key_fd(&session->policy.receipt_key, sealed_key_fd, key); if (result != 0) return result;
    memset(receipt_wire, 0, VINCI_BROKER_CLOSING_RECEIPT_WIRE_BYTES); put64(receipt_wire, UINT64_C(0x56494e43434c4f53));
    put32(receipt_wire + 8u, 4u); put32(receipt_wire + 12u, VINCI_BROKER_CLOSING_RECEIPT_WIRE_BYTES);
    put64(receipt_wire + 24u, session->policy.attempt_identity); put64(receipt_wire + 32u, session->hello.monotonic_deadline_ns);
    put64(receipt_wire + 40u, (uint64_t)session->pid); memcpy(receipt_wire + 64u, session->hello.session_identity_sha256, 32u);
    memcpy(receipt_wire + 96u, session->prelaunch_receipt_sha256, 32u); memcpy(receipt_wire + 128u, session->prelaunch_storage_sha256, 32u);
    memcpy(receipt_wire + 160u, journal_sha256, 32u); memcpy(receipt_wire + 192u, session->policy.cgroup_identity_sha256, 32u);
    memcpy(receipt_wire + 224u, session->policy.broker_identity_sha256, 32u); memcpy(receipt_wire + 256u, session->policy.receipt_key.key_id, 32u);
    struct vinci_sha256_context context; vinci_sha256_init(&context); vinci_sha256_update(&context, receipt_wire, 384u);
    vinci_sha256_final(&context, receipt_wire + 384u);
    result = vinci_hmac_sha256(key, 32u, receipt_wire, 416u, receipt_wire + 416u); memset(key, 0, sizeof(key));
    if (result != 0) return result;
    char digest_hex[65], name[128]; hex32(digest_hex, receipt_wire + 384u);
    int name_bytes = snprintf(name, sizeof(name), "closing-%016llx-%s.receipt", (unsigned long long)session->policy.attempt_identity, digest_hex);
    if (name_bytes <= 0 || (size_t)name_bytes >= sizeof(name)) return -EOVERFLOW;
    memcpy(session->closing_journal_sha256, journal_sha256, 32u); memcpy(session->closing_receipt_sha256, receipt_wire + 384u, 32u);
    vinci_sha256_init(&context); vinci_sha256_update(&context, receipt_wire, VINCI_BROKER_CLOSING_RECEIPT_WIRE_BYTES);
    vinci_sha256_final(&context, session->closing_storage_sha256);
    result = persist_atomic(session->receipt_directory_fd, name, receipt_wire, VINCI_BROKER_CLOSING_RECEIPT_WIRE_BYTES);
    if (result != 0) { session->reconcile_stage = 2u; session->phase = VINCI_SESSION_RECONCILE_ONLY; return result; }
    session->phase = VINCI_SESSION_CLOSING_DURABLE; return 0;
}

static int read_small_file(int directory_fd, const char *name, uint8_t *bytes, size_t capacity, size_t *length) {
    int fd = openat(directory_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); if (fd < 0) return -errno;
    ssize_t count = pread(fd, bytes, capacity, 0); int result = count >= 0 && (size_t)count < capacity ? 0 : -EOVERFLOW;
    if (result == 0) *length = (size_t)count;
    close(fd);
    return result;
}

static int event_value(const uint8_t *bytes, size_t length, const char *name, int expected) {
    size_t name_length = strlen(name), offset = 0; int matches = 0;
    while (offset < length) {
        const uint8_t *newline = memchr(bytes + offset, '\n', length - offset); if (newline == NULL) return 0;
        size_t line_length = (size_t)(newline - (bytes + offset));
        if (line_length == name_length + 2u && memcmp(bytes + offset, name, name_length) == 0
            && bytes[offset + name_length] == ' ' && bytes[offset + name_length + 1u] == (uint8_t)('0' + expected)) matches++;
        else if (line_length >= name_length + 1u && memcmp(bytes + offset, name, name_length) == 0 && bytes[offset + name_length] == ' ') return 0;
        offset += line_length + 1u;
    }
    return matches == 1;
}

static int wait_pidfd_terminal(struct vinci_broker_session *session, siginfo_t *info) {
    int timeout = remaining_milliseconds(session); if (timeout <= 0) return -ETIMEDOUT;
    struct pollfd descriptor = { .fd = session->pidfd, .events = POLLIN };
    int result = poll(&descriptor, 1, timeout); if (result < 0) return -errno;
    if (result == 0) return -ETIMEDOUT;
    if ((descriptor.revents & POLLIN) == 0) return -EIO;
    memset(info, 0, sizeof(*info));
    if (waitid(P_PIDFD, (id_t)session->pidfd, info, WEXITED | WNOWAIT | WNOHANG) != 0 || info->si_pid != session->pid
        || (info->si_code != CLD_EXITED && info->si_code != CLD_KILLED && info->si_code != CLD_DUMPED)) return -ECHILD;
    return 0;
}

static int validate_evidence_fd(int fd, uint32_t type, const uint8_t session_identity[32],
                                const uint8_t cgroup_identity[32], const uint8_t key[32], uint8_t digest[32]) {
    struct stat metadata; uint8_t wire[128], expected[32];
    if (fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_nlink != 0 || (metadata.st_mode & 0777u) != 0400u
        || pread(fd, wire, sizeof(wire), 0) != (ssize_t)sizeof(wire) || get64(wire) != UINT64_C(0x56494e4345564944)
        || get32(wire + 8u) != 4u || get32(wire + 12u) != sizeof(wire) || get32(wire + 16u) != type
        || get32(wire + 20u) != 0 || memcmp(wire + 24u, session_identity, 32u) != 0
        || memcmp(wire + 56u, cgroup_identity, 32u) != 0
        || vinci_hmac_sha256(key, 32u, wire, 88u, expected) != 0 || memcmp(expected, wire + 88u, 32u) != 0) return -EKEYREJECTED;
    uint8_t reserved = 0; for (size_t index = 120u; index < sizeof(wire); index++) reserved |= wire[index]; if (reserved != 0) return -EPROTO;
    struct vinci_sha256_context context; vinci_sha256_init(&context); vinci_sha256_update(&context, wire, sizeof(wire)); vinci_sha256_final(&context, digest); return 0;
}

int vinci_broker_session_finalize_terminal(struct vinci_broker_session *session,
                                           const struct vinci_broker_terminal_inputs *inputs,
                                           uint8_t receipt_wire[VINCI_BROKER_TERMINAL_RECEIPT_WIRE_BYTES]) {
    if (session == NULL || inputs == NULL || receipt_wire == NULL || session->phase != VINCI_SESSION_CLOSING_DURABLE
        || inputs->attach_audit_receipt_fd < 0 || inputs->capture_receipt_fd < 0 || inputs->cgroup_policy_receipt_fd < 0
        || inputs->ingress_closure_receipt_fd < 0) return -EPERM;
    uint8_t held_identity[32], key[32], attach_key[32], capture_key[32], policy_key[32], ingress_key[32];
    uint8_t attach_digest[32], capture_digest[32], policy_digest[32], ingress_digest[32];
    int result = derive_cgroup_identity(session->cgroup_directory_fd, session->policy.cgroup_owner_uid,
                                        session->policy.cgroup_owner_gid, held_identity);
    if (result != 0 || memcmp(held_identity, session->policy.cgroup_identity_sha256, 32u) != 0
        || validate_key_fd(&session->policy.receipt_key, inputs->sealed_key_fd, key) != 0
        || validate_key_fd(&session->policy.attach_audit_key, inputs->attach_audit_key_fd, attach_key) != 0
        || validate_key_fd(&session->policy.capture_key, inputs->capture_key_fd, capture_key) != 0
        || validate_key_fd(&session->policy.cgroup_policy_key, inputs->cgroup_policy_key_fd, policy_key) != 0
        || validate_key_fd(&session->policy.ingress_authority_key, inputs->ingress_authority_key_fd, ingress_key) != 0
        || validate_evidence_fd(inputs->attach_audit_receipt_fd, 1u, session->hello.session_identity_sha256,
                                held_identity, attach_key, attach_digest) != 0
        || validate_evidence_fd(inputs->capture_receipt_fd, 2u, session->hello.session_identity_sha256,
                                held_identity, capture_key, capture_digest) != 0
        || validate_evidence_fd(inputs->cgroup_policy_receipt_fd, 3u, session->hello.session_identity_sha256,
                                held_identity, policy_key, policy_digest) != 0
        || validate_evidence_fd(inputs->ingress_closure_receipt_fd, 4u, session->hello.session_identity_sha256,
                                held_identity, ingress_key, ingress_digest) != 0) {
        memset(key, 0, sizeof(key)); memset(attach_key, 0, sizeof(attach_key)); memset(capture_key, 0, sizeof(capture_key));
        memset(policy_key, 0, sizeof(policy_key)); memset(ingress_key, 0, sizeof(ingress_key));
        session->phase = VINCI_SESSION_UNCONTAINED; return -EKEYREJECTED;
    }
    memset(attach_key, 0, sizeof(attach_key)); memset(capture_key, 0, sizeof(capture_key));
    memset(policy_key, 0, sizeof(policy_key)); memset(ingress_key, 0, sizeof(ingress_key));
    int freeze_fd = openat(session->cgroup_directory_fd, "cgroup.freeze", O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
    if (freeze_fd < 0) { session->phase = VINCI_SESSION_UNCONTAINED; return -errno; }
    ssize_t freeze_count = write(freeze_fd, "1\n", 2u); int freeze_error = errno; close(freeze_fd);
    if (freeze_count != 2) { session->phase = VINCI_SESSION_UNCONTAINED; return freeze_count < 0 ? -freeze_error : -EIO; }
    int kill_fd = openat(session->cgroup_directory_fd, "cgroup.kill", O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
    if (kill_fd < 0) { session->phase = VINCI_SESSION_UNCONTAINED; return -errno; }
    ssize_t kill_count = write(kill_fd, "1\n", 2u); int kill_error = errno;
    if (close(kill_fd) != 0 && kill_count == 2) { session->phase = VINCI_SESSION_UNCONTAINED; return -errno; }
    if (kill_count != 2) { session->phase = VINCI_SESSION_UNCONTAINED; return kill_count < 0 ? -kill_error : -EIO; }
    session->phase = VINCI_SESSION_DOMAIN_KILLED;
    siginfo_t info; result = wait_pidfd_terminal(session, &info); if (result != 0) goto fail;
    session->phase = VINCI_SESSION_TASK_TERMINAL_OBSERVED;
    uint8_t events1[512], procs1[64]; size_t e1, p1; uint64_t zero_started, now; unsigned samples = 0;
    if (monotonic_now(&zero_started) != 0) { result = -EIO; goto fail; }
    do {
        if (read_small_file(session->cgroup_directory_fd, "cgroup.events", events1, sizeof(events1), &e1) != 0
            || read_small_file(session->cgroup_directory_fd, "cgroup.procs", procs1, sizeof(procs1), &p1) != 0
            || !event_value(events1, e1, "populated", 0) || !event_value(events1, e1, "frozen", 1) || p1 != 0) { result = -EBUSY; goto fail; }
        samples++; struct timespec pause = { .tv_sec = 0, .tv_nsec = 10000000L }; if (nanosleep(&pause, NULL) != 0 && errno != EINTR) { result = -errno; goto fail; }
        if (monotonic_now(&now) != 0 || now >= session->hello.monotonic_deadline_ns) { result = -ETIMEDOUT; goto fail; }
    } while (now - zero_started < session->policy.zero_stability_ns);
    if (samples < 2u) { result = -EBUSY; goto fail; }
    session->phase = VINCI_SESSION_ZERO_PROVEN;
    memset(receipt_wire, 0, VINCI_BROKER_TERMINAL_RECEIPT_WIRE_BYTES); put64(receipt_wire, UINT64_C(0x56494e435445524d));
    put32(receipt_wire + 8u, 4u); put32(receipt_wire + 12u, VINCI_BROKER_TERMINAL_RECEIPT_WIRE_BYTES); put64(receipt_wire + 24u, session->policy.attempt_identity);
    put64(receipt_wire + 32u, (uint64_t)session->pid); put32(receipt_wire + 40u, (uint32_t)info.si_code); put32(receipt_wire + 44u, (uint32_t)info.si_status);
    memcpy(receipt_wire + 64u, session->hello.session_identity_sha256, 32u); memcpy(receipt_wire + 96u, session->prelaunch_receipt_sha256, 32u);
    memcpy(receipt_wire + 128u, session->prelaunch_storage_sha256, 32u); memcpy(receipt_wire + 160u, session->closing_journal_sha256, 32u);
    memcpy(receipt_wire + 192u, attach_digest, 32u); memcpy(receipt_wire + 224u, capture_digest, 32u);
    memcpy(receipt_wire + 256u, policy_digest, 32u); memcpy(receipt_wire + 320u, session->closing_receipt_sha256, 32u);
    memcpy(receipt_wire + 352u, session->closing_storage_sha256, 32u); put32(receipt_wire + 384u, samples);
    memcpy(receipt_wire + 416u, ingress_digest, 32u);
    memcpy(receipt_wire + 448u, session->target_injection_transcript_sha256, 32u);
    struct vinci_sha256_context context;
    vinci_sha256_init(&context); vinci_sha256_update(&context, events1, e1); vinci_sha256_final(&context, receipt_wire + 288u);
    vinci_sha256_init(&context); vinci_sha256_update(&context, receipt_wire, 640u); vinci_sha256_final(&context, receipt_wire + 640u);
    if (vinci_hmac_sha256(key, 32u, receipt_wire, 672u, receipt_wire + 672u) != 0) { memset(key, 0, sizeof(key)); result = -EIO; goto fail; }
    memset(key, 0, sizeof(key)); session->phase = VINCI_SESSION_TERMINAL_BODY_COMMITTED;
    char digest_hex[65], name[128]; hex32(digest_hex, receipt_wire + 640u);
    int name_bytes = snprintf(name, sizeof(name), "terminal-%016llx-%s.receipt", (unsigned long long)session->policy.attempt_identity, digest_hex);
    if (name_bytes <= 0 || (size_t)name_bytes >= sizeof(name)) { result = -EOVERFLOW; goto fail; }
    result = persist_atomic(session->receipt_directory_fd, name, receipt_wire, VINCI_BROKER_TERMINAL_RECEIPT_WIRE_BYTES);
    if (result != 0) { session->reconcile_stage = 3u; goto reconcile; }
    session->phase = VINCI_SESSION_TERMINAL_STORAGE_COMMITTED;
    siginfo_t reaped; memset(&reaped, 0, sizeof(reaped));
    if (waitid(P_PIDFD, (id_t)session->pidfd, &reaped, WEXITED) != 0 || reaped.si_pid != info.si_pid
        || reaped.si_code != info.si_code || reaped.si_status != info.si_status) {
        session->reconcile_stage = 3u; session->phase = VINCI_SESSION_RECONCILE_ONLY; return -ECHILD;
    }
    session->phase = VINCI_SESSION_SEALED; return 0;
reconcile: memset(key, 0, sizeof(key)); session->phase = VINCI_SESSION_RECONCILE_ONLY; return result;
fail: memset(key, 0, sizeof(key)); session->phase = VINCI_SESSION_UNCONTAINED; return result;
}

int vinci_broker_session_close(struct vinci_broker_session *session) {
    if (session == NULL || (session->phase != VINCI_SESSION_SEALED && session->phase != VINCI_SESSION_RECONCILE_ONLY
        && session->phase != VINCI_SESSION_TERMINAL_FAILURE_COMMITTED)) return -EPERM;
    if (session->notification_fd >= 0) close(session->notification_fd);
    if (session->control_fd >= 0) close(session->control_fd);
    if (session->target_attestation_fd >= 0) close(session->target_attestation_fd);
    if (session->target_attestation_source_fd >= 0) close(session->target_attestation_source_fd);
    if (session->target_attestation_key_fd >= 0) close(session->target_attestation_key_fd);
    if (session->target_attestation_context_fd >= 0) close(session->target_attestation_context_fd);
    if (session->cgroup_directory_fd >= 0) close(session->cgroup_directory_fd);
    if (session->receipt_directory_fd >= 0) close(session->receipt_directory_fd);
    if (session->pidfd >= 0) close(session->pidfd);
    session->notification_fd = session->control_fd = session->target_attestation_fd = session->target_attestation_source_fd = -1;
    session->target_attestation_key_fd = session->target_attestation_context_fd = -1;
    session->cgroup_directory_fd = session->receipt_directory_fd = session->pidfd = -1; return 0;
}

static int verify_receipt_chain_member(const struct vinci_broker_session *session, const uint8_t key[32],
                                       const uint8_t *wire, size_t wire_bytes, uint64_t magic,
                                       size_t session_offset, size_t digest_offset, size_t hmac_offset) {
    uint8_t digest[32], hmac[32]; struct vinci_sha256_context context;
    if (wire == NULL || get64(wire) != magic || get32(wire + 8u) != 4u || get32(wire + 12u) != wire_bytes
        || get64(wire + 24u) != session->policy.attempt_identity
        || memcmp(wire + session_offset, session->hello.session_identity_sha256, 32u) != 0) return -EPROTO;
    vinci_sha256_init(&context); vinci_sha256_update(&context, wire, digest_offset); vinci_sha256_final(&context, digest);
    if (memcmp(digest, wire + digest_offset, 32u) != 0
        || vinci_hmac_sha256(key, 32u, wire, hmac_offset, hmac) != 0 || memcmp(hmac, wire + hmac_offset, 32u) != 0) return -EKEYREJECTED;
    return 0;
}

int vinci_broker_session_reconcile(struct vinci_broker_session *session, int sealed_key_fd,
                                   const uint8_t prelaunch[VINCI_BROKER_RECEIPT_WIRE_BYTES],
                                   const uint8_t closing[VINCI_BROKER_CLOSING_RECEIPT_WIRE_BYTES],
                                   const uint8_t terminal[VINCI_BROKER_TERMINAL_RECEIPT_WIRE_BYTES]) {
    if (session == NULL || session->phase != VINCI_SESSION_RECONCILE_ONLY || session->reconcile_stage < 1u
        || session->reconcile_stage > 3u) return -EPERM;
    uint8_t key[32]; int result = validate_key_fd(&session->policy.receipt_key, sealed_key_fd, key); if (result != 0) return result;
    char digest_hex[65], name[128]; struct vinci_sha256_context context;
    if (verify_receipt_chain_member(session, key, prelaunch, VINCI_BROKER_RECEIPT_WIRE_BYTES,
                                    UINT64_C(0x56494e4350524543), 96u, 512u, 544u) != 0) goto divergent;
    uint8_t canonical_prelaunch[VINCI_BROKER_RECEIPT_WIRE_BYTES];
    encode_prelaunch(session, prelaunch + 224u, canonical_prelaunch);
    if (memcmp(canonical_prelaunch, prelaunch, 512u) != 0 || !zero_region(prelaunch + 576u, 64u)) goto divergent;
    hex32(digest_hex, prelaunch + 512u); snprintf(name, sizeof(name), "prelaunch-%016llx-%s.receipt",
        (unsigned long long)session->policy.attempt_identity, digest_hex);
    if (identical_existing(session->receipt_directory_fd, name, prelaunch, VINCI_BROKER_RECEIPT_WIRE_BYTES) != 0) goto divergent;
    memcpy(session->prelaunch_receipt_sha256, prelaunch + 512u, 32u); vinci_sha256_init(&context);
    memcpy(session->prelaunch_receipt_wire, prelaunch, VINCI_BROKER_RECEIPT_WIRE_BYTES);
    vinci_sha256_update(&context, prelaunch, VINCI_BROKER_RECEIPT_WIRE_BYTES); vinci_sha256_final(&context, session->prelaunch_storage_sha256);
    if (session->reconcile_stage == 1u) { session->reconcile_stage = 0; session->phase = VINCI_SESSION_PRELAUNCH_STORAGE_COMMITTED; memset(key, 0, 32u); return 0; }
    if (verify_receipt_chain_member(session, key, closing, VINCI_BROKER_CLOSING_RECEIPT_WIRE_BYTES,
                                    UINT64_C(0x56494e43434c4f53), 64u, 384u, 416u) != 0
        || !zero_region(closing + 16u, 8u) || !zero_region(closing + 48u, 16u)
        || memcmp(closing + 96u, session->prelaunch_receipt_sha256, 32u) != 0
        || memcmp(closing + 128u, session->prelaunch_storage_sha256, 32u) != 0) goto divergent;
    if (get64(closing + 32u) != session->hello.monotonic_deadline_ns || get64(closing + 40u) != (uint64_t)session->pid
        || memcmp(closing + 192u, session->policy.cgroup_identity_sha256, 32u) != 0
        || memcmp(closing + 224u, session->policy.broker_identity_sha256, 32u) != 0
        || memcmp(closing + 256u, session->policy.receipt_key.key_id, 32u) != 0
        || !zero_region(closing + 288u, 96u) || !zero_region(closing + 448u, 64u)) goto divergent;
    hex32(digest_hex, closing + 384u); snprintf(name, sizeof(name), "closing-%016llx-%s.receipt",
        (unsigned long long)session->policy.attempt_identity, digest_hex);
    if (identical_existing(session->receipt_directory_fd, name, closing, VINCI_BROKER_CLOSING_RECEIPT_WIRE_BYTES) != 0) goto divergent;
    memcpy(session->closing_journal_sha256, closing + 160u, 32u); memcpy(session->closing_receipt_sha256, closing + 384u, 32u);
    vinci_sha256_init(&context); vinci_sha256_update(&context, closing, VINCI_BROKER_CLOSING_RECEIPT_WIRE_BYTES);
    vinci_sha256_final(&context, session->closing_storage_sha256);
    if (session->reconcile_stage == 2u) { session->reconcile_stage = 0; session->phase = VINCI_SESSION_CLOSING_DURABLE; memset(key, 0, 32u); return 0; }
    if (verify_receipt_chain_member(session, key, terminal, VINCI_BROKER_TERMINAL_RECEIPT_WIRE_BYTES,
                                    UINT64_C(0x56494e435445524d), 64u, 640u, 672u) != 0
        || !zero_region(terminal + 16u, 8u) || !zero_region(terminal + 48u, 16u)
        || memcmp(terminal + 96u, session->prelaunch_receipt_sha256, 32u) != 0
        || memcmp(terminal + 128u, session->prelaunch_storage_sha256, 32u) != 0
        || memcmp(terminal + 160u, session->closing_journal_sha256, 32u) != 0
        || memcmp(terminal + 320u, session->closing_receipt_sha256, 32u) != 0
        || memcmp(terminal + 352u, session->closing_storage_sha256, 32u) != 0
        || memcmp(terminal + 448u, session->target_injection_transcript_sha256, 32u) != 0
        || get64(terminal + 32u) != (uint64_t)session->pid || get32(terminal + 384u) < 2u
        || !zero_region(terminal + 388u, 28u) || !zero_region(terminal + 480u, 160u)
        || !zero_region(terminal + 704u, 64u)) goto divergent;
    hex32(digest_hex, terminal + 640u); snprintf(name, sizeof(name), "terminal-%016llx-%s.receipt",
        (unsigned long long)session->policy.attempt_identity, digest_hex);
    if (identical_existing(session->receipt_directory_fd, name, terminal, VINCI_BROKER_TERMINAL_RECEIPT_WIRE_BYTES) != 0) goto divergent;
    siginfo_t reaped; memset(&reaped, 0, sizeof(reaped));
    if (waitid(P_PIDFD, (id_t)session->pidfd, &reaped, WEXITED | WNOHANG) != 0 || reaped.si_pid != session->pid
        || (uint32_t)reaped.si_code != get32(terminal + 40u) || (uint32_t)reaped.si_status != get32(terminal + 44u)) goto divergent;
    session->reconcile_stage = 0; session->phase = VINCI_SESSION_SEALED; memset(key, 0, 32u); return 0;
divergent: memset(key, 0, 32u); session->phase = VINCI_SESSION_UNCONTAINED; return -EKEYREJECTED;
}
