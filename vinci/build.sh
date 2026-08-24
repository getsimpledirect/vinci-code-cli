#!/usr/bin/env bash
# Vinci build — compiles Pi WITHOUT re-fetching the ~1000 external model catalogs that the stock
# `npm run build` pulls from models.dev / OpenRouter / NVIDIA / Vercel on EVERY build.
#
# Vinci Code is single-provider (only the Vinci provider; /model is Vinci-only) — those catalogs are
# irrelevant to us, and the generated files (models.generated.ts, providers/*.models.ts,
# image-models.generated.ts) are already committed. Skipping the fetch makes the build:
#   • network-free (no more transient "generate-models" failures),
#   • faster, and
#   • drift-free (the generated files stay untouched, so `git status` stays clean).
#
# Use this instead of `npm run build`.  (If you ever DO want to refresh the upstream catalogs, run
# the stock `npm run build` once.)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "Building Vinci (no external model fetch)…"
( cd "$ROOT/packages/tui" && npm run build )
( cd "$ROOT/packages/ai" && npx tsgo -p tsconfig.build.json )   # tsgo only — skip generate-models/image-models
( cd "$ROOT/packages/agent" && npm run build )
( cd "$ROOT/packages/coding-agent" && npm run build )           # includes copy-assets
( cd "$ROOT/packages/orchestrator" && npm run build )
echo "✓ Vinci built — packages/coding-agent/dist/cli.js is ready. Relaunch: vinci/bin/vinci"
