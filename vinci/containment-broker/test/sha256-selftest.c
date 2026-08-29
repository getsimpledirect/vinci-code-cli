#include "../native/sha256.h"

#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void hex(const uint8_t digest[32], char output[65]) {
    static const char alphabet[] = "0123456789abcdef";
    for (size_t index = 0; index < 32; index++) {
        output[index * 2] = alphabet[digest[index] >> 4u];
        output[index * 2 + 1u] = alphabet[digest[index] & 0x0fu];
    }
    output[64] = '\0';
}

int main(void) {
    static const char expected[] = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    struct vinci_sha256_context context;
    uint8_t digest[32];
    char actual[65];
    vinci_sha256_init(&context);
    vinci_sha256_update(&context, "abc", 3);
    vinci_sha256_final(&context, digest);
    hex(digest, actual);
    if (strcmp(actual, expected) != 0) return 1;

    char path[] = "/tmp/vinci-sha256-selftest.XXXXXX";
    int fd = mkstemp(path);
    if (fd < 0 || write(fd, "abc", 3) != 3 || vinci_sha256_fd(fd, digest) != 0) return 2;
    unlink(path);
    close(fd);
    hex(digest, actual);
    if (strcmp(actual, expected) != 0) return 3;
    uint8_t key[20];
    memset(key, 0x0b, sizeof(key));
    if (vinci_hmac_sha256(key, sizeof(key), "Hi There", 8, digest) != 0) return 4;
    hex(digest, actual);
    return strcmp(actual, "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7") == 0 ? 0 : 5;
}
