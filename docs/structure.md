# Repository & Artifacts Structure

## Repository Layout

```
├── docs/                          # Documentation (this directory)
├── docker/
│   ├── Dockerfile                 # Multi-stage: base → browser-bench-build, browser-bench-measure
│   ├── package-build.json         # Node package for build image (no deps)
│   └── package-measure.json       # Node package for measure image (playwright 1.58.2)
├── bench.sh                       # Shell wrapper: builds CLI if needed, runs bench
├── bench.ps1                      # PowerShell wrapper: builds CLI if needed, runs bench
├── bench/
│   ├── package.json               # Separate from root. Deps: typescript, tsx, rollup
│   ├── tsconfig.json              # strict, ESNext, NodeNext module resolution
│   ├── rollup.config.mjs          # Bundle src/main.ts → artifacts/bench/bench.mjs (ESM)
│   └── src/
│       ├── main.ts                # Entry point: parseArgs → buildContext → runStages
│       ├── args.ts                # CLI argument parsing, validation, help text
│       ├── context.ts             # BenchContext type, defaults, serialization
│       ├── enums.ts               # All dimension enums + routing tables + constraints
│       ├── exec.ts                # Cross-platform process execution, Docker, WSL helpers
│       ├── log.ts                 # Structured logging (respects --verbose)
│       ├── lib/
│       │   ├── build-config.ts    # Preset → MSBuild flag mapping + validation
│       │   ├── sdk-info.ts        # Git hash extraction, date parsing
│       │   ├── metrics.ts         # Metrics registry (names, units, categories)
│       │   ├── measure-utils.ts   # Static server, file sizes, result JSON builder
│       │   ├── internal-utils.ts  # Engine commands, bench result parsing
│       │   ├── throttle-profiles.ts # Desktop/mobile profile definitions
│       │   ├── runtime-pack-resolver.ts # Runtime pack resolution, date decoding
│       │   └── pizza-walkthrough.ts # Playwright order flow for blazing-pizza
│       └── stages/
│           ├── index.ts           # Stage registry, sequential runner
│           ├── docker-image.ts    # Build Docker images
│           ├── acquire-sdk.ts     # SDK download, hash resolution, sdk-info.json
│           ├── build.ts           # Build all app×preset, write build-manifest
│           ├── measure.ts         # Measure all combinations, write result JSONs
│           ├── consolidate.ts     # Merge results into gh-pages
│           ├── schedule.ts        # Gap detection, workflow dispatch
│           ├── enumerate-commits.ts # Enumerate runtime commits via GitHub API
│           ├── enumerate-packs.ts # Runtime pack catalog
│           ├── enumerate-sdks.ts  # SDK catalog
│           └── transform-views.ts # View file generation
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
├── sdk-list.json                  # Catalog of SDK versions + git hashes
└── commits-list.json              # Recent dotnet/runtime commits from GitHub API
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
Example: `2026-03-02T12-34-56Z_abc1234_mono_devloop_desktop_chrome_empty-browser.json`

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
