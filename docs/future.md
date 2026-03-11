# Future Work

Items deferred from the initial implementation. Revisit as the system matures.

## CoreCLR Runtime

Add `coreclr` as a measured runtime alongside `mono`. Requires CoreCLR-on-WASM to reach feature parity with Mono's Browser target. When enabled:
- 5 valid presets: `devloop`, `no-workload`, `native-relink`, `invariant`, `no-reflection-emit` (`aot` and `no-jiterp` are mono-only)
- Adds 80 measurement runs per SDK commit (5 × 16)
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

Add `wasi-node` and `wasmtime` engines when CoreCLR WASI matures. Requires new engine routing in `run-measure-job.mjs` and CLI measurement support.

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


## Overview Tab

The default landing page. Shows a high-level health summary: how is the latest build doing compared to previous builds and older .NET releases?

### Layout

```
┌─ Latest Build ────────────────────────────────────────────────────────┐
│  SDK: 11.0.100-preview.3.26153.117   Date: 2026-03-05   Commit: abc1234  │
└───────────────────────────────────────────────────────────────────────┘

┌─ empty-browser ───────────────────────────────────────────────────────┐
│                                                                       │
│  Time to Managed (warm)    Download Size          Compile Time        │
│  ┌──────────────────┐      ┌──────────────────┐   ┌────────────────┐  │
│  │ 56 ms            │      │ 7.8 MB           │   │ 4,443 ms       │  │
│  │ ▼ 3% vs prev     │      │ ▲ 1% vs prev     │   │ — same         │  │
│  │ ▼ 15% vs Net10   │      │ ▼ 22% vs Net10   │   │ ▼ 40% vs Net10 │  │
│  └──────────────────┘      └──────────────────┘   └────────────────┘  │
│                                                                       │
│  [sparkline: time-to-reach-managed last 30 days]                      │
│  [sparkline: download-size-total last 30 days]                        │
└───────────────────────────────────────────────────────────────────────┘

┌─ empty-blazor ────────────────────────────────────────────────────────┐
│  (same card layout)                                                   │
└───────────────────────────────────────────────────────────────────────┘

┌─ blazing-pizza ───────────────────────────────────────────────────────┐
│  (same card layout + pizza-walkthru KPI)                              │
└───────────────────────────────────────────────────────────────────────┘

┌─ microbenchmarks ─────────────────────────────────────────────────────┐
│  JS Interop: 3.2M ops/sec    JSON Parse: 199K ops/sec                 │
│  ▼ 2% vs prev                ▲ 5% vs prev                            │
└───────────────────────────────────────────────────────────────────────┘
```

### Content Per App Card

Each app gets a summary card with:

**KPI Tiles** — one tile per key metric, using the **reference series** (`mono/no-workload/desktop/chrome` for external apps, `mono/no-workload/desktop/v8` for microbenchmarks):

| App | KPI Metrics |
|-----|------------|
| `empty-browser` | `time-to-reach-managed`, `download-size-total`, `compile-time` |
| `empty-blazor` | `time-to-reach-managed`, `download-size-total`, `compile-time` |
| `blazing-pizza` | `time-to-reach-managed`, `download-size-total`, `pizza-walkthru` |
| `microbenchmarks` | `js-interop-ops`, `json-parse-ops`, `exception-ops` |

Each KPI tile shows:
1. **Current value** — latest data point from the most recent column
2. **Delta vs previous build** — percentage change from the previous column (green ▼ = improvement for time/size metrics, red ▲ = regression)
3. **Delta vs last frozen release** — comparison to the latest frozen release's last column (e.g. Net10 GA)

Arrows are direction-aware per metric type:
- Time/size metrics: lower is better (▼ green, ▲ red)
- Throughput metrics (ops/sec): higher is better (▲ green, ▼ red)

**Sparklines** — tiny inline charts (last 30 days) for the top 2 metrics per app. Gives a quick visual trend without needing to switch tabs. Uses the same reference series.

### Data Source

The overview tab reads from the same view data files as other tabs. It loads:
1. The most recent week header (for latest + previous column metadata)
2. The data files for KPI metrics across all apps for that week
3. The last frozen release header + data for comparison baseline

No additional transformer output needed — the overview assembles KPIs from existing data.

### Click-through

Clicking an app card navigates to that app's detail tab.
