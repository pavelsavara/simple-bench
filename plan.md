# Plan: Rewrite `scripts/` as TypeScript CLI (`bench/`)

## Goal

Replace the `scripts/` folder (Node.js ESM `.mjs` files) with a TypeScript project in `bench/`.
Single CLI entry point, strongly typed context, stage-based pipeline, cross-platform exec helpers.

## Design Documents

| Document | Description |
|----------|-------------|
| [docs/pipeline-model.md](docs/pipeline-model.md) | Data dimensions, metric definitions, combination matrix |
| [docs/pipeline.md](docs/pipeline.md) | Build phases, measure phases, consolidation, local execution |
| [docs/structure.md](docs/structure.md) | Repository layout, artifact paths, key path patterns |
| [docs/ci.md](docs/ci.md) | CI workflows, Docker images, triggers, self-scheduling |
| [docs/sdk-and-runtime.md](docs/sdk-and-runtime.md) | SDK resolution, git hash chain, runtime pack enumeration |
| [docs/transformer.md](docs/transformer.md) | View transformer algorithm, bucketing, incremental updates |
| [docs/ui.md](docs/ui.md) | Dashboard UI layout, chart zones, filter panel |
| [docs/view-model.md](docs/view-model.md) | Pre-aggregated view JSON file formats |

---

## Architecture

### Single CLI Entry Point

```
bench --stages <comma-separated> [options]
```

One `main()` function. One `parseArgs()` call. One strongly-typed `BenchContext` object threaded through all stages.

### Stages

The pipeline is a sequence of stages. Each stage receives `BenchContext`, may mutate it (via spread-copy), and passes it to the next.

| Stage | Container | Description |
|-------|-----------|-------------|
| `docker-image` | host | Build Docker images (browser-bench-build, browser-bench-measure) |
| `acquire-sdk` | build | Download/install .NET SDK, resolve git hashes, write sdk-info.json |
| `build` | build | Build all app×preset combinations, write build-manifest.json |
| `measure` | measure | Run measurements for all app×preset×engine×profile combinations |
| `consolidate` | any | Merge result JSONs into gh-pages data/ directory |
| `schedule` | any | Detect untested runtime commits, dispatch benchmark workflows |
| `enumerate-packs` | any | Catalog runtime pack versions from NuGet feeds |
| `enumerate-sdks` | any | Catalog SDK versions from CDN + NuGet |
| `transform-views` | any | Build pre-aggregated view files for dashboard |

Default (no `--stages`): `acquire-sdk,build,measure`

Stages that cross container boundaries persist context to `artifacts/bench-context.json` and reload it on the next container.

### Docker Orchestration (`--via-docker`)

When `--via-docker` is set, the CLI:
1. Runs `docker-image` stage on host (if requested)
2. Serializes context to `artifacts/bench-context.json`
3. Runs build-container stages via `docker run ... bench --stages acquire-sdk,build --context artifacts/bench-context.json`
4. Runs measure-container stages via `docker run ... bench --stages measure --context artifacts/bench-context.json`

All Docker/WSL exec logic lives in `bench/src/exec.ts`.

### Build & Run

| Environment | Tool | How |
|-------------|------|-----|
| Local dev | `tsx` | `npx tsx bench/src/main.ts --stages ...` |
| Docker container | `node` (bundled) | `node artifacts/bench/bench.mjs --stages ...` |
| CI workflow | `node` (bundled) | Same as Docker |

Bundle: `rollup` → single ESM file `artifacts/bench/bench.mjs`.
Compiled during Docker image creation (`npm run build` in Dockerfile).

### Shell Wrappers

Thin `bench.sh` and `bench.ps1` at repo root:
- Ensure Node.js v24 is available
- Forward all args to `tsx bench/src/main.ts` (dev) or `node artifacts/bench/bench.mjs` (production)
- No logic beyond prerequisite checks

---

## Enums (Dimensions)

```typescript
enum Runtime {
    Mono = 'mono',
    CoreCLR = 'coreclr',
    NativeAOTLLVM = 'naotllvm',  // legacy alias for Mono
}

enum Preset {
    DevLoop = 'devloop',
    NoWorkload = 'no-workload',
    Aot = 'aot',
    NativeRelink = 'native-relink',
    NoJiterp = 'no-jiterp',
    Invariant = 'invariant',
    NoReflectionEmit = 'no-reflection-emit',
}

enum Engine {
    Chrome = 'chrome',
    Firefox = 'firefox',
    V8 = 'v8',
    Node = 'node',
}

enum Profile {
    Desktop = 'desktop',
    Mobile = 'mobile',
}

enum App {
    EmptyBrowser = 'empty-browser',
    EmptyBlazor = 'empty-blazor',
    BlazingPizza = 'blazing-pizza',
    Microbenchmarks = 'microbenchmarks',
}

enum Stage {
    DockerImage = 'docker-image',
    AcquireSdk = 'acquire-sdk',
    Build = 'build',
    Measure = 'measure',
    Consolidate = 'consolidate',
    Schedule = 'schedule',
    EnumeratePacks = 'enumerate-packs',
    EnumerateSdks = 'enumerate-sdks',
    TransformViews = 'transform-views',
}

enum MetricKey {
    CompileTime = 'compile-time',
    DiskSizeTotal = 'disk-size-total',
    DiskSizeWasm = 'disk-size-wasm',
    DiskSizeDlls = 'disk-size-dlls',
    DownloadSizeTotal = 'download-size-total',
    TimeToReachManaged = 'time-to-reach-managed',
    TimeToReachManagedCold = 'time-to-reach-managed-cold',
    MemoryPeak = 'memory-peak',
    PizzaWalkthru = 'pizza-walkthru',
    JsInteropOps = 'js-interop-ops',
    JsonParseOps = 'json-parse-ops',
    ExceptionOps = 'exception-ops',
}
```

### Routing Rules (baked into App enum or companion map)

```typescript
const APP_CONFIG: Record<App, AppConfig> = {
    [App.EmptyBrowser]:   { browserOnly: false, internal: false },
    [App.EmptyBlazor]:    { browserOnly: true,  internal: false },
    [App.BlazingPizza]:   { browserOnly: true,  internal: false },
    [App.Microbenchmarks]:{ browserOnly: false, internal: true },
};
```

### Preset Constraints

```typescript
const WORKLOAD_PRESETS: Set<Preset> = new Set([
    Preset.NativeRelink, Preset.Aot, Preset.NoJiterp,
    Preset.Invariant, Preset.NoReflectionEmit,
]);
const NON_WORKLOAD_PRESETS: Set<Preset> = new Set([
    Preset.DevLoop, Preset.NoWorkload,
]);
// Mono-only presets (invalid with CoreCLR)
const MONO_ONLY_PRESETS: Set<Preset> = new Set([Preset.Aot, Preset.NoJiterp]);
```

---

## CLI Parameters

```
bench [options]

Pipeline control:
  --stages <list>          Comma-separated stage names (default: acquire-sdk,build,measure)
  --via-docker             Run build/measure stages inside Docker containers
  --context <path>         Load/save BenchContext from JSON file (cross-container handoff)
  --dry-run                Minimal run: empty-browser + devloop + chrome only

SDK & Runtime:
  --sdk-channel <ch>       SDK channel (default: 11.0)
  --sdk-version <ver>      Exact SDK version (overrides channel)
  --runtime <rt>           Runtime flavor: mono, coreclr (default: mono)
  --runtime-pack <ver>     Specific runtime pack version
  --runtime-commit <hash>  Specific dotnet/runtime commit hash

Filters (comma-separated, restrict what gets built/measured):
  --app <list>             App filter (default: all)
  --preset <list>          Preset filter (default: all; dry-run: devloop)
  --engine <list>          Engine filter (default: all; dry-run: chrome)
  --profile <list>         Profile filter (default: all)

Measurement:
  --retries <n>            Max retries on timeout (default: 3)
  --timeout <ms>           Per-measurement timeout (default: 300000)
  --warm-runs <n>          Warm reload iterations (default: 3)
  --no-headless            Launch browsers in headed mode

Docker (only with --via-docker):
  --skip-docker-build      Reuse existing Docker images

Consolidation:
  --artifacts-dir <path>   CI artifacts input directory
  --data-dir <path>        gh-pages data/ output directory

Scheduling:
  --max-dispatches <n>     Max workflow dispatches (default: 3)
  --recent <n>             Consider N most recent packs (default: 30)
  --repo <owner/name>      GitHub repository (default: auto-detect)
  --branch <name>          Branch for dispatch (default: main)

Enumeration:
  --major <n>              .NET major version (default: 11)
  --months <n>             History months to scan (default: 3)
  --force-enumerate        Re-resolve all versions (ignore cache)

General:
  --help                   Show help
  --verbose                Verbose logging
```

---

### Context Serialization

For cross-container handoff:
```typescript
function saveContext(ctx: BenchContext, path: string): void;
function loadContext(path: string): BenchContext;
```

Only serializable fields are persisted (no functions, no resolved module references).

---

## File Structure

```
bench/
├── package.json               # Separate from root. Deps: typescript, tsx, rollup, @types/node
├── tsconfig.json              # strict, ESNext, NodeNext module resolution
├── rollup.config.mjs          # Bundle src/main.ts → artifacts/bench/bench.mjs (ESM)
├── .eslintrc.cjs              # typescript-eslint, strict style rules
├── src/
│   ├── main.ts                # Entry point: parseArgs → buildContext → runStages
│   ├── args.ts                # CLI argument parsing, validation, help text
│   ├── context.ts             # BenchContext type, defaults, serialization
│   ├── enums.ts               # All dimension enums + routing tables + constraints
│   ├── exec.ts                # Cross-platform process execution, Docker commands, WSL helpers
│   ├── log.ts                 # Structured logging (respects --verbose)
│   ├── stages/
│   │   ├── index.ts           # Stage registry, sequential runner
│   │   ├── docker-image.ts    # Build Docker images ✅
│   │   ├── acquire-sdk.ts     # SDK download, hash resolution, sdk-info.json (stub)
│   │   ├── build.ts           # Build all app×preset, write build-manifest ✅
│   │   ├── measure.ts         # Measure all combinations, write result JSONs (stub)
│   │   ├── consolidate.ts     # Merge results into gh-pages (stub)
│   │   ├── schedule.ts        # Gap detection, workflow dispatch (stub)
│   │   ├── enumerate-packs.ts # Runtime pack catalog (stub)
│   │   ├── enumerate-sdks.ts  # SDK catalog (stub)
│   │   └── transform-views.ts # View file generation (stub)
│   └── lib/                   # (not yet created)
│       ├── build-config.ts    # Preset → MSBuild flag mapping
│       ├── sdk-info.ts        # Version parsing, SHORT_DATE decoding
│       ├── metrics.ts         # Metric registry (shared types)
│       ├── measure-utils.ts   # Static server, file sizes, result JSON builder
│       ├── internal-utils.ts  # Engine commands, bench result parsing
│       ├── throttle-profiles.ts # Desktop/mobile CDP throttling
│       ├── runtime-pack-resolver.ts # Pack resolution, NuGet queries
│       └── pizza-walkthrough.ts # Playwright order flow automation
```

### Shell Wrappers (repo root)

```
bench.sh                       # #!/bin/bash — check Node, exec tsx or node
bench.ps1                      # PowerShell — check Node, exec tsx or node
```

---

## Environment Support Matrix

| Environment | Node | Docker | .NET SDK | How bench runs |
|-------------|------|--------|----------|---------------|
| Windows (native) | ✓ | — | local | `bench.ps1 --stages acquire-sdk,build,measure` |
| Windows + WSL Docker | ✓ | WSL | in container | `bench.ps1 --via-docker --stages docker-image,acquire-sdk,build,measure` |
| Ubuntu (native) | ✓ | — | local | `./bench.sh --stages acquire-sdk,build,measure` |
| Ubuntu + Docker | ✓ | native | in container | `./bench.sh --via-docker --stages ...` |
| Build container | ✓ | — | installed | `node artifacts/bench/bench.mjs --stages acquire-sdk,build` |
| Measure container | ✓ | — | — | `node artifacts/bench/bench.mjs --stages measure --context ...` |

---

## Implementation Plan

### Step 1: Scaffold `bench/` project ✅
- `bench/package.json` with deps: `typescript`, `tsx`, `@rollup/plugin-typescript`, `rollup`, `@types/node`
- `bench/tsconfig.json` (strict, ESNext, NodeNext)
- `bench/rollup.config.mjs`
- `bench/.eslintrc.cjs` (typescript-eslint, strict style rules)

### Step 2: Implement enums + context + args ✅
- `bench/src/enums.ts` — all enums, routing tables, constraint sets, parse/validate helpers
- `bench/src/context.ts` — `BenchContext` interface, `SdkInfo`, `BuildManifestEntry`, save/load
- `bench/src/args.ts` — `parseArgs()` → `BenchContext`, help text, validation, dry-run defaults, `--context` handoff
- `bench/src/main.ts` — `main()`: parse → build context → dispatch stages → optional context save

### Step 3: Implement exec.ts ✅
- Cross-platform `exec()`, `execCapture()`, Docker helpers (`dockerExec`, `dockerBuild`, `dockerRun`, `dockerFixPermissions`)
- WSL path conversion (`toWslPath`, `toWindowsPath`)
- Platform detection (`getPlatform`, `isWindows`, `isInDocker`, `isCI`)
- .NET helpers (`dotnetPublish`, `dotnetWorkloadInstall`, `dotnetWorkloadList`)

### Step 4: Implement stage skeleton ✅
- `bench/src/stages/index.ts` — stage registry, `runStages(ctx)` loop
- All 9 stage files created with `export async function run(ctx: BenchContext): Promise<BenchContext>`
- `bench/src/log.ts` — `banner()`, `info()`, `err()` helpers

### Step 5: Shell wrappers ✅
- `bench.sh` — checks Node, runs `npm ci` if needed, `exec npx tsx bench/src/main.ts`
- `bench.ps1` — same, plus normalizes PowerShell comma-split args

### Step 6: Port stages one by one
- [ ] `enumerate-packs` — stub (runtime pack catalog from NuGet)
- [ ] `enumerate-sdks` — stub (SDK catalog from CDN + NuGet)
- [x] `docker-image` — fully implemented (build both images, skip logic)
- [x] `build` — fully implemented (207 lines: app×preset iteration, dotnet publish, workload install, compile-time tracking, integrity check, build-manifest + sdk-info emission)
- [ ] `acquire-sdk` — stub (SDK download, hash resolution, sdk-info.json)
- [ ] `measure` — stub (browser + CLI measurement, result JSON writing)
- [ ] `consolidate` — stub (merge results into gh-pages data/)
- [ ] `schedule` — stub (gap detection, workflow dispatch)
- [ ] `transform-views` — stub (view file generation for dashboard)
- [ ] `lib/` folder — not yet created; build-config logic currently inlined in `enums.ts` and `build.ts`
- [ ] Unit tests (`bench/tests/*.test.ts`)

### Step 7: Update Dockerfile
- Add `npm run build` step for `bench/` in build stage
- Bundle `artifacts/bench/bench.mjs` into both images

### Step 8: Update CI workflows
- Replace `node scripts/run-pipeline.mjs` with `node artifacts/bench/bench.mjs --stages ...`
- Replace `node scripts/run-measure-job.mjs` with `node artifacts/bench/bench.mjs --stages measure --context ...`

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript (strict) | Type safety for context, enums, stage interfaces |
| Local dev runner | `tsx` | Fast (esbuild-based), no separate compile step |
| Production bundler | Rollup → ESM | Single file, tree-shaken, runs on Node 24 |
| CLI structure | Single binary with `--stages` | Resume from middle, cross-container handoff via `--context` |
| Docker orchestration | In TypeScript (`--via-docker`) | Consistent cross-platform, reuses `exec.ts` |
| Shell wrappers | Minimal `bench.sh`/`bench.ps1` | Only check Node prereq, delegate everything to TS |
| `naotllvm` | Kept as legacy alias for `mono` | Backward compat for old result data |
| `no-jiterp` preset | Kept | Valid mono-only preset |
| Apps | Hardcoded enum | Bake routing rules (browserOnly, internal) |
| CI run URL | Derived from `GITHUB_RUN_ID` + `GITHUB_REPOSITORY` env vars | No need for separate `--ci-run-url` parameter |

---

## TODO

- [ ] Implement `dotnet_managed_ready` timing marker for Blazor apps (`empty-blazor`, `blazing-pizza`) via a Blazor startup hook so that `time-to-reach-managed` and `time-to-reach-managed-cold` are available for all apps. The design assumes these metrics are always present.
