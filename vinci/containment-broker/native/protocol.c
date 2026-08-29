#include "protocol.h"

#include <errno.h>
#include <limits.h>
#include <string.h>

static void store_u32(uint8_t *output, uint32_t value) {
    output[0] = (uint8_t)(value >> 24u); output[1] = (uint8_t)(value >> 16u);
    output[2] = (uint8_t)(value >> 8u); output[3] = (uint8_t)value;
}

static void store_u64(uint8_t *output, uint64_t value) {
    for (size_t index = 0; index < 8u; index++) output[index] = (uint8_t)(value >> (56u - index * 8u));
}

static uint32_t load_u32(const uint8_t *input) {
    return ((uint32_t)input[0] << 24u) | ((uint32_t)input[1] << 16u)
        | ((uint32_t)input[2] << 8u) | (uint32_t)input[3];
}

static uint64_t load_u64(const uint8_t *input) {
    uint64_t value = 0;
    for (size_t index = 0; index < 8u; index++) value = (value << 8u) | input[index];
    return value;
}

static int zero_bytes(const uint8_t *input, size_t length) {
    uint8_t aggregate = 0;
    for (size_t index = 0; index < length; index++) aggregate |= input[index];
    return aggregate == 0;
}

static void make_header(uint8_t *output, size_t bytes, uint64_t magic) {
    memset(output, 0, bytes);
    store_u64(output, magic); store_u32(output + 8u, VINCI_BROKER_PROTOCOL_VERSION);
    store_u32(output + 12u, (uint32_t)bytes);
}

static int valid_header(const uint8_t *input, size_t input_bytes, uint64_t magic, size_t exact_bytes) {
    return input != NULL && input_bytes == exact_bytes && load_u64(input) == magic
        && load_u32(input + 8u) == VINCI_BROKER_PROTOCOL_VERSION && load_u32(input + 12u) == exact_bytes;
}

int vinci_protocol_encode_hello(uint8_t output[VINCI_BROKER_HELLO_WIRE_BYTES], const struct vinci_broker_hello *hello) {
    if (output == NULL || hello == NULL) return -EINVAL;
    make_header(output, VINCI_BROKER_HELLO_WIRE_BYTES, VINCI_BROKER_HELLO_MAGIC);
    store_u64(output + 16u, hello->monotonic_deadline_ns); store_u32(output + 24u, hello->max_release_bytes);
    memcpy(output + 32u, hello->nonce, 32u); memcpy(output + 64u, hello->session_identity_sha256, 32u);
    memcpy(output + 96u, hello->trampoline_sha256, 32u); memcpy(output + 128u, hello->executable_sha256, 32u);
    memcpy(output + 160u, hello->argv_environment_sha256, 32u);
    memcpy(output + 192u, hello->receipt_key_id, 32u);
    store_u32(output + 224u, hello->target_uid); store_u32(output + 228u, hello->target_gid);
    store_u64(output + 232u, (uint64_t)hello->expected_parent_pid);
    memcpy(output + 248u, hello->executable_provenance_sha256, 32u);
    memcpy(output + 280u, hello->trampoline_build_receipt_sha256, 32u);
    memcpy(output + 312u, hello->target_attestation_key_id, 32u);
    memcpy(output + 344u, hello->target_attestation_context_sha256, 32u);
    store_u64(output + 376u, hello->attempt_identity);
    return 0;
}

int vinci_protocol_decode_hello(struct vinci_broker_hello *hello, const uint8_t *input, size_t input_bytes) {
    if (hello == NULL || !valid_header(input, input_bytes, VINCI_BROKER_HELLO_MAGIC, VINCI_BROKER_HELLO_WIRE_BYTES)
        || !zero_bytes(input + 28u, 4u) || !zero_bytes(input + 240u, 8u)) return -EPROTO;
    memset(hello, 0, sizeof(*hello)); hello->monotonic_deadline_ns = load_u64(input + 16u);
    hello->max_release_bytes = load_u32(input + 24u); memcpy(hello->nonce, input + 32u, 32u);
    memcpy(hello->session_identity_sha256, input + 64u, 32u); memcpy(hello->trampoline_sha256, input + 96u, 32u);
    memcpy(hello->executable_sha256, input + 128u, 32u); memcpy(hello->argv_environment_sha256, input + 160u, 32u);
    memcpy(hello->receipt_key_id, input + 192u, 32u);
    hello->target_uid = load_u32(input + 224u); hello->target_gid = load_u32(input + 228u);
    hello->expected_parent_pid = (int64_t)load_u64(input + 232u);
    memcpy(hello->executable_provenance_sha256, input + 248u, 32u);
    memcpy(hello->trampoline_build_receipt_sha256, input + 280u, 32u);
    memcpy(hello->target_attestation_key_id, input + 312u, 32u);
    memcpy(hello->target_attestation_context_sha256, input + 344u, 32u);
    hello->attempt_identity = load_u64(input + 376u);
    return hello->attempt_identity == 0 ? -EPROTO : 0;
}

int vinci_protocol_encode_report(uint8_t output[VINCI_BROKER_REPORT_WIRE_BYTES], const struct vinci_trampoline_report *report) {
    if (output == NULL || report == NULL || report->pid <= 0) return -EINVAL;
    make_header(output, VINCI_BROKER_REPORT_WIRE_BYTES, VINCI_BROKER_REPORT_MAGIC);
    store_u64(output + 16u, (uint64_t)report->pid); store_u32(output + 24u, report->uid);
    store_u32(output + 28u, report->gid); store_u32(output + 32u, report->no_new_privs);
    memcpy(output + 40u, report->nonce, 32u); memcpy(output + 72u, report->session_identity_sha256, 32u);
    memcpy(output + 104u, report->trampoline_sha256, 32u); memcpy(output + 136u, report->executable_sha256, 32u);
    return 0;
}

int vinci_protocol_decode_report(struct vinci_trampoline_report *report, const uint8_t *input, size_t input_bytes) {
    uint64_t pid;
    if (report == NULL || !valid_header(input, input_bytes, VINCI_BROKER_REPORT_MAGIC, VINCI_BROKER_REPORT_WIRE_BYTES)
        || !zero_bytes(input + 36u, 4u) || !zero_bytes(input + 168u, 32u)) return -EPROTO;
    pid = load_u64(input + 16u); if (pid == 0 || pid > INT64_MAX) return -EPROTO;
    memset(report, 0, sizeof(*report)); report->pid = (int64_t)pid; report->uid = load_u32(input + 24u);
    report->gid = load_u32(input + 28u); report->no_new_privs = load_u32(input + 32u);
    memcpy(report->nonce, input + 40u, 32u); memcpy(report->session_identity_sha256, input + 72u, 32u);
    memcpy(report->trampoline_sha256, input + 104u, 32u); memcpy(report->executable_sha256, input + 136u, 32u);
    return 0;
}

int vinci_protocol_encode_commit(uint8_t output[VINCI_BROKER_COMMIT_WIRE_BYTES], const struct vinci_broker_prelaunch_commit *commit) {
    if (output == NULL || commit == NULL || commit->attempt_identity == 0) return -EINVAL;
    make_header(output, VINCI_BROKER_COMMIT_WIRE_BYTES, VINCI_BROKER_COMMIT_MAGIC);
    store_u64(output + 16u, commit->monotonic_deadline_ns); store_u64(output + 24u, commit->attempt_identity);
    memcpy(output + 32u, commit->nonce, 32u); memcpy(output + 64u, commit->session_identity_sha256, 32u);
    memcpy(output + 96u, commit->receipt_body_sha256, 32u); memcpy(output + 128u, commit->receipt_hmac_sha256, 32u);
    memcpy(output + 160u, commit->receipt_key_id, 32u);
    return 0;
}

int vinci_protocol_decode_commit(struct vinci_broker_prelaunch_commit *commit, const uint8_t *input, size_t input_bytes) {
    if (commit == NULL || !valid_header(input, input_bytes, VINCI_BROKER_COMMIT_MAGIC, VINCI_BROKER_COMMIT_WIRE_BYTES)
        || !zero_bytes(input + 192u, 16u)) return -EPROTO;
    memset(commit, 0, sizeof(*commit)); commit->monotonic_deadline_ns = load_u64(input + 16u);
    commit->attempt_identity = load_u64(input + 24u); memcpy(commit->nonce, input + 32u, 32u);
    memcpy(commit->session_identity_sha256, input + 64u, 32u); memcpy(commit->receipt_body_sha256, input + 96u, 32u);
    memcpy(commit->receipt_hmac_sha256, input + 128u, 32u); memcpy(commit->receipt_key_id, input + 160u, 32u);
    return commit->attempt_identity == 0 ? -EPROTO : 0;
}

int vinci_protocol_encode_release_header(uint8_t output[VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES], const struct vinci_broker_release *release) {
    if (output == NULL || release == NULL) return -EINVAL;
    make_header(output, VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES, VINCI_BROKER_RELEASE_MAGIC);
    store_u32(output + 16u, release->payload_bytes); store_u32(output + 20u, release->argc); store_u32(output + 24u, release->envc);
    memcpy(output + 32u, release->nonce, 32u); memcpy(output + 64u, release->session_identity_sha256, 32u);
    memcpy(output + 96u, release->prelaunch_receipt_sha256, 32u); memcpy(output + 128u, release->argv_environment_sha256, 32u);
    return 0;
}

int vinci_protocol_decode_release_header(struct vinci_broker_release *release, const uint8_t *input, size_t input_bytes) {
    if (release == NULL || !valid_header(input, input_bytes, VINCI_BROKER_RELEASE_MAGIC, VINCI_BROKER_RELEASE_HEADER_WIRE_BYTES)
        || !zero_bytes(input + 28u, 4u) || !zero_bytes(input + 160u, 24u)) return -EPROTO;
    memset(release, 0, sizeof(*release)); release->payload_bytes = load_u32(input + 16u);
    release->argc = load_u32(input + 20u); release->envc = load_u32(input + 24u);
    memcpy(release->nonce, input + 32u, 32u); memcpy(release->session_identity_sha256, input + 64u, 32u);
    memcpy(release->prelaunch_receipt_sha256, input + 96u, 32u); memcpy(release->argv_environment_sha256, input + 128u, 32u);
    return 0;
}

void vinci_protocol_encode_slice(uint8_t output[VINCI_BROKER_SLICE_WIRE_BYTES], const struct vinci_broker_slice *slice) {
    store_u32(output, slice->offset); store_u32(output + 4u, slice->length);
}

int vinci_protocol_decode_slice(struct vinci_broker_slice *slice, const uint8_t *input, size_t input_bytes) {
    if (slice == NULL || input == NULL || input_bytes != VINCI_BROKER_SLICE_WIRE_BYTES) return -EPROTO;
    slice->offset = load_u32(input); slice->length = load_u32(input + 4u); return 0;
}
