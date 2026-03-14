# Pipeline Stages

The bench CLI executes a sequence of stages. Each stage receives a `BenchContext` and returns an updated one. Stages are registered in `bench/src/stages/index.ts` and dispatched sequentially.

## Stage List

| # | Stage | Container | Description |
|---|-------|-----------|-------------|
| 1 | `check-out-cache` | host | Checkout gh-pages branch, seed artifacts from cache |
| 2 | `docker-image` | host | Build Docker images if missing |
| 3 | `enumerate-commits` | build | Fetch dotnet/runtime commit history from GitHub API |
| 4 | `enumerate-daily-packs` | build | Discover nightly NuGet packs, resolve git hashes |
| 5 | `enumerate-release-packs` | build | Discover GA release packs, resolve git hashes |
| 6 | `update-cache` | build | Copy pack/commit lists back to gh-pages/cache, push |
| 7 | `schedule` | measure | Dispatch GitHub Actions for untested SDK versions |
| 8 | `resolve-sdk` | build | Resolve target pack from pack catalogs, build SdkInfo |
| 9 | `download-sdk` | build | Download SDK via dotnet-install, detect bundled runtime |
| 10 | `build` | build | `dotnet publish` for each app×preset combination |
| 11 | `measure` | measure | Browser/CLI measurement via Playwright/d8/node |
| 12 | `transform-views` | measure | Build/update pivot views from `artifacts/results` |
| 13 | `update-views` | host | Commit and push data/ to gh-pages |

## Default Pipeline

When invoked without `--stages`, the default stages are:

```
resolve-sdk → download-sdk → build → measure → transform-views
```

The CI workflow (`benchmark.yml`) runs the full pipeline:

```
check-out-cache → docker-image → enumerate-daily-packs → enumerate-release-packs →
update-cache → resolve-sdk → download-sdk → build → measure → transform-views → update-views
```

## Docker Container Architecture

When `--via-docker` is set (default on Linux CI), stages are classified into three targets:

| Target | Docker Image | Stages |
|--------|-------------|--------|
| **host** | (none — runs directly) | check-out-cache, docker-image, update-views |
| **build** | `browser-bench-build` | enumerate-*, update-cache, resolve-sdk, download-sdk, build |
| **measure** | `browser-bench-measure` | measure, transform-views, schedule |

Consecutive stages with the same target are **batched** into a single container invocation. Context is serialized to `artifacts/docker-context.json` for cross-container handoff.

The measure container runs as non-root (uid from host or 1001) because Firefox requires it.

### Docker Images

Both images derive from a common `base` stage (Ubuntu 24.04 + Node 24 + tsx):

- **browser-bench-build**: Adds .NET SDK prerequisites, emscripten, cmake. Used for SDK installation and app compilation.
- **browser-bench-measure**: Adds Playwright browsers (Chromium + Firefox), V8 d8 (via jsvu). Used for running measurements.

## Stage Details

### 1. check-out-cache

Ensures `gh-pages/` is checked out locally. Seeds `artifacts/` with cached pack lists from `gh-pages/cache/` (only copies files that don't already exist in artifacts).

Files seeded: `daily-packs-list.json`, `release-packs-list.json`, `commits-list.json`.

### 2. docker-image

Builds the Docker images if they don't exist. Skipped inside containers or with `--skip-docker-build`. Uses `--force-docker-build` to rebuild unconditionally.

### 3. enumerate-commits

Fetches dotnet/runtime commit history from GitHub API for the configured lookback window (`--months`, default 3). Writes `artifacts/commits-list.json`. Supports incremental updates — fetches only one page of recent commits when an existing file is found.

### 4. enumerate-daily-packs

Discovers nightly runtime pack versions from the Azure DevOps NuGet feed (`dnceng/public`). For each version:

1. Derives SDK version (e.g., `11.0.0-preview.3.26153.117` → `11.0.100-preview.3.26153.117`)
2. Validates SDK zip exists on CDN
3. Fetches `productCommit-win-x64.json` to get VMR commit
4. Reads `source-manifest.json` from VMR to resolve runtime/aspnetcore/sdk git hashes
5. Reads `global.json` from VMR to get bootstrap SDK version
6. Fetches commit datetimes from GitHub API

Writes `artifacts/daily-packs-list.json`. Supports incremental updates.

### 5. enumerate-release-packs

Discovers GA releases from the official .NET releases index (`dotnetcli.blob.core.windows.net`). For each release:

1. Fetches `productCommit` from CDN
2. Detects VMR vs pre-VMR topology
3. For VMR (.NET 10+): reads `source-manifest.json`, handles 2xx/3xx band indirection via `Version.Details.xml`
4. For pre-VMR (.NET 8/9): uses productCommit hashes directly
5. Resolves commit datetimes from GitHub API

Writes `artifacts/release-packs-list.json`. Supports incremental updates.

### 6. update-cache

Copies `daily-packs-list.json`, `release-packs-list.json`, and `commits-list.json` from artifacts back to `gh-pages/cache/`, then commits and pushes.

### 7. schedule

Compares pack lists against already-tested SDK versions in `gh-pages/data/`. For each untested pack, dispatches a `benchmark.yml` workflow via `gh workflow run`. Priority: releases oldest→newest, then daily builds latest→oldest. Limited by `--max-dispatches`.

### 8. resolve-sdk

Resolves which SDK to target based on `--runtime-commit`, `--runtime-pack`, `--sdk-version`, or latest for the configured channel. Loads pack catalogs from `daily-packs-list.json` and `release-packs-list.json`, resolves the target pack, builds `SdkInfo` (including `source: 'daily' | 'release'`), and computes SDK paths.

### 9. download-sdk

Downloads the SDK resolved by `resolve-sdk` via official dotnet-install scripts. Daily builds use the Azure feed (`ci.dot.net/public`); release builds use the default feed. After installation, detects the bundled runtime pack version and restores an override runtime pack if needed. Writes `sdk-info.json`.

### 10. build

Two-phase build process:

1. **Phase A (non-workload presets)**: Builds apps with presets that don't require wasm-tools workload (e.g., `no-workload`). Validates wasm-tools is NOT pre-installed.
2. **Workload install**: Installs the wasm-tools workload.
3. **Phase B (workload presets)**: Builds apps with presets that require the workload (e.g., `aot`, `native-relink`).

Each app×preset combination runs `dotnet publish` with MSBuild properties from `PRESET_MAP` and configuration from `PRESET_CONFIG`. Records compile time and file integrity.

Writes `build-manifest.json` and `sdk-info.json` to `artifacts/results/{runId}/`.

### 11. measure

Iterates the build manifest. For each entry × engine × profile:

**Browser engines (Chrome, Firefox via Playwright):**
1. Start static HTTP server with COOP/COEP headers
2. Measure file sizes (walk `_framework/` directory)
3. Launch browser, set up CDP (Chrome only: Network + Performance domains)
4. Apply throttle profile (mobile: 3× CPU slowdown + 20 Mbps network)
5. Cold load: navigate, wait for `dotnet_managed_ready` or page load
6. Warm loads: reload N times (default 3), take minimum time
7. Track: download-size-total (sum of `encodedDataLength`), memory-peak (poll `JSHeapUsedSize`), timing

**CLI engines (V8 d8, Node):**
1. Find `main.js` in publish directory
2. Run: `d8 --module main.js` or `node main.js`
3. Parse stdout JSON for `time-to-reach-managed`

**Special handling:**
- `blazing-pizza` app: scripted walkthrough for `pizza-walkthrough` metric
- `havit-bootstrap` app:scripted walkthrough for `havit-walkthrough` metric
- `mud-blazor` app:scripted walkthrough for `mud-walkthrough` metric
- `micro-benchmarks` app: multiple sample runs, reports ops/sec using median
- Firefox: no CDP, so no download-size-total or memory-peak

### 12. transform-views

Reads result JSON files from `artifacts/results/` and builds/updates the published pivot views in `gh-pages/data/views/`.

The stage:
- Loads the current run's result files directly from `artifacts/results/`
- Merges them with any existing bucket data already present under `gh-pages/data/views/`
- Splits results into **daily builds** (SDK version has prerelease tag) vs **GA releases** (stable SDK version)
- Daily builds: only the highest-major daily builds go into **week views** (ISO week boundaries); lower-major dailies are filtered out
- GA releases: bucketed by **major version** into release views (e.g., `net9`, `net10`)
- For each bucket, builds pivot grid: app → metric → rowKey → values[]
- Writes `header.json` + `{app}_{metric}.json` data files
- Writes `data/views/index.json`

### 13. update-views

Commits and pushes `gh-pages/data/views/` after `transform-views`. Skipped in dry-run mode.

## CI Workflows

### benchmark.yml (Daily, 04:00 UTC)

Three jobs:

1. **build** — Runs in `browser-bench-build` container: enumerate packs, resolve SDK, download SDK, build apps
2. **measure** (matrix: desktop + mobile profiles) — Runs in `browser-bench-measure` container: measure all engine×profile combinations
3. **aggregate** — Runs on host: transform-views, update-views (push to gh-pages)

Accepts `sdk_version` input for targeting specific versions (used by schedule dispatches).

### docker-build.yml (Weekly, Sunday)

Builds and pushes Docker images to `ghcr.io`. Triggered weekly or on Dockerfile changes.

### schedule.yml (Manual)

Runs enumerate stages + schedule stage to dispatch benchmark runs for any untested SDK versions.
