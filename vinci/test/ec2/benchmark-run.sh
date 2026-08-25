#!/usr/bin/env bash
# Runs one scored public-repository repetition on the disposable EC2 worker.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ARTIFACT_DIR="${VINCI_EC2_ARTIFACT_DIR:?VINCI_EC2_ARTIFACT_DIR is required}"
PROVIDER="${VINCI_EC2_REPO_PROVIDER:?VINCI_EC2_REPO_PROVIDER is required}"
MODEL="${VINCI_EC2_REPO_MODEL:?VINCI_EC2_REPO_MODEL is required}"
CAMPAIGN_ID="${VINCI_EC2_CAMPAIGN_ID:?VINCI_EC2_CAMPAIGN_ID is required}"
REPETITION="${VINCI_EC2_REPETITION:?VINCI_EC2_REPETITION is required}"
CREDENTIAL_FILE="${VINCI_EC2_CREDENTIAL_FILE:?VINCI_EC2_CREDENTIAL_FILE is required}"
CAPTURE_UI="${VINCI_EC2_CAPTURE_UI:-no}"
fails=0

case "${PROVIDER}" in
  vinci)
    [[ "${MODEL}" == "forte" ]] || { echo "Vinci benchmark model must be forte" >&2; exit 2; }
    ;;
  codex | claude)
    [[ "${MODEL}" == "default" ]] || { echo "Comparator benchmark model must be default" >&2; exit 2; }
    ;;
  *) echo "Benchmark provider must be vinci, codex, or claude" >&2; exit 2 ;;
esac
[[ "${CAMPAIGN_ID}" =~ ^[a-z0-9][a-z0-9-]{2,60}$ ]] || { echo "Invalid campaign id" >&2; exit 2; }
[[ "${REPETITION}" =~ ^([1-9]|1[0-9]|20)$ ]] || { echo "Repetition must be 1-20" >&2; exit 2; }
[[ "${CAPTURE_UI}" =~ ^(yes|no)$ ]] || { echo "Capture UI must be yes or no" >&2; exit 2; }
[[ -r "${CREDENTIAL_FILE}" ]] || { echo "Credential file is not readable" >&2; exit 3; }

case "${PROVIDER}" in
  vinci)
    install -d -m 0700 "${HOME}/.pi/agent"
    jq -n --rawfile key "${CREDENTIAL_FILE}" '{vinci: {type: "api_key", key: ($key | rtrimstr("\n"))}}' >"${HOME}/.pi/agent/auth.json"
    chmod 0600 "${HOME}/.pi/agent/auth.json"
    # Derived from piConfig.name in packages/coding-agent/src/config.ts (shell cannot import it).
    export VINCI_CODING_AGENT_DIR="${HOME}/.pi/agent"
    ;;
  codex) export OPENAI_API_KEY="$(<"${CREDENTIAL_FILE}")" ;;
  claude) export ANTHROPIC_API_KEY="$(<"${CREDENTIAL_FILE}")" ;;
esac

mkdir -p "${ARTIFACT_DIR}/analysis" "${ARTIFACT_DIR}/coding" "${ARTIFACT_DIR}/logs"
exec > >(tee "${ARTIFACT_DIR}/logs/benchmark-run.log") 2>&1

record_failure() {
  echo "FAILED: $1"
  fails=$((fails + 1))
}

cd "${ROOT}"
npm ci --ignore-scripts || record_failure "Install pinned Vinci dependencies"
if [[ "${PROVIDER}" == "vinci" ]]; then
  bash vinci/build.sh || record_failure "Build Vinci"
fi

common=(
  --mode live
  --provider "${PROVIDER}"
  --model "${MODEL}"
  --campaign-id "${CAMPAIGN_ID}"
  --repetition "${REPETITION}"
)
node vinci/test/ec2/run-repo-corpus.mjs \
  "${common[@]}" \
  --limit 3 \
  --manifest vinci/test/ec2/repos/scenarios.json \
  --output "${ARTIFACT_DIR}/analysis" || record_failure "Read-only corpus"

coding=(
  "${common[@]}"
  --limit 7
  --allow-repo-code yes
  --manifest vinci/test/ec2/repos/coding-scenarios.json
  --output "${ARTIFACT_DIR}/coding"
)
if [[ "${CAPTURE_UI}" == "yes" && "${PROVIDER}" == "vinci" ]]; then
  coding+=(--capture-ui-scenario express-repeated-query-values)
fi
node vinci/test/ec2/run-repo-corpus.mjs "${coding[@]}" || record_failure "Coding corpus"

{
  echo "campaign_id=${CAMPAIGN_ID}"
  echo "repetition=${REPETITION}"
  echo "provider=${PROVIDER}"
  echo "model=${MODEL}"
  echo "node=$(node --version)"
  echo "npm=$(npm --version)"
  echo "pnpm=$(pnpm --version)"
  echo "go=$(go version)"
  echo "uv=$(uv --version)"
  if [[ "${PROVIDER}" == "codex" ]]; then codex --version; fi
  if [[ "${PROVIDER}" == "claude" ]]; then claude --version; fi
} >"${ARTIFACT_DIR}/environment.txt" 2>&1

rm -f "${HOME}/.pi/agent/auth.json"
unset OPENAI_API_KEY ANTHROPIC_API_KEY
exit "${fails}"
