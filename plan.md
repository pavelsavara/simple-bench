# Plan: .NET Browser WASM Benchmark Suite

## Overview

A benchmarking solution that measures .NET Browser/WASM performance (CoreCLR + Mono) across multiple sample apps, engines, and build configurations. Results stored as weekly-sharded JSON on `gh-pages`, visualized with a Chart.js dashboard, collected via GitHub Actions.

## Design Documents

| Document | Description |
|----------|-------------|
| [model.md](model.md) | Data dimensions, metric definitions, JSON schemas, file naming, directory layout, manifest structure |
| [views.md](views.md) | Dashboard UI pages from user perspective — navigation, charts, filters, interactions |
| [pipeline.md](pipeline.md) | CI pipeline: GitHub Actions workflows, Docker image, Playwright measurement, SDK resolution, result commits |
| [ui.md](ui.md) | Dashboard JavaScript implementation — modules, data loading, Chart.js config, filter logic |

## Repo Structure

```
simple-bench/
├── .github/
│   └── workflows/
│       ├── benchmark.yml           # Daily benchmark runs (matrix of configs)
│       ├── consolidate.yml         # Merge results to gh-pages branch
│       └── docker-build.yml        # Build/push Docker image to ghcr.io
├── docker/
│   └── Dockerfile                  # V8, Node, Chrome, Firefox, Playwright deps
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
│       ├── data-loader.js           # Manifest + weekly JSON fetching
│       ├── chart-manager.js         # Chart.js chart creation/update
│       ├── filters.js               # Side-panel filter state management
│       └── style.css
├── scripts/
│   ├── measure-external.mjs        # Playwright + CDP: download size, TTFR, TTFUC, memory
│   ├── measure-internal.mjs        # Run microbenchmarks on V8/Node/Chrome/Firefox
│   ├── resolve-sdk.sh              # Download nightly SDK, extract version+hash
│   ├── build-app.sh                # Build/publish sample app with MSBuild flags
│   └── consolidate-results.mjs     # Merge CI artifacts into gh-pages data/
├── apps/                            # Sample app configs and overrides
│   ├── empty-browser/
│   │   └── app.json                 # App metadata, template name, build flags
│   ├── empty-blazor/
│   │   └── app.json
│   └── blazing-pizza/
│       └── app.json                 # Repo URL, pinned commit, mock backend config
├── docs/
│   ├── model.md
│   ├── views.md
│   ├── pipeline.md
│   └── ui.md
├── plan.md                          # This file
├── package.json                     # Playwright + any Node dependencies
└── README.md
```

## Implementation Phases

### Phase 1: Foundation
Core infrastructure that everything else depends on.

| Step | Task | Output | Depends on |
|------|------|--------|------------|
| 1.1 | Init repo: `package.json`, `.gitignore`, folder structure | Repo skeleton | — |
| 1.2 | Create [Dockerfile](docker/Dockerfile) with V8 (`d8`), Node LTS, Chrome, Firefox, Playwright system deps | Docker image | — |
| 1.3 | Create [resolve-sdk.sh](scripts/resolve-sdk.sh) — download nightly SDK, output version + git hash JSON | SDK resolver | — |
| 1.4 | Create [build-app.sh](scripts/build-app.sh) — build/publish sample app with runtime/config flags | App builder | 1.3 |
| 1.5 | Create `gh-pages` branch with empty `data/manifest.json` + dashboard skeleton | Data branch | — |

### Phase 2: Sample Apps
Set up the 4 sample applications and the microbenchmark harness.

| Step | Task | Output | Depends on |
|------|------|--------|------------|
| 2.1 | [apps/empty-browser/](apps/empty-browser/) — `dotnet new web` config, browser target | App config | 1.3 |
| 2.2 | [apps/empty-blazor/](apps/empty-blazor/) — `dotnet new blazorwasm` config | App config | 1.3 |
| 2.3 | [apps/blazing-pizza/](apps/blazing-pizza/) — clone script, pinned commit, mock backend | App config | 1.3 |
| 2.4 | [src/microbenchmarks/](src/microbenchmarks/) — C# project with `[JSExport]` benchmark methods | C# project | 1.3 |
| 2.5 | [bench-driver.mjs](src/microbenchmarks/bench-driver.mjs) — JS harness: loop, measure, produce JSON | JS harness | 2.4 |

### Phase 3: Measurement Scripts
The core measurement logic.

| Step | Task | Output | Depends on |
|------|------|--------|------------|
| 3.1 | [measure-external.mjs](scripts/measure-external.mjs) — Playwright + CDP: TTFR, TTFUC, download size, memory peak | External script | 1.2, 2.1-2.3 |
| 3.2 | [measure-internal.mjs](scripts/measure-internal.mjs) — run microbenchmarks on each engine, collect JSON | Internal script | 1.2, 2.4-2.5 |
| 3.3 | Define + document JSON output schema (see [model.md](docs/model.md)) | Schema | — |

### Phase 4: CI Pipelines
GitHub Actions workflows.

| Step | Task | Output | Depends on |
|------|------|--------|------------|
| 4.1 | [benchmark.yml](.github/workflows/benchmark.yml) — matrix: runtime×config×app×engine, daily cron + dispatch | CI workflow | Phase 1-3 |
| 4.2 | [consolidate.yml](.github/workflows/consolidate.yml) — download artifacts, merge into gh-pages, commit | CI workflow | 4.1 |
| 4.3 | [docker-build.yml](.github/workflows/docker-build.yml) — build + push Docker image weekly | CI workflow | 1.2 |
| 4.4 | [consolidate-results.mjs](scripts/consolidate-results.mjs) — script used by 4.2 to merge data | Script | 3.3 |

### Phase 5: Dashboard
Static web UI on GitHub Pages.

| Step | Task | Output | Depends on |
|------|------|--------|------------|
| 5.1 | [index.html](src/dashboard/index.html) — page shell, navigation tabs, filter sidebar | HTML | 3.3 |
| 5.2 | [data-loader.js](src/dashboard/data-loader.js) — fetch manifest, lazy-load weekly JSONs | JS module | 3.3 |
| 5.3 | [chart-manager.js](src/dashboard/chart-manager.js) — Chart.js line charts, tooltips, colors | JS module | 5.1 |
| 5.4 | [filters.js](src/dashboard/filters.js) — checkbox state, URL hash sync, re-render on change | JS module | 5.1 |
| 5.5 | [app.js](src/dashboard/app.js) — orchestrator wiring modules together | JS module | 5.2-5.4 |
| 5.6 | Generate sample test data, verify charts render correctly | Test data | 5.1-5.5 |

### Phase 6: Polish
| Step | Task | Output | Depends on |
|------|------|--------|------------|
| 6.1 | README.md with architecture overview, quickstart, manual run instructions | Docs | All |
| 6.2 | End-to-end test: run one config locally in Docker, verify data → dashboard | Validation | All |

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Data storage | gh-pages branch, weekly-sharded JSON | Free hosting, easy fetch() from UI, no server |
| Upload mechanism | CI artifacts → consolidation job | Avoids concurrent git push conflicts |
| Dashboard tech | Chart.js + vanilla JS | No build step, simple to deploy on Pages |
| Browser result extraction | Playwright `page.evaluate()` | Direct, reliable, no HTTP server needed in test |
| Docker registry | ghcr.io | Free for public repos, integrated with GH Actions |
| Runtime flavors | CoreCLR + Mono | Compare both VMs on browser target |
| Build configs | Release, AOT (Mono), NativeRelink | Cover the main production scenarios |
| SDK resolution | Latest nightly default, optional version param | Flexibility for regression investigation |
| Browser versions | Latest Playwright-compatible | Consistent with Playwright's tested versions |

## Future Considerations

- **Regression alerts**: Threshold-based detection → auto-file GitHub issues (post-MVP)
- **Historical backfill**: Import data from existing perf runs
- **Debug app builds**: Add app Debug/Release as another matrix dimension
- **WASI target**: Add wasi-node and wasmtime engines when CoreCLR WASI matures
