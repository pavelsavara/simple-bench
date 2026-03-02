#!/bin/bash
# build-app.sh — Build and publish a sample app with MSBuild flags
#
# Usage:
#   ./scripts/build-app.sh <app> <runtime> <config>
#
# Examples:
#   ./scripts/build-app.sh empty-browser coreclr release
#   ./scripts/build-app.sh empty-blazor mono aot
#
# Output: published app in artifacts/publish/{app}/
#         compile time in artifacts/results/compile-time.json

set -euo pipefail

APP="${1:?Usage: build-app.sh <app> <runtime> <config>}"
RUNTIME="${2:?Usage: build-app.sh <app> <runtime> <config>}"
CONFIG="${3:?Usage: build-app.sh <app> <runtime> <config>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO_DIR/artifacts}"
APP_DIR="$REPO_DIR/apps/$APP"
PUBLISH_DIR="$ARTIFACTS_DIR/publish/$APP"

# Validate app directory exists
if [ ! -d "$APP_DIR" ]; then
    echo "Error: App directory not found: $APP_DIR" >&2
    exit 1
fi

# Ensure dotnet is available
DOTNET="${DOTNET_ROOT:-}/dotnet"
if [ ! -x "$DOTNET" ]; then
    DOTNET="dotnet"
fi

# Get publish arguments from JS utility
PUBLISH_ARGS=$(node -e "
    import { getPublishArgs } from '$SCRIPT_DIR/lib/build-config.mjs';
    const args = getPublishArgs('$RUNTIME', '$CONFIG', '$APP_DIR', '$PUBLISH_DIR');
    process.stdout.write(args.join('\n'));
")

# Clean previous publish output
rm -rf "$PUBLISH_DIR"
mkdir -p "$PUBLISH_DIR"
mkdir -p "$ARTIFACTS_DIR/results"

echo "Building $APP (runtime=$RUNTIME, config=$CONFIG)..." >&2
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
cat <<EOF > "$ARTIFACTS_DIR/results/compile-time.json"
{
  "compileTimeMs": $COMPILE_TIME_MS,
  "app": "$APP",
  "runtime": "$RUNTIME",
  "config": "$CONFIG"
}
EOF
