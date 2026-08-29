#define _GNU_SOURCE
#ifndef __linux__
#error "the target bootstrap is Linux-only"
#endif

#include "target_bootstrap_linux.h"
#include "protocol.h"
#include "sha256.h"

#include <stdint.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

static long raw_syscall6(long number, long a0, long a1, long a2, long a3, long a4, long a5) {
#if defined(__x86_64__)
    register long r10 __asm__("r10") = a3; register long r8 __asm__("r8") = a4; register long r9 __asm__("r9") = a5;
    long result; __asm__ volatile("syscall" : "=a"(result) : "a"(number), "D"(a0), "S"(a1), "d"(a2), "r"(r10), "r"(r8), "r"(r9) : "rcx", "r11", "memory");
    return result;
#elif defined(__aarch64__)
    register long x0 __asm__("x0") = a0; register long x1 __asm__("x1") = a1; register long x2 __asm__("x2") = a2;
    register long x3 __asm__("x3") = a3; register long x4 __asm__("x4") = a4; register long x5 __asm__("x5") = a5;
    register long x8 __asm__("x8") = number; __asm__ volatile("svc 0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x5), "r"(x8) : "memory");
    return x0;
#else
#error "unsupported Linux architecture"
#endif
}

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

int vinci_target_bootstrap_attest(void) {
    uint8_t key[32], key_id[32], context_wire[VINCI_BROKER_TARGET_CONTEXT_WIRE_BYTES];
    uint8_t wire[VINCI_BROKER_TARGET_ATTESTATION_WIRE_BYTES], expected[32];
    /* exec resets dumpability.  Re-establish the no-ptrace boundary before
       reading either inherited attestation object. */
    if (raw_syscall6(__NR_prctl, PR_SET_DUMPABLE, 0, 0, 0, 0, 0) != 0) return -1;
    if (raw_syscall6(__NR_pread64, VINCI_BROKER_TARGET_ATTESTATION_KEY_FD, (long)key, sizeof(key), 0, 0, 0) != (long)sizeof(key)) return -1;
    if (raw_syscall6(__NR_pread64, VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD, (long)context_wire, sizeof(context_wire), 0, 0, 0)
        != (long)sizeof(context_wire)) return -1;
    struct vinci_sha256_context context; vinci_sha256_init(&context); vinci_sha256_update(&context, key, sizeof(key)); vinci_sha256_final(&context, key_id);
    uint8_t reserved = 0; for (size_t index = 184u; index < sizeof(context_wire); index++) reserved |= context_wire[index];
    if (reserved != 0 || get64(context_wire) != UINT64_C(0x56494e4354435458) || get32(context_wire + 8u) != 4u
        || get32(context_wire + 12u) != sizeof(context_wire) || memcmp(context_wire + 120u, key_id, 32u) != 0
        || vinci_hmac_sha256(key, 32u, context_wire, 152u, expected) != 0 || memcmp(expected, context_wire + 152u, 32u) != 0) return -1;
    memset(wire, 0, sizeof(wire)); put64(wire, UINT64_C(0x56494e4354415454)); put32(wire + 8u, 4u);
    long own_pid = raw_syscall6(__NR_getpid, 0, 0, 0, 0, 0, 0); if (own_pid <= 0) return -1;
    put32(wire + 12u, sizeof(wire)); put64(wire + 16u, (uint64_t)own_pid);
    memcpy(wire + 24u, context_wire + 16u, 8u + 32u + 32u + 32u + 32u);
    if (vinci_hmac_sha256(key, sizeof(key), wire, 160u, wire + 160u) != 0) return -1;
    memset(key, 0, sizeof(key)); struct iovec vector = { .iov_base = wire, .iov_len = sizeof(wire) };
    struct msghdr message = { .msg_iov = &vector, .msg_iovlen = 1 };
    long count = raw_syscall6(__NR_sendmsg, VINCI_BROKER_TARGET_ATTESTATION_FD, (long)&message, MSG_NOSIGNAL, 0, 0, 0);
    memset(wire, 0, sizeof(wire));
    if (count != (long)sizeof(wire)) return -1;
    if (raw_syscall6(__NR_close, VINCI_BROKER_TARGET_ATTESTATION_FD, 0, 0, 0, 0, 0) != 0
        || raw_syscall6(__NR_close, VINCI_BROKER_TARGET_ATTESTATION_KEY_FD, 0, 0, 0, 0, 0) != 0
        || raw_syscall6(__NR_close, VINCI_BROKER_TARGET_ATTESTATION_CONTEXT_FD, 0, 0, 0, 0, 0) != 0) return -1;
    return 0;
}
