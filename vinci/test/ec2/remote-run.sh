#!/usr/bin/env bash
# Root-side SSM entry point. The test process itself runs as the unprivileged `vinci` user.
set -uo pipefail

if (( $# != 9 )); then
  echo "usage: remote-run.sh <s3-result-uri> <repetitions> <repo-mode> <repo-limit> <s3-credential-uri-or-empty> <repo-profile> <repo-ui-scenario-or-empty> <repo-provider> <repo-model>" >&2
  exit 2
fi

RESULT_URI="$1"
REPETITIONS="$2"
REPO_MODE="$3"
REPO_LIMIT="$4"
AUTH_URI="$5"
REPO_PROFILE="$6"
REPO_UI_SCENARIO="$7"
REPO_PROVIDER="$8"
REPO_MODEL="$9"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ARTIFACT_DIR="/home/vinci/artifacts"
ARCHIVE="/tmp/vinci-ec2-results.tgz"
OPENROUTER_KEY_FILE="/home/vinci/.pi/agent/openrouter.key"

if [[ ! "${REPO_PROVIDER}" =~ ^(vinci|openrouter)$ ]]; then
  echo "Repository provider must be vinci or openrouter" >&2
  exit 2
fi

rm -rf "${ARTIFACT_DIR}"
install -d -o vinci -g vinci -m 0755 "${ARTIFACT_DIR}"

if [[ "${REPO_MODE}" == "live" ]]; then
  [[ -n "${AUTH_URI}" ]] || { echo "Live repository scenarios require a credential bundle" >&2; exit 3; }
  install -d -o vinci -g vinci -m 0700 /home/vinci/.pi/agent
  aws s3 cp "${AUTH_URI}" /tmp/vinci-test-credential --only-show-errors
  if [[ "${REPO_PROVIDER}" == "vinci" ]]; then
    install -o vinci -g vinci -m 0600 /tmp/vinci-test-credential /home/vinci/.pi/agent/auth.json
  else
    install -o vinci -g vinci -m 0600 /tmp/vinci-test-credential "${OPENROUTER_KEY_FILE}"
  fi
fi

set +e
runuser -u vinci -- env \
  HOME=/home/vinci \
  VINCI_EC2_ARTIFACT_DIR="${ARTIFACT_DIR}" \
  VINCI_EC2_REPETITIONS="${REPETITIONS}" \
  VINCI_EC2_REPO_MODE="${REPO_MODE}" \
  VINCI_EC2_REPO_LIMIT="${REPO_LIMIT}" \
  VINCI_EC2_REPO_PROFILE="${REPO_PROFILE}" \
  VINCI_EC2_REPO_UI_SCENARIO="${REPO_UI_SCENARIO}" \
  VINCI_EC2_REPO_PROVIDER="${REPO_PROVIDER}" \
  VINCI_EC2_REPO_MODEL="${REPO_MODEL}" \
  VINCI_EC2_OPENROUTER_KEY_FILE="${OPENROUTER_KEY_FILE}" \
  VINCI_CODING_AGENT_DIR=/home/vinci/.pi/agent \
  bash "${ROOT}/vinci/test/ec2/aggressive-run.sh"
test_status=$?
set -e

rm -f /tmp/vinci-test-credential /home/vinci/.pi/agent/auth.json "${OPENROUTER_KEY_FILE}"

cp /var/lib/vinci-runner/ready "${ARTIFACT_DIR}/instance-ready.txt" 2>/dev/null || true
cp /var/log/cloud-init-output.log "${ARTIFACT_DIR}/cloud-init-output.log" 2>/dev/null || true
chown -R vinci:vinci "${ARTIFACT_DIR}"
(
  cd "${ARTIFACT_DIR}"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
)

tar -C "${ARTIFACT_DIR}" -czf "${ARCHIVE}" .
if ! aws s3 cp "${ARCHIVE}" "${RESULT_URI}" --only-show-errors; then
  echo "Failed to upload EC2 test artifacts to ${RESULT_URI}" >&2
  exit 90
fi

exit "${test_status}"
