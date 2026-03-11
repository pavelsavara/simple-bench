# Future Work

Items deferred from the initial implementation. Revisit as the system matures.

## CoreCLR Runtime

Add `coreclr` as a measured runtime alongside `mono`. Requires CoreCLR-on-WASM to reach feature parity with Mono's Browser target. When enabled:
- 6 valid presets: `devloop`, `no-workload`, `native-relink`, `invariant`, `no-reflection-emit`, `r2r` (`aot` and `no-jiterp` are mono-only; `r2r` is coreclr-only)
- The `r2r` (ReadyToRun) preset enables pre-compiled IL for faster startup on CoreCLR
- Adds measurement runs per SDK commit (6 presets × 16 engine/profile combos = 96)
- Runtime pack enumeration needs a CoreCLR browser-wasm package source

## Dashboard Overview Tab

The first-pass dashboard shows per-app metric charts with filters. A richer overview tab is deferred:

### KPI Tiles

Per-app summary cards with one tile per key metric, using a **reference series** (`mono/no-workload/desktop/chrome` for external apps, `mono/no-workload/desktop/v8` for microbenchmarks):

| App | KPI Metrics |
|-----|------------|
| `empty-browser` | `time-to-reach-managed`, `download-size-total`, `compile-time` |
| `empty-blazor` | `time-to-reach-managed`, `download-size-total`, `compile-time` |
| `blazing-pizza` | `time-to-reach-managed`, `download-size-total`, `pizza-walkthru` |
| `microbenchmarks` | `js-interop-ops`, `json-parse-ops`, `exception-ops` |

Each tile shows:
1. **Current value** — latest data point
2. **Delta vs previous build** — percentage change (green ▼ = improvement for time/size, red ▲ = regression)
3. **Delta vs last frozen release** — comparison to latest frozen release's last column (e.g. Net10 GA)

Direction-aware arrows per metric type:
- Time/size: lower is better (▼ green, ▲ red)
- Throughput (ops/sec): higher is better (▲ green, ▼ red)

### Sparklines

Tiny inline charts (last 30 days) for the top 2 metrics per app. Quick visual trend without switching tabs. Same reference series.

### Click-through

Clicking an app card navigates to that app's detail tab.

## Regression Alerts

Threshold-based detection → auto-file GitHub issues. Detect sustained regressions (not just noise) by comparing rolling averages or percentile bands.

## Historical Backfill

Import data from existing perf runs (e.g. WasmPerformanceMeasurements). The `migrate-old-data.mjs` script handles schema mapping.

## WASI Target

Add `wasi-node` and `wasmtime` engines when CoreCLR WASI matures. Requires new engine routing and CLI measurement support.

## NativeAOT-LLVM Runtime

Add `naotllvm` as a runtime flavor when NativeAOT-LLVM for browser WASM matures. This would be a separate runtime target distinct from Mono, producing fully AOT-compiled WASM via LLVM. Currently listed as a legacy alias for `mono` in the enum for backward compatibility with old result data.

## Granular AppBundle Size Tracking

Track individual file sizes (`dotnet.native.wasm`, `icudt.dat`, per-assembly sizes) in addition to totals, for finer-grained size regression detection.

## Environment Fingerprint

Capture `uname -a`, `/proc/cpuinfo`, `/proc/meminfo`, browser versions, emscripten version alongside results for reproducibility and cross-machine comparisons.

## Compact Index Format (IdMap)

If month index files grow too large, adopt integer ID mapping (flavor→int, metric→int) to compress the index, as used in radekdoulik/bench-results.

## Percentile Storage for Microbenchmarks

Store min/p50/p99 across multiple runs rather than a single value — reduces noise. bench-results stores `minTimes`.

## Gap-Filling Scheduler

Adopt radekdoulik/bench-results pattern — track measured vs. unmeasured commits over a window, pick the midpoint of the largest gap for backfill when CI capacity is idle.
