#if defined(__x86_64__)
    .text
    .globl _start
    .type _start,@function
_start:
    xor %ebp, %ebp
    mov (%rsp), %rdi
    lea 8(%rsp), %rsi
    and $-16, %rsp
    call vinci_trampoline_main
    mov %eax, %edi
    mov $60, %eax
    syscall
    ud2
    .size _start, .-_start

    .globl vinci_raw_syscall6
    .type vinci_raw_syscall6,@function
vinci_raw_syscall6:
    mov %rdi, %rax
    mov %r8, %r10
    mov %r9, %r8
    mov 8(%rsp), %r9
    mov %rsi, %rdi
    mov %rdx, %rsi
    mov %rcx, %rdx
    syscall
    ret
    .size vinci_raw_syscall6, .-vinci_raw_syscall6
#elif defined(__aarch64__)
    .text
    .globl _start
    .type _start,%function
_start:
    ldr x0, [sp]
    add x1, sp, #8
    bl vinci_trampoline_main
    mov x8, #93
    svc #0
    brk #0
    .size _start, .-_start

    .globl vinci_raw_syscall6
    .type vinci_raw_syscall6,%function
vinci_raw_syscall6:
    mov x8, x0
    mov x0, x1
    mov x1, x2
    mov x2, x3
    mov x3, x4
    mov x4, x5
    mov x5, x6
    svc #0
    ret
    .size vinci_raw_syscall6, .-vinci_raw_syscall6
#else
#error "unsupported Linux architecture"
#endif

    .section .note.GNU-stack,"",@progbits
