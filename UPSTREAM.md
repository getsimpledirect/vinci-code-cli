# Upstream Provenance

This document records the provenance of the Vinci Code repository: where it comes
from, what it forks, on what commit it is based, and how it stays in sync with
upstream. Facts stated here were verified from this repository (git history,
branch model, and license files).

## Upstream project

This repository is a fork of **Pi** (also known as `pi-mono`), the open-source
agent harness project by Mario Zechner.

- Project name: Pi
- Repository: <https://github.com/badlogic/pi-mono>
- Website: <https://pi.dev>
- License: MIT License
- Copyright: Copyright (c) 2025 Mario Zechner (see root `LICENSE`)

## Fork base

The merge-base of the `main` and `vinci` branches — the upstream reference point
this fork is based on — is commit:

```
244f1deaf1ae0fc1a242d9df5cddf457cf3d36a7
```

## Branch model

This repository has a single branch, `main`: upstream Pi's history (4,854 commits)
with the Vinci layer applied on top. Every commit up to and including the fork base
is upstream's, authored by upstream's contributors and preserved unchanged.

Vinci additions are confined to two places, which is what keeps upstream syncs
tractable:

- `vinci/` - the Vinci layer
- `packages/**/vinci-*.ts` - Vinci changes living inside upstream packages

Maintenance happens in a separate private repository that keeps a pristine upstream
mirror alongside the Vinci trunk, so upstream can be fast-forwarded and the Vinci
layer rebased on top. Contributors do not need that setup; `main` here is the
published result of it.

## How to sync from upstream

Vinci Code pulls Pi maintenance updates with the checked-in sync script:

```bash
vinci/sync-upstream.sh            # pull latest upstream/main
vinci/sync-upstream.sh v0.81.0    # pull a specific Pi release tag (recommended)
```

The script fast-forwards the upstream mirror branch, rebases the Vinci trunk on top, verifies
the polyglot identity contract, and reports a completeness check. A detailed,
operational maintenance guide lives at [`vinci/UPSTREAM.md`](vinci/UPSTREAM.md).

For the full picture of the product and what the Vinci layer adds, see
[`vinci/README.md`](vinci/README.md).
