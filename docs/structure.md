# Repository & Artifacts Structure

## Repository Layout

```
├── docs/                          # Documentation (this directory)
├── docker/
│   ├── Dockerfile                 # Multi-stage: base → browser-bench-build, browser-bench-measure
│   ├── package-build.json         # Node package for build image (no deps)
│   └── package-measure.json       # Node package for measure image (playwright 1.58.2)
├── scripts/
│   ├── run-bench.mjs              # Unified entry point for local/docker execution
│   ├── run-pipeline.mjs           # Build phase orchestrator (Phases 0–6)
│   ├── run-measure-job.mjs        # Measure phase orchestrator (per app/preset)
│   ├── measure-external.mjs       # Browser + CLI measurement (chrome/firefox/v8/node)
│   ├── measure-internal.mjs       # Microbenchmark measurement
│   ├── consolidate-results.mjs    # Merge results into gh-pages data/
│   ├── schedule-benchmarks.mjs    # Gap detection & workflow dispatch
│   ├── enumerate-runtime-packs.mjs # Catalog runtime packs from NuGet feeds
│   ├── enumerate-sdks.mjs         # Catalog SDKs from CDN + NuGet
│   ├── init-gh-pages.sh           # Bootstrap gh-pages branch
│   ├── local-bench.sh/.ps1        # Local mode wrapper (no Docker)
│   ├── local-docker-bench.sh/.ps1 # Docker mode wrapper
│   └── lib/
│       ├── build-app.mjs          # Single app build (dotnet publish wrapper)
│       ├── build-config.mjs       # Preset → MSBuild flag mapping + validation
│       ├── measure-utils.mjs      # Static server, file sizes, result JSON builder
│       ├── internal-utils.mjs     # Engine commands, bench result parsing
│       ├── metrics.mjs            # Metrics registry (names, units, categories)
│       ├── throttle-profiles.mjs  # Desktop/mobile profile definitions
│       ├── resolve-sdk.mjs        # SDK download + version resolution
│       ├── sdk-info.mjs           # Git hash extraction, date parsing
│       ├── runtime-pack-resolver.mjs # Runtime pack resolution, date decoding
│       └── pizza-walkthrough.mjs  # Playwright order flow for blazing-pizza
├── src/
│   ├── Directory.Build.props      # Output paths, imports versions.props + presets.props
│   ├── Directory.Build.targets    # Runtime pack override target (UpdateRuntimePack)
│   ├── presets.props               # MSBuild PropertyGroups per BenchmarkPreset
│   ├── versions.props              # SDK auto-detection, TFM, package version alignment
│   ├── AllApps.proj                # Solution-level project for building all apps
│   ├── restore/
│   │   └── restore-runtime-pack.proj  # Restore-only project for downloading runtime packs
│   ├── empty-browser/             # Minimal wasm console app (has timing marker)
│   ├── empty-blazor/              # Minimal Blazor app (no timing marker)
│   ├── blazing-pizza/             # Real-world Blazor app (multi-page order flow)
│   └── microbenchmarks/           # JS interop / JSON / exception perf benchmarks
├── tests/
│   └── unit/                      # Node.js test runner tests (*.test.mjs)
├── NuGet.config                   # Feed configuration (nuget.org + AzDO public feeds)
├── package.json                   # Root: Node 24, ES modules, Playwright + Chart.js deps
└── artifacts/                     # Gitignored — all build/measure outputs
```

## Artifacts Directory Layout

```
artifacts/
├── sdks/
│   └── {os}.sdk{version_or_channel}/
│       ├── sdk-info.json          # Resolved SDK metadata + git hashes
│       ├── dotnet                 # SDK binary
│       └── ...                    # Full SDK installation
│
├── nuget-packages/                # Local NuGet cache (--packages target)
│   └── {package-id}/{version}/    # Downloaded NuGet packages
│
├── bin/{AppName}/{BuildLabel}/{Preset}/
│   └── ...                        # Intermediate build outputs
│
├── obj/{AppName}/{BuildLabel}/{Preset}/
│   └── ...                        # Temporary build artifacts
│
├── publish/{app}/{buildLabel}/{preset}/
│   ├── compile-time.json          # {compileTimeMs, app, runtime, preset}
│   ├── publish.binlog             # MSBuild binary log
│   ├── web.config
│   ├── {App}.runtimeconfig.json
│   ├── {App}.staticwebassets.endpoints.json
│   └── wwwroot/
│       ├── index.html
│       ├── main.{fingerprint}.js  # App entry point (fingerprinted)
│       └── _framework/
│           ├── dotnet.js          # Runtime loader
│           ├── dotnet.native.wasm # Native WASM binary
│           ├── *.dll              # IL assemblies (if webcil off)
│           ├── *.wasm             # Webcil-wrapped assemblies (if webcil on)
│           └── ...                # ICU data, config, etc.
│
├── results/
│   ├── .run-id                    # Current run timestamp
│   ├── {RUN_TIMESTAMP}/
│   │   ├── sdk-info.json          # Copy for this run
│   │   └── build-manifest.json    # [{app, preset, compileTimeMs, integrity}]
│   └── {runtimeCommitDateTime}_{hash7}_{runtime}_{preset}_{profile}_{engine}_{app}.json
│
├── runtime-packs.json             # Catalog of runtime pack versions + git hashes
└── sdk-list.json                  # Catalog of SDK versions + git hashes
```

## Key Path Patterns

### Build label

Controls directory nesting under `bin/`, `obj/`, `publish/`:
- With runtime pack override: `{sdkVersion}_{runtimePackVersion}`
- Without: `{sdkVersion}`
- Local default: `local`

### Result filename

```
{runtimeCommitDateTime}_{hash7}_{runtime}_{preset}_{profile}_{engine}_{app}.json
```
Example: `2026-03-02T12-34-56-UTC_abc1234_mono_devloop_desktop_chrome_empty-browser.json`

### gh-pages data directory (after consolidation)

```
data/
├── index.json                     # {lastUpdated, dimensions, months[]}
├── {YYYY-MM}.json                 # Month index: commits[] → results[]
└── {year}/
    └── {YYYY-MM-DD}/
        └── {result-filename}.json # Individual result files
```

## Fingerprinting

Apps using `Microsoft.NET.Sdk.WebAssembly` can define fingerprint patterns in their .csproj:

```xml
<StaticWebAssetFingerprintPattern Include="JS" Pattern="*.js" Expression="#[.{fingerprint}]!" />
```

This produces files like `main.z43bqdwb86.js`. The mapping is stored in `{App}.staticwebassets.endpoints.json` and resolved by the static server during measurement.

## MSBuild Output Paths

Controlled by `Directory.Build.props`:
- `ArtifactsPath` → `artifacts/bin/{AppName}/{BuildLabel}/{Preset}/`
- `BaseIntermediateOutputPath` → `artifacts/obj/{AppName}/{BuildLabel}/{Preset}/`
- Publish output via `-o` flag → `artifacts/publish/{app}/{buildLabel}/{preset}/`

The `BuildLabel` property defaults to `local` and is overridden by the pipeline to the SDK version string.
