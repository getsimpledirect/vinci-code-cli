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

## Upstream's own README

Reproduced verbatim below, so this fork stays honest about what it is built on. It
describes **upstream Pi**, not Vinci Code: its package names, install instructions,
Discord and npm links all point at the upstream project, and none of them are Vinci
support channels. It is kept here rather than in the README because it documents Pi.
Heading levels are shifted down so it nests under this section; the text is otherwise
unchanged.

### Pi Agent Harness

This is the home of the Pi agent harness project including our self extensible coding agent.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

#### All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

#### Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

#### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

#### Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

#### Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

#### Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
