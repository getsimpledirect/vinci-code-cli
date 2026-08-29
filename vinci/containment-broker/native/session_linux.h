#ifndef VINCI_CONTAINMENT_BROKER_SESSION_LINUX_H
#define VINCI_CONTAINMENT_BROKER_SESSION_LINUX_H

#include "protocol.h"
#include "launcher_linux.h"

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#define VINCI_BROKER_MAX_TARGET_RULES 256u
#define VINCI_BROKER_RECEIPT_WIRE_BYTES 640u
#define VINCI_BROKER_TERMINAL_RECEIPT_WIRE_BYTES 768u
#define VINCI_BROKER_CLOSING_RECEIPT_WIRE_BYTES 512u

enum vinci_broker_session_phase {
    VINCI_SESSION_CREATED = 0,
    VINCI_SESSION_HELLO_SENT,
    VINCI_SESSION_LISTENER_ACQUIRED,
    VINCI_SESSION_REPORT_VERIFIED,
    VINCI_SESSION_PRELAUNCH_BODY_COMMITTED,
    VINCI_SESSION_PRELAUNCH_STORAGE_COMMITTED,
    VINCI_SESSION_COMMIT_TASK_VERIFIED,
    VINCI_SESSION_RELEASE_ARMED,
    VINCI_SESSION_EXEC_PERMITTED,
    VINCI_SESSION_RUNNING_ATTESTED,
    VINCI_SESSION_CLOSING_DURABLE,
    VINCI_SESSION_TASK_TERMINAL_OBSERVED,
    VINCI_SESSION_DOMAIN_KILLED,
    VINCI_SESSION_ZERO_PROVEN,
    VINCI_SESSION_TERMINAL_BODY_COMMITTED,
    VINCI_SESSION_TERMINAL_STORAGE_COMMITTED,
    VINCI_SESSION_SEALED,
    VINCI_SESSION_RECONCILE_ONLY,
    VINCI_SESSION_TERMINAL_FAILURE_COMMITTED,
    VINCI_SESSION_UNCONTAINED,
};

enum vinci_broker_target_action {
    VINCI_TARGET_DENY = 0,
    VINCI_TARGET_CONTINUE_SCALAR = 1,
    VINCI_TARGET_CONTINUE_OUTPUT_POINTER = 2,
    VINCI_TARGET_EMULATE_ERRNO = 3,
};

struct vinci_broker_target_rule {
    int syscall_number;
    enum vinci_broker_target_action action;
    uint8_t scalar_argument_mask;
    uint8_t output_pointer_mask;
    uint16_t reserved;
    uint64_t argument_values[6];
    uint64_t argument_maximums[6];
    int32_t emulated_errno;
};

struct vinci_broker_key_policy {
    uint8_t key_id[VINCI_BROKER_KEY_ID_BYTES];
    uint8_t provenance_sha256[VINCI_BROKER_SHA256_BYTES];
    uint64_t generation;
    uint64_t not_before_monotonic_ns;
    uint64_t not_after_monotonic_ns;
    uid_t owner_uid;
    int revoked;
};

struct vinci_broker_session_policy {
    uid_t uid;
    gid_t gid;
    pid_t expected_parent;
    uint64_t monotonic_deadline_ns;
    uint64_t attempt_identity;
    uint32_t max_release_bytes;
    uint8_t nonce[VINCI_BROKER_NONCE_BYTES];
    uint8_t session_identity_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t trampoline_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t executable_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t argv_environment_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t executable_provenance_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t trampoline_build_receipt_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t cgroup_identity_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t broker_identity_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t control_socket_identity_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t target_attestation_socket_identity_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t target_attestation_context_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t receipt_directory_identity_sha256[VINCI_BROKER_SHA256_BYTES];
    uid_t cgroup_owner_uid;
    gid_t cgroup_owner_gid;
    uint64_t zero_stability_ns;
    int single_thread_only;
    struct vinci_broker_key_policy receipt_key;
    struct vinci_broker_key_policy target_attestation_key;
    struct vinci_broker_key_policy attach_audit_key;
    struct vinci_broker_key_policy capture_key;
    struct vinci_broker_key_policy cgroup_policy_key;
    struct vinci_broker_key_policy ingress_authority_key;
    const struct vinci_broker_target_rule *target_rules;
    size_t target_rule_count;
};

struct vinci_broker_session {
    int control_fd;
    int pidfd;
    int notification_fd;
    int target_attestation_fd;
    int target_attestation_source_fd;
    int target_attestation_key_fd;
    int target_attestation_context_fd;
    int cgroup_directory_fd;
    int receipt_directory_fd;
    pid_t pid;
    enum vinci_broker_session_phase phase;
    struct vinci_broker_hello hello;
    struct vinci_trampoline_report report;
    struct vinci_broker_session_policy policy;
    struct vinci_broker_target_rule target_rules[VINCI_BROKER_MAX_TARGET_RULES];
    size_t target_rule_count;
    uint64_t last_notification_id;
    int has_last_notification_id;
    unsigned bootstrap_step;
    unsigned cloexec_step;
    int pending_notification;
    uint8_t pending_notification_storage[256];
    int exec_consumed;
    unsigned target_injection_mask;
    uint8_t target_injection_transcript_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t prelaunch_receipt_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t prelaunch_storage_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t prelaunch_receipt_wire[VINCI_BROKER_RECEIPT_WIRE_BYTES];
    uint8_t closing_journal_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t closing_receipt_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t closing_storage_sha256[VINCI_BROKER_SHA256_BYTES];
    unsigned reconcile_stage;
};

struct vinci_broker_terminal_inputs {
    int sealed_key_fd;
    int attach_audit_key_fd;
    int capture_key_fd;
    int cgroup_policy_key_fd;
    int ingress_authority_key_fd;
    int attach_audit_receipt_fd;
    int capture_receipt_fd;
    int cgroup_policy_receipt_fd;
    int ingress_closure_receipt_fd;
};

int vinci_broker_derive_policy_identity(const struct vinci_broker_session_policy *policy,
                                        uint8_t digest[VINCI_BROKER_SHA256_BYTES]);
int vinci_broker_derive_task_attestation_identity(const struct vinci_broker_task *task,
                                                  uint8_t digest[VINCI_BROKER_SHA256_BYTES]);
int vinci_broker_session_initialize(struct vinci_broker_session *session, int receipt_directory_fd,
                                    struct vinci_broker_task *task,
                                    const struct vinci_broker_session_policy *policy);
int vinci_broker_build_target_context(const struct vinci_broker_session_policy *policy, int sealed_attestation_key_fd,
                                      uint8_t context_wire[VINCI_BROKER_TARGET_CONTEXT_WIRE_BYTES]);
int vinci_broker_session_send_hello(struct vinci_broker_session *session);
int vinci_broker_session_acquire_listener(struct vinci_broker_session *session);
int vinci_broker_session_receive_report(struct vinci_broker_session *session);
int vinci_broker_session_commit_prelaunch(struct vinci_broker_session *session, int sealed_key_fd,
                                          const uint8_t journal_sha256[VINCI_BROKER_SHA256_BYTES],
                                          uint8_t receipt_wire[VINCI_BROKER_RECEIPT_WIRE_BYTES]);
int vinci_broker_session_release(struct vinci_broker_session *session, const void *payload, size_t payload_bytes,
                                 uint32_t argc, uint32_t envc);
int vinci_broker_session_mediate_once(struct vinci_broker_session *session);
int vinci_broker_session_confirm_running(struct vinci_broker_session *session);
int vinci_broker_session_begin_closing(struct vinci_broker_session *session, int sealed_key_fd,
                                       const uint8_t journal_sha256[VINCI_BROKER_SHA256_BYTES],
                                       uint8_t receipt_wire[VINCI_BROKER_CLOSING_RECEIPT_WIRE_BYTES]);
int vinci_broker_session_finalize_terminal(struct vinci_broker_session *session,
                                           const struct vinci_broker_terminal_inputs *inputs,
                                           uint8_t receipt_wire[VINCI_BROKER_TERMINAL_RECEIPT_WIRE_BYTES]);
int vinci_broker_session_close(struct vinci_broker_session *session);
int vinci_broker_session_reconcile(struct vinci_broker_session *session, int sealed_key_fd,
                                   const uint8_t prelaunch[VINCI_BROKER_RECEIPT_WIRE_BYTES],
                                   const uint8_t closing[VINCI_BROKER_CLOSING_RECEIPT_WIRE_BYTES],
                                   const uint8_t terminal[VINCI_BROKER_TERMINAL_RECEIPT_WIRE_BYTES]);

#endif
