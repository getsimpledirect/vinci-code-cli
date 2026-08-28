# Vinci containment broker v3 — local fail-closed implementation

This package is an isolated implementation of the portable control, journal,
receipt, capture-proof and remote-effect portions of the frozen v3 contract:

- contract SHA-256: `d7be725147d40bddf1218b42d6edc788bb29e55ab6bc3e2217cd1d34b8b75c93`;
- implementation base: `136933eb1f0874ee4ee704fdf77e07efb8242a6b`;
- package boundary: `vinci/containment-broker/` only.

It is **not an admitted containment runtime**. It cannot launch an episode on
macOS or any other host. The native manifest has `admitted=false`, no binary
digest, no Linux build receipt and no Linux test receipt. `requireNativeAdmission`
therefore refuses launch, and the authority-specific prelaunch/terminal receipt
builders refuse while `NATIVE_IMPLEMENTATION_ADMITTED=false`. The C launcher is
an explicit `ENOTSUP` boundary and the fixed trampoline exits without `execveat`;
both sources refuse unadmitted or non-Linux builds.

Passing local tests establishes only portable serialization/state/refusal logic.
It does not establish `clone3`, trampoline isolation, Linux privilege/namespace/
cgroup identity, `cgroup.kill`, subtree zero, repopulation exclusion, real memfd
seals, writer elimination, provider idempotency, consumer integration or safe
deployment.

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

## Native boundary

`native/protocol.h` freezes the inherited control/executable FD numbers and
nonce-bound hello/report/release messages. `native/trampoline_linux.c` contains
the fixed pre-release barrier shape, but deliberately cannot execute episode
code. `native/launcher_linux.c` contains no operational process creation path.

A distinct Linux implementation successor must add and independently review:

1. the exact digest-pinned binary build and package receipt;
2. the fixed pre-release seccomp program;
3. credential, supplementary-group, capability, namespace and FD setup/proof;
4. the single `clone3(CLONE_INTO_CGROUP)` adapter and fixed OCI equivalent;
5. real broker-owned memfd mediation, cgroup kill/events and attach auditing;
6. admitted real-Linux crash/mutation evidence.

No PID, PGID, process-group, `/proc`, pipe-EOF, subreaper, `pkill`, daemon-cgroup
or post-start attachment fallback is admissible.

## Local checks

```sh
cd vinci/containment-broker
npm test
npm run test:mutations
```

These checks intentionally do not compile or run the native Linux sources.
