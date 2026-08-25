#!/usr/bin/env bash
# Root-side SSM entry point for one scored benchmark repetition.
set -uo pipefail

if (( $# != 8 )); then
  echo "usage: benchmark-remote-run.sh <result-uri> <credential-uri> <provider> <model> <campaign-id> <repetition> <capture-ui> <evidence-uri>" >&2
  exit 2
fi

RESULT_URI="$1"
CREDENTIAL_URI="$2"
PROVIDER="$3"
MODEL="$4"
CAMPAIGN_ID="$5"
REPETITION="$6"
CAPTURE_UI="$7"
EVIDENCE_URI="$8"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ARTIFACT_DIR="/home/vinci/artifacts"
CREDENTIAL_FILE="/home/vinci/.benchmark-credential"
ARCHIVE="/tmp/vinci-benchmark-results.tgz"

rm -rf "${ARTIFACT_DIR}"
install -d -o vinci -g vinci -m 0755 "${ARTIFACT_DIR}"
aws s3 cp "${CREDENTIAL_URI}" /tmp/vinci-benchmark-credential --only-show-errors
install -o vinci -g vinci -m 0600 /tmp/vinci-benchmark-credential "${CREDENTIAL_FILE}"

# Older launch-template instances may predate the corpus' pnpm fixture. Keep the
# source-staged benchmark self-contained while the immutable runner rolls forward.
if ! command -v pnpm >/dev/null 2>&1; then
  npm-24 install --prefix /opt/vinci-pnpm pnpm@11.3.0 --ignore-scripts
  ln -sf /opt/vinci-pnpm/node_modules/.bin/pnpm /usr/local/bin/pnpm
fi
command -v pnpm >/dev/null 2>&1 || exit 71
runuser -u vinci -- env PATH=/usr/local/bin:/usr/bin:/bin pnpm --version || exit 71

set +e
runuser -u vinci -- env \
  HOME=/home/vinci \
  PATH=/usr/local/bin:/usr/bin:/bin \
  VINCI_EC2_ARTIFACT_DIR="${ARTIFACT_DIR}" \
  VINCI_EC2_REPO_PROVIDER="${PROVIDER}" \
  VINCI_EC2_REPO_MODEL="${MODEL}" \
  VINCI_EC2_CAMPAIGN_ID="${CAMPAIGN_ID}" \
  VINCI_EC2_REPETITION="${REPETITION}" \
  VINCI_EC2_CAPTURE_UI="${CAPTURE_UI}" \
  VINCI_EC2_CREDENTIAL_FILE="${CREDENTIAL_FILE}" \
  bash "${ROOT}/vinci/test/ec2/benchmark-run.sh"
test_status=$?
set -e

rm -f /tmp/vinci-benchmark-credential "${CREDENTIAL_FILE}" /home/vinci/.pi/agent/auth.json
chown -R vinci:vinci "${ARTIFACT_DIR}"
(
  cd "${ARTIFACT_DIR}"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
)
tar -C "${ARTIFACT_DIR}" -czf "${ARCHIVE}" .
aws s3 cp "${ARCHIVE}" "${RESULT_URI}" --only-show-errors || exit 90
aws s3 cp "${ARCHIVE}" "${EVIDENCE_URI}" --only-show-errors || exit 91
exit "${test_status}"
