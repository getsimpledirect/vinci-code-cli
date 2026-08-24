#!/usr/bin/env bash
# Runs only on the disposable EC2 worker. It intentionally repeats the highest-risk harness paths.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ARTIFACT_DIR="${VINCI_EC2_ARTIFACT_DIR:-${ROOT}/vinci-test-artifacts}"
REPETITIONS="${VINCI_EC2_REPETITIONS:-5}"
REPO_MODE="${VINCI_EC2_REPO_MODE:-inventory}"
REPO_LIMIT="${VINCI_EC2_REPO_LIMIT:-3}"
REPO_PROFILE="${VINCI_EC2_REPO_PROFILE:-analysis}"
REPO_UI_SCENARIO="${VINCI_EC2_REPO_UI_SCENARIO:-}"
REPO_PROVIDER="${VINCI_EC2_REPO_PROVIDER:-vinci}"
REPO_MODEL="${VINCI_EC2_REPO_MODEL:-forte}"
OPENROUTER_KEY_FILE="${VINCI_EC2_OPENROUTER_KEY_FILE:-}"
ORIGINAL_PATH="${PATH}"
fails=0

if [[ ! "${REPETITIONS}" =~ ^[0-9]+$ ]] || (( REPETITIONS < 1 || REPETITIONS > 20 )); then
  echo "VINCI_EC2_REPETITIONS must be an integer from 1 to 20" >&2
  exit 2
fi
if [[ ! "${REPO_MODE}" =~ ^(skip|inventory|live)$ ]]; then
  echo "VINCI_EC2_REPO_MODE must be skip, inventory, or live" >&2
  exit 2
fi
if [[ ! "${REPO_LIMIT}" =~ ^[0-9]+$ ]] || (( REPO_LIMIT < 1 || REPO_LIMIT > 20 )); then
  echo "VINCI_EC2_REPO_LIMIT must be an integer from 1 to 20" >&2
  exit 2
fi
if [[ ! "${REPO_PROFILE}" =~ ^(analysis|coding)$ ]]; then
  echo "VINCI_EC2_REPO_PROFILE must be analysis or coding" >&2
  exit 2
fi
if [[ ! "${REPO_PROVIDER}" =~ ^(vinci|openrouter)$ ]]; then
  echo "VINCI_EC2_REPO_PROVIDER must be vinci or openrouter" >&2
  exit 2
fi
if [[ "${REPO_PROVIDER}" == "vinci" && "${REPO_MODEL}" != "forte" ]]; then
  echo "VINCI_EC2_REPO_MODEL must be forte for the Vinci provider" >&2
  exit 2
fi
if [[ "${REPO_PROVIDER}" == "openrouter" && ! "${REPO_MODEL}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.:-]*$ ]]; then
  echo "VINCI_EC2_REPO_MODEL must be a provider/model id for OpenRouter" >&2
  exit 2
fi
if [[ "${REPO_MODE}" == "live" && "${REPO_PROVIDER}" == "openrouter" ]]; then
  [[ -n "${OPENROUTER_KEY_FILE}" && -r "${OPENROUTER_KEY_FILE}" ]] || {
    echo "The live OpenRouter lane requires a readable mode-0600 key file" >&2
    exit 3
  }
  OPENROUTER_API_KEY="$(<"${OPENROUTER_KEY_FILE}")"
  [[ -n "${OPENROUTER_API_KEY}" ]] || { echo "The OpenRouter key file is empty" >&2; exit 3; }
  export OPENROUTER_API_KEY
fi
if [[ -n "${REPO_UI_SCENARIO}" && ! "${REPO_UI_SCENARIO}" =~ ^[a-z0-9][a-z0-9-]{2,60}$ ]]; then
  echo "VINCI_EC2_REPO_UI_SCENARIO must be empty or a scenario id" >&2
  exit 2
fi
if [[ -n "${REPO_UI_SCENARIO}" && ( "${REPO_MODE}" != "live" || "${REPO_PROFILE}" != "coding" ) ]]; then
  echo "VINCI_EC2_REPO_UI_SCENARIO requires the live coding repository lane" >&2
  exit 2
fi

mkdir -p "${ARTIFACT_DIR}/logs" "${ARTIFACT_DIR}/terminal"
exec > >(tee "${ARTIFACT_DIR}/logs/aggressive-run.log") 2>&1

record_failure() {
  echo "  FAILED: $1"
  fails=$((fails + 1))
}

run_group() {
  local label="$1"
  shift
  echo
  echo "── ${label} ─────────────────────────────────────────"
  "$@" || record_failure "${label}"
}

activate_node() {
  local major="$1"
  local bin_dir="${ARTIFACT_DIR}/node-${major}-bin"
  mkdir -p "${bin_dir}"
  ln -sf "$(command -v "node-${major}")" "${bin_dir}/node"
  ln -sf "$(command -v "npm-${major}")" "${bin_dir}/npm"
  if command -v "npx-${major}" >/dev/null 2>&1; then
    ln -sf "$(command -v "npx-${major}")" "${bin_dir}/npx"
  fi
  export PATH="${bin_dir}:${ORIGINAL_PATH}"
  node --version
  npm --version
}

{
  echo "started_at=$(date -u +%FT%TZ)"
  echo "repetitions=${REPETITIONS}"
  echo "repository_profile=${REPO_PROFILE}"
  echo "repository_mode=${REPO_MODE}"
  echo "repository_ui_scenario=${REPO_UI_SCENARIO:-none}"
  echo "repository_provider=${REPO_PROVIDER}"
  echo "repository_model=${REPO_MODEL}"
  uname -a
  cat /etc/os-release
  free -h
  df -h /
  ulimit -a
  bwrap --version
} >"${ARTIFACT_DIR}/environment.txt" 2>&1

cd "${ROOT}"
activate_node 22
run_group "Install pinned dependencies" npm ci --ignore-scripts
run_group "Build Vinci" bash vinci/build.sh
run_group "Static checks" npm run check
run_group "Node 22 offline harness" env VINCI_SKIP_SMOKE=1 bash vinci/test/run.sh

activate_node 24
run_group "Node 24 offline harness with Linux bwrap" env VINCI_SKIP_SMOKE=1 bash vinci/test/run.sh

if [[ "${REPO_MODE}" != "skip" ]]; then
  repo_manifest="vinci/test/ec2/repos/scenarios.json"
  repo_arguments=(
    --mode "${REPO_MODE}"
    --limit "${REPO_LIMIT}"
    --manifest "${repo_manifest}"
    --output "${ARTIFACT_DIR}/repositories"
    --provider "${REPO_PROVIDER}"
    --model "${REPO_MODEL}"
  )
  if [[ "${REPO_PROFILE}" == "coding" ]]; then
    repo_manifest="vinci/test/ec2/repos/coding-scenarios.json"
    repo_arguments=(
      --mode "${REPO_MODE}"
      --limit "${REPO_LIMIT}"
      --manifest "${repo_manifest}"
      --output "${ARTIFACT_DIR}/repositories"
      --provider "${REPO_PROVIDER}"
      --model "${REPO_MODEL}"
    )
    if [[ "${REPO_MODE}" == "live" ]]; then
      repo_arguments+=(--allow-repo-code yes)
    fi
    if [[ -n "${REPO_UI_SCENARIO}" ]]; then
      repo_arguments+=(--capture-ui-scenario "${REPO_UI_SCENARIO}")
    fi
  fi
  run_group "Pinned public-repository corpus (${REPO_PROFILE}, ${REPO_MODE}, ${REPO_PROVIDER}/${REPO_MODEL})" \
    node vinci/test/ec2/run-repo-corpus.mjs "${repo_arguments[@]}"
fi

for iteration in $(seq 1 "${REPETITIONS}"); do
  run_group "Loop regression ${iteration}/${REPETITIONS}" node vinci/test/loopbreak-integration.mjs
  run_group "Guard regression ${iteration}/${REPETITIONS}" node vinci/test/guard-integration.mjs
  run_group "Scope regression ${iteration}/${REPETITIONS}" node vinci/test/scope-integration.mjs
  run_group "Shell-state regression ${iteration}/${REPETITIONS}" node vinci/test/shell-integration.mjs
  run_group "UI regression ${iteration}/${REPETITIONS}" \
    node packages/coding-agent/node_modules/vitest/dist/cli.js --run vinci/test/ui/scenarios.test.mjs
done

for size in "60 20" "80 24" "120 40"; do
  read -r columns rows <<<"${size}"
  run_group "Native terminal ${columns}x${rows}" \
    node vinci/test/ec2/capture-terminal.mjs \
      --output "${ARTIFACT_DIR}/terminal" \
      --columns "${columns}" \
      --rows "${rows}"
done
run_group "Build terminal visual report" \
  node vinci/test/ec2/visual-report.mjs --directory "${ARTIFACT_DIR}/terminal"

sleep 1
if pgrep -af "${ROOT}/packages/coding-agent/dist/cli.js" >"${ARTIFACT_DIR}/lingering-processes.txt"; then
  record_failure "Vinci CLI process remained after native PTY capture"
else
  echo "No Vinci CLI processes remained after PTY capture." >"${ARTIFACT_DIR}/lingering-processes.txt"
fi

{
  echo "finished_at=$(date -u +%FT%TZ)"
  free -h
  df -h /
  ps -eo pid,ppid,stat,rss,etime,comm --sort=-rss | head -30
} >"${ARTIFACT_DIR}/resources-after.txt" 2>&1

(
  cd "${ARTIFACT_DIR}"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
)

echo
if (( fails == 0 )); then
  echo "All aggressive EC2 test groups passed."
else
  echo "${fails} aggressive EC2 test group(s) failed."
fi
exit "${fails}"
