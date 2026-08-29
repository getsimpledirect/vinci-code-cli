#ifndef VINCI_CONTAINMENT_BROKER_LAUNCHER_LINUX_H
#define VINCI_CONTAINMENT_BROKER_LAUNCHER_LINUX_H

#include <sys/types.h>

struct vinci_broker_launch_fds {
    int cgroup;
    int executable;
    int trampoline;
    int receipt_verifier;
    int executable_provenance;
    int trampoline_build_receipt;
    int target_attestation_key;
    int target_attestation_context;
    int standard_input;
    int standard_output;
    int standard_error;
};

struct vinci_broker_launch_identity {
    uid_t uid;
    gid_t gid;
};

struct vinci_broker_task {
    pid_t pid;
    int pidfd;
    pid_t expected_parent;
    uid_t target_uid;
    gid_t target_gid;
    int cgroup_fd;
    int control_fd;
    int target_attestation_fd;
    int target_attestation_source_fd;
    int target_attestation_key_fd;
    int target_attestation_context_fd;
};

int vinci_clone_into_cgroup(const struct vinci_broker_launch_fds *fds,
                            const struct vinci_broker_launch_identity *identity,
                            struct vinci_broker_task *task);
int vinci_broker_task_close(struct vinci_broker_task *task);

#endif
