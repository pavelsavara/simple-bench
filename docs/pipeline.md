# Pipeline: CI, Docker, Measurement, and Result Publishing

## Overview

Three GitHub Actions workflows orchestrate the benchmarking:

1. **benchmark.yml** — builds apps (build job) then measures them (matrix measure jobs) daily (or on-demand)
2. **consolidate.yml** — merges results into gh-pages branch
3. **docker-build.yml** — builds/publishes the Docker image
4. **test.yml** — runs unit + E2E tests on PR/push

All benchmark steps run inside Docker containers. The **build** job uses `browser-bench-build` (contains .NET SDK prerequisites). The **measure** matrix jobs use `browser-bench-measure` (contains browsers, V8, Playwright). Build artifacts are passed between jobs via GitHub Actions artifact upload/download.

All build outputs and temp files go to `artifacts/` (gitignored):
- `artifacts/sdk/` — downloaded .NET SDK
- `artifacts/publish/{app}/` — dotnet publish output
- `artifacts/results/` — benchmark result JSONs
- `artifacts/logs/` — build and measurement logs

---

## Docker Images

The pipeline uses two separate Docker images built from a single multi-stage `docker/Dockerfile`. This keeps image sizes small and separates build-time concerns (.NET SDK prerequisites) from measurement-time concerns (browsers, JS engines).

### Dockerfile location: `docker/Dockerfile`

### Base stage: `base`
Shared foundation for both images: `ubuntu:24.04` + Node.js 24.x + common system utilities (curl, git, tar, unzip, jq, python3).

### Image 1: `ghcr.io/<org>/browser-bench-build:latest`
Used by the **build** job. Contains .NET SDK native prerequisites for compiling WASM apps.

| Component | Version strategy | Install method |
|-----------|-----------------|----------------|
| **Ubuntu** | `24.04` | Base stage |
| **Node.js** | Pinned major (24.x) | Base stage (NodeSource apt repo) |
| **jq, curl, git, tar, unzip** | System | Base stage |
| **.NET prerequisites** | System | `apt install libicu-dev libssl-dev zlib1g-dev libatomic1` |

npm dependencies: none (build scripts use only Node.js built-ins + local modules).

### Image 2: `ghcr.io/<org>/browser-bench-measure:latest`
Used by the **measure** matrix jobs. Contains JS engines and browsers for running benchmarks.

| Component | Version strategy | Install method |
|-----------|-----------------|----------------|
| **Ubuntu** | `24.04` | Base stage |
| **Node.js** | Pinned major (24.x) | Base stage (NodeSource apt repo) |
| **jq, curl, git, tar, unzip** | System | Base stage |
| **V8 (`d8`)** | Pinned jsvu version | `npm install -g jsvu@3.0.3` |
| **Playwright** | Exact version (matches `docker/package-measure.json`) | `npm install playwright@1.58.2` |
| **Chrome** | Pinned via Playwright version | `npx playwright install --with-deps chromium` |
| **Firefox** | Pinned via Playwright version | `npx playwright install --with-deps firefox` |

npm dependencies: `playwright` (from `docker/package-measure.json`).

> **Version pinning policy**: All tool versions that can influence benchmark measurements are pinned to exact versions. Playwright pins the exact Chromium/Firefox builds, so updating Playwright is the single control point for browser engine changes. Bumps should be done intentionally via PR with the expectation that timing metrics may shift.

### What is NOT in the images
- **.NET SDK**: Downloaded at benchmark runtime from nightly feed. Different runs may test different SDK versions.
- **Sample apps**: Checked out from the repo at runtime.
- **Browsers/V8**: Not in the build image (not needed for compilation).
- **.NET native libs**: Not in the measure image (not needed for running benchmarks).

### Dockerfile outline (multi-stage)

```dockerfile
# ── Shared base ──────────────────────────────────────────
FROM ubuntu:24.04 AS base
RUN apt-get update && apt-get install -y \
    curl git tar unzip jq python3 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 ARTIFACTS_DIR=/bench/artifacts
RUN mkdir -p $ARTIFACTS_DIR/sdk $ARTIFACTS_DIR/publish $ARTIFACTS_DIR/results $ARTIFACTS_DIR/logs
WORKDIR /bench

# ── Build image ──────────────────────────────────────────
FROM base AS browser-bench-build
RUN apt-get update && apt-get install -y \
    libicu-dev libssl-dev zlib1g-dev libatomic1 \
    && rm -rf /var/lib/apt/lists/*
ENV DOTNET_ROOT=/opt/dotnet PATH="/opt/dotnet:${PATH}"
COPY docker/package-build.json ./package.json
RUN npm install --omit=dev && rm -rf /root/.npm

# ── Measure image ────────────────────────────────────────
FROM base AS browser-bench-measure
RUN apt-get update && apt-get install -y \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2t64 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g jsvu@3.0.3 && jsvu --os=linux64 --engines=v8 \
    && ln -s /root/.jsvu/bin/v8 /usr/local/bin/d8
COPY docker/package-measure.json ./package.json
RUN npm install --omit=dev && rm -rf /root/.npm
RUN npx playwright install --with-deps chromium firefox
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
```

### Image rebuild workflow: `docker-build.yml`

Builds both images in **parallel jobs**, each with registry-based layer caching.

```yaml
name: Docker Image
on:
  schedule:
    - cron: '0 0 * * 0'  # Weekly on Sunday
  push:
    paths: ['docker/**']
  workflow_dispatch:

jobs:
  build-image:
    runs-on: ubuntu-latest
    permissions: { packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: '${{ github.actor }}', password: '${{ secrets.GITHUB_TOKEN }}' }
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/Dockerfile
          target: browser-bench-build
          push: true
          tags: ghcr.io/${{ github.repository }}/browser-bench-build:latest
          cache-from: type=registry,ref=ghcr.io/${{ github.repository }}/browser-bench-build:cache
          cache-to: type=registry,ref=ghcr.io/${{ github.repository }}/browser-bench-build:cache,mode=max

  measure-image:
    runs-on: ubuntu-latest
    permissions: { packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: '${{ github.actor }}', password: '${{ secrets.GITHUB_TOKEN }}' }
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/Dockerfile
          target: browser-bench-measure
          push: true
          tags: ghcr.io/${{ github.repository }}/browser-bench-measure:latest
          cache-from: type=registry,ref=ghcr.io/${{ github.repository }}/browser-bench-measure:cache
          cache-to: type=registry,ref=ghcr.io/${{ github.repository }}/browser-bench-measure:cache,mode=max
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
INSTALL_DIR="${ARTIFACTS_DIR:-/bench/artifacts}/sdk"

if [ -z "$SDK_VERSION" ]; then
    # Download latest nightly
    curl -fsSL https://aka.ms/dotnet/10.0/daily/dotnet-sdk-linux-x64.tar.gz -o /tmp/sdk.tar.gz
else
    curl -fsSL "https://dotnetcli.azureedge.net/dotnet/Sdk/${SDK_VERSION}/dotnet-sdk-${SDK_VERSION}-linux-x64.tar.gz" -o /tmp/sdk.tar.gz
fi

mkdir -p "$INSTALL_DIR"
tar xzf /tmp/sdk.tar.gz -C "$INSTALL_DIR"
rm /tmp/sdk.tar.gz

# Add to PATH for this session
export DOTNET_ROOT="$INSTALL_DIR"
export PATH="$INSTALL_DIR:$PATH"

# Extract version info and resolve git hashes
# See scripts/resolve-sdk.sh for full algorithm:
# 1. Gets SDK commit (vmrGitHash) and Host commit from `dotnet --info`
# 2. Fetches source-manifest.json from VMR to resolve sdkGitHash and runtimeGitHash
# 3. Falls back to SDK_COMMIT/HOST_COMMIT if not a VMR build
RESOLVED_VERSION=$("$INSTALL_DIR/dotnet" --version)
# ... (hash resolution logic) ...
echo '{"sdkVersion":"...","runtimeGitHash":"...","sdkGitHash":"...","vmrGitHash":"...","commitDate":"...","commitTime":"..."}' > /tmp/sdk-info.json
cat /tmp/sdk-info.json
```

After the wasm-tools workload is installed (by `run-pipeline.mjs`), the `workloadVersion` field is added to `sdk-info.json`:

```json
{
  "sdkVersion": "11.0.100-preview.3.26062.1",
  "runtimeGitHash": "...",
  "sdkGitHash": "...",
  "vmrGitHash": "...",
  "commitDate": "2026-03-03",
  "commitTime": "04-00-00-UTC",
  "workloadVersion": "11.0.0-preview.3.26062.1"
}
```

---

## Build Script

### Script: `scripts/build-app.sh`

Builds and publishes a sample app with the appropriate MSBuild flags for the given runtime + preset combination.

### Parameters

```bash
./scripts/build-app.sh <app> <runtime> <preset>
# Example: ./scripts/build-app.sh empty-blazor coreclr no-workload
```

### MSBuild presets

All build configuration is driven by two custom properties passed to `dotnet publish`:
- **`/p:BenchmarkPreset=<value>`** — selects the preset (sets `Configuration` + feature flags in the csproj)
- **`/p:RuntimeFlavor=<value>`** — selects CoreCLR or Mono

The csproj maps `BenchmarkPreset` to the standard `Configuration` (Release/Debug) and any feature flags:

| Preset dimension | `BenchmarkPreset` | `Configuration` (set by csproj) | Feature flags (set by csproj) |
|-----------------|--------------------------|-------------------------------|-------------------------------|
| `no-workload` | `NoWorkload` | `Release` | _(none)_ |
| `aot` | `Aot` | `Release` | `RunAOTCompilation=true` |
| `native-relink` | `NativeRelink` | `Release` | `WasmNativeRelink=true` |
| `invariant` | `Invariant` | `Release` | `InvariantGlobalization=true` |
| `no-reflection-emit` | `NoReflectionEmit` | `Release` | `_WasmNoReflectionEmit=true` |
| `debug` | `Debug` | `Debug` | _(none)_ |

The `obj/` and `bin/` directories are redirected to `artifacts/` via `<ArtifactsPath>` to keep the source tree clean.

The build script records wall-clock **compile time** (start to end of `dotnet publish`) and writes it to `artifacts/results/compile-time.json` for inclusion in the final result JSON.

### App setup per sample

| App | Setup | Publish command |
|-----|-------|----------------|
| `empty-browser` | `dotnet new web` in temp dir | `dotnet publish -o artifacts/publish/{app}` |
| `empty-blazor` | `dotnet new blazorwasm` in temp dir | `dotnet publish -o artifacts/publish/{app}` |
| `blazing-pizza` | `git clone --depth 1 <repo> -b <commit>` | `dotnet publish src/BlazingPizza.Client -o artifacts/publish/{app}` |
| `microbenchmarks` | Already in `src/microbenchmarks/` | `dotnet publish -o artifacts/publish/{app}` |

The published output directory (`artifacts/publish/{app}`) is used by the measurement scripts.

---

## Measurement

### External Metrics: `scripts/measure-external.mjs`

Measures published app load characteristics using Playwright and Chrome DevTools Protocol.

```
Input:  --app <name> --publish-dir <path> --output <result.json>
Output: JSON result file with meta + external metrics (compile-time, disk-size-total/wasm/dlls, download-size-total, time-to-reach-managed, time-to-reach-managed-cold, memory-peak)
```

Note: `compile-time` is not measured by this script — it is read from `artifacts/results/compile-time.json` (produced by `build-app.sh`) and merged into the final result JSON.

### Steps

```javascript
// 1. Start static HTTP server with COOP/COEP headers (built-in node:http)
const srv = await startStaticServer(publishDir); // auto-assigns port
// All responses include:
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp

// 2. Read file-system sizes: wasm + dlls (uncompressed, from publish dir)
const fileSizes = await measureFileSizes(publishDir);
// fileSizes.wasmSize — total bytes of *.wasm files in _framework/
// fileSizes.dllsSize — total bytes of *.dll files in _framework/

// 3. Launch Chrome via Playwright with CDP
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const client = await context.newCDPSession(page);
await client.send('Network.enable');
await client.send('Performance.enable');

// 4. Track compressed download size via CDP
let downloadSizeTotal = 0;
client.on('Network.loadingFinished', (evt) => {
    downloadSizeTotal += evt.encodedDataLength; // compressed bytes over wire
});

// 5. Start periodic memory sampling (every 100ms, track peak JSHeapUsedSize)
let memoryPeak = 0;
const memoryPoller = startMemorySampling(client, (value) => {
    if (value > memoryPeak) memoryPeak = value;
});

// 6. Cold load — first navigation
await page.goto(url, { timeout, waitUntil: 'load' });
await page.waitForFunction(
    () => globalThis.dotnet_managed_ready !== undefined,
    { timeout }
);
const coldTime = await page.evaluate(() => globalThis.dotnet_managed_ready);

// 7. Warm loads — 3 reloads, take minimum
let warmMin = Infinity;
for (let i = 0; i < 3; i++) {
    await page.reload({ timeout, waitUntil: 'load' });
    await page.waitForFunction(
        () => globalThis.dotnet_managed_ready !== undefined,
        { timeout }
    );
    const warm = await page.evaluate(() => globalThis.dotnet_managed_ready);
    if (warm < warmMin) warmMin = warm;
}

// 8. Let memory settle, stop sampling, write result JSON
await sleep(2000);
stopMemorySampling(memoryPoller);
```

### Size measurement strategy

| Metric | Source | Why |
|--------|--------|-----|
| `disk-size-total` | `fs.stat` sum of all files in publish dir | Tracks total published bundle size |
| `disk-size-wasm` | `fs.stat` on `*.wasm` in `_framework/` | Tracks code size changes (uncompressed) |
| `disk-size-dlls` | `fs.stat` on `*.dll` in `_framework/` | Tracks managed assembly size (uncompressed) |
| `download-size-total` | CDP `encodedDataLength` sum | Reflects real-world download cost (compressed) |

### Reach-Managed detection

Two timing markers are set during app startup:

1. **`dotnet_ready`** — JS-side marker set in `main.mjs` just before `dotnet.run()`. Measures time from navigation to WASM bootstrap completion.
2. **`dotnet_managed_ready`** — C#-side marker set in `Program.cs` via `[JSImport]` interop. Measures time from navigation to actual managed code execution.

```javascript
// main.mjs:
globalThis.dotnet_ready = performance.now();
await dotnet.run();

// Program.cs (via JSImport interop):
Interop.SetGlobalProperty("dotnet_managed_ready", Interop.GetTimestamp());
```

The measurement script uses `dotnet_managed_ready` for the time-to-reach-managed metrics:
- **Cold**: measured on first navigation (no cache)
- **Warm**: minimum of 3 reloads (browser caches active)

### Memory peak measurement
CDP `JSHeapUsedSize` is sampled every 100ms during the entire measurement (cold + warm loads + 2s settle time). The maximum observed value is reported as `memory-peak`.

### Retry strategy
Only **timeout errors** trigger a retry (configurable, default 2 retries). Navigation failures and other errors fail immediately.

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
| `presets` | choice | `all` | `all`, `no-workload-only`, `aot-only`, `native-relink-only` |

### Two-job pipeline (build + measure matrix)

The benchmark workflow uses two separate jobs with distinct Docker images:

**Job 1 — `build`** (container: `browser-bench-build`):  
Executes `scripts/run-pipeline.mjs --build-only` which:
1. Installs the .NET SDK once
2. Validates that wasm-tools workload is **not** pre-installed
3. Builds all apps × non-workload presets (`debug`, `no-workload`)
4. Installs the wasm-tools workload, captures its version in `sdk-info.json`
5. Builds all apps × workload presets (`aot`, `invariant`, `native-relink`, `no-jiterp`, `no-reflection-emit`)
6. Outputs a matrix JSON and uploads build artifacts

**Job 2 — `measure`** (container: `browser-bench-measure`):  
Runs as a matrix strategy over app × preset combinations. Each job:
1. Downloads the published binaries + sdk-info from Job 1
2. Runs `scripts/run-measure-job.mjs` for all applicable engines
3. Uploads result JSONs

Apps are auto-discovered from `src/` (any directory containing a `.csproj`).

### Job definitions

```yaml
jobs:
  # Job 1: Build all apps (browser-bench-build image)
  build:
    runs-on: ubuntu-latest
    container: ghcr.io/${{ github.repository }}/browser-bench-build:latest
    timeout-minutes: 60
    outputs:
      matrix: ${{ steps.build.outputs.matrix }}
    steps:
      - uses: actions/checkout@v4
      - name: Build all apps (continue on failure)
        id: build
        run: |
          MATRIX=$(node scripts/run-pipeline.mjs --build-only ...)
          echo "matrix=$MATRIX" >> "$GITHUB_OUTPUT"
      - uses: actions/upload-artifact@v4  # sdk-info
      - uses: actions/upload-artifact@v4  # builds

  # Job 2: Measure (browser-bench-measure image, matrix strategy)
  measure:
    needs: build
    runs-on: ubuntu-latest
    container: ghcr.io/${{ github.repository }}/browser-bench-measure:latest
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        include: ${{ fromJSON(needs.build.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v4  # sparse: scripts/ + package.json
      - uses: actions/download-artifact@v4  # sdk-info + builds
      - run: node scripts/run-measure-job.mjs --app ... --preset ...
      - uses: actions/upload-artifact@v4  # results
```

### Pipeline orchestrator: `scripts/run-pipeline.mjs`

The orchestrator handles sequencing and validates that workload-dependent builds
only run after the workload is installed. Key features:

- **Workload validation**: Before non-workload builds, asserts `dotnet workload list` does NOT show wasm-tools
- **Workload version capture**: After installing wasm-tools, parses the version from `dotnet workload list` and writes it to `sdk-info.json` as `workloadVersion`
- **App discovery**: Scans `apps/` directory for subdirectories containing `.csproj` files
- **Preset grouping**: Uses `getPresetGroups()` from `build-config.mjs` to split presets into non-workload and workload groups
- **Dry-run mode**: `--dry-run` flag skips measurement phase (useful for build-only CI validation)

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
2. Read existing `data-dir/index.json` (or create empty if first run)
3. For each result JSON:
   - Parse `meta` to get `commitDate`, `commitTime`, `runtimeGitHash`, `sdkGitHash`, `vmrGitHash`, dimension values
   - Compute target directory: `{data-dir}/{year}/{commitDate}/`
   - Compute filename: `{commitTime}_{runtimehash7}_{runtime}_{preset}_{engine}_{app}.json`
   - Create directory if needed
   - Copy file to target path
   - Compute month key `YYYY-MM` from `commitDate`
   - Load or create month index `{data-dir}/{YYYY-MM}.json`
   - Find or create commit entry in month index (by `runtimeGitHash`)
   - Add/replace result entry (same dimensions = replace)
4. For each modified month index: sort commits by date+time, write `{YYYY-MM}.json`
5. Update `index.json`: re-derive `months[]`, `dimensions`, `lastUpdated`
6. Write `index.json`

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
| Playwright measurement timeout | 5 minute timeout per measurement. Retry up to 3 times with fresh browser context before failing the job (inspired by radekdoulik/bench-results bootstrap retry + hard timeout pattern). |
| Microbenchmark crash | Fail the job. Capture stderr in artifact for debugging. |
| Consolidation push conflict | Retry with `git pull --rebase` once. If still failing, fail and alert. |
| Docker image pull fails | Fall back to building from Dockerfile (slow but autonomous). |

### Failure notifications
- GitHub Actions already sends email on workflow failure (if configured).
- Future: post to a Slack/Teams channel or create a GitHub issue on repeated failures.

---

## Test Workflow: `test.yml`

### Triggers
- Push to main branch
- Pull requests

### Steps

```yaml
name: Tests
on:
  push:
    branches: [main]
  pull_request:

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: node --test tests/unit/

  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test tests/e2e/
```

### GitHub API integration for CI verification

The `tests/e2e/helpers/gh-api.mjs` helper uses `@octokit/rest` (or the `gh` CLI) to programmatically check CI status. This enables:
- Verifying that a benchmark workflow run completed successfully
- Checking that artifacts were uploaded
- Confirming that the consolidation job updated the gh-pages branch

```javascript
// tests/e2e/helpers/gh-api.mjs
import { Octokit } from '@octokit/rest';

export async function getLatestWorkflowRun(owner, repo, workflowName) {
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const { data } = await octokit.actions.listWorkflowRuns({
        owner, repo,
        workflow_id: workflowName,
        per_page: 1
    });
    return data.workflow_runs[0];
}

export async function getRunArtifacts(owner, repo, runId) {
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const { data } = await octokit.actions.listWorkflowRunArtifacts({
        owner, repo,
        run_id: runId
    });
    return data.artifacts;
}
```

This is used in E2E tests to verify the full pipeline works after deployment.

---

## Workflow Diagram

```
  ┌─────────────────────────────────────────────────────┐
  │           benchmark.yml — Job 1: build              │
  │     container: browser-bench-build:latest            │
  │                                                     │
  │  1. Install SDK + workload                          │
  │  2. Build all apps × presets                         │
  │  3. Upload sdk-info + publish artifacts              │
  └─────────────────────────┬───────────────────────────┘
                        │ artifacts: sdk-info + builds
                        ▼
  ┌─────────────────────────────────────────────────────┐
  │      benchmark.yml — Job 2: measure (matrix)        │
  │     container: browser-bench-measure:latest          │
  │                                                     │
  │  For each app × preset:                              │
  │    1. Download sdk-info + published app              │
  │    2. Run measurements (all engines)                 │
  │    3. Upload result JSONs                            │
  └─────────────────────┬───────────────────────────────┘
                        │ upload all results
                        ▼
  [results-{app}-{preset}]
                        │ workflow_run (on success)
                        ▼
  ┌─────────────────────────────────────────────────────┐
  │               consolidate.yml                       │
  │                                                     │
  │  1. Download all result artifacts                   │
  │  2. Checkout gh-pages                               │
  │  3. Run consolidate-results.mjs                     │
  │  4. git commit + push                               │
  └─────────────────────┬───────────────────────────────┘
                        │
                        ▼
  ┌─────────────────────────────────────────────────────┐
  │              gh-pages branch                        │
  │                                                     │
  │  data/index.json          (updated)                 │
  │  data/2026-03.json         (month index, updated)   │
  │  data/2026/2026-03-02/*.json (new results)          │
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
