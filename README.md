# .NET Browser WASM Benchmark Suite

Daily performance tracking for .NET WebAssembly in browsers. Automatically builds sample apps against the latest nightly .NET SDK, measures load time, download size, and memory across engines and build configurations, then publishes the results to a [live dashboard](https://pavelsavara.github.io/simple-bench/).

## What it measures

| Category | Metrics |
|----------|---------|
| **Size** | Total bundle, WASM binary, managed DLLs (disk + over-the-wire) |
| **Startup** | Time to reach managed code (cold & warm) |
| **Memory** | Peak JS heap during load |
| **Throughput** | JS interop, JSON parsing, exception handling (ops/sec) |

Across dimensions: **runtime** (CoreCLR, Mono) × **preset** (Release, AOT, NativeRelink, Invariant, Debug, …) × **engine** (Chrome, Firefox, V8, Node) × **app** (empty-browser, empty-blazor, blazing-pizza, microbenchmarks).

## Pipeline flow

```
  ┌──────────────────────────┐
  │  Docker image build      │  weekly / on Dockerfile change
  │  browser-bench-build     │  (.NET SDK prerequisites)
  │  browser-bench-measure   │  (V8, Chrome, Firefox, Playwright)
  └──────────────────────────┘

  ┌──────────────────────────┐
  │  Benchmark (daily)       │
  │                          │
  │  1. Build job            │  download nightly SDK → build all
  │     (build container)    │  app × preset combinations
  │          │               │
  │          ▼ artifacts     │
  │  2. Measure jobs         │  matrix of app × preset × JS engines
  │     (measure container)  │  
  │          │               │
  │          ▼ result JSONs  │
  │  3. Consolidate          │  merge into gh-pages data/
  └──────────────────────────┘

  ┌──────────────────────────┐
  │  GitHub Pages dashboard  │  Chart.js line charts, filterable
  │  data/ (JSON time series)│  by runtime, preset, engine
  └──────────────────────────┘
```

## Repo structure

```
src/                  Sample apps (.csproj + C# + JS)
scripts/              Build, measure, and pipeline scripts (Node.js + bash)
  lib/                Shared utilities (build-config, sdk-info, metrics)
docker/               Multi-stage Dockerfile (build + measure images)
tests/unit/           Unit tests (Node.js test runner)
.github/workflows/    CI: benchmark, consolidate, docker-build, test
docs/                 Design documents (model, pipeline, views, UI)
```

## Local development

```bash
# Unit tests (Node.js >= 24)
npm ci && npm test

# Full pipeline simulation with Docker
./scripts/local-bench.sh --dry-run    # chrome-only, like PR validation

# Re-measure only (skip rebuild)
./scripts/local-bench.sh --skip-docker --skip-build --app empty-browser --preset debug
```

See [agent.md](agent.md) for detailed instructions.

## Documentation

- [model.md](docs/model.md) — data dimensions, metric definitions, JSON schemas
- [pipeline.md](docs/pipeline.md) — CI workflows, Docker images, SDK resolution, measurement scripts
- [views.md](docs/views.md) — dashboard pages and interactions
- [ui.md](docs/ui.md) — dashboard JS implementation details