#!/bin/bash
# local-bench.sh — Simulate CI benchmark pipeline locally using Docker.
#
# Steps (re-startable — skip with flags):
#   1. docker-build   Build both Docker images
#   2. build          Build all apps inside the build container
#   3. measure        Run measurements inside measure containers (sequentially)
#
# Usage:
#   ./local-bench.sh                      # Run all steps
#   ./local-bench.sh --skip-docker        # Skip Docker image build
#   ./local-bench.sh --skip-build         # Skip app build (reuse artifacts/publish)
#   ./local-bench.sh --skip-docker --skip-build   # Measure only
#   ./local-bench.sh --step docker-build  # Run only one step
#   ./local-bench.sh --step build
#   ./local-bench.sh --step measure
#
# Options:
#   --sdk-channel <ch>   SDK channel (default: 11.0)
#   --sdk-version <ver>  Specific SDK version (default: latest nightly)
#   --dry-run            Measure chrome only (like PR mode)
#   --app <name>         Measure only this app (default: all from matrix)
#   --preset <name>      Measure only this preset (default: all from matrix)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTIFACTS_DIR="$REPO_DIR/artifacts"

# ── Log file setup ───────────────────────────────────────────────────────────
# Tee all output (stdout + stderr) to a log file for easier debugging.
mkdir -p "$ARTIFACTS_DIR"
LOG_FILE="$ARTIFACTS_DIR/local-bench.log"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "" >> "$LOG_FILE"
echo "═══ local-bench.sh started at $(date -u +%Y-%m-%dT%H:%M:%SZ) ═══" >> "$LOG_FILE"

# ── Defaults ─────────────────────────────────────────────────────────────────

SKIP_DOCKER=false
SKIP_BUILD=false
SKIP_MEASURE=false
ONLY_STEP=""
SDK_CHANNEL="11.0"
SDK_VERSION=""
DRY_RUN=false
FILTER_APP=""
FILTER_PRESET=""

# ── Parse args ───────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-docker)   SKIP_DOCKER=true; shift ;;
        --skip-build)    SKIP_BUILD=true; shift ;;
        --skip-measure)  SKIP_MEASURE=true; shift ;;
        --step)          ONLY_STEP="$2"; shift 2 ;;
        --sdk-channel)   SDK_CHANNEL="$2"; shift 2 ;;
        --sdk-version)   SDK_VERSION="$2"; shift 2 ;;
        --dry-run)       DRY_RUN=true; shift ;;
        --app)           FILTER_APP="$2"; shift 2 ;;
        --preset)        FILTER_PRESET="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# If --step is set, only run that step
if [[ -n "$ONLY_STEP" ]]; then
    SKIP_DOCKER=true; SKIP_BUILD=true; SKIP_MEASURE=true
    case "$ONLY_STEP" in
        docker-build) SKIP_DOCKER=false ;;
        build)        SKIP_BUILD=false ;;
        measure)      SKIP_MEASURE=false ;;
        *) echo "Unknown step: $ONLY_STEP (valid: docker-build, build, measure)" >&2; exit 1 ;;
    esac
fi

BUILD_IMAGE="browser-bench-build:latest"
MEASURE_IMAGE="browser-bench-measure:latest"

# ── Helpers ──────────────────────────────────────────────────────────────────

banner() { echo -e "\n\033[1;36m═══ $1 ═══\033[0m"; }
info()   { echo -e "\033[0;32m▶ $1\033[0m"; }
err()    { echo -e "\033[0;31m✗ $1\033[0m" >&2; }

# Fix ownership on artifacts so the host user can always read/delete them,
# even when files were created by root inside Docker.
fix_permissions() {
    if [[ -d "$ARTIFACTS_DIR" ]]; then
        docker run --rm -v "$ARTIFACTS_DIR:/a" "$BUILD_IMAGE" \
            chmod -R a+rw /a 2>/dev/null || true
    fi
}

# Clean artifacts subdirectories. Files may be owned by root (created inside
# Docker), so fix permissions first.
clean_artifacts() {
    local dirs=("$@")
    fix_permissions
    for d in "${dirs[@]}"; do
        rm -rf "$ARTIFACTS_DIR/$d"
    done
}

# ── Step 1: Build Docker images ──────────────────────────────────────────────

if [[ "$SKIP_DOCKER" == false ]]; then
    banner "Step 1: Build Docker images"

    info "Building $BUILD_IMAGE..."
    docker build --target browser-bench-build \
        -t "$BUILD_IMAGE" -f "$REPO_DIR/docker/Dockerfile" "$REPO_DIR"

    info "Building $MEASURE_IMAGE..."
    docker build --target browser-bench-measure \
        -t "$MEASURE_IMAGE" -f "$REPO_DIR/docker/Dockerfile" "$REPO_DIR"

    info "Docker images ready"
else
    info "Skipping Docker image build"
fi

# ── Step 2: Build apps ───────────────────────────────────────────────────────

MANIFEST_FILE="$ARTIFACTS_DIR/results/build-manifest.json"

if [[ "$SKIP_BUILD" == false ]]; then
    banner "Step 2: Build all apps"

    # Clean previous artifacts (SDK must be fresh — leftover workload breaks validation)
    info "Cleaning artifacts/sdk and artifacts/publish..."
    clean_artifacts sdk publish
    mkdir -p "$ARTIFACTS_DIR"

    SDK_VERSION_ARG=""
    if [[ -n "$SDK_VERSION" ]]; then
        SDK_VERSION_ARG="--sdk-version $SDK_VERSION"
    fi

    DRY_RUN_BUILD_FLAG=""
    if [[ "$DRY_RUN" == true ]]; then
        DRY_RUN_BUILD_FLAG="--dry-run"
    fi

    BUILD_START=$(date +%s)
    info "Running build inside $BUILD_IMAGE..."
    docker run --rm \
        -v "$REPO_DIR:/bench" \
        -w /bench \
        -e ARTIFACTS_DIR=/bench/artifacts \
        "$BUILD_IMAGE" \
        bash -c "
            npm ci --ignore-scripts 2>&1 | tail -3
            node scripts/run-pipeline.mjs \
                --sdk-channel '$SDK_CHANNEL' \
                $SDK_VERSION_ARG \
                --runtime mono \
                $DRY_RUN_BUILD_FLAG
        "
    BUILD_END=$(date +%s)

    fix_permissions

    if [[ ! -f "$MANIFEST_FILE" ]]; then
        err "Build manifest not found at $MANIFEST_FILE"
        exit 1
    fi

    info "Build completed in $((BUILD_END - BUILD_START))s"
    info "Build manifest: $(cat "$MANIFEST_FILE")"
    info "Build artifacts in $ARTIFACTS_DIR/publish/"
    info "SDK info: $(cat "$ARTIFACTS_DIR/sdk/sdk-info.json" 2>/dev/null || echo 'not found')"
else
    info "Skipping build (reusing $ARTIFACTS_DIR/publish/)"
    if [[ ! -f "$MANIFEST_FILE" ]]; then
        err "No build manifest found. Run the build step first."
        exit 1
    fi
    info "Reusing manifest: $(cat "$MANIFEST_FILE")"
fi

# ── Step 3: Measure ──────────────────────────────────────────────────────────

if [[ "$SKIP_MEASURE" == false ]]; then
    banner "Step 3: Run measurements"

    MATRIX=$(cat "$MANIFEST_FILE")
    SDK_INFO="$ARTIFACTS_DIR/sdk/sdk-info.json"

    if [[ ! -f "$SDK_INFO" ]]; then
        err "sdk-info.json not found at $SDK_INFO — run the build step first."
        exit 1
    fi

    # Clear previous results (but keep build-manifest.json)
    mkdir -p "$ARTIFACTS_DIR/results"

    DRY_RUN_FLAG=""
    if [[ "$DRY_RUN" == true ]]; then
        DRY_RUN_FLAG="--dry-run"
    fi

    ENTRY_COUNT=$(echo "$MATRIX" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
    CURRENT=0
    FAILED=0
    MEASURE_TOTAL_START=$(date +%s)

    info "Measuring $ENTRY_COUNT app/preset combinations..."

    echo "$MATRIX" | python3 -c "
import sys, json
for entry in json.load(sys.stdin):
    print(entry['app'] + ' ' + entry['preset'])
" | while read -r APP PRESET; do
        # Apply filters
        if [[ -n "$FILTER_APP" && "$APP" != "$FILTER_APP" ]]; then continue; fi
        if [[ -n "$FILTER_PRESET" && "$PRESET" != "$FILTER_PRESET" ]]; then continue; fi

        CURRENT=$((CURRENT + 1))
        PUBLISH_DIR="/bench/artifacts/publish/$APP/$PRESET"

        info "[$CURRENT/$ENTRY_COUNT] Measuring $APP / $PRESET..."
        STEP_START=$(date +%s)

        if ! docker run --rm \
            -v "$REPO_DIR:/bench" \
            -w /bench \
            -e ARTIFACTS_DIR=/bench/artifacts \
            "$MEASURE_IMAGE" \
            bash -c "
                npm ci 2>&1 | tail -3
                node scripts/run-measure-job.mjs \
                    --app '$APP' \
                    --preset '$PRESET' \
                    --publish-dir '$PUBLISH_DIR' \
                    --sdk-info /bench/artifacts/sdk/sdk-info.json \
                    --build-manifest /bench/artifacts/results/build-manifest.json \
                    --output-dir /bench/artifacts/results \
                    --runtime mono \
                    --retries 3 \
                    --timeout 300000 \
                    $DRY_RUN_FLAG
            "; then
            err "Measurement failed for $APP / $PRESET (continuing...)"
            FAILED=$((FAILED + 1))
        fi
        STEP_END=$(date +%s)
        info "[$CURRENT/$ENTRY_COUNT] $APP / $PRESET completed in $((STEP_END - STEP_START))s"
        fix_permissions
    done

    MEASURE_TOTAL_END=$(date +%s)
    banner "Results"
    info "Total measurement time: $((MEASURE_TOTAL_END - MEASURE_TOTAL_START))s"
    if ls "$ARTIFACTS_DIR/results/"*.json 1>/dev/null 2>&1; then
        echo "Result files:"
        ls -lh "$ARTIFACTS_DIR/results/"*.json
    else
        echo "No result files produced."
    fi
else
    info "Skipping measurements"
fi

echo ""
info "Done."
