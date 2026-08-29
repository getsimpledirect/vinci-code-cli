#define _GNU_SOURCE

#include "sha256.h"

#include <errno.h>
#include <string.h>
#include <unistd.h>

static const uint32_t round_constants[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

static uint32_t rotate_right(uint32_t value, unsigned count) {
    return (value >> count) | (value << (32u - count));
}

static uint32_t load_be32(const uint8_t *bytes) {
    return ((uint32_t)bytes[0] << 24u) | ((uint32_t)bytes[1] << 16u) | ((uint32_t)bytes[2] << 8u) | bytes[3];
}

static void store_be32(uint8_t *bytes, uint32_t value) {
    bytes[0] = (uint8_t)(value >> 24u);
    bytes[1] = (uint8_t)(value >> 16u);
    bytes[2] = (uint8_t)(value >> 8u);
    bytes[3] = (uint8_t)value;
}

static void transform(struct vinci_sha256_context *context, const uint8_t block[64]) {
    uint32_t words[64];
    for (size_t index = 0; index < 16; index++) words[index] = load_be32(block + index * 4u);
    for (size_t index = 16; index < 64; index++) {
        uint32_t first = rotate_right(words[index - 15], 7) ^ rotate_right(words[index - 15], 18) ^ (words[index - 15] >> 3u);
        uint32_t second = rotate_right(words[index - 2], 17) ^ rotate_right(words[index - 2], 19) ^ (words[index - 2] >> 10u);
        words[index] = words[index - 16] + first + words[index - 7] + second;
    }
    uint32_t a = context->state[0], b = context->state[1], c = context->state[2], d = context->state[3];
    uint32_t e = context->state[4], f = context->state[5], g = context->state[6], h = context->state[7];
    for (size_t index = 0; index < 64; index++) {
        uint32_t sum_one = rotate_right(e, 6) ^ rotate_right(e, 11) ^ rotate_right(e, 25);
        uint32_t choice = (e & f) ^ ((~e) & g);
        uint32_t temporary_one = h + sum_one + choice + round_constants[index] + words[index];
        uint32_t sum_zero = rotate_right(a, 2) ^ rotate_right(a, 13) ^ rotate_right(a, 22);
        uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
        uint32_t temporary_two = sum_zero + majority;
        h = g; g = f; f = e; e = d + temporary_one; d = c; c = b; b = a; a = temporary_one + temporary_two;
    }
    context->state[0] += a; context->state[1] += b; context->state[2] += c; context->state[3] += d;
    context->state[4] += e; context->state[5] += f; context->state[6] += g; context->state[7] += h;
}

void vinci_sha256_init(struct vinci_sha256_context *context) {
    static const uint32_t initial[8] = { 0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au, 0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u };
    memcpy(context->state, initial, sizeof(initial));
    context->bit_count = 0;
    context->block_bytes = 0;
}

void vinci_sha256_update(struct vinci_sha256_context *context, const void *input, size_t length) {
    const uint8_t *bytes = input;
    context->bit_count += (uint64_t)length * 8u;
    while (length > 0) {
        size_t available = 64u - context->block_bytes;
        size_t copied = length < available ? length : available;
        memcpy(context->block + context->block_bytes, bytes, copied);
        context->block_bytes += copied;
        bytes += copied;
        length -= copied;
        if (context->block_bytes == 64u) {
            transform(context, context->block);
            context->block_bytes = 0;
        }
    }
}

void vinci_sha256_final(struct vinci_sha256_context *context, uint8_t digest[32]) {
    context->block[context->block_bytes++] = 0x80u;
    if (context->block_bytes > 56u) {
        memset(context->block + context->block_bytes, 0, 64u - context->block_bytes);
        transform(context, context->block);
        context->block_bytes = 0;
    }
    memset(context->block + context->block_bytes, 0, 56u - context->block_bytes);
    for (size_t index = 0; index < 8; index++) context->block[63u - index] = (uint8_t)(context->bit_count >> (index * 8u));
    transform(context, context->block);
    for (size_t index = 0; index < 8; index++) store_be32(digest + index * 4u, context->state[index]);
    memset(context, 0, sizeof(*context));
}

int vinci_sha256_fd(int fd, uint8_t digest[32]) {
    struct vinci_sha256_context context;
    uint8_t buffer[32768];
    off_t offset = 0;
    vinci_sha256_init(&context);
    for (;;) {
        ssize_t count = pread(fd, buffer, sizeof(buffer), offset);
        if (count == 0) break;
        if (count < 0) return -errno;
        vinci_sha256_update(&context, buffer, (size_t)count);
        offset += count;
    }
    vinci_sha256_final(&context, digest);
    return 0;
}

int vinci_hmac_sha256(const void *key_input, size_t key_bytes, const void *message, size_t message_bytes, uint8_t digest[32]) {
    if (key_input == NULL || key_bytes == 0 || (message == NULL && message_bytes != 0) || digest == NULL) return -EINVAL;
    const uint8_t *key = key_input;
    uint8_t normalized[64];
    uint8_t inner_digest[32];
    memset(normalized, 0, sizeof(normalized));
    if (key_bytes > sizeof(normalized)) {
        struct vinci_sha256_context key_context;
        vinci_sha256_init(&key_context);
        vinci_sha256_update(&key_context, key, key_bytes);
        vinci_sha256_final(&key_context, normalized);
    } else {
        memcpy(normalized, key, key_bytes);
    }
    uint8_t inner_pad[64];
    uint8_t outer_pad[64];
    for (size_t index = 0; index < sizeof(normalized); index++) {
        inner_pad[index] = normalized[index] ^ 0x36u;
        outer_pad[index] = normalized[index] ^ 0x5cu;
    }
    struct vinci_sha256_context context;
    vinci_sha256_init(&context);
    vinci_sha256_update(&context, inner_pad, sizeof(inner_pad));
    vinci_sha256_update(&context, message, message_bytes);
    vinci_sha256_final(&context, inner_digest);
    vinci_sha256_init(&context);
    vinci_sha256_update(&context, outer_pad, sizeof(outer_pad));
    vinci_sha256_update(&context, inner_digest, sizeof(inner_digest));
    vinci_sha256_final(&context, digest);
    memset(normalized, 0, sizeof(normalized));
    memset(inner_pad, 0, sizeof(inner_pad));
    memset(outer_pad, 0, sizeof(outer_pad));
    memset(inner_digest, 0, sizeof(inner_digest));
    return 0;
}
