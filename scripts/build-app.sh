#!/bin/bash
# build-app.sh — Build and publish a sample app with MSBuild flags
#
# Usage:
#   ./scripts/build-app.sh <app> <runtime> <preset> [commit-date]
#
# Examples:
#   ./scripts/build-app.sh empty-browser coreclr no-workload
#   ./scripts/build-app.sh empty-blazor mono aot 2026-06-02
#
# Output: published app in artifacts/publish/{app}/{commit-date}/{preset}/
#         compile time in artifacts/publish/{app}/{commit-date}/{preset}/compile-time.json

set -euo pipefail

APP="${1:?Usage: build-app.sh <app> <runtime> <preset> [commit-date]}"
RUNTIME="${2:?Usage: build-app.sh <app> <runtime> <preset> [commit-date]}"
PRESET="${3:?Usage: build-app.sh <app> <runtime> <preset> [commit-date]}"
COMMIT_DATE="${4:-local}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO_DIR/artifacts}"
APP_DIR="$REPO_DIR/src/$APP"
PUBLISH_DIR="$ARTIFACTS_DIR/publish/$APP/$COMMIT_DATE/$PRESET"

# Ensure dotnet is available
DOTNET="${DOTNET_ROOT:-}/dotnet"
if [ ! -x "$DOTNET" ]; then
    DOTNET="dotnet"
fi

# Detect SDK major version for project selection
SDK_VERSION=$("$DOTNET" --version 2>/dev/null || echo "0.0.0")
SDK_MAJOR=$(echo "$SDK_VERSION" | cut -d. -f1)

# Microsoft.NET.Sdk.WebAssembly was introduced in .NET 8.
# For .NET 6 and 7, empty-browser and microbenchmarks need the
# BlazorWebAssembly-based variant projects.
if [ "$SDK_MAJOR" -lt 8 ] 2>/dev/null; then
    case "$APP" in
        empty-browser)
            APP_DIR="$REPO_DIR/src/empty-browser-v6v7"
            echo "SDK $SDK_VERSION: using BlazorWebAssembly variant for $APP" >&2
            ;;
        microbenchmarks)
            APP_DIR="$REPO_DIR/src/microbenchmarks-v6v7"
            echo "SDK $SDK_VERSION: using BlazorWebAssembly variant for $APP" >&2
            ;;
    esac
fi

# Validate app directory exists

# Get publish arguments from JS utility
PUBLISH_ARGS=$(node -e "
    import { getPublishArgs } from '$SCRIPT_DIR/lib/build-config.mjs';
    const args = getPublishArgs('$RUNTIME', '$PRESET', '$APP_DIR', '$PUBLISH_DIR');
    process.stdout.write(args.join('\n'));
")

# Clean previous publish output
rm -rf "$PUBLISH_DIR"
mkdir -p "$PUBLISH_DIR"

# If RUNTIME_PACK_DIR is set, pass it to MSBuild
if [ -n "${RUNTIME_PACK_DIR:-}" ]; then
    PUBLISH_ARGS="$PUBLISH_ARGS
/p:RuntimePackDir=$RUNTIME_PACK_DIR"
    echo "Using runtime pack: $RUNTIME_PACK_DIR" >&2
fi

echo "Building $APP (runtime=$RUNTIME, preset=$PRESET)..." >&2
echo "  dotnet $PUBLISH_ARGS" >&2

# Record compile time
START_TIME=$(date +%s%N)

# Run dotnet publish
# shellcheck disable=SC2086
IFS=$'\n' read -r -d '' -a ARGS_ARRAY <<< "$PUBLISH_ARGS" || true
"$DOTNET" "${ARGS_ARRAY[@]}"

END_TIME=$(date +%s%N)
COMPILE_TIME_MS=$(( (END_TIME - START_TIME) / 1000000 ))

echo "Build completed in ${COMPILE_TIME_MS}ms" >&2

# Write compile time for downstream consumption
cat <<EOF > "$PUBLISH_DIR/compile-time.json"
{
  "compileTimeMs": $COMPILE_TIME_MS,
  "app": "$APP",
  "runtime": "$RUNTIME",
  "preset": "$PRESET"
}
EOF
