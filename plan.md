# Plan: .NET Browser WASM Benchmark Suite

## Current: CI Fix (2026-03-04)

### Issues from run [#22669524404](https://github.com/pavelsavara/simple-bench/actions/runs/22669524404/job/65709714125)

1. **dotnet-install stdout polluting `$GITHUB_OUTPUT`** — `run()` in `run-pipeline.mjs` used `stdio: 'inherit'`, so child processes sent `dotnet-install:` messages to stdout, captured in `$MATRIX`. Fixed by redirecting child stdout to stderr: `stdio: ['inherit', process.stderr, 'inherit']`.

2. **`ERR_PACKAGE_PATH_NOT_EXPORTED` for `@actions/artifact`** — `@actions/artifact` v2+ is ESM-only; `require()` fails on Node 24. Fixed by converting heredoc to `node --input-type=module` with ESM `import` statements.

Status: ✅ Complete — all 241 unit tests pass

---

## Overview

A benchmarking solution that measures .NET Browser/WASM performance (CoreCLR + Mono) across multiple sample apps, engines, and build configurations. Results stored as daily-sharded JSON on `gh-pages` (organized by commit date, indexed by month), visualized with a Chart.js dashboard, collected via GitHub Actions.

## Design Documents

| Document | Description |
|----------|-------------|
| [model.md](model.md) | Data dimensions, metric definitions, JSON schemas, file naming, directory layout, index structure |
| [views.md](views.md) | Dashboard UI pages from user perspective — navigation, charts, filters, interactions |
| [pipeline.md](pipeline.md) | CI pipeline: GitHub Actions workflows, Docker image, Playwright measurement, SDK resolution, result commits |
| [ui.md](ui.md) | Dashboard JavaScript implementation — modules, data loading, Chart.js config, filter logic |
| [migration.md](migration.md) | Old → new schema mapping for importing WasmPerformanceMeasurements historical data |

## Repo Structure

```
simple-bench/
├── .github/
│   └── workflows/
│       ├── benchmark.yml           # Daily benchmark runs (matrix of configs)
│       ├── consolidate.yml         # Merge results to gh-pages branch
│       ├── docker-build.yml        # Build/push Docker image to ghcr.io
│       └── test.yml                # Unit + E2E tests on PR and push
├── docker/
│   ├── Dockerfile                  # Multi-stage: base → browser-bench-build, base → browser-bench-measure
│   ├── package-build.json          # Minimal npm deps for build image (none)
│   └── package-measure.json        # Playwright dep for measure image
├── src/
│   ├── microbenchmarks/            # C# JSExport benchmark project
│   │   ├── MicroBenchmarks.csproj
│   │   ├── JsInteropBench.cs
│   │   ├── JsonBench.cs
│   │   ├── ExceptionBench.cs
│   │   └── bench-driver.mjs        # JS harness that calls [JSExport] methods
│   └── dashboard/                   # Static web UI (served from gh-pages)
│       ├── index.html
│       ├── app.js                   # Main application logic
│       ├── data-loader.js           # Index + month index + result JSON fetching
│       ├── chart-manager.js         # Chart.js chart creation/update
│       ├── filters.js               # Side-panel filter state management
│       └── style.css
├── tests/
│   ├── unit/                        # Unit tests (Node.js test runner)
│   │   ├── data-loader.test.mjs     # Month index filtering, data caching
│   │   ├── chart-manager.test.mjs   # Dataset building, series grouping
│   │   ├── filters.test.mjs         # Filter state, URL hash parsing
│   │   ├── consolidate.test.mjs     # Month index merge, dedup, daily sharding
│   ├── sdk-info.test.mjs        # SDK version parsing, commit hash extraction
│   │   ├── build-config.test.mjs    # Build preset → MSBuild flag mapping
│   │   ├── measure-utils.test.mjs   # Static server, file sizes, result JSON, compile time reader
│   │   ├── metrics.test.mjs         # Metrics registry validation
│   │   └── fixtures/                # Sample index.json, month indexes, result JSONs, dotnet --info output
│   └── e2e/                         # End-to-end tests (Playwright)
│       ├── dashboard.spec.mjs       # Load dashboard, verify charts render
│       ├── pipeline-smoke.spec.mjs  # Build app, run measure script, verify JSON
│       └── helpers/
│           └── gh-api.mjs           # GitHub API helpers for CI status checks
├── scripts/
│   ├── measure-external.mjs        # Playwright + CDP: download sizes, reach-managed timing, memory
│   ├── measure-internal.mjs        # Run microbenchmarks on V8/Node/Chrome/Firefox
│   ├── resolve-sdk.sh              # Download nightly SDK, extract version+hash
│   ├── build-app.sh                # Build/publish sample app with MSBuild flags
│   ├── init-gh-pages.sh            # Initialize gh-pages branch (one-time setup)
│   ├── consolidate-results.mjs     # Merge CI artifacts into gh-pages data/
│   └── lib/
│       ├── sdk-info.mjs            # SDK version parsing utilities (testable)
│       ├── build-config.mjs        # Build preset → MSBuild flag mapping (testable)
│       ├── metrics.mjs             # Canonical metric registry (shared by scripts + dashboard)
│       └── measure-utils.mjs       # Static server, file sizes, result JSON utilities (testable)
├── apps/                            # Sample app configs and overrides
│   ├── empty-browser/
│   │   └── app.json                 # App metadata, template name, build flags
│   ├── empty-blazor/
│   │   └── app.json
│   └── blazing-pizza/
│       └── app.json                 # Repo URL, pinned commit, mock backend config
├── artifacts/                       # Build outputs and temp files (gitignored)
│   ├── publish/                     # dotnet publish output per app
│   ├── sdk/                         # Downloaded .NET SDK
│   ├── results/                     # Benchmark result JSONs before upload
│   └── logs/                        # Build and measurement logs
├── docs/
│   ├── model.md
│   ├── views.md
│   ├── pipeline.md
│   ├── ui.md
│   └── migration.md
├── plan.md                          # This file
├── NuGet.config                     # NuGet feeds (dotnet-public, dotnet10, dotnet11)
├── package.json                     # Playwright + any Node dependencies
└── README.md
```

The `artifacts/` directory is gitignored. All build scripts write outputs there:
- `scripts/resolve-sdk.sh` → `artifacts/sdks/`
- `scripts/build-app.sh` → `artifacts/publish/{app}/`
- `scripts/measure-*.mjs` → `artifacts/results/`
- Build logs → `artifacts/logs/`

## Implementation Phases

### Phase 1: Foundation ✅
Core infrastructure that everything else depends on.

| Step | Task | Output | Status |
|------|------|--------|--------|
| 1.1 | Init repo: `package.json`, `.gitignore`, `NuGet.config`, folder structure | Repo skeleton | ✅ Done |
| 1.2 | Create [Dockerfile](docker/Dockerfile) with multi-stage build: `browser-bench-build` (Node + .NET prereqs) and `browser-bench-measure` (V8/d8, Chrome, Firefox, Playwright) | Docker images | ✅ Done |
| 1.3 | Create [resolve-sdk.sh](scripts/resolve-sdk.sh) — uses official `dotnet-install.sh`, outputs version + git hash + build date JSON via [sdk-info.mjs](scripts/lib/sdk-info.mjs) | SDK resolver | ✅ Done |
| 1.4 | Create [build-app.sh](scripts/build-app.sh) — build/publish sample app to `artifacts/publish/` with runtime/preset flags via [build-config.mjs](scripts/lib/build-config.mjs) | App builder | ✅ Done |
| 1.5 | Create [init-gh-pages.sh](scripts/init-gh-pages.sh) — repeatable script to initialize `gh-pages` branch | Data branch | ✅ Done |
| 1.6 | Unit tests for SDK version parsing + build flag generation (35 tests) | Tests | ✅ Done |
| 2.1 | [apps/empty-browser/](apps/empty-browser/) — `.csproj` + `Program.cs` + `main.mjs` + `index.html` (browser-wasm standalone) | App config | ✅ Done |

### Phase 2: First End-to-End Slice (empty-browser + external metrics) ✅
Get one app measured end-to-end before expanding to more apps/metrics.

| Step | Task | Output | Status |
|------|------|--------|--------|
| 2.1 | [apps/empty-browser/](apps/empty-browser/) — `dotnet new web` config, browser target, `dotnet_ready` JS marker + `dotnet_managed_ready` C# marker via JSImport | App config | ✅ Done |
| 2.2 | [measure-external.mjs](scripts/measure-external.mjs) — Playwright + CDP: compile time, download sizes (CDP total + FS wasm/dlls), time-to-reach-managed (min of 3 warm reloads), time-to-reach-managed-cold, memory peak (100ms JSHeapUsedSize sampling). Built-in node:http server with COOP/COEP. Retry on timeout only (default 2). | External script | ✅ Done |
| 2.3 | Unit tests for measure-utils (33 tests): MIME types, static server (COOP/COEP, path traversal), file sizes, result JSON builder, compile time reader. Plus metrics registry tests. | Tests | ✅ Done |
| 2.4 | JSON output schema documented in [model.md](docs/model.md), implemented in [measure-utils.mjs](scripts/lib/measure-utils.mjs) `buildResultJson()` | Schema | ✅ Done |

### Phase 3: CI Pipeline (single-app) ✅
Get the CI loop working for the single empty-browser app.

| Step | Task | Output | Status |
|------|------|--------|--------|
| 3.1 | [benchmark.yml](.github/workflows/benchmark.yml) — matrix: runtime×preset, single app (empty-browser), chrome engine only | CI workflow | ✅ Done |
| 3.2 | [consolidate.yml](.github/workflows/consolidate.yml) — download artifacts, merge into gh-pages, commit | CI workflow | ✅ Done |
| 3.3 | [consolidate-results.mjs](scripts/consolidate-results.mjs) — merge artifacts into gh-pages data/ | Script | ✅ Done |
| 3.4 | Unit tests for consolidate-results: month index merge, dedup, daily sharding (34 tests) | Tests | ✅ Done |
| 3.5 | [docker-build.yml](.github/workflows/docker-build.yml) — build + push Docker image weekly | CI workflow | ✅ Done |
| 3.6 | [test.yml](.github/workflows/test.yml) — run unit tests on PR/push | CI workflow | ✅ Done |

### Phase 4: Dashboard
Static web UI on GitHub Pages.

| Step | Task | Output | Depends on |
|------|------|--------|------------|
| 4.1 | [index.html](src/dashboard/index.html) — page shell, navigation tabs, filter sidebar | HTML | 2.4 |
| 4.2 | [data-loader.js](src/dashboard/data-loader.js) — fetch index, lazy-load month indexes + result JSONs | JS module | 2.4 |
| 4.3 | [chart-manager.js](src/dashboard/chart-manager.js) — Chart.js line charts, tooltips, colors | JS module | 4.1 |
| 4.4 | [filters.js](src/dashboard/filters.js) — checkbox state, URL hash sync, re-render on change | JS module | 4.1 |
| 4.5 | [app.js](src/dashboard/app.js) — orchestrator wiring modules together | JS module | 4.2-4.4 |
| 4.6 | Unit tests for data-loader (filtering, caching) and filters (hash parse/serialize) | Tests | 4.2, 4.4 |
| 4.7 | E2E test: Playwright loads dashboard with fixture data, verifies charts render | Tests | 4.1-4.5 |
| 4.8 | Generate sample test data, verify charts render correctly | Test data | 4.1-4.5 |

### Phase 5: Polish & Docs
| Step | Task | Output | Depends on |
|------|------|--------|------------|
| 5.1 | README.md with architecture overview, quickstart, manual run instructions | Docs | Phase 1-4 |
| 5.2 | End-to-end test: run one preset locally in Docker, verify data → dashboard | Validation | Phase 1-4 |

### Phase 6: Additional Sample Apps
Expand to the remaining 3 sample apps.

| Step | Task | Output | Depends on |
|------|------|--------|------------|
| 6.1 | [apps/empty-blazor/](apps/empty-blazor/) — `dotnet new blazorwasm` config | App config | Phase 2 |
| 6.2 | [apps/blazing-pizza/](apps/blazing-pizza/) — clone script, pinned commit, mock backend | App config | Phase 2 |
| 6.3 | [src/microbenchmarks/](src/microbenchmarks/) — C# project with `[JSExport]` benchmark methods | C# project | Phase 2 |
| 6.4 | [bench-driver.mjs](src/microbenchmarks/bench-driver.mjs) — JS harness: loop, measure, produce JSON | JS harness | 6.3 |
| 6.5 | Update benchmark.yml matrix to include all apps | CI update | Phase 3 |
| 6.6 | E2E tests for each new app: verify build + measure produce valid JSON | Tests | 6.1-6.4 |

### Phase 7: Internal Metrics
Add microbenchmark measurement support.

| Step | Task | Output | Depends on |
|------|------|--------|------------|
| 7.1 | [measure-internal.mjs](scripts/measure-internal.mjs) — run microbenchmarks on V8/Node/Chrome/Firefox | Internal script | 6.3-6.4 |
| 7.2 | Unit tests for measure-internal: mock engine output, verify JSON schema | Tests | 7.1 |
| 7.3 | Update benchmark.yml matrix to include all engines for microbenchmarks | CI update | 7.1 |
| 7.4 | Update dashboard to show microbenchmark metrics (ops/sec charts) | UI update | 7.1, Phase 4 |

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Data storage | gh-pages branch, daily-sharded JSON + per-month index files | Free hosting, easy fetch() from UI, no server |
| Upload mechanism | CI artifacts → consolidation job | Avoids concurrent git push conflicts |
| Dashboard tech | Chart.js + vanilla JS | No build step, simple to deploy on Pages |
| Browser result extraction | Playwright `page.evaluate()` | Direct, reliable, no HTTP server needed in test |
| Docker registry | ghcr.io | Free for public repos, integrated with GH Actions |
| Dependency pinning | All exact versions | Playwright version pins Chromium/Firefox builds; avoids silent measurement drift |
| Runtime flavors | CoreCLR + Mono + LLVM NativeAOT | Compare all three runtimes on browser target |
| Build presets | NoWorkload, AOT (Mono), NativeRelink, Invariant, NoReflectionEmit, DevLoop | Cover production + diagnostic scenarios |
| SDK resolution | Latest nightly default, optional version param | Flexibility for regression investigation |
| Browser versions | Latest Playwright-compatible | Consistent with Playwright's tested versions |

## Testing Strategy

Every component has both unit tests and E2E validation:

| Component | Unit Tests | E2E Tests |
|-----------|-----------|----------|
| `resolve-sdk.sh` | Verify output JSON parsing, version extraction | Run in Docker, confirm SDK installs |
| `build-app.sh` | Verify MSBuild flag generation per preset | Build empty-browser in Docker, verify `artifacts/publish/` |
| `measure-external.mjs` | Mock CDP events, verify metric extraction + JSON schema (download-size-total/wasm/dlls, time-to-reach-managed/cold) | Run against published app in Docker, verify result JSON |
| `measure-internal.mjs` | Mock engine stdout, verify JSON parsing | Run microbenchmarks on V8/Node in Docker |
| `consolidate-results.mjs` | Merge fixtures → verify month index dedup, daily sharding | Consolidation workflow with test artifacts |
| `data-loader.js` | Month index filtering, caching, lazy fetch | — (covered by dashboard E2E) |
| `filters.js` | URL hash parse/serialize, checkbox state | — (covered by dashboard E2E) |
| `chart-manager.js` | Dataset grouping, series key generation | — (covered by dashboard E2E) |
| Dashboard (full) | — | Playwright loads dashboard with fixture data, verifies chart rendering + filter interactions |

### Test workflow: `test.yml`
- Triggered on push and PR
- Runs unit tests via Node.js test runner (`node --test tests/unit/*.test.mjs`)
- Runs E2E tests via Playwright (`npx playwright test tests/e2e/`)
- Uses `gh` CLI / GitHub REST API to verify CI status programmatically:
  - `tests/e2e/helpers/gh-api.mjs` uses `@octokit/rest` to check workflow run status
  - Useful for testing the consolidation pipeline: trigger benchmark → check artifacts → verify gh-pages update

## Future Considerations

- **Regression alerts**: Threshold-based detection → auto-file GitHub issues (post-MVP)
- **Historical backfill**: Import data from existing perf runs
- **WASI target**: Add wasi-node and wasmtime engines when CoreCLR WASI matures
- **Gap-filling scheduler**: Adopt radekdoulik/bench-results pattern — track measured vs. unmeasured commits over a window, pick the midpoint of the largest gap for backfill when CI capacity is idle
- **Granular AppBundle size tracking**: Track individual file sizes (`dotnet.native.wasm`, `icudt.dat`, `_framework/` dir) in addition to total download size, for finer-grained size regression detection
- **Environment fingerprint per run**: Capture `uname -a`, `/proc/cpuinfo`, `/proc/meminfo`, browser versions, emscripten version alongside results for reproducibility and cross-machine comparisons
- **Compact index format (IdMap)**: If month index files grow too large, adopt an integer ID mapping (flavor→int, metric→int) as used in radekdoulik/bench-results to compress the index
- **Use minimum (or percentiles) instead of mean**: For internal microbenchmarks, store min/p50/p99 across multiple runs rather than a single value — reduces noise (bench-results stores `minTimes`)
- **Commit-hash–based re-runs**: Allow the CI to re-benchmark a specific git commit and merge results into the correct historical date directory (already supported by the commit-date directory structure)
