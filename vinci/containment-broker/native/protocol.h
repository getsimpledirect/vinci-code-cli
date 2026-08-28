#ifndef VINCI_CONTAINMENT_BROKER_PROTOCOL_H
#define VINCI_CONTAINMENT_BROKER_PROTOCOL_H

#include <stdint.h>

#define VINCI_BROKER_PROTOCOL_VERSION 3u
#define VINCI_BROKER_CONTROL_FD 3
#define VINCI_BROKER_EXECUTABLE_FD 4
#define VINCI_BROKER_NONCE_BYTES 32u
#define VINCI_BROKER_SHA256_BYTES 32u

#define VINCI_BROKER_HELLO_MAGIC UINT64_C(0x56494e434948454c)
#define VINCI_BROKER_REPORT_MAGIC UINT64_C(0x56494e4349525054)
#define VINCI_BROKER_RELEASE_MAGIC UINT64_C(0x56494e434952454c)

struct vinci_broker_hello {
    uint64_t magic;
    uint32_t version;
    uint32_t reserved;
    uint8_t nonce[VINCI_BROKER_NONCE_BYTES];
    uint8_t trampoline_sha256[VINCI_BROKER_SHA256_BYTES];
};

struct vinci_trampoline_report {
    uint64_t magic;
    uint32_t version;
    uint32_t report_bytes;
    int64_t pid;
    uint32_t uid;
    uint32_t gid;
    uint8_t nonce[VINCI_BROKER_NONCE_BYTES];
    uint8_t executable_identity_sha256[VINCI_BROKER_SHA256_BYTES];
};

struct vinci_broker_release {
    uint64_t magic;
    uint32_t version;
    uint32_t release_bytes;
    uint8_t nonce[VINCI_BROKER_NONCE_BYTES];
    uint8_t prelaunch_receipt_sha256[VINCI_BROKER_SHA256_BYTES];
    uint8_t argv_environment_sha256[VINCI_BROKER_SHA256_BYTES];
};

#endif
