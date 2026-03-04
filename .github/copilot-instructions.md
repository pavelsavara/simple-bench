# Agent Instructions

## Project Overview

.NET Browser WASM benchmark suite. Builds sample apps with various .NET SDK presets, then measures load time, download size, and memory in browsers/JS engines. Results are stored as JSON on `gh-pages` and visualized with a Chart.js dashboard.

Key directories:
- `src/` — sample apps (empty-browser, empty-blazor, blazing-pizza, microbenchmarks)
- `scripts/` — build, measure, and pipeline orchestration scripts (Node.js + bash)
- `scripts/lib/` — shared utilities (build-config, sdk-info, measure-utils, metrics)
- `tests/unit/` — unit tests (Node.js test runner)
- `docker/` — multi-stage Dockerfile (build image + measure image)
- `artifacts/` — gitignored build outputs, SDK, results

## Running Tests

### A) With Node.js (unit tests — no Docker needed)

Prerequisites: Node.js >= 24

```bash
# Install dependencies
npm ci

# Run all unit tests
npm test

# Run a single test file
node --test tests/unit/build-config.test.mjs
node --test tests/unit/measure-utils.test.mjs

# Run tests matching a name pattern
node --test --test-name-pattern "compile time" tests/unit/measure-utils.test.mjs
```

Test files:
- `build-config.test.mjs` — MSBuild preset → flag mapping
- `sdk-info.test.mjs` — SDK version parsing, commit hash extraction
- `measure-utils.test.mjs` — static server, file sizes, result JSON, compile time reader
- `metrics.test.mjs` — metrics registry validation
- `consolidate-results.test.mjs` — month index merge, dedup, daily sharding
- `data-loader.test.mjs` — month index filtering, data caching
- `filters.test.mjs` — filter state, URL hash parsing
- `measure-internal.test.mjs` — internal benchmark measurement
- `migrate-old-data.test.mjs` — old schema migration
- `runtime-pack-resolver.test.mjs` — runtime pack resolution, date decoding, VMR commit mapping
- `schedule-benchmarks.test.mjs` — gap detection for benchmark scheduling

### B) With Docker (full CI pipeline simulation)

Prerequisites: Docker

The `scripts/local-docker-bench.sh` script simulates the CI benchmark pipeline locally. It uses two Docker images:
- **browser-bench-build** — Ubuntu + Node.js + .NET SDK prerequisites (builds apps)
- **browser-bench-measure** — Ubuntu + Node.js + V8/d8 + Playwright + Chrome + Firefox (runs benchmarks)

```bash
# Full run: build images → build apps → measure
./scripts/local-docker-bench.sh

# Skip Docker image rebuild (reuse cached images)
./scripts/local-docker-bench.sh --skip-docker

# Skip build and measure only (reuse existing artifacts/publish/)
./scripts/local-docker-bench.sh --skip-docker --skip-build

# Run a single step
./scripts/local-docker-bench.sh --step docker-build
./scripts/local-docker-bench.sh --step build
./scripts/local-docker-bench.sh --step measure

# Fast mode: chrome only (like PR validation)
./scripts/local-docker-bench.sh --dry-run

# Measure only one app/preset combination
./scripts/local-docker-bench.sh --skip-docker --skip-build --app empty-browser --preset debug

# Use a specific SDK version
./scripts/local-docker-bench.sh --sdk-version 11.0.100-preview.3.26062.1
```

#### Typical development loop

1. First run — build everything:
   ```bash
   ./scripts/local-docker-bench.sh --dry-run
   ```

2. After changing measurement scripts — re-measure only:
   ```bash
   ./scripts/local-docker-bench.sh --skip-docker --skip-build --dry-run
   ```

3. After changing build scripts or .csproj files — rebuild + measure:
   ```bash
   ./scripts/local-docker-bench.sh --skip-docker --dry-run
   ```

4. After changing Dockerfile — full rebuild:
   ```bash
   ./scripts/local-docker-bench.sh
   ```

#### Outputs

- `artifacts/sdk/sdk-info.json` — resolved SDK version and git hashes
- `artifacts/publish/{app}/{preset}/` — published app binaries
- `artifacts/results/*.json` — benchmark result JSONs

## Building a single app manually

```bash
# With .NET SDK installed locally
cd src/empty-browser
dotnet publish /p:BenchmarkPreset=Debug

# Inside the build container
docker run --rm -v "$PWD:/bench" -w /bench browser-bench-build:latest \
    bash scripts/build-app.sh empty-browser mono debug
```

## CI Workflows

- `.github/workflows/benchmark.yml` — daily benchmark: build job → measure matrix → consolidate
- `.github/workflows/docker-build.yml` — weekly Docker image rebuild (two parallel jobs)
- `.github/workflows/test.yml` — unit tests on PR/push
- `.github/workflows/consolidate.yml` — merge results into gh-pages branch
