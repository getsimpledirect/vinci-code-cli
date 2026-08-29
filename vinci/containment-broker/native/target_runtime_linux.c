#define _GNU_SOURCE

#ifndef __linux__
#error "the target runtime is Linux-only"
#endif

#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* The admitted target links -nostdlib so it carries no libc startup code, no
 * ELF interpreter and no init/fini arrays: linking static glibc pulled in a
 * .fini_array, which is exactly the post-main execution the target ABI refuses.
 *
 * A freestanding implementation must still provide memcpy, memmove, memset and
 * memcmp: the C standard lets the compiler emit calls to exactly those four for
 * structure and array operations however the source is written, and it does.
 *
 * An earlier version of this file supplied only memcpy and memset and called
 * them "the complete set the target link requires". That was true by accident,
 * not by rule -- it held only because --gc-sections happened to drop the one
 * caller of the others. Changing target_bootstrap_linux.c to the freestanding
 * flag set changed codegen, GCC emitted memcmp, and the link broke on BOTH
 * toolchains. The set below is the one the standard names, so it does not
 * depend on which calls survive garbage collection. Anything beyond it appears
 * as an undefined reference rather than being silently taken from libc. */

void *memcpy(void *destination, const void *source, size_t length) {
    uint8_t *output = destination;
    const uint8_t *input = source;
    for (size_t index = 0; index < length; index++) output[index] = input[index];
    return destination;
}

void *memmove(void *destination, const void *source, size_t length) {
    uint8_t *output = destination;
    const uint8_t *input = source;
    if (output == input || length == 0) return destination;
    if (output < input) {
        for (size_t index = 0; index < length; index++) output[index] = input[index];
    } else {
        for (size_t index = length; index > 0; index--) output[index - 1] = input[index - 1];
    }
    return destination;
}

void *memset(void *destination, int value, size_t length) {
    uint8_t *output = destination;
    for (size_t index = 0; index < length; index++) output[index] = (uint8_t)value;
    return destination;
}

int memcmp(const void *first, const void *second, size_t length) {
    const uint8_t *left = first;
    const uint8_t *right = second;
    for (size_t index = 0; index < length; index++) {
        if (left[index] != right[index]) return left[index] < right[index] ? -1 : 1;
    }
    return 0;
}
