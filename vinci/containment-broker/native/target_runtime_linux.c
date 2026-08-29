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
 * GCC still emits calls to memcpy and memset for structure and array
 * operations even under -ffreestanding, so the target must supply them itself.
 * These two are the complete set the target link requires; anything further
 * appears as an undefined reference rather than being silently taken from libc. */

void *memcpy(void *destination, const void *source, size_t length) {
    uint8_t *output = destination;
    const uint8_t *input = source;
    for (size_t index = 0; index < length; index++) output[index] = input[index];
    return destination;
}

void *memset(void *destination, int value, size_t length) {
    uint8_t *output = destination;
    for (size_t index = 0; index < length; index++) output[index] = (uint8_t)value;
    return destination;
}
