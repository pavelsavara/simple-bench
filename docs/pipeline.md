# Pipeline: CI, Docker, Measurement, and Result Publishing

## Overview

Three GitHub Actions workflows orchestrate the benchmarking:

1. **benchmark.yml** — runs benchmark matrix daily (or on-demand)
2. **consolidate.yml** — merges results into gh-pages branch
3. **docker-build.yml** — builds/publishes the Docker image

All benchmark jobs run inside a Docker container with pre-installed engines (V8, Node, Chrome, Firefox). The .NET SDK is downloaded at runtime from the nightly feed.

---

## Docker Image

### Image: `ghcr.io/<org>/browser-bench:latest`

### Dockerfile location: `docker/Dockerfile`

### Base image
`ubuntu:24.04`

### Installed components

| Component | Version strategy | Install method |
|-----------|-----------------|----------------|
| **V8 (`d8`)** | Latest stable | Download prebuilt from `https://storage.googleapis.com/aspect-build/aspect-d8/` or build from chromium snapshots |
| **Node.js** | LTS (22.x) | `nvm install --lts` or NodeSource apt repo |
| **Chrome** | Latest Playwright-compatible | `npx playwright install --with-deps chromium` |
| **Firefox** | Latest Playwright-compatible | `npx playwright install --with-deps firefox` |
| **Playwright** | Latest | `npm install playwright` (global in /opt/playwright) |
| **Python 3** | System | `apt install python3 python3-pip` |
| **jq** | System | `apt install jq` |
| **.NET prerequisites** | System | `apt install libicu-dev libssl-dev zlib1g-dev` |
| **curl, git, tar, unzip** | System | `apt install` |

### What is NOT in the image
- **.NET SDK**: Downloaded at benchmark runtime from nightly feed. Different runs may test different SDK versions.
- **Sample apps**: Checked out from the repo at runtime.

### Dockerfile outline

```dockerfile
FROM ubuntu:24.04

# System packages
RUN apt-get update && apt-get install -y \
    curl git tar unzip jq python3 python3-pip \
    libicu-dev libssl-dev zlib1g-dev \
    # Playwright system dependencies
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2t64 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Node.js LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs

# V8 d8 standalone
RUN mkdir -p /opt/v8 && \
    curl -fsSL <v8-prebuilt-url> -o /tmp/d8.zip && \
    unzip /tmp/d8.zip -d /opt/v8 && \
    ln -s /opt/v8/d8 /usr/local/bin/d8

# Playwright browsers (Chrome + Firefox)
RUN npm install -g playwright && \
    npx playwright install --with-deps chromium firefox

ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
ENV DOTNET_ROOT=/opt/dotnet
ENV PATH="${DOTNET_ROOT}:${PATH}"

WORKDIR /bench
```

### Image rebuild workflow: `docker-build.yml`

```yaml
name: Docker Image
on:
  schedule:
    - cron: '0 0 * * 0'  # Weekly on Sunday
  push:
    paths: ['docker/**']
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: docker/
          push: true
          tags: ghcr.io/${{ github.repository }}/browser-bench:latest
```

---

## SDK Resolution

### Script: `scripts/resolve-sdk.sh`

Downloads .NET SDK from the nightly feed and reports version + git hash.

### Nightly feed URLs

| Channel | URL pattern |
|---------|-------------|
| .NET 10 daily | `https://aka.ms/dotnet/10.0/daily/dotnet-sdk-linux-x64.tar.gz` |
| Specific version | `https://dotnetcli.azureedge.net/dotnet/Sdk/{version}/dotnet-sdk-{version}-linux-x64.tar.gz` |

### Script behavior

```bash
#!/bin/bash
set -euo pipefail

SDK_VERSION="${1:-}"  # Optional: specific version. Empty = latest nightly.
INSTALL_DIR="${DOTNET_ROOT:-/opt/dotnet}"

if [ -z "$SDK_VERSION" ]; then
    # Download latest nightly
    curl -fsSL https://aka.ms/dotnet/10.0/daily/dotnet-sdk-linux-x64.tar.gz -o /tmp/sdk.tar.gz
else
    curl -fsSL "https://dotnetcli.azureedge.net/dotnet/Sdk/${SDK_VERSION}/dotnet-sdk-${SDK_VERSION}-linux-x64.tar.gz" -o /tmp/sdk.tar.gz
fi

mkdir -p "$INSTALL_DIR"
tar xzf /tmp/sdk.tar.gz -C "$INSTALL_DIR"
rm /tmp/sdk.tar.gz

# Extract version info
RESOLVED_VERSION=$("$INSTALL_DIR/dotnet" --version)
GIT_HASH=$("$INSTALL_DIR/dotnet" --info | grep -oP 'Commit:\s+\K[a-f0-9]+')

# Output as JSON for downstream consumption
echo "{\"sdkVersion\": \"$RESOLVED_VERSION\", \"gitHash\": \"$GIT_HASH\"}" > /tmp/sdk-info.json
cat /tmp/sdk-info.json
```

---

## Build Script

### Script: `scripts/build-app.sh`

Builds and publishes a sample app with the appropriate MSBuild flags for the given runtime + config combination.

### Parameters

```bash
./scripts/build-app.sh <app> <runtime> <config>
# Example: ./scripts/build-app.sh empty-blazor coreclr release
```

### MSBuild flags per configuration

| Config | Flags |
|--------|-------|
| `release` | `-c Release /p:RuntimeFlavor={runtime}` |
| `aot` | `-c Release /p:RuntimeFlavor=Mono /p:RunAOTCompilation=true` |
| `native-relink` | `-c Release /p:RuntimeFlavor={runtime} /p:WasmNativeRelink=true` |

### App setup per sample

| App | Setup | Publish command |
|-----|-------|----------------|
| `empty-browser` | `dotnet new web` in temp dir | `dotnet publish -o /bench/publish/{app}` |
| `empty-blazor` | `dotnet new blazorwasm` in temp dir | `dotnet publish -o /bench/publish/{app}` |
| `blazing-pizza` | `git clone --depth 1 <repo> -b <commit>` | `dotnet publish src/BlazingPizza.Client -o /bench/publish/{app}` |
| `microbenchmarks` | Already in `src/microbenchmarks/` | `dotnet publish -o /bench/publish/{app}` |

The published output directory (`/bench/publish/{app}`) is used by the measurement scripts.

---

## Measurement

### External Metrics: `scripts/measure-external.mjs`

Measures published app load characteristics using Playwright and Chrome DevTools Protocol.

```
Input:  --app <name> --publish-dir <path> --output <result.json>
Output: JSON result file with meta + external metrics
```

### Steps

```javascript
// 1. Start static HTTP server for the published app
const server = await startServer(publishDir, port);

// 2. Launch Chrome via Playwright with CDP
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

// 3. Set up CDP session for network and performance tracking
const client = await page.context().newCDPSession(page);
await client.send('Network.enable');
await client.send('Performance.enable');

// 4. Track network requests for download size
let totalDownloadSize = 0;
client.on('Network.loadingFinished', (event) => {
    totalDownloadSize += event.encodedDataLength;
});

// 5. Navigate and measure timing
await page.goto(`http://localhost:${port}`);

// 6. Extract timing via page.evaluate()
const timing = await page.evaluate(() => {
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return {
        timeToFirstRender: fcp ? fcp.startTime : null,
        timeToFirstUiChange: window.__firstMutationTime ?? null
    };
});

// 7. Get memory peak from CDP
const perfMetrics = await client.send('Performance.getMetrics');
const heapUsed = perfMetrics.metrics.find(m => m.name === 'JSHeapUsedSize');

// 8. Write result JSON
```

### First UI Change detection
The sample apps need a small injected script (or the measurement script injects it via `page.addInitScript`) that sets up a `MutationObserver`:

```javascript
// Injected into the page before navigation
const observer = new MutationObserver(() => {
    if (!window.__firstMutationTime) {
        window.__firstMutationTime = performance.now();
    }
});
observer.observe(document.body, { childList: true, subtree: true });
```

### Internal Metrics: `scripts/measure-internal.mjs`

Runs microbenchmarks on the specified engine and collects JSON output.

```
Input:  --engine <v8|node|chrome|firefox> --publish-dir <path> --output <result.json>
```

### Engine execution strategies

| Engine | Execution |
|--------|-----------|
| **V8** | `d8 --module /bench/publish/microbenchmarks/bench-driver.mjs` — stdout is JSON |
| **Node** | `node /bench/publish/microbenchmarks/bench-driver.mjs` — stdout is JSON |
| **Chrome** | Playwright launches Chrome, navigates to bench page, `page.evaluate()` extracts result JSON |
| **Firefox** | Playwright launches Firefox, navigates to bench page, `page.evaluate()` extracts result JSON |

For Chrome/Firefox: the published microbenchmarks app includes an HTML page that loads `bench-driver.mjs` as a module, runs benchmarks, and stores results on `window.__benchResults`. Playwright extracts with:

```javascript
await page.waitForFunction(() => window.__benchResults !== undefined, { timeout: 300000 });
const results = await page.evaluate(() => window.__benchResults);
```

---

## Benchmark Workflow: `benchmark.yml`

### Triggers
- **Schedule**: Daily at 04:00 UTC
- **Manual**: `workflow_dispatch` with optional inputs

### Inputs (workflow_dispatch)

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `sdk_version` | string | `""` (latest nightly) | Specific SDK version or empty for latest |
| `configurations` | choice | `all` | `all`, `release-only`, `aot-only`, `native-relink-only` |

### Matrix strategy

```yaml
strategy:
  fail-fast: false
  matrix:
    app: [empty-browser, empty-blazor, blazing-pizza, microbenchmarks]
    runtime: [coreclr, mono]
    config: [release, aot, native-relink]
    engine: [v8, node, chrome, firefox]
    exclude:
      # AOT is Mono-only
      - runtime: coreclr
        config: aot
      # External apps only measured on Chrome
      - app: empty-browser
        engine: v8
      - app: empty-browser
        engine: node
      - app: empty-browser
        engine: firefox
      - app: empty-blazor
        engine: v8
      - app: empty-blazor
        engine: node
      - app: empty-blazor
        engine: firefox
      - app: blazing-pizza
        engine: v8
      - app: blazing-pizza
        engine: node
      - app: blazing-pizza
        engine: firefox
```

### Job steps

```yaml
jobs:
  bench:
    runs-on: ubuntu-latest
    container: ghcr.io/${{ github.repository }}/browser-bench:latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - name: Resolve SDK
        id: sdk
        run: |
          ./scripts/resolve-sdk.sh "${{ inputs.sdk_version }}"
          echo "sdk_info=$(cat /tmp/sdk-info.json)" >> $GITHUB_OUTPUT

      - name: Build app
        run: ./scripts/build-app.sh ${{ matrix.app }} ${{ matrix.runtime }} ${{ matrix.config }}

      - name: Run benchmark
        run: |
          DATE=$(date -u +%Y-%m-%d)
          SDK_VERSION=$(echo '${{ steps.sdk.outputs.sdk_info }}' | jq -r .sdkVersion)
          GIT_HASH=$(echo '${{ steps.sdk.outputs.sdk_info }}' | jq -r .gitHash)
          FILENAME="${DATE}_${{ matrix.runtime }}_${{ matrix.config }}_${{ matrix.engine }}_${{ matrix.app }}.json"
          
          if [ "${{ matrix.app }}" = "microbenchmarks" ]; then
            node scripts/measure-internal.mjs \
              --engine ${{ matrix.engine }} \
              --publish-dir /bench/publish/${{ matrix.app }} \
              --sdk-version "$SDK_VERSION" \
              --git-hash "$GIT_HASH" \
              --date "$DATE" \
              --runtime ${{ matrix.runtime }} \
              --config ${{ matrix.config }} \
              --output "/tmp/results/${FILENAME}"
          else
            node scripts/measure-external.mjs \
              --app ${{ matrix.app }} \
              --publish-dir /bench/publish/${{ matrix.app }} \
              --sdk-version "$SDK_VERSION" \
              --git-hash "$GIT_HASH" \
              --date "$DATE" \
              --runtime ${{ matrix.runtime }} \
              --config ${{ matrix.config }} \
              --output "/tmp/results/${FILENAME}"
          fi

      - name: Upload result
        uses: actions/upload-artifact@v4
        with:
          name: result_${{ matrix.runtime }}_${{ matrix.config }}_${{ matrix.engine }}_${{ matrix.app }}
          path: /tmp/results/*.json
          retention-days: 7
```

---

## Consolidation Workflow: `consolidate.yml`

### Trigger
```yaml
on:
  workflow_run:
    workflows: ["Benchmark"]
    types: [completed]
```

Only runs if the benchmark workflow succeeded.

### Steps

```yaml
jobs:
  consolidate:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: gh-pages

      - uses: actions/download-artifact@v4
        with:
          run-id: ${{ github.event.workflow_run.id }}
          path: /tmp/artifacts/
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Merge results
        run: node scripts/consolidate-results.mjs /tmp/artifacts/ data/

      - name: Commit and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/
          git diff --cached --quiet || (
            git commit -m "Add benchmark results $(date -u +%Y-%m-%d)"
            git push
          )
```

### Consolidation script: `scripts/consolidate-results.mjs`

```
Input:  consolidate-results.mjs <artifacts-dir> <data-dir>
```

Logic:
1. Scan `artifacts-dir` for all `*.json` files (flattened from artifact subdirs)
2. Read existing `data-dir/manifest.json` (or create empty if first run)
3. For each result JSON:
   - Parse `meta` to get dimension values
   - Compute ISO week: `{year}/W{week}` from `meta.date`
   - Compute target path: `{data-dir}/{year}/W{week}/{filename}`
   - Create directory if needed
   - Copy file to target path
   - Build manifest entry (or replace if duplicate: same date + all dimensions)
4. Re-derive `dimensions` from full run list
5. Sort runs by date descending
6. Write updated `manifest.json`

### Conflict avoidance
- Only one consolidation job runs at a time (matrix jobs upload artifacts, consolidation runs once after all complete)
- GitHub Actions `workflow_run` guarantees single trigger per parent workflow run
- If the gh-pages push fails due to race condition (unlikely), the workflow will fail and can be manually re-run

---

## NuGet Feeds

The nightly SDK already contains built-in NuGet feed configuration. For sample apps that need NuGet packages:

| Feed | URL | Purpose |
|------|-----|---------|
| dotnet10 daily | `https://dnceng.pkgs.visualstudio.com/public/_packaging/dotnet10/nuget/v3/index.json` | Nightly .NET 10 packages |
| nuget.org | `https://api.nuget.org/v3/index.json` | Stable packages |

A `NuGet.config` in the repo root configures these feeds:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="dotnet10" value="https://dnceng.pkgs.visualstudio.com/public/_packaging/dotnet10/nuget/v3/index.json" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
```

---

## Error Handling and Retries

| Scenario | Strategy |
|----------|----------|
| SDK download fails | Retry 3 times with backoff. If still failing, fail the job. |
| App build fails | Fail the job. Likely a breaking change in nightly SDK — useful signal. |
| Playwright measurement timeout | 5 minute timeout per measurement. Fail the job on timeout. |
| Microbenchmark crash | Fail the job. Capture stderr in artifact for debugging. |
| Consolidation push conflict | Retry with `git pull --rebase` once. If still failing, fail and alert. |
| Docker image pull fails | Fall back to building from Dockerfile (slow but autonomous). |

### Failure notifications
- GitHub Actions already sends email on workflow failure (if configured).
- Future: post to a Slack/Teams channel or create a GitHub issue on repeated failures.

---

## Workflow Diagram

```
  ┌─────────────────────────────────────────────────────┐
  │                  benchmark.yml                       │
  │                                                     │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐           │
  │  │ coreclr  │ │  mono    │ │  mono    │  ...×26   │
  │  │ release  │ │  release │ │  aot     │  matrix   │
  │  │ chrome   │ │  chrome  │ │  v8      │  legs     │
  │  │ empty-bw │ │ empty-bw │ │ micro    │           │
  │  └────┬─────┘ └────┬─────┘ └────┬─────┘           │
  │       │upload       │upload      │upload            │
  │       ▼             ▼            ▼                  │
  │  [artifacts] [artifacts]  [artifacts]               │
  └─────────────────────┬───────────────────────────────┘
                        │ workflow_run (on success)
                        ▼
  ┌─────────────────────────────────────────────────────┐
  │               consolidate.yml                        │
  │                                                     │
  │  1. Download all artifacts                          │
  │  2. Checkout gh-pages                               │
  │  3. Run consolidate-results.mjs                     │
  │  4. git commit + push                               │
  └─────────────────────┬───────────────────────────────┘
                        │
                        ▼
  ┌─────────────────────────────────────────────────────┐
  │              gh-pages branch                         │
  │                                                     │
  │  data/manifest.json  (updated)                      │
  │  data/2026/W09/*.json (new results)                 │
  │  index.html + app/   (dashboard)                    │
  └─────────────────────┬───────────────────────────────┘
                        │ GitHub Pages
                        ▼
              https://<org>.github.io/simple-bench/
```

---

## Manual Re-run

To benchmark a specific SDK version (e.g., investigating a regression):

1. Go to Actions → Benchmark → Run workflow
2. Set `sdk_version` to the specific version (e.g., `10.0.100-preview.3.25130.1`)
3. Optionally limit `configurations` to narrow the matrix
4. The run will produce results tagged with that specific SDK version
5. Consolidation will add/replace data points for that date + dimensions
6. Dashboard will show the data point on the timeline

If the same date + dimensions already exist, the consolidation will **overwrite** the previous result (idempotent re-runs).
