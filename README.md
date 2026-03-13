# .NET Browser WASM Benchmark Suite

Daily performance tracking for .NET WebAssembly in browsers. Automatically builds sample apps against the latest nightly .NET SDK, measures load time, download size, and memory across engines and build configurations, then publishes the results to a [live dashboard](https://pavelsavara.github.io/simple-bench/).

## What it measures

Five sample apps are built with every nightly .NET SDK and measured across Chrome, Firefox, V8, and Node:

| App | Description |
|-----|-------------|
| **empty-browser** | Minimal WASM app — baseline for framework overhead |
| **empty-blazor** | Minimal Blazor WebAssembly app |
| **blazing-pizza** | Blazor pizza ordering demo (with UI walkthrough timing) |
| **havit-bootstrap** | Havit Blazor Bootstrap component library |
| **micro-benchmarks** | JS interop, JSON parse, and exception throughput tests |

Each app is built under 7 preset configurations (debug, release, AOT, native-relink, etc.) and measured for:

- **Compile time** — `dotnet publish` wall clock
- **Disk size** — total, WASM-only, and DLL-only
- **Download size** — compressed bytes over the wire (Chrome/CDP)
- **Load time** — cold start and warm reload to managed code entry
- **Peak JS heap** — memory high-water mark (Chrome/CDP)
- **Throughput** — JS interop, JSON parse, exception ops/sec (micro-benchmarks)

See [docs/measurement-matrix.md](docs/measurement-matrix.md) for the full dimension matrix and constraints.

## Pipeline flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ GitHub Actions (daily 04:00 UTC)                                    │
│                                                                     │
│  Job 1: build                                                       │
│    check-out-cache → enumerate-commits → enumerate-daily-packs      │
│    → enumerate-release-packs → update-cache → schedule              │
│    → acquire-sdk → build                                            │
│                                                                     │
│  Job 2: measure (matrix: 1..N SDK commits from schedule)            │
│    acquire-sdk → measure → transform-views                          │
│                                                                     │
│  Job 3: aggregate                                                   │
│    check-out-cache → update-views (push to gh-pages)                │
│                                                                     │
│ Docker containers:                                                  │
│   build jobs  → ghcr.io/.../browser-bench-build  (SDK + emscripten) │
│   measure jobs → ghcr.io/.../browser-bench-measure (Playwright + d8)│
└─────────────────────────────────────────────────────────────────────┘
```

The build job discovers new SDK commits, builds all apps for each, then the measure job (parallelized per commit) runs Playwright browsers and CLI engines to collect metrics. Results are written as JSON and pushed to the `gh-pages` branch, where a static dashboard reads them.

See [docs/pipeline-stages.md](docs/pipeline-stages.md) for detailed stage descriptions.

## Repo structure

```
bench/src/          TypeScript CLI — pipeline orchestration and measurement
  stages/           One file per pipeline stage (12 stages)
  lib/              Shared utilities (metrics, throttle profiles, stats, etc.)
src/                .NET sample apps and MSBuild configuration
  empty-browser/    Minimal WASM app with JSImport timing marker
  empty-blazor/     Minimal Blazor WebAssembly app
  blazing-pizza/    Blazor pizza ordering demo
  havit-bootstrap/  Havit Blazor Bootstrap app
  micro-benchmarks/  JS interop throughput benchmarks
  presets.props     MSBuild presets (AOT, NativeRelink, Invariant, etc.)
docker/             Dockerfile (build + measure images) and entrypoint
.github/workflows/  CI: benchmark.yml (daily), docker-build.yml, schedule.yml
artifacts/          Build outputs, SDK cache, NuGet packages, results
gh-pages/           Dashboard (index.html + Svelte app) and result data
docs/               Detailed documentation
```

See [docs/directory-layout.md](docs/directory-layout.md) for the full tree.
