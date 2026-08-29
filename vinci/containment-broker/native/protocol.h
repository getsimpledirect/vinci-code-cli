#ifndef VINCI_CONTAINMENT_BROKER_PROTOCOL_H
#define VINCI_CONTAINMENT_BROKER_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

#define VINCI_BROKER_PROTOCOL_VERSION 4u
#define VINCI_BROKER_CONTROL_FD 3
#define VINCI_BROKER_EXECUTABLE_FD 4
#define VINCI_BROKER_TRAMPOLINE_FD 5
#define VINCI_BROKER_NOTIFICATION_FD 6
#define VINCI_BROKER_RECEIPT_VERIFIER_FD 7
#define VINCI_BROKER_EXECUTABLE_PROVENANCE_FD 8
#define VINCI_BROKER_TRAMPOLINE_BUILD_RECEIPT_FD 9
#define VINCI_BROKER_TARGET_ATTESTATION_FD 10
#define VINCI_BROKER_TARGET_ATTESTATION_KEY_FD 11
#define VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD 12
#define VINCI_BROKER_NONCE_BYTES 32u
#define VINCI_BROKER_SHA256_BYTES 32u
#define VINCI_BROKER_KEY_ID_BYTES 32u
#define VINCI_BROKER_MAX_RELEASE_BYTES (64u * 1024u)
#define VINCI_BROKER_MAX_ARGC 64u
#define VINCI_BROKER_MAX_ENVC 64u

#define VINCI_BROKER_HELLO_MAGIC UINT64_C(0x56494e434948454c)
#define VINCI_BROKER_REPORT_MAGIC UINT64_C(0x56494e4349525054)
#define VINCI_BROKER_COMMIT_MAGIC UINT64_C(0x56494e434950434d)
#define VINCI_BROKER_RELEASE_MAGIC UINT64_C(0x56494e434952454c)

/* Wire records are byte strings, never C object representations. */
#define VINCI_BROKER_HELLO_WIRE_BYTES 384u
#define VINCI_BROKER_OBJECT_RECEIPT_WIRE_BYTES 128u
#define VINCI_BROKER_TARGET_CONTEXT_WIRE_BYTES 192u
#define VINCI_BROKER_TARGET_ATTESTATION_WIRE_BYTES 192u
#define VINCI_BROKER_REPORT_WIRE_BYTES 200u
#define VINCI_BROKER_COMMIT_WIRE_BYTES 208u
#define VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES 184u
#define VINCI_BROKER_SLICE_WIRE_BYTES 8u

struct vinci_broker_hello {
    uint64_t monotonic_deadline_ns;
    uint64_t attempt_identity;
    uint32_t max_release_bytes;
    uint8_t nonce[VINCI_BROKER_NONCE_BYTES];
    uint8_t session_identity_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t trampoline_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t executable_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t argv_environment_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t receipt_key_id[VINCI_BROKER_KEY_ID_BYTES];
    uint32_t target_uid;
    uint32_t target_gid;
    int64_t expected_parent_pid;
    uint8_t executable_provenance_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t trampoline_build_receipt_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t target_attestation_key_id[VINCI_BROKER_KEY_ID_BYTES];
    uint8_t target_attestation_context_sha256[VINCI_BROKER_SHA256_BYTES];
};

struct vinci_trampoline_report {
    int64_t pid;
    uint32_t uid;
    uint32_t gid;
    uint32_t no_new_privs;
    uint8_t nonce[VINCI_BROKER_NONCE_BYTES];
    uint8_t session_identity_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t trampoline_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t executable_sha256[VINCI_BROKER_SHA256_BYTES];
};

struct vinci_broker_prelaunch_commit {
    uint64_t monotonic_deadline_ns;
    uint64_t attempt_identity;
    uint8_t nonce[VINCI_BROKER_NONCE_BYTES];
    uint8_t session_identity_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t receipt_body_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t receipt_hmac_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t receipt_key_id[VINCI_BROKER_KEY_ID_BYTES];
};

struct vinci_broker_release {
    uint32_t payload_bytes;
    uint32_t argc;
    uint32_t envc;
    uint8_t nonce[VINCI_BROKER_NONCE_BYTES];
    uint8_t session_identity_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t prelaunch_receipt_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t argv_environment_sha256[VINCI_BROKER_SHA256_BYTES];
};

struct vinci_broker_slice { uint32_t offset; uint32_t length; };

int vinci_protocol_encode_hello(uint8_t output[VINCI_BROKER_HELLO_WIRE_BYTES], const struct vinci_broker_hello *hello);
int vinci_protocol_decode_hello(struct vinci_broker_hello *hello, const uint8_t *input, size_t input_bytes);
int vinci_protocol_encode_report(uint8_t output[VINCI_BROKER_REPORT_WIRE_BYTES], const struct vinci_trampoline_report *report);
int vinci_protocol_decode_report(struct vinci_trampoline_report *report, const uint8_t *input, size_t input_bytes);
int vinci_protocol_encode_commit(uint8_t output[VINCI_BROKER_COMMIT_WIRE_BYTES], const struct vinci_broker_prelaunch_commit *commit);
int vinci_protocol_decode_commit(struct vinci_broker_prelaunch_commit *commit, const uint8_t *input, size_t input_bytes);
int vinci_protocol_encode_release_header(uint8_t output[VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES], const struct vinci_broker_release *release);
int vinci_protocol_decode_release_header(struct vinci_broker_release *release, const uint8_t *input, size_t input_bytes);
void vinci_protocol_encode_slice(uint8_t output[VINCI_BROKER_SLICE_WIRE_BYTES], const struct vinci_broker_slice *slice);
int vinci_protocol_decode_slice(struct vinci_broker_slice *slice, const uint8_t *input, size_t input_bytes);

#endif
