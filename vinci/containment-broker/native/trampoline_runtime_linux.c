#define _GNU_SOURCE

#ifndef __linux__
#error "the trampoline runtime is Linux-only"
#endif

#include "trampoline_runtime_linux.h"

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <signal.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

static int vinci_errno_storage;

int *__errno_location(void) {
    return &vinci_errno_storage;
}

static long checked(long result) {
    if (result < 0 && result >= -4095) {
        vinci_errno_storage = (int)-result;
        return -1;
    }
    return result;
}

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

int memcmp(const void *first, const void *second, size_t length) {
    const uint8_t *left = first;
    const uint8_t *right = second;
    for (size_t index = 0; index < length; index++) {
        if (left[index] != right[index]) return left[index] < right[index] ? -1 : 1;
    }
    return 0;
}

void *memchr(const void *bytes, int value, size_t length) {
    const uint8_t *input = bytes;
    for (size_t index = 0; index < length; index++) if (input[index] == (uint8_t)value) return (void *)(input + index);
    return NULL;
}

size_t strlen(const char *string) {
    size_t length = 0;
    while (string[length] != '\0') length++;
    return length;
}

int strcmp(const char *first, const char *second) {
    size_t index = 0;
    while (first[index] != '\0' && first[index] == second[index]) index++;
    return (unsigned char)first[index] - (unsigned char)second[index];
}

ssize_t recvmsg(int fd, struct msghdr *message, int flags) {
    return (ssize_t)checked(vinci_raw_syscall6(__NR_recvmsg, fd, (long)message, flags, 0, 0, 0));
}

ssize_t sendmsg(int fd, const struct msghdr *message, int flags) {
    return (ssize_t)checked(vinci_raw_syscall6(__NR_sendmsg, fd, (long)message, flags, 0, 0, 0));
}

ssize_t pread(int fd, void *buffer, size_t length, off_t offset) {
    return (ssize_t)checked(vinci_raw_syscall6(__NR_pread64, fd, (long)buffer, (long)length, (long)offset, 0, 0));
}

int fstat(int fd, struct stat *metadata) {
    return (int)checked(vinci_raw_syscall6(__NR_fstat, fd, (long)metadata, 0, 0, 0, 0));
}

int fcntl(int fd, int command, ...) {
    va_list arguments;
    long value = 0;
    va_start(arguments, command);
    if (command != F_GETFD && command != F_GET_SEALS) value = (long)va_arg(arguments, int);
    va_end(arguments);
    return (int)checked(vinci_raw_syscall6(__NR_fcntl, fd, command, value, 0, 0, 0));
}

int close(int fd) {
    return (int)checked(vinci_raw_syscall6(__NR_close, fd, 0, 0, 0, 0, 0));
}

pid_t getpid(void) {
    return (pid_t)checked(vinci_raw_syscall6(__NR_getpid, 0, 0, 0, 0, 0, 0));
}

pid_t getppid(void) {
    return (pid_t)checked(vinci_raw_syscall6(__NR_getppid, 0, 0, 0, 0, 0, 0));
}

int setgroups(size_t count, const gid_t *groups) {
    return (int)checked(vinci_raw_syscall6(__NR_setgroups, (long)count, (long)groups, 0, 0, 0, 0));
}

int setresgid(gid_t real, gid_t effective, gid_t saved) {
    return (int)checked(vinci_raw_syscall6(__NR_setresgid, real, effective, saved, 0, 0, 0));
}

int setresuid(uid_t real, uid_t effective, uid_t saved) {
    return (int)checked(vinci_raw_syscall6(__NR_setresuid, real, effective, saved, 0, 0, 0));
}

int prctl(int option, ...) {
    va_list arguments;
    int values[4];
    va_start(arguments, option);
    for (size_t index = 0; index < 4u; index++) values[index] = va_arg(arguments, int);
    va_end(arguments);
    return (int)checked(vinci_raw_syscall6(__NR_prctl, option, (long)values[0], (long)values[1],
                                           (long)values[2], (long)values[3], 0));
}

int sigemptyset(sigset_t *set) {
    memset(set, 0, sizeof(*set));
    return 0;
}

int sigfillset(sigset_t *set) {
    memset(set, 0xff, sizeof(*set));
    return 0;
}

int sigprocmask(int operation, const sigset_t *set, sigset_t *old_set) {
    return (int)checked(vinci_raw_syscall6(__NR_rt_sigprocmask, operation, (long)set, (long)old_set, 8, 0, 0));
}
