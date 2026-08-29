/* A pre-main constructor the compiler cannot elide.
 *
 * The previous version marked both functions `static` with empty bodies, and
 * GCC 15 at -O2 optimised the whole translation unit away: the object carried a
 * zero-byte .text, no .init_array and no symbols at all. That made this mutant
 * a no-op which could never have been caught, so the gate that consumed it was
 * inert. External linkage plus a volatile side effect forces the constructor to
 * be emitted and a real .init_array entry to exist. */

volatile int vinci_forbidden_pre_main_ran;

void vinci_register_forbidden_constructor(void);

__attribute__((constructor)) void vinci_register_forbidden_constructor(void) {
    vinci_forbidden_pre_main_ran = 1;
}
