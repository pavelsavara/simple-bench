# Measurement Matrix

The benchmark explores a multi-dimensional space of **Runtime × Preset × Engine × Profile × App**.
Not all combinations are valid — constraints prune the matrix significantly.

## Dimensions

### Runtimes (3)

| Value | Description |
|-------|-------------|
| `mono` | .NET Mono interpreter/JIT (default for browser WASM) |
| `coreclr` | CoreCLR runtime (experimental WASM support) |
| `naotllvm` | Native AOT via LLVM (ahead-of-time compiled) |

### Presets (7)

| Value | MSBuild Preset | Configuration | Requires Workload |
|-------|----------------|---------------|--------------------|
| `devloop` | DevLoop | Debug | No |
| `no-workload` | NoWorkload | Release | No |
| `native-relink` | NativeRelink | Release | Yes (`wasm-tools`) |
| `aot` | Aot | Release | Yes |
| `no-jiterp` | NoJiterp | Release | Yes |
| `invariant` | Invariant | Release | Yes |
| `no-reflection-emit` | NoReflectionEmit | Release | Yes |

### Engines (4)

| Value | Type | CDP Support | Description |
|-------|------|-------------|-------------|
| `chrome` | Browser | Yes | Chromium via Playwright |
| `firefox` | Browser | No | Firefox via Playwright |
| `v8` | CLI | No | V8's `d8` shell (via jsvu) |
| `node` | CLI | No | Node.js |

### Profiles (2)

| Value | CPU Throttle | Network | Description |
|-------|-------------|---------|-------------|
| `desktop` | None | None | Unthrottled |
| `mobile` | 3× slowdown | 20 Mbps down / 5 Mbps up / 70ms RTT | Simulated Android on 4G LTE |

### Apps (5)

| Value | Browser Only | Internal | Description |
|-------|-------------|----------|-------------|
| `empty-browser` | No | No | Minimal WASM app with JSImport timing marker |
| `empty-blazor` | Yes | No | Minimal Blazor WebAssembly app |
| `blazing-pizza` | Yes | No | Blazor pizza ordering app (with walkthrough) |
| `havit-bootstrap` | Yes | No | Havit Blazor Bootstrap component library |
| `microbenchmarks` | No | Yes | JS interop / JSON / exception throughput tests |

## Constraint Rules

### 1. Engine constraints by app

- **`browserOnly` apps** (empty-blazor, blazing-pizza, havit-bootstrap) → **browser engines only** (chrome, firefox)
- **Non-browserOnly apps** (empty-browser, microbenchmarks) → **all engines** (chrome, firefox, v8, node)

### 2. Profile constraints by engine

- **Chrome** → desktop, mobile (mobile uses CDP throttling)
- **Firefox** → desktop only (no CDP, no throttling)
- **V8, Node** → desktop only (CLI, no throttling)

### 3. Runtime constraints by preset

- **`aot`** → Mono only (compiles to native WASM via Emscripten + LLVM)
- **`no-jiterp`** → Mono only (disables Mono's jiterpreter)
- All other presets → all runtimes

### 4. App × preset skip rules

Blazor apps (empty-blazor, blazing-pizza, havit-bootstrap) are **skipped** for:
- **`invariant`** preset
- **`no-reflection-emit`** preset

These presets break Blazor's runtime reflection requirements.

### 5. Internal vs external measurement

- **External apps** → measured via Playwright browser automation or CLI execution
- **Internal apps** (microbenchmarks) → measured via the same infrastructure but collect throughput metrics instead of load-time metrics

## Metrics

### External metrics (non-internal apps)

| Key | Display Name | Unit | Category | Source |
|-----|-------------|------|----------|--------|
| `compile-time` | Compile Time | ms | time | `dotnet publish` wall clock |
| `disk-size-total` | Disk Size (Total) | bytes | size | Published output directory walk |
| `disk-size-native` | Disk Size (WASM) | bytes | size | `*.wasm` files in `_framework/` |
| `disk-size-assemblies` | Disk Size (DLLs) | bytes | size | `*.dll` files in `_framework/` |
| `download-size-total` | Download Size (Total) | bytes | size | CDP `Network.loadingFinished` sum (Chrome only) |
| `time-to-reach-managed-warm` | Time to Managed (Warm) | ms | time | Min of N warm reloads, `bench_results['time-to-reach-managed']` |
| `time-to-reach-managed-cold` | Time to Managed (Cold) | ms | time | First navigation, `bench_results['time-to-reach-managed']` |
| `memory-peak` | Peak JS Heap | bytes | memory | CDP `Performance.getMetrics` JSHeapUsedSize polling (Chrome only) |
| `pizza-walkthru` | Pizza Walkthrough | ms | time | Playwright UI automation of order flow (blazing-pizza + desktop only) |

### Internal metrics (microbenchmarks only)

| Key | Display Name | Unit | Category | Source |
|-----|-------------|------|----------|--------|
| `compile-time` | Compile Time | ms | time | `dotnet publish` wall clock |
| `memory-peak` | Peak JS Heap | bytes | memory | CDP polling (Chrome only) |
| `js-interop-ops` | JS Interop | ops/sec | throughput | Median of samples: JS → C# [JSExport] tight loop |
| `json-parse-ops` | JSON Parse | ops/sec | throughput | Median of samples: JS passes JSON to C# deserializer |
| `exception-ops` | Exception Handling | ops/sec | throughput | Median of samples: JS → C# throw/catch loop |

### Metric availability by engine

|  | Chrome | Firefox | V8 | Node |
|--|--------|---------|-----|------|
| compile-time | ✓ | ✓ | ✓ | ✓ |
| disk-size-* | ✓ | ✓ | ✓ | ✓ |
| download-size-total | ✓ | null | null | null |
| time-to-reach-managed-warm | ✓ | ✓ | ✓ (or wall-clock) | ✓ (or wall-clock) |
| time-to-reach-managed-cold | ✓ | ✓ | ✓ (or wall-clock) | ✓ (or wall-clock) |
| memory-peak | ✓ | null | null | null |
| pizza-walkthru | ✓ (blazing-pizza + desktop) | ✓ (blazing-pizza + desktop) | null | null |
| js-interop-ops | ✓ (microbenchmarks) | ✓ (microbenchmarks) | ✓ (microbenchmarks) | ✓ (microbenchmarks) |
| json-parse-ops | ✓ (microbenchmarks) | ✓ (microbenchmarks) | ✓ (microbenchmarks) | ✓ (microbenchmarks) |
| exception-ops | ✓ (microbenchmarks) | ✓ (microbenchmarks) | ✓ (microbenchmarks) | ✓ (microbenchmarks) |

## Valid Combinations Matrix

### Engine × Profile × App

| App | chrome/desktop | chrome/mobile | firefox/desktop | v8/desktop | node/desktop |
|-----|:-:|:-:|:-:|:-:|:-:|
| empty-browser | ✓ | ✓ | ✓ | ✓ | ✓ |
| empty-blazor | ✓ | ✓ | ✓ | — | — |
| blazing-pizza | ✓ | ✓ | ✓ | — | — |
| havit-bootstrap | ✓ | ✓ | ✓ | — | — |
| microbenchmarks | ✓ | ✓ | ✓ | ✓ | ✓ |

### App × Preset validity

| App | devloop | no-workload | native-relink | aot | no-jiterp | invariant | no-reflection-emit |
|-----|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| empty-browser | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| empty-blazor | ✓ | ✓ | ✓ | ✓ | ✓ | **skip** | **skip** |
| blazing-pizza | ✓ | ✓ | ✓ | ✓ | ✓ | **skip** | **skip** |
| havit-bootstrap | ✓ | ✓ | ✓ | ✓ | ✓ | **skip** | **skip** |
| microbenchmarks | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### Runtime × Preset validity

| Preset | mono | coreclr | naotllvm |
|--------|:-:|:-:|:-:|
| devloop | ✓ | ✓ | ✓ |
| no-workload | ✓ | ✓ | ✓ |
| native-relink | ✓ | ✓ | ✓ |
| aot | ✓ | — | — |
| no-jiterp | ✓ | — | — |
| invariant | ✓ | ✓ | ✓ |
| no-reflection-emit | ✓ | ✓ | ✓ |

## Approximate Effective Combination Count

For a single SDK commit with **runtime=mono** (the primary target):

- **empty-browser**: 7 presets × 5 engine/profiles = 35 measurements
- **empty-blazor**: 5 presets × 3 engine/profiles = 15 measurements
- **blazing-pizza**: 5 presets × 3 engine/profiles = 15 measurements
- **havit-bootstrap**: 5 presets × 3 engine/profiles = 15 measurements
- **microbenchmarks**: 7 presets × 5 engine/profiles = 35 measurements

**Total per commit (mono)**: ~115 measurements

Each measurement produces one result JSON file with the full set of metrics for that combination.

## Build Phases

The `build` stage processes presets in two phases:

1. **Non-workload phase** (`devloop`, `no-workload`) — built without `wasm-tools` workload installed
2. **Workload phase** (`native-relink`, `aot`, `no-jiterp`, `invariant`, `no-reflection-emit`) — built after `dotnet workload install wasm-tools`

Both phases build all apps for each applicable preset, producing a build manifest consumed by the `measure` stage.
