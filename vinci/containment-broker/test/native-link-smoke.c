#include "../native/launcher_linux.h"
#include "../native/session_linux.h"

/* Linking this translation unit with every hosted native object is the API and
   undefined-symbol gate. Runtime containment is exercised by a separate Linux
   end-to-end harness and must never be inferred from this executable. */
int main(void) {
    struct vinci_broker_task task = { 0 };
    struct vinci_broker_session session = { 0 };
    return task.pid != 0 || session.phase != VINCI_SESSION_CREATED;
}
