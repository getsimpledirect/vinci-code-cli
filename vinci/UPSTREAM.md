# Upstream tracking — pulling Pi maintenance updates

Vinci Code is a **thin fork** of upstream Pi (`badlogic/pi-mono`). The active public product
source and release publisher is `getsimpledirect/vinci-code-cli/main`. Integrate Pi changes
through a reviewed public branch, preserving the Vinci layer and current public security fixes.
The inline `[vinci]` patch inventory lives in [`PATCHES.md`](PATCHES.md).

The retained `sync-upstream.sh` implements the private repository's legacy mirror/rebase model,
not public product maintenance. It changes local Git configuration, restores catalog files,
pushes `main`, and rebases `vinci`. **Do not run it in the public product checkout** until that
route is adapted and reviewed. The private operational history and unresolved work remain
retained; this document does not claim consolidation or archival is complete.

## Legacy private branch model

In the private checkout, `main` is the pristine Pi mirror and `vinci` carries the historical
product layer. Merging private `vinci` into private `main` breaks that legacy maintenance flow.
These roles do not describe public `main`. Current protected release tags use `vinci-vX.Y.Z`
on reviewed public product commits; the installer consumes the signed manifest and archive.

## Remotes

```
origin    → getsimpledirect/vinci-code-cli   (this repository)
upstream  → badlogic/pi-mono                 (the real Pi)
```

If `upstream` is missing after a fresh clone:
`git remote add upstream https://github.com/badlogic/pi-mono.git`

## Legacy private sync

The commands below document the retained private workflow only. They require a separately
owned private checkout whose `origin` is that private repository, appropriate review, and
explicit push authorization. They are not commands to run against the public remotes above.

```bash
vinci/sync-upstream.sh            # → latest upstream/main
vinci/sync-upstream.sh v0.81.0    # → a specific release tag (recommended: pin releases)
```

The script: enables **`git rerere`** → refuses a dirty tree → fetches upstream + tags →
**fast-forwards** `main` (never a merge commit) → pushes `main` → **rebases** `vinci` on the new
`main` → verifies `vinci/identity.json` → prints the `[vinci]` patched-file count as a completeness
check. If Pi touches a file our layer also patches, the rebase stops on that `[vinci]` block for you
to resolve; `rerere` records the resolution so you never re-do it next release. After a clean rebase,
**run the tests, then push**:

```bash
bash vinci/test/run.sh && git push --force-with-lease origin vinci
```

### If a rebase conflicts

Every conflict is a `[vinci]`-marked block (the inventory is in [`PATCHES.md`](PATCHES.md)). Resolve
it, `git rebase --continue`, and when done sanity-check nothing was dropped:

```bash
git grep -n '\[vinci\]' -- packages/    # should still show every patch from PATCHES.md's table
```

## Model catalogs are Pi's — what "true of Vinci" means for models

Pi ships generated model catalogs (`packages/ai/src/models.generated.ts`,
`image-models.generated.ts`, `providers/*.models.ts` — snapshots of models.dev / OpenRouter / etc.).
Those catalogs are LIVE for BYOK — they are how a user's own provider offers its models. What they
are NOT is Vinci's own identity, which comes from:

- `vinci/identity.json` — the canonical app name, provider, default model, tagline, and required
  extension set, checked against runtime sources after every sync;
- `vinci/extensions/vinci-provider.ts` — the runtime-registered managed Vinci classes and
  automatic selection; and
- the managed-view `/model` filter when `VINCI_SHOW_OTHER_PROVIDERS=0` (PATCHES.md §4).
  The default BYOK view also exposes upstream provider catalogs.

So a Pi sync can rewrite every catalog and **nothing about Vinci's models changes**. The rules that keep
it that way:

1. **Update catalog generators rather than generated catalog files.** Keep any necessary public
   change narrow and reviewed; the private legacy rebase policy preserves upstream catalog bytes.
2. **Build with `vinci/build.sh`, not the stock `npm run build`** — the stock build re-fetches
   external catalogs on every run and dirties the tree with drift.
3. The legacy `sync-upstream.sh` **restores** any uncommitted catalog drift before
   syncing, **warns** if a vinci commit touches a catalog, and installs per-clone merge attributes
   (`.git/info/attributes`, `merge=ours`) so any catalog conflict during the rebase auto-resolves to
   upstream's version.

## After a sync — re-verify the pins

Pi's **model registry and config schema change per release**. After bumping, check:

- `extensions/vinci-provider.ts` — provider config shape (`registerProvider` fields,
  `compat`, `thinkingFormat`), model `contextWindow` / `maxTokens`.
- `bin/vinci` — the CLI flags (`--theme` / `--extension` / `--provider` / `--model`)
  and the header/theme extension APIs (`ctx.ui.setHeader`, the 51 theme tokens).
- Run the identity, security and exact packaged-launch checks against the reviewed public source.
  Production installation follows its signed immutable artifact rather than moving source `main`.

## Why not a GitHub Action?

A private-repo scheduled Action could open a "sync" PR automatically, but the manual
script is safer while the layer is young — a human should eye each Pi bump for registry/
schema drift before it ships. Revisit once the layer stabilizes.
