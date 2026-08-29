#ifndef VINCI_CONTAINMENT_BROKER_TARGET_BOOTSTRAP_LINUX_H
#define VINCI_CONTAINMENT_BROKER_TARGET_BOOTSTRAP_LINUX_H

/* Must be the statically linked target's first userspace boundary. */
int vinci_target_bootstrap_attest(void);

#endif
