#!/usr/bin/env bash
# Package Vinci Code into a self-contained tarball for the prebuilt install flow (curl … | sh → extract
# → `vinci`). The artifact is a PRUNED monorepo: the built dist of the forked packages + the vinci/
# layer + a runtime node_modules (with the @earendil-works → packages/* workspace symlinks preserved, so
# the PATCHED packages resolve). Dev-only tooling and source maps are excluded to keep it lean.
#
# Usage:  bash vinci/package.sh [out-dir]        (default: ./release)
# Set VINCI_UPDATE_SIGNING_KEY + VINCI_UPDATE_SEQUENCE to also produce the signed beta manifest.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-${ROOT}/release}"
VERSION="$(node -e 'const i=require(process.argv[1]); if(typeof i.version!=="string") process.exit(1); process.stdout.write(i.version)' "${ROOT}/vinci/identity.json")"
TGZ="${OUT}/vinci-code-${VERSION}.tgz"
CURRENT_TGZ="${OUT}/vinci-code.tgz"
EXCLUDES="$(mktemp "${TMPDIR:-/tmp}/vinci-package-excludes.XXXXXX")"
trap 'rm -f "${EXCLUDES}"' EXIT
mkdir -p "${OUT}"

echo "── Building (network-free) ─────────────────────────"
bash "${ROOT}/vinci/build.sh" >/dev/null
echo "  ✓ built"

echo "── Packaging → ${TGZ} ─────────────────────────────"
# Package only the transitive production dependency closure of the five shipped workspaces. This
# removes development CLIs and test runners as whole graphs, along with unrelated local packages,
# so no shipped entry point can depend on one of the explicit development-tool exclusions below.
node "${ROOT}/vinci/scripts/package-excludes.mjs" "${ROOT}" > "${EXCLUDES}"

# Tar straight from the repo root so paths extract as packages/… + vinci/ + node_modules (the launcher
# resolves ROOT from its own location, so this layout runs as-is). Package only Vinci runtime assets;
# tests, docs, infrastructure state, and release tooling must never enter the public archive.
tar -czf "${TGZ}" -C "${ROOT}" \
  --exclude-from="${EXCLUDES}" \
  --exclude='node_modules/typescript' \
  --exclude='node_modules/unbash' \
  --exclude='node_modules/@typescript' \
  --exclude='node_modules/@biomejs' \
  --exclude='node_modules/@types' \
  --exclude='node_modules/esbuild' \
  --exclude='node_modules/@esbuild' \
  --exclude='node_modules/ssh2/test' \
  --exclude='node_modules/.cache' \
  --exclude='node_modules/.vite' \
  --exclude='node_modules/.bin' \
  --exclude='*.map' \
  --exclude='*.ts.map' \
  --exclude='vinci/worker/README.md' \
  packages/agent/dist packages/agent/package.json \
  packages/ai/dist packages/ai/package.json \
  packages/coding-agent/dist packages/coding-agent/package.json \
  packages/orchestrator/dist packages/orchestrator/package.json \
  packages/tui/dist packages/tui/package.json \
  vinci/bin vinci/extensions vinci/themes vinci/assets vinci/updater vinci/worker \
  vinci/scripts/report-wrong.mjs vinci/scripts/reap-heal-temp.mjs vinci/scripts/resolve-dispatch.mjs \
  vinci/dispatch-manifest.json vinci/identity.json vinci/NOTICE \
  package.json node_modules

cp "${TGZ}" "${CURRENT_TGZ}"
# Record the checksum against the BASENAME so `shasum -c` works from the release dir on any machine
# (an absolute build path is unverifiable elsewhere and leaks the builder's filesystem layout).
( cd "${OUT}" && shasum -a 256 "vinci-code-${VERSION}.tgz" > "vinci-code-${VERSION}.tgz.sha256" )

# Ship the installer next to the tarball.
cp "${ROOT}/vinci/install.sh" "${OUT}/install.sh"

if [ -n "${VINCI_UPDATE_SIGNING_KEY:-}" ]; then
  [ -n "${VINCI_UPDATE_SEQUENCE:-}" ] || {
    echo "VINCI_UPDATE_SEQUENCE is required when signing an update manifest" >&2
    exit 1
  }
  node "${ROOT}/vinci/scripts/create-update-manifest.mjs" \
    --artifact "${TGZ}" \
    --artifact-url "${VINCI_UPDATE_ARTIFACT_URL:-https://vinci-assets.s3.ca-central-1.amazonaws.com/vinci-code/vinci-code-${VERSION}.tgz}" \
    --version "${VERSION}" \
    --minimum-version "${VINCI_UPDATE_MINIMUM_VERSION:-${VERSION}}" \
    --sequence "${VINCI_UPDATE_SEQUENCE}" \
    --channel "${VINCI_UPDATE_CHANNEL:-beta}" \
    --mandatory "${VINCI_UPDATE_MANDATORY:-false}" \
    --private-key "${VINCI_UPDATE_SIGNING_KEY}" \
    --public-key "${ROOT}/vinci/updater/public-key.pem" \
    --output "${OUT}/manifest-${VINCI_UPDATE_CHANNEL:-beta}.json"
elif [ "${VINCI_PACKAGE_REQUIRE_SIGNING:-0}" = "1" ]; then
  echo "VINCI_UPDATE_SIGNING_KEY is required for a publishable Vinci package" >&2
  exit 1
else
  echo "  ! unsigned development package (set VINCI_UPDATE_SIGNING_KEY for release)"
fi

echo "  ✓ ${TGZ}  ($(du -h "${TGZ}" | cut -f1))"
echo "  ✓ ${CURRENT_TGZ}  (compatibility copy)"
echo "  ✓ ${TGZ}.sha256"
echo "  ✓ ${OUT}/install.sh"
echo
echo "Next: publish the immutable archive, signed manifest, and installer; then run:"
echo "  curl -fsSL https://vinci.getsimpledirect.com/install | sh"
