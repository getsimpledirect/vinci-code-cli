# Vinci containment broker v4 — unadmitted native Linux candidate

This package contains the portable v3 control plane and a local-only candidate
for the reviewed native Linux contract:

- contract SHA-256: `d7be725147d40bddf1218b42d6edc788bb29e55ab6bc3e2217cd1d34b8b75c93`;
- implementation base: `136933eb1f0874ee4ee704fdf77e07efb8242a6b`;
- package boundary: `vinci/containment-broker/` only.

It is **not an admitted containment runtime**. It cannot launch an episode on
macOS or any other host. The native manifest has `admitted=false`, no binary
digest, no Linux build receipt and no Linux test receipt. `requireNativeAdmission`
therefore refuses launch, and the authority-specific prelaunch/terminal receipt
builders refuse while `NATIVE_IMPLEMENTATION_ADMITTED=false`. The candidate C
sources are inspectable implementation work, not a capability or deployment
receipt.

Passing local tests establishes only portable serialization/state/refusal logic.
It does not establish `clone3`, trampoline isolation, Linux privilege/namespace/
cgroup identity, `cgroup.kill`, subtree zero, repopulation exclusion, real memfd
seals, writer elimination, broker-process crash recovery, target-output capture
causality, consumer integration or safe deployment.

## Invariants implemented locally

- Append-only, checksummed, monotonic episode journal with file and directory
  fsync and no-reuse episode directories.
- Exact lifecycle ordering and absorbing `UNCONTAINED` recovery after every
  nonterminal process restart or corrupt/torn journal.
- Canonical HMAC-SHA-256 authenticated prelaunch/terminal receipt primitives.
- Fail-closed host, fixed-trampoline, privilege, namespace, cgroup-view and
  complete inherited-FD allowlist validation.
- A portable broker-mediated capture model that closes ingress before accepting
  zero/no-writer proof and refuses seal completion without fsync, identity
  continuity and all four required memfd seals.
- A separate durable remote-effect state model binding authority, target,
  content, precondition and single-use operation identity. Ambiguity permits only
  the predeclared read-only reconciliation and never a mutation retry.
- Exact declarative crash, native-Linux and mutation matrices under `test/`.

## Native candidate boundary

The native candidate has one `clone3(CLONE_INTO_CGROUP | CLONE_PIDFD)` launch
path, a fixed sealed trampoline, a canonical big-endian wire protocol, an
all-notify seccomp session mediator, authenticated prelaunch/closing/terminal
receipts and a fixed target-entry attestation shim. The target ABI requires the
admitted executable to link `native/target_entry_linux.S`; `_start` calls
`vinci_target_bootstrap_attest` before the target's fixture/main entry. An
ordinary executable that does not satisfy this build contract is not eligible.

The launcher creates and owns both endpoint pairs before `clone3`. Its task
handle retains only the broker control endpoint, the broker attestation endpoint
and the attestation source endpoint; the child receives only the control peer.
Session initialization proves the attestation endpoints are one empty connected
`SOCK_SEQPACKET` pair, binds their descriptor identity into the policy identity,
and consumes the task handle. The final target exec carries no attestation
socket, key or context descriptor. After the target's exact first mediated
`PR_SET_DUMPABLE(0)` completes, the broker injects the three held sources into
fixed fds 10--12 through the still-pending seccomp notification. This remains a
candidate contract, not Linux admission, until executable replacement, early
injection, response-loss and ptrace mutants pass on the independent Linux gate.

The current reconciliation API covers response loss while the original broker
session, pidfd and held cgroup/receipt-directory descriptors still exist. It is
not broker-process crash recovery. No restart constructor currently reopens and
authenticates the complete attempt from durable authority, so crash-recovery
admission remains categorically held.

Before native admission, an independent Linux runner must execute the exact
launcher, trampoline, mediator and target together and produce authenticated
evidence for:

1. the complete digest-pinned source, toolchain, link and binary identity;
2. the ordered bootstrap and target-entry transition with no earlier syscall;
3. descendant creation, cgroup ingress closure, kill, transient repopulation and
   stable-zero proof;
4. notification replay/stale-ID, fd-substitution, broker-death and response-loss
   boundaries;
5. target output whose sealed capture receipt is causally joined to the exact
   session and executable; and
6. independently reconstructable broker-process crash recovery, or an explicit
   permanent refusal of that contract claim.

No PID, PGID, process-group, `/proc`, pipe-EOF, subreaper, `pkill`, daemon-cgroup
or post-start attachment fallback is admissible.

## Local checks

```sh
cd vinci/containment-broker
npm test
npm run test:mutations
```

On non-Linux hosts these checks compile only the portable protocol/hash known
answer tests and assert that native admission is false. On Linux,
`test/linux-native-build.sh` strictly compiles and links every current native
source and the fixed-entry target fixture. That script is a build/KAT gate only;
it is not a real-host containment test and cannot populate a Linux runtime
receipt. The end-to-end cgroup/descendant/repopulation/crash/capture gate remains
required and unexecuted until an admitted Linux runner is available.
