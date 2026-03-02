#!/bin/bash
# resolve-sdk.sh — Download .NET SDK and output version + git hash JSON
#
# Usage:
#   ./scripts/resolve-sdk.sh [channel] [specific-version]
#
# Examples:
#   ./scripts/resolve-sdk.sh                    # Latest .NET 11 daily
#   ./scripts/resolve-sdk.sh 10.0               # Latest .NET 10 daily
#   ./scripts/resolve-sdk.sh "" 11.0.100-preview.3.25130.1  # Specific version
#
# Output: writes sdk-info.json to $INSTALL_DIR and prints it to stdout

set -euo pipefail

CHANNEL="${1:-11.0}"
SDK_VERSION="${2:-}"
INSTALL_DIR="${ARTIFACTS_DIR:-artifacts}/sdk"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$INSTALL_DIR"

# Download official install script
echo "Downloading dotnet-install.sh..." >&2
curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
chmod +x /tmp/dotnet-install.sh

# Install SDK
if [ -n "$SDK_VERSION" ]; then
    echo "Installing .NET SDK $SDK_VERSION..." >&2
    /tmp/dotnet-install.sh --version "$SDK_VERSION" --install-dir "$INSTALL_DIR"
else
    echo "Installing latest .NET SDK from channel $CHANNEL (daily quality)..." >&2
    /tmp/dotnet-install.sh --channel "$CHANNEL" --quality daily --install-dir "$INSTALL_DIR"
fi

export DOTNET_ROOT="$INSTALL_DIR"
export PATH="$INSTALL_DIR:$PATH"

# Extract version and commit info
RESOLVED_VERSION=$("$INSTALL_DIR/dotnet" --version)
DOTNET_INFO=$("$INSTALL_DIR/dotnet" --info)
GIT_HASH=$(echo "$DOTNET_INFO" | grep -oP 'Commit:\s+\K[a-f0-9]+' | head -1)

if [ -z "$GIT_HASH" ]; then
    echo "Warning: Could not extract git hash from dotnet --info" >&2
    GIT_HASH="0000000000000000000000000000000000000000"
fi

# Parse build date from version string (YYDDD pattern)
# e.g. 11.0.100-preview.3.25130.1 → 25130 → 2025-05-10
COMMIT_DATE=$(node -e "
    import { parseBuildDate } from '$SCRIPT_DIR/lib/sdk-info.mjs';
    const d = parseBuildDate('$RESOLVED_VERSION');
    process.stdout.write(d || '');
")

if [ -z "$COMMIT_DATE" ]; then
    echo "Warning: Could not parse build date from version, using current date" >&2
    COMMIT_DATE=$(date -u +%Y-%m-%d)
fi

# Use current UTC time for the time component (unique per run)
COMMIT_TIME=$(date -u +%H-%M-%S-UTC)

# Build and write JSON
cat <<EOF > "$INSTALL_DIR/sdk-info.json"
{
  "sdkVersion": "$RESOLVED_VERSION",
  "gitHash": "$GIT_HASH",
  "commitDate": "$COMMIT_DATE",
  "commitTime": "$COMMIT_TIME"
}
EOF

cat "$INSTALL_DIR/sdk-info.json"
