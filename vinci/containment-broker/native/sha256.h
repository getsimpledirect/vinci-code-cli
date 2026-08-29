#ifndef VINCI_CONTAINMENT_BROKER_SHA256_H
#define VINCI_CONTAINMENT_BROKER_SHA256_H

#include <stddef.h>
#include <stdint.h>

struct vinci_sha256_context {
    uint32_t state[8];
    uint64_t bit_count;
    uint8_t block[64];
    size_t block_bytes;
};

void vinci_sha256_init(struct vinci_sha256_context *context);
void vinci_sha256_update(struct vinci_sha256_context *context, const void *bytes, size_t length);
void vinci_sha256_final(struct vinci_sha256_context *context, uint8_t digest[32]);
int vinci_sha256_fd(int fd, uint8_t digest[32]);
int vinci_hmac_sha256(const void *key, size_t key_bytes, const void *message, size_t message_bytes, uint8_t digest[32]);

#endif
