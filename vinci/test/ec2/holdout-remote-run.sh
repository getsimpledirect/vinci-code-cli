#!/usr/bin/env bash
# Downloads hidden verification only after the agent-facing process has exited.
set -uo pipefail

if (( $# != 12 )); then
  echo "usage: holdout-remote-run.sh <result-uri> <credential-uri> <provider> <model> <campaign-id> <repetition> <task-uri> <task-sha256> <verifier-uri> <verifier-sha256> <evidence-uri> <source-root>" >&2
  exit 2
fi

RESULT_URI="$1"
CREDENTIAL_URI="$2"
PROVIDER="$3"
MODEL="$4"
CAMPAIGN_ID="$5"
REPETITION="$6"
TASK_URI="$7"
TASK_SHA256="$8"
VERIFIER_URI="$9"
VERIFIER_SHA256="${10}"
EVIDENCE_URI="${11}"
ROOT="${12}"
ARTIFACT_DIR="/home/vinci/holdout-artifacts"
CREDENTIAL_FILE="/home/vinci/.holdout-credential"
TASK_ROOT="/home/vinci/holdout-task"
VERIFIER_ROOT="/home/vinci/holdout-verifier"

extract_checked() {
  local archive="$1"
  local destination="$2"
  local expected="$3"
  echo "${expected}  ${archive}" | sha256sum --check --status || return 80
  if tar -tzf "${archive}" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    echo "Archive contains an unsafe path" >&2
    return 81
  fi
  install -d -o vinci -g vinci -m 0700 "${destination}"
  tar -C "${destination}" --no-same-owner --no-same-permissions -xzf "${archive}"
  chown -R vinci:vinci "${destination}"
}

rm -rf "${ARTIFACT_DIR}" "${TASK_ROOT}" "${VERIFIER_ROOT}"
install -d -o vinci -g vinci -m 0755 "${ARTIFACT_DIR}"
aws s3 cp "${CREDENTIAL_URI}" /tmp/vinci-holdout-credential --only-show-errors
install -o vinci -g vinci -m 0600 /tmp/vinci-holdout-credential "${CREDENTIAL_FILE}"
if ! command -v pnpm >/dev/null 2>&1; then
  npm-24 install --prefix /opt/vinci-pnpm pnpm@11.3.0 --ignore-scripts
  ln -sf /opt/vinci-pnpm/node_modules/.bin/pnpm /usr/local/bin/pnpm
fi
command -v pnpm >/dev/null 2>&1 || exit 71
aws s3 cp "${TASK_URI}" /tmp/vinci-holdout-task.tgz --only-show-errors
extract_checked /tmp/vinci-holdout-task.tgz "${TASK_ROOT}" "${TASK_SHA256}" || exit $?
rm -f /tmp/vinci-holdout-task.tgz

set +e
runuser -u vinci -- env \
  HOME=/home/vinci \
  PATH=/usr/local/bin:/usr/bin:/bin \
  VINCI_EC2_ARTIFACT_DIR="${ARTIFACT_DIR}" \
  VINCI_EC2_REPO_PROVIDER="${PROVIDER}" \
  VINCI_EC2_REPO_MODEL="${MODEL}" \
  VINCI_EC2_CAMPAIGN_ID="${CAMPAIGN_ID}" \
  VINCI_EC2_REPETITION="${REPETITION}" \
  VINCI_EC2_CREDENTIAL_FILE="${CREDENTIAL_FILE}" \
  VINCI_EC2_HOLDOUT_TASK_ROOT="${TASK_ROOT}" \
  bash "${ROOT}/vinci/test/ec2/holdout-run.sh"
agent_status=$?
set -e

# Remove all agent-facing private material before hidden checks enter the machine.
rm -rf "${TASK_ROOT}"
rm -f "${CREDENTIAL_FILE}" /tmp/vinci-holdout-credential /home/vinci/.pi/agent/auth.json
aws s3 cp "${VERIFIER_URI}" /tmp/vinci-holdout-verifier.tgz --only-show-errors
extract_checked /tmp/vinci-holdout-verifier.tgz "${VERIFIER_ROOT}" "${VERIFIER_SHA256}" || exit $?
rm -f /tmp/vinci-holdout-verifier.tgz

set +e
runuser -u vinci -- env HOME=/home/vinci PATH=/usr/local/bin:/usr/bin:/bin \
  node "${ROOT}/vinci/test/ec2/verify-holdout-corpus.mjs" \
  --input "${ARTIFACT_DIR}" \
  --manifest "${VERIFIER_ROOT}/manifest.json" \
  --verifier-root "${VERIFIER_ROOT}" \
  --output "${ARTIFACT_DIR}/hidden-verification.json"
verification_status=$?
set -e

rm -rf "${VERIFIER_ROOT}" "${ARTIFACT_DIR}/work"
{
  echo "campaign_id=${CAMPAIGN_ID}"
  echo "repetition=${REPETITION}"
  echo "provider=${PROVIDER}"
  echo "model=${MODEL}"
  echo "agent_status=${agent_status}"
  echo "hidden_verification_status=${verification_status}"
} >"${ARTIFACT_DIR}/environment.txt"
(
  cd "${ARTIFACT_DIR}"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
)
tar -C "${ARTIFACT_DIR}" -czf /tmp/vinci-holdout-results.tgz .
aws s3 cp /tmp/vinci-holdout-results.tgz "${RESULT_URI}" --only-show-errors || exit 90
aws s3 cp /tmp/vinci-holdout-results.tgz "${EVIDENCE_URI}" --only-show-errors || exit 91
(( agent_status == 0 && verification_status == 0 ))
