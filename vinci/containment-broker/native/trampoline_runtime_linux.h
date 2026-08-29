#ifndef VINCI_CONTAINMENT_BROKER_TRAMPOLINE_RUNTIME_LINUX_H
#define VINCI_CONTAINMENT_BROKER_TRAMPOLINE_RUNTIME_LINUX_H

long vinci_raw_syscall6(long number, long first, long second, long third,
                        long fourth, long fifth, long sixth);

#endif
