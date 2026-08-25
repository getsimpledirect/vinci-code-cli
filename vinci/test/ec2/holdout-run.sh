#!/usr/bin/env bash
# Runs the agent-facing half of a private holdout corpus.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ARTIFACT_DIR="${VINCI_EC2_ARTIFACT_DIR:?VINCI_EC2_ARTIFACT_DIR is required}"
PROVIDER="${VINCI_EC2_REPO_PROVIDER:?VINCI_EC2_REPO_PROVIDER is required}"
MODEL="${VINCI_EC2_REPO_MODEL:?VINCI_EC2_REPO_MODEL is required}"
CAMPAIGN_ID="${VINCI_EC2_CAMPAIGN_ID:?VINCI_EC2_CAMPAIGN_ID is required}"
REPETITION="${VINCI_EC2_REPETITION:?VINCI_EC2_REPETITION is required}"
CREDENTIAL_FILE="${VINCI_EC2_CREDENTIAL_FILE:?VINCI_EC2_CREDENTIAL_FILE is required}"
TASK_ROOT="${VINCI_EC2_HOLDOUT_TASK_ROOT:?VINCI_EC2_HOLDOUT_TASK_ROOT is required}"

[[ -r "${TASK_ROOT}/manifest.json" ]] || { echo "Holdout task manifest is not readable" >&2; exit 3; }
[[ -d "${TASK_ROOT}/fixtures" ]] || { echo "Holdout fixture directory is missing" >&2; exit 3; }
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
  *) echo "Holdout provider must be vinci, codex, or claude" >&2; exit 2 ;;
esac

mkdir -p "${ARTIFACT_DIR}/logs"
exec > >(tee "${ARTIFACT_DIR}/logs/holdout-run.log") 2>&1

cd "${ROOT}"
npm ci --ignore-scripts || exit 10
if [[ "${PROVIDER}" == "vinci" ]]; then bash vinci/build.sh || exit 11; fi

export VINCI_EC2_FIXTURE_ROOT="${TASK_ROOT}/fixtures"
export VINCI_EC2_REMOVE_FIXTURE_AFTER_APPLY=yes
node vinci/test/ec2/run-repo-corpus.mjs \
  --mode live \
  --provider "${PROVIDER}" \
  --model "${MODEL}" \
  --campaign-id "${CAMPAIGN_ID}" \
  --repetition "${REPETITION}" \
  --limit 20 \
  --allow-repo-code yes \
  --preserve-work yes \
  --manifest "${TASK_ROOT}/manifest.json" \
  --output "${ARTIFACT_DIR}"
