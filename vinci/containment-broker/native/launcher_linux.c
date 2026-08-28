/*
 * Linux born-in-domain launcher boundary. This file intentionally exposes no
 * operational launch function until a separately reviewed build provides the
 * credential/namespace setup, pidfd ownership and admitted trampoline binary.
 * It contains no post-start PID attachment, process-group or /proc fallback.
 */

#ifndef __linux__
#error "the containment launcher is Linux-only"
#endif

#ifndef VINCI_ADMITTED_NATIVE_BUILD
#error "unadmitted launcher build refused"
#endif

#include "protocol.h"

#include <errno.h>

int vinci_clone_into_cgroup_unavailable(int cgroup_fd, int control_fd, int executable_fd) {
    if (cgroup_fd < 0 || control_fd < 0 || executable_fd < 0) return -EINVAL;
    /*
     * A future exact Linux-reviewed successor replaces this refusal with one
     * clone3(CLONE_INTO_CGROUP) call that creates the fixed trampoline and no
     * other child path. Returning ENOTSUP is the only locally authorized state.
     */
    return -ENOTSUP;
}
