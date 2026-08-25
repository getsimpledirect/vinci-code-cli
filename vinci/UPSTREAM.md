# Upstream tracking — pulling Pi maintenance updates

Vinci Code is a **thin fork**: `main` mirrors upstream Pi (`badlogic/pi-mono`, ~weekly
releases) and stays **pristine**; all Vinci work lives on the `vinci` branch. Almost everything
is additive (the `vinci/` dir + new `vinci-*.ts` files), so syncing is almost always
conflict-free; the only thing that can conflict is the small set of inline `[vinci]` core
patches inventoried in [`PATCHES.md`](PATCHES.md).

## The golden rule: **`vinci` is the trunk; never merge it into `main`**

`main`'s one job is to be a clean mirror of upstream Pi so we can fast-forward it and rebase our
layer on top. `vinci` is the product line — the released code, the branch the installer builds from
(`package.sh`). **Do not merge `vinci` → `main`.** Doing so makes `main` carry the whole layer, which
permanently breaks the ff-main / rebase-vinci flow (every future Pi change that touches a file we
also patch would then conflict against a `main` full of vinci commits). If you want a stable release
pointer, **tag a commit on `vinci`** with the `vinci-` prefix (`git tag vinci-X.Y.Z`) — its own
namespace, so it never collides with Pi's ~300 `vX.Y.Z` tags that the mirror carries, and tags
survive the force-push that a rebase requires. The only case to revisit this is heavy multi-person PR development *on the layer
itself*, where a force-pushed trunk hurts; that's a deliberate model change, not a routine merge.

## Remotes

```
origin    → getsimpledirect/vinci-code-cli   (this repository)
upstream  → badlogic/pi-mono                 (the real Pi)
```

If `upstream` is missing after a fresh clone:
`git remote add upstream https://github.com/badlogic/pi-mono.git`

## Routine sync

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
- `vinci/extensions/vinci-provider.ts` — the runtime-registered Vinci models (piccolo / bozza / tela)
  and their windows and prices; and
- the `VINCI_CODE` `/model` filter (PATCHES.md §4) — the selector only ever shows `provider === "vinci"`,
  no matter what the catalogs contain.

So a Pi sync can rewrite every catalog and **nothing about Vinci's models changes**. The rules that keep
it that way:

1. **Never edit or commit the catalogs on `vinci`.** They're upstream's; carrying local changes makes
   every future rebase conflict on huge generated diffs.
2. **Build with `vinci/build.sh`, not the stock `npm run build`** — the stock build re-fetches ~1000
   external catalogs on every run and dirties the tree with drift.
3. `sync-upstream.sh` enforces this automatically: it **restores** any uncommitted catalog drift before
   syncing, **warns** if a vinci commit touches a catalog, and installs per-clone merge attributes
   (`.git/info/attributes`, `merge=ours`) so any catalog conflict during the rebase auto-resolves to
   upstream's version.

## After a sync — re-verify the pins

Pi's **model registry and config schema change per release**. After bumping, check:

- `extensions/vinci-provider.ts` — provider config shape (`registerProvider` fields,
  `compat`, `thinkingFormat`), model `contextWindow` / `maxTokens`.
- `bin/vinci` — the CLI flags (`--theme` / `--extension` / `--provider` / `--model`)
  and the header/theme extension APIs (`ctx.ui.setHeader`, the 51 theme tokens).
- Pin a known-good tag in production rather than tracking `main` head.

## Why not a GitHub Action?

A private-repo scheduled Action could open a "sync" PR automatically, but the manual
script is safer while the layer is young — a human should eye each Pi bump for registry/
schema drift before it ships. Revisit once the layer stabilizes.
