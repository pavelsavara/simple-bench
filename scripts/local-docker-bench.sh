#!/bin/bash
# local-docker-bench.sh — Simulate CI benchmark pipeline locally using Docker.
#
# Thin wrapper around run-bench.mjs --mode docker.
# Checks prerequisites then delegates to JS orchestrator.
#
# Usage:
#   ./scripts/local-docker-bench.sh                       # Run all steps
#   ./scripts/local-docker-bench.sh --skip-docker          # Skip Docker image build
#   ./scripts/local-docker-bench.sh --skip-build           # Skip app build
#   ./scripts/local-docker-bench.sh --skip-docker --skip-build  # Measure only
#   ./scripts/local-docker-bench.sh --step docker-build    # Run only one step
#   ./scripts/local-docker-bench.sh --step build
#   ./scripts/local-docker-bench.sh --step measure
#   ./scripts/local-docker-bench.sh --dry-run              # Chrome only
#   ./scripts/local-docker-bench.sh --app try-mud-blazor   # Single app
#   ./scripts/local-docker-bench.sh --engine chrome        # Specific engine
#   ./scripts/local-docker-bench.sh --preset devloop,aot     # Specific presets
#
# All flags are forwarded to: node scripts/run-bench.mjs --mode docker ...

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

if ! command -v docker &>/dev/null; then
    err "Docker not found. Install Docker to use Docker mode."
    exit 1
fi

# npm ci if node_modules missing
if [[ ! -d "$REPO_DIR/node_modules" ]]; then
    info "node_modules not found — running npm ci..."
    (cd "$REPO_DIR" && npm ci)
fi

# ── Delegate to JS orchestrator ──────────────────────────────────────────────

exec node "$SCRIPT_DIR/run-bench.mjs" --mode docker "$@"
