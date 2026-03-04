#!/bin/bash
# resolve-sdk.sh — Download .NET SDK and output version + git hashes JSON
#
# Resolves three git hashes from three different repos:
#   - vmrGitHash:     dotnet/dotnet (VMR) commit that produced the SDK build
#   - sdkGitHash:     dotnet/sdk repo commit
#   - runtimeGitHash: dotnet/runtime repo commit
#
# Resolution algorithm:
#   1. Install SDK, run `dotnet --info`
#   2. Extract "SDK: Commit:" hash (DOTNET_COMMIT)
#   3. Try fetching src/source-manifest.json from dotnet/dotnet at DOTNET_COMMIT
#   4. If found → DOTNET_COMMIT is the VMR commit; parse sdk + runtime hashes from manifest
#   5. If not → fallback: DOTNET_COMMIT is sdkGitHash, Host Commit is runtimeGitHash
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
INSTALL_DIR="$(cd "${ARTIFACTS_DIR:-artifacts}" && pwd)/linux.sdk${SDK_VERSION}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$INSTALL_DIR"

# Skip download if SDK is already installed
if [ -f "$INSTALL_DIR/sdk-info.json" ]; then
    EXISTING_VERSION=$(jq -r '.sdkVersion // empty' "$INSTALL_DIR/sdk-info.json" 2>/dev/null)
    if [ -n "$EXISTING_VERSION" ]; then
        echo "SDK already installed at $INSTALL_DIR ($EXISTING_VERSION), skipping download." >&2
        export DOTNET_ROOT="$INSTALL_DIR"
        export PATH="$INSTALL_DIR:$PATH"
        export DOTNET_NOLOGO=true
        NUGET_DIR="$(cd "$INSTALL_DIR/.." && pwd)/nuget-packages"
        mkdir -p "$NUGET_DIR"
        export NUGET_PACKAGES="$NUGET_DIR"
        cat "$INSTALL_DIR/sdk-info.json"
        exit 0
    fi
fi

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
export DOTNET_NOLOGO=true

# Place NuGet cache inside artifacts so it's isolated and reproducible
NUGET_DIR="$(cd "$INSTALL_DIR/.." && pwd)/nuget-packages"
mkdir -p "$NUGET_DIR"
export NUGET_PACKAGES="$NUGET_DIR"

# Persist for subsequent CI steps (GitHub Actions)
if [ -n "${GITHUB_ENV:-}" ]; then
    echo "DOTNET_ROOT=$INSTALL_DIR" >> "$GITHUB_ENV"
    echo "PATH=$INSTALL_DIR:$PATH" >> "$GITHUB_ENV"
    echo "NUGET_PACKAGES=$NUGET_DIR" >> "$GITHUB_ENV"
    echo "DOTNET_NOLOGO=true" >> "$GITHUB_ENV"
fi

# Extract version and commit info
RESOLVED_VERSION=$("$INSTALL_DIR/dotnet" --version)
DOTNET_INFO=$("$INSTALL_DIR/dotnet" --info)

# Extract the first Commit: line (from .NET SDK section)
DOTNET_COMMIT=$(echo "$DOTNET_INFO" | grep -oP 'Commit:\s+\K[a-f0-9]+' | head -1)
# Extract the Host section's Commit: line (from dotnet/runtime host)
HOST_COMMIT=$(echo "$DOTNET_INFO" | sed -n '/^Host:/,/^$/p' | grep -oP 'Commit:\s+\K[a-f0-9]+' | head -1)

if [ -z "$DOTNET_COMMIT" ]; then
    echo "Warning: Could not extract commit hash from dotnet --info" >&2
    DOTNET_COMMIT="0000000000000000000000000000000000000000"
fi

# ── Resolve three git hashes ────────────────────────────────────────────────
# Try treating DOTNET_COMMIT as a VMR (dotnet/dotnet) commit by fetching
# src/source-manifest.json at that hash. For VMR-based builds (≥.NET 9),
# the SDK section's Commit: is the VMR commit hash.

VMR_GIT_HASH=""
SDK_GIT_HASH=""
RUNTIME_GIT_HASH=""

MANIFEST_URL="https://raw.githubusercontent.com/dotnet/dotnet/$DOTNET_COMMIT/src/source-manifest.json"
echo "Trying VMR resolution at $DOTNET_COMMIT..." >&2

if MANIFEST=$(curl -fsSL "$MANIFEST_URL" 2>/dev/null); then
    echo "VMR commit confirmed. Extracting repo hashes from source-manifest.json..." >&2
    VMR_GIT_HASH="$DOTNET_COMMIT"

    # Parse individual repo hashes from the VMR source-manifest.json
    SDK_GIT_HASH=$(echo "$MANIFEST" | node -e "
        const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
        const entry = (data.repositories || []).find(r => r.path === 'sdk' || r.path === 'src/sdk');
        process.stdout.write(entry?.commitSha || '');
    ")
    RUNTIME_GIT_HASH=$(echo "$MANIFEST" | node -e "
        const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
        const entry = (data.repositories || []).find(r => r.path === 'runtime' || r.path === 'src/runtime');
        process.stdout.write(entry?.commitSha || '');
    ")

    echo "  vmrGitHash:     $VMR_GIT_HASH" >&2
    echo "  sdkGitHash:     $SDK_GIT_HASH" >&2
    echo "  runtimeGitHash: $RUNTIME_GIT_HASH" >&2
else
    echo "VMR resolution failed (non-VMR build or network error). Using fallback." >&2
fi

# Fallback: if VMR resolution didn't provide hashes
if [ -z "$SDK_GIT_HASH" ]; then
    SDK_GIT_HASH="$DOTNET_COMMIT"
    echo "  sdkGitHash (fallback from SDK Commit): $SDK_GIT_HASH" >&2
fi
if [ -z "$RUNTIME_GIT_HASH" ]; then
    RUNTIME_GIT_HASH="${HOST_COMMIT:-$DOTNET_COMMIT}"
    echo "  runtimeGitHash (fallback from Host Commit): $RUNTIME_GIT_HASH" >&2
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
  "runtimeGitHash": "$RUNTIME_GIT_HASH",
  "sdkGitHash": "$SDK_GIT_HASH",
  "vmrGitHash": "$VMR_GIT_HASH",
  "commitDate": "$COMMIT_DATE",
  "commitTime": "$COMMIT_TIME"
}
EOF

cat "$INSTALL_DIR/sdk-info.json"
