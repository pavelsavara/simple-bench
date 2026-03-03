#!/bin/bash
# init-gh-pages.sh — Initialize the gh-pages branch with empty index and dashboard skeleton
#
# This script creates an orphan gh-pages branch with the initial data structure.
# Run once during repo setup.
#
# Usage:
#   ./scripts/init-gh-pages.sh
#
# After running:
#   git push origin gh-pages

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Creating orphan gh-pages branch..."
cd "$REPO_DIR"

git checkout --orphan gh-pages
git reset --hard

# Data directory with minimal index
mkdir -p data

cat > data/index.json << 'INDEXEOF'
{
  "months": [],
  "lastUpdated": null,
  "dimensions": {
    "runtimes": ["coreclr", "mono", "llvm_naot"],
    "presets": ["no-workload", "aot", "native-relink", "no-jiterp", "invariant", "no-reflection-emit", "debug"],
    "engines": ["v8", "node", "chrome", "firefox"],
    "apps": ["empty-browser", "empty-blazor", "blazing-pizza", "microbenchmarks"]
  }
}
INDEXEOF

# Dashboard skeleton (placeholder — replaced in Phase 4)
mkdir -p app

cat > index.html << 'HTMLEOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>.NET WASM Benchmark Dashboard</title>
</head>
<body>
    <h1>.NET WASM Benchmark Dashboard</h1>
    <p>Dashboard coming soon. Data collection is active.</p>
    <p><a href="https://github.com/pavelsavara/simple-bench">GitHub</a></p>
</body>
</html>
HTMLEOF

git add -A
git commit -m "Initialize gh-pages with empty index and dashboard skeleton"

echo ""
echo "gh-pages branch created locally."
echo ""
echo "To push:"
echo "  git push origin gh-pages"
echo ""
echo "To return to main:"
echo "  git checkout main"
