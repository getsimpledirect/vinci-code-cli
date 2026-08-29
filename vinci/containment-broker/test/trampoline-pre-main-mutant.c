static void forbidden_constructor(void) {
}

__attribute__((constructor)) static void register_forbidden_constructor(void) {
    forbidden_constructor();
}
