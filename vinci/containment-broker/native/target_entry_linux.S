#if defined(__x86_64__)
    .text
    .globl _start
    .type _start,@function
_start:
    call vinci_target_bootstrap_attest
    test %eax,%eax
    jne .Lfailure
    call vinci_target_fixture_main
    mov %eax,%edi
    mov $60,%eax
    syscall
.Lfailure:
    mov $125,%edi
    mov $60,%eax
    syscall
    .size _start, .-_start
#elif defined(__aarch64__)
    .text
    .globl _start
    .type _start,%function
_start:
    bl vinci_target_bootstrap_attest
    cbnz w0, .Lfailure
    bl vinci_target_fixture_main
    mov x8, #93
    svc #0
.Lfailure:
    mov x0, #125
    mov x8, #93
    svc #0
    .size _start, .-_start
#else
#error "unsupported Linux architecture"
#endif

    .section .note.GNU-stack,"",@progbits
