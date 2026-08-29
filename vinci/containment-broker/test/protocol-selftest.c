#include "../native/protocol.h"

#include <stdint.h>
#include <string.h>

int main(void) {
    struct vinci_broker_hello input;
    struct vinci_broker_hello decoded;
    uint8_t wire[VINCI_BROKER_HELLO_WIRE_BYTES];
    memset(&input, 0, sizeof(input));
    input.monotonic_deadline_ns = UINT64_C(0x0102030405060708);
    input.attempt_identity = UINT64_C(0x1112131415161718);
    input.max_release_bytes = 4096u;
    input.target_uid = 1000u;
    input.target_gid = 1001u;
    input.expected_parent_pid = 42;
    memset(input.nonce, 1, sizeof(input.nonce));
    memset(input.session_identity_sha256, 2, sizeof(input.session_identity_sha256));
    memset(input.trampoline_sha256, 3, sizeof(input.trampoline_sha256));
    memset(input.executable_sha256, 4, sizeof(input.executable_sha256));
    memset(input.argv_environment_sha256, 5, sizeof(input.argv_environment_sha256));
    memset(input.receipt_key_id, 6, sizeof(input.receipt_key_id));
    if (vinci_protocol_encode_hello(wire, &input) != 0 || wire[16] != 1u || wire[23] != 8u
        || vinci_protocol_decode_hello(&decoded, wire, sizeof(wire)) != 0
        || memcmp(&input, &decoded, sizeof(input)) != 0) return 1;
    wire[240] = 1u;
    if (vinci_protocol_decode_hello(&decoded, wire, sizeof(wire)) == 0) return 2;

    struct vinci_broker_slice slice = { .offset = UINT32_C(0x01020304), .length = 7u };
    struct vinci_broker_slice decoded_slice;
    uint8_t slice_wire[VINCI_BROKER_SLICE_WIRE_BYTES];
    vinci_protocol_encode_slice(slice_wire, &slice);
    if (slice_wire[0] != 1u || slice_wire[3] != 4u
        || vinci_protocol_decode_slice(&decoded_slice, slice_wire, sizeof(slice_wire)) != 0
        || decoded_slice.offset != slice.offset || decoded_slice.length != slice.length) return 3;
    return 0;
}
