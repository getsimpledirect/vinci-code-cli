#!/usr/bin/env bash
# The "no contracts at runtime" gate. `@getsimpledirect/vinci-contracts` is a PRIVATE GitHub Packages
# dependency; the public tarball must be installable and must LAUNCH without it. Four layers:
#
#   1. manifests   — no package.json in the tree (the ROOT one included) lists the private scope
#                    under dependencies/optionalDependencies/peerDependencies. Private-only drift
#                    checks may install devDependencies; the public tree needs neither package.
#   2. sources     — no runtime source (vinci/extensions, vinci/bin, vinci/updater, packages/*/src)
#                    imports the scope other than `import type` / inline `type` specifiers.
#   3. built output — nothing under vinci/dist, vinci/extensions (the coding-agent build emits
#                    un-bundled .js copies of vinci/extensions/lib/*.ts IN PLACE) or packages/*/dist
#                    contains the byte string `@getsimpledirect` at all, outside a type-only
#                    import in a .ts file. Type imports do not survive emit, so no import grammar is
#                    trusted here: template specifiers, require.resolve, export-star, concatenation
#                    and comments all count. Skipped with a notice when the tree is not built.
#   4. artifact    — given a tarball: no node_modules/@getsimpledirect inside it, AND layer 3 over
#                    EVERY file in the archive — node_modules, extensionless executables such as
#                    vinci/bin/vinci, manifests (manifest rule) — skipping only binaries by
#                    extension and NUL sniff, and symlinks. The skip list is the allowlist.
#
# 0.0.51 shipped a payload that failed on every launch because layer 1 only read packages/*/package.json
# (the root manifest was never scanned), layers 2-3 did not exist, and layer 4 only looked for the
# package's FILES — correctly absent — never for the import that needed them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCANNER="${ROOT}/vinci/scripts/scan-contracts-runtime-imports.mjs"

if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [vinci-code.tgz]" >&2
  exit 2
fi

fail() {
  echo "$1" >&2
  exit 1
}

# 1. Manifests — root first. This is the one 0.0.51's guard skipped.
manifests=("${ROOT}/package.json")
for manifest in "${ROOT}"/packages/*/package.json; do
  manifests+=("${manifest}")
done
node "${SCANNER}" --manifest "${manifests[@]}" \
  || fail "Private Vinci packages must not be runtime dependencies (devDependencies only)."

# 2. Sources.
sources=("${ROOT}/vinci/extensions" "${ROOT}/vinci/bin" "${ROOT}/vinci/updater")
for source_dir in "${ROOT}"/packages/*/src; do
  [ -d "${source_dir}" ] && sources+=("${source_dir}")
done
node "${SCANNER}" --source "${sources[@]}" \
  || fail "Runtime sources may import @getsimpledirect/* as \`import type\` only."

# 3. Built output, when present.
built=()
[ -d "${ROOT}/vinci/dist" ] && built+=("${ROOT}/vinci/dist")
built+=("${ROOT}/vinci/extensions")
for dist_dir in "${ROOT}"/packages/*/dist; do
  [ -d "${dist_dir}" ] && built+=("${dist_dir}")
done
if [ -d "${ROOT}/vinci/dist/extensions" ]; then
  node "${SCANNER}" --shipped "${built[@]}" \
    || fail "Built output references @getsimpledirect at runtime; the public payload cannot resolve it."
else
  echo "  ! built output not scanned: vinci/dist/extensions is absent (run vinci/build.sh first)"
fi

if ! grep -Fq -- "--exclude='node_modules/@getsimpledirect'" "${ROOT}/vinci/package.sh"; then
  fail "vinci/package.sh must exclude node_modules/@getsimpledirect from the public artifact"
fi

# 4. Artifact.
if [ "$#" -eq 1 ]; then
  artifact="$1"
  [ -f "${artifact}" ] || fail "Vinci artifact does not exist: ${artifact}"
  if tar -tzf "${artifact}" | grep -F 'node_modules/@getsimpledirect/' >/dev/null; then
    fail "Public Vinci artifact contains private @getsimpledirect runtime files: ${artifact}"
  fi
  unpack="$(mktemp -d "${TMPDIR:-/tmp}/vinci-contracts-guard.XXXXXX")"
  trap 'rm -rf "${unpack}"' EXIT
  # The WHOLE archive: node_modules and extensionless files included. Nothing shipped is exempt.
  tar -xzf "${artifact}" -C "${unpack}"
  [ -n "$(ls -A "${unpack}")" ] || fail "Vinci artifact is empty: ${artifact}"
  ( cd "${unpack}" && node "${SCANNER}" --shipped . ) \
    || fail "Public Vinci artifact references @getsimpledirect and may fail to start: ${artifact}"
fi

echo "  ✓ contracts runtime guard: no private runtime dependency, no runtime import in sources or built output, private scope excluded"
