#!/bin/bash
# local-bench.sh — Run the benchmark pipeline locally (no Docker).
#
# Thin wrapper around run-bench.mjs --mode local.
# Checks prerequisites (Node.js, npm, Playwright) then delegates to JS.
#
# Usage:
#   ./scripts/local-bench.sh                              # Run all steps
#   ./scripts/local-bench.sh --skip-build                  # Measure only
#   ./scripts/local-bench.sh --app try-mud-blazor          # Single app
#   ./scripts/local-bench.sh --engine chrome,firefox       # Specific engines
#   ./scripts/local-bench.sh --dry-run                     # Chrome only (fast)
#   ./scripts/local-bench.sh --preset debug,aot            # Specific presets
#   ./scripts/local-bench.sh --runtime mono                # Runtime flavor
#   ./scripts/local-bench.sh --sdk-version 11.0.100-preview.3.26062.1
#
# All flags are forwarded to: node scripts/run-bench.mjs --mode local ...

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Helpers ──────────────────────────────────────────────────────────────────

info()  { echo -e "\033[0;32m▶ $1\033[0m"; }
err()   { echo -e "\033[0;31m✗ $1\033[0m" >&2; }

# ── Prerequisites ────────────────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
    err "Node.js not found. Install Node.js >= 24."
    exit 1
fi
info "Node.js $(node -v)"

# npm ci if node_modules missing
if [[ ! -d "$REPO_DIR/node_modules" ]]; then
    info "node_modules not found — running npm ci..."
    (cd "$REPO_DIR" && npm ci)
fi

# Install Playwright browsers if needed (check for headless shell directory)
PW_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
if [[ ! -d "$PW_CACHE"/chromium_headless_shell-* ]]; then
    info "Playwright browsers not found — installing..."
    npx playwright install --with-deps chromium firefox
fi

# ── Delegate to JS orchestrator ──────────────────────────────────────────────

exec node "$SCRIPT_DIR/run-bench.mjs" --mode local "$@"
