# Third-Party Notices

This file records third-party software incorporated into or relied upon by this
repository. It is derived from what is actually present in the repository
(`package.json` / `package-lock.json` workspaces and vendored code with its own
licence file) and is intended for accurate attribution.

## Scope of this notice

This notice covers:

1. The first-party workspace packages shipped in this repository.
2. The repository's direct (non-transitive) npm dependencies as declared in the
   root `package.json` and the individual workspace `package.json` files.

This notice does **not** enumerate the full transitive dependency tree. The
root `package-lock.json` contains hundreds of transitive npm packages with mixed
licences; producing a complete and accurate per-package inventory requires a
license-scanning tool (for example `npx license-checker` or a CI license audit).
Before a public release, run such a tool against the installed dependency tree
and publish the generated full notice alongside this one.

## First-party workspace packages

All of the following are MIT-licensed (per their `package.json` `license`
field) and are part of the upstream Pi project this distribution forks:

| Package | Version | License |
|---------|---------|---------|
| `@earendil-works/pi-ai` | 0.80.3 | MIT |
| `@earendil-works/pi-agent-core` | 0.80.3 | MIT |
| `@earendil-works/pi-coding-agent` | 0.80.3 | MIT |
| `@earendil-works/pi-orchestrator` | 0.80.3 | MIT |
| `@earendil-works/pi-tui` | 0.80.3 | MIT |

The root `package.json` also declares example-extension workspaces under
`packages/coding-agent/examples/extensions/` (with-deps,
custom-provider-anthropic, custom-provider-gitlab-duo, sandbox, gondolin).

## Development-time tooling (root devDependencies)

The root `package.json` declares the following direct development-time
dependencies. Licences are not asserted individually here; they are declared in
each package and should be confirmed by the license-scanning step above:

- `@anthropic-ai/sandbox-runtime` (Apache-2.0 as declared in
  `package-lock.json`)
- `@biomejs/biome`
- `@types/node`
- `@typescript/native-preview`
- `esbuild`
- `husky`
- `jiti`
- `shx`
- `tsx`
- `typescript`

## Upstream attribution

Pi and all `@earendil-works/*` packages included here are
Copyright (c) 2025 Mario Zechner, licensed under the MIT License (see the root
`LICENSE`). Alpine Pacific Trading Inc.'s modifications are additive and are covered by
the modifications notice in the root `LICENSE`. See [`UPSTREAM.md`](UPSTREAM.md)
for full provenance.
