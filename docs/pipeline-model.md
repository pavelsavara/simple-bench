# Benchmark Dimensions & Values

Every benchmark result is identified by a tuple of `(app, preset, runtime, engine, profile)`. Not all combinations are valid.

## Apps

| App | SDK | Measurement | Timing Marker | Notes |
|-----|-----|-------------|---------------|-------|
| `empty-browser` | Microsoft.NET.Sdk.WebAssembly | measure-external | Yes (JSImport → `dotnet_managed_ready`) | Minimal console app |
| `empty-blazor` | Microsoft.NET.Sdk.BlazorWebAssembly | measure-external | No (standard Blazor startup) | Minimal Blazor template |
| `blazing-pizza` | Microsoft.NET.Sdk.BlazorWebAssembly | measure-external + pizza-walkthrough | No | Multi-page Blazor app with order workflow |
| `microbenchmarks` | Microsoft.NET.Sdk.WebAssembly | measure-internal | Yes (`bench_complete`) | JS interop, JSON, exception perf |

**Routing rules** (run-measure-job.mjs):
- `BROWSER_ONLY_APPS = {empty-blazor, blazing-pizza}` → chrome + firefox only (no CLI engines)
- `INTERNAL_APPS = {microbenchmarks}` → uses `measure-internal.mjs` instead of `measure-external.mjs`
- Default (empty-browser) → all 4 engines

## Presets

Build optimization profiles defined in `src/presets.props`, mapped to MSBuild args in `scripts/lib/build-config.mjs`.

### Non-workload presets (no wasm-tools needed)

| Preset | Config | WasmBuildNative | Key Properties |
|--------|--------|-----------------|----------------|
| `devloop` | Debug | false | Symbols, full ICU, EventSource, no compression, webcil off |
| `no-workload` | Release | false | Aggressive trimming, no native build |

### Workload presets (require `dotnet workload install wasm-tools`)

| Preset | Config | WasmBuildNative | Key Properties |
|--------|--------|-----------------|----------------|
| `native-relink` | Release | true | WasmNativeStrip, aggressive trimming |
| `aot` | Release | true | RunAOTCompilation=true — **mono only** |
| `no-jiterp` | Release | true | BlazorWebAssemblyJiterpreter=false — **mono only** |
| `invariant` | Release | true | InvariantGlobalization, InvariantTimeZone, full TrimMode, diagnostics off |
| `no-reflection-emit` | Release | true | DynamicCodeSupport=false — inherits invariant's strict settings |

**Invariant & no-reflection-emit** share the strictest trimming: `TrimMode=full`, no diagnostics, no metrics, no stack traces, predefined cultures only.

## Runtimes

| Runtime | MSBuild Value | Constraints |
|---------|---------------|-------------|
| `mono` | `/p:RuntimeFlavor=Mono` | Supports all 7 presets |
| `coreclr` | `/p:RuntimeFlavor=CoreCLR` | Cannot use `aot` or `no-jiterp` presets. Extra `r2r` preset. |
| `naotllvm` | - | -future- |

**Validation** (build-config.mjs): `aot` or `no-jiterp` with `coreclr` → error.

## Engines

### Browser engines (via Playwright)

| Engine | CDP | Download Size | Memory Peak | Profiles |
|--------|-----|---------------|-------------|----------|
| `chrome` | Yes | Yes (Network.loadingFinished encodedDataLength) | Yes (JSHeapUsedSize sampled 100ms) | desktop + mobile |
| `firefox` | No | No (null) | No (null) | desktop only |

### CLI engines

| Engine | Command | How It Works |
|--------|---------|-------------|
| `v8` | `d8 --module main.js` | Parses stdout JSON for `time-to-reach-managed` |
| `node` | `node main.js` | Same stdout parsing |

CLI engines measure timing only (no download size, no memory). Fall back to wall-clock if marker absent.

**Engine selection** (run-measure-job.mjs):
- Explicit `--engine` filter → use it
- `--dry-run` → `['chrome']` only
- Browser-only apps → `['chrome', 'firefox']`
- Default → `['chrome', 'firefox', 'v8', 'node']`

## Profiles

| Profile | CPU | Network | Engine |
|---------|-----|---------|--------|
| `desktop` | 1x (none) | Unlimited | All |
| `mobile` | 3x slowdown | 20 Mbps ↓ / 5 Mbps ↑ / 70ms RTT | Chrome only (requires CDP) |

**Profile selection** (run-measure-job.mjs):
- Explicit `--profile` filter → use it
- `engine != 'chrome'` → `['desktop']` only
- Chrome → `['desktop', 'mobile']`

## Metrics

### External metrics (all apps except microbenchmarks)

| Metric | Unit | Source | Availability |
|--------|------|--------|-------------|
| `compile-time` | ms | `compile-time.json` written during build | All |
| `disk-size-total` | bytes | Walk publish dir recursively | All |
| `disk-size-wasm` | bytes | `_framework/*.wasm` | All |
| `disk-size-dlls` | bytes | `_framework/*.dll` | All |
| `download-size-total` | bytes | CDP Network.loadingFinished sum | Chrome only |
| `time-to-reach-managed` | ms | Min of N warm reloads to `dotnet_managed_ready` | Apps with marker + any engine |
| `time-to-reach-managed-cold` | ms | First navigation (no cache) | Apps with marker + any engine |
| `memory-peak` | bytes | CDP Performance.getMetrics JSHeapUsedSize max | Chrome only |
| `pizza-walkthru` | ms | Playwright order workflow wall-clock | blazing-pizza + Chrome only |

### Internal metrics (microbenchmarks only)

| Metric | Unit | What It Measures |
|--------|------|-----------------|
| `js-interop-ops` | ops/sec | Tight loop: JS calls C# [JSExport] method |
| `json-parse-ops` | ops/sec | JS passes JSON to C# method that deserializes |
| `exception-ops` | ops/sec | JS calls C# method that throws/catches |

Plus `memory-peak` (Chrome only) from CDP.

## Combination Matrix

**Per preset×runtime pair**, a full run produces:

| App | chrome desktop | chrome mobile | firefox desktop | v8 desktop | node desktop | Total |
|-----|--------|--------|---------|----|----|-------|
| empty-browser | ✓ | ✓ | ✓ | ✓ | ✓ | 5 |
| empty-blazor | ✓ | ✓ | ✓ | — | — | 3 |
| blazing-pizza | ✓ | ✓ | ✓ | — | — | 3 |
| microbenchmarks | ✓ | ✓ | ✓ | ✓ | ✓ | 5 |
| **Total** | | | | | | **16** |

Valid preset×runtime pairs: 7 (mono) + 5 (coreclr, future) = 12.  
Current matrix (mono only): 7 × 16 = **112 measurement runs** per SDK commit.  
Future matrix (with coreclr): 12 × 16 = **192 measurement runs** per SDK commit.
