#!/usr/bin/env bash
# Pull Pi maintenance updates into the Vinci Code mirror.
#
# Strategy (see vinci/UPSTREAM.md): `main` stays PRISTINE = upstream Pi. All Vinci work
# lives on the `vinci` branch. This script fast-forwards main to upstream, then rebases
# vinci on top — so our additive vinci/ layer replays cleanly on the latest Pi.
#
# Usage:
#   vinci/sync-upstream.sh              # sync to upstream/main (latest)
#   vinci/sync-upstream.sh v0.81.0      # sync to a specific upstream tag (recommended: pin)
#
# Safe by construction: refuses to run with a dirty tree; main only ever fast-forwards
# (never a merge commit); the rebase stops for you to resolve if Pi ever touches a path
# our vinci/ layer also touches (it shouldn't — the layer is self-contained).
set -euo pipefail

TARGET="${1:-upstream/main}"

# Remember conflict resolutions so you never re-resolve the same [vinci] inline block twice across
# syncs (a big deal for a long-lived fork — each patch site is resolved once, then replayed forever).
git config rerere.enabled true
git config rerere.autoupdate true

# ── Model-catalog policy: the generated catalogs are PI'S files, never Vinci's ──────────────────
# What's "true of Vinci" for models lives in vinci/extensions/vinci-provider.ts (runtime-registered)
# plus the VINCI_CODE /model filter (PATCHES.md §4) — the generated catalogs (models.dev / OpenRouter
# snapshots) are inert for a single-provider product. They must never carry Vinci-side edits, or every
# future sync conflicts on 500-line generated diffs. Enforced three ways below; git pathspec globs
# (quoted, so git — not the shell — expands them) cover the whole set.
CATALOGS=("packages/ai/src/models.generated.ts" "packages/ai/src/image-models.generated.ts" "packages/ai/src/providers/*.models.ts")

# (a) A stock `npm run build` re-fetches the catalogs and dirties the tree (vinci/build.sh skips the
#     fetch — use it instead). That drift is pure noise: restore it rather than refuse the sync.
if [ -n "$(git status --porcelain -- "${CATALOGS[@]}")" ]; then
  echo "→ Restoring generated model-catalog drift (a stock 'npm run build' re-fetched them; build with vinci/build.sh)…"
  git checkout -- "${CATALOGS[@]}"
fi

# (b) If a catalog edit ever slipped into a vinci commit, flag it loudly — drop the commit rather than
#     carry it (it would re-conflict on every future sync).
if [ -n "$(git log --oneline main..vinci -- "${CATALOGS[@]}" 2>/dev/null)" ]; then
  echo "⚠ The vinci branch carries commits touching the generated model catalogs:" >&2
  git log --oneline main..vinci -- "${CATALOGS[@]}" >&2
  echo "  Those files are upstream Pi's. Drop/revert these changes — Vinci's models live in vinci-provider.ts." >&2
fi

# (c) Per-clone merge attributes (.git/info/ — never committed, zero upstream conflict surface): if a
#     rebase ever DOES conflict on a catalog, auto-resolve to upstream's side ('ours' during a rebase
#     of vinci onto main = the new base, i.e. Pi's version).
git config merge.ours.driver true
mkdir -p .git/info
for p in "${CATALOGS[@]}"; do
  grep -qsF "${p} merge=ours" .git/info/attributes || echo "${p} merge=ours" >> .git/info/attributes
done

# Must be clean.
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Working tree is dirty. Commit or stash first." >&2
  exit 1
fi

# The inline-patch inventory BEFORE the sync — every upstream file the vinci layer edits carries a
# [vinci] marker (see vinci/PATCHES.md). We show it after the rebase so you can confirm none were
# dropped when resolving conflicts.
patched_files() { git grep -l '\[vinci\]' -- packages/ 2>/dev/null | grep -v '/vinci-' || true; }
BEFORE_COUNT="$(patched_files | wc -l | tr -d ' ')"

echo "→ Fetching upstream (badlogic/pi-mono) + tags…"
git fetch upstream --tags --prune

# Resolve a bare tag like "v0.81.0" to a ref.
if git rev-parse -q --verify "refs/tags/${TARGET}" >/dev/null 2>&1; then
  TARGET="refs/tags/${TARGET}"
fi
echo "→ Target: ${TARGET} ($(git rev-parse --short "${TARGET}"))"

echo "→ Fast-forwarding main → upstream…"
git checkout main
git merge --ff-only "${TARGET}"
git push origin main

echo "→ Rebasing vinci onto main…"
git checkout vinci
if git rebase main; then
  AFTER_COUNT="$(patched_files | wc -l | tr -d ' ')"
  if ! node vinci/test/identity-contract.mjs; then
    echo "ERROR: Vinci identity contract failed after the rebase. Do not push this sync." >&2
    exit 1
  fi
  echo "✓ Synced. vinci is now on top of $(git rev-parse --short main)."
  echo "  Inline [vinci] patch files: ${AFTER_COUNT} (was ${BEFORE_COUNT} before the sync)."
  if [ "${AFTER_COUNT}" != "${BEFORE_COUNT}" ]; then
    echo "  ⚠ The patched-file count changed — a [vinci] block may have been dropped during a resolution."
    echo "    Cross-check against vinci/PATCHES.md before pushing:  git grep -n '\\[vinci\\]' -- packages/"
  fi
  echo "  Then verify + push:  bash vinci/test/run.sh  &&  git push --force-with-lease origin vinci"
  echo "  Also re-pin the launcher / provider models if Pi's registry or config schema changed this release."
else
  echo "✗ Rebase hit a conflict — Pi touched a file the vinci/ layer also patches (see vinci/PATCHES.md)." >&2
  echo "  Each conflict is a [vinci]-marked block. Resolve it (rerere will remember the resolution for" >&2
  echo "  next time), 'git rebase --continue', then: bash vinci/test/run.sh && git push --force-with-lease origin vinci" >&2
  exit 1
fi
