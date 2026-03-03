# Migration: WasmPerformanceMeasurements → simple-bench

This document maps the old `radekdoulik/WasmPerformanceMeasurements` data format to the new `simple-bench` schema and defines the transformation rules for importing historical data.

## Source Repositories

| Role | Repository | Location |
|------|-----------|----------|
| **Tools** | `radekdoulik/bench-results` | Controller, bench-current.sh, WasmBenchmarkResults (C# post-processor) |
| **Data** | `radekdoulik/WasmPerformanceMeasurements` | `measurements/{hash40}/…` — 5334 commits, 85K files, 2022-03 to 2025-11 |
| **Benchmark app** | `dotnet/runtime` | `src/mono/sample/wasm/browser-bench/` — the C# + JS measurement harness |

## Old Data Structure

### Directory layout

```
measurements/
├── index2.zip                     # Compressed index.json (~49 MB uncompressed)
├── jsonDataFiles.txt              # List of all results.json paths
├── latest.txt                     # Last processed commit hash
├── slices/
│   └── last.zip                   # "Last 14 days" slice of index (~76 KB)
└── {hash40}/                      # One directory per git commit (5334 dirs)
    ├── versions.txt               # Browser versions
    ├── hw-info.txt                # /proc/meminfo + /proc/cpuinfo
    ├── system.txt                 # uname -a
    ├── emscripten-version.txt     # Emscripten version (some commits)
    └── {build}/                   # aot, interp, nativeaot
        └── {config}/              # default, simd, wasm-eh, simd+wasm-eh, …
            └── {env}/             # chrome, firefox
                ├── results.json   # Raw benchmark results + computed minTimes
                ├── results.html   # Human-readable HTML report
                └── git-log.txt   # Git commit message + author + date
```

### Discovered builds, configs, environments (from all 5334 commits)

| Dimension | Values |
|-----------|--------|
| **Builds** | `aot`, `interp`, `nativeaot` |
| **Configs** | `default`, `simd`, `wasm-eh`, `simd+wasm-eh`, `nosimd`, `threads`, `mt`, `legacy`, `hybrid-globalization` |
| **Environments** | `chrome`, `firefox` (only these two; no v8/node in old data) |

### results.json schema

```json
{
  "results": [
    { "span": "00:00:04.8720000", "steps": 103, "taskName": "AppStart", "measurementName": "Page show" },
    ...
  ],
  "minTimes": {
    "AppStart, Page show": 42.038,
    "Exceptions, TryCatch": 0.0000626,
    ...
  },
  "timeStamp": "11/18/2025 22:10:27"
}
```

- `results[]`: Raw individual runs — each has a TimeSpan `span`, iteration count `steps`, and names.
- `minTimes`: Pre-computed `min(span.TotalMilliseconds / steps)` across all iterations for each `"taskName, measurementName"` key. **Unit: milliseconds per operation.**
- `timeStamp`: When the benchmark ran (local time of the node).

### index.json schema (inside index2.zip)

```json
{
  "FlavorMap": { "aot.default.chrome": 0, "interp.default.firefox": 3, ... },
  "MeasurementMap": { "AppStart, Page show": 0, "Size, AppBundle": 24, ... },
  "Data": [
    {
      "hash": "917a0b1...",
      "flavorId": 0,
      "commitTime": "2022-03-14T18:08:17-04:00",
      "minTimes": { "0": 64.11, "1": 459.86, ... },
      "sizes": { "24": 12100920, "25": 1758720, ... }
    }
  ]
}
```

- 17 unique flavors (build.config.env triples)
- 727 measurement names (but ~650+ are per-file Size entries or error strings)
- 21,040 data entries across all flavors and commits
- `sizes` map uses measurement IDs from MeasurementMap (e.g. 24 = "Size, AppBundle")

### Old measurement categories

| Category | Count | Examples | Notes |
|----------|-------|---------|-------|
| AppStart | ~12 | Page show, Reach managed, Reach managed cold, Blazor Page show, Browser Page show, … | ms/op — startup timing |
| Size | ~650+ | AppBundle, managed, dotnet.wasm, icudt.dat, per-file sizes for blazor-template/**/*, browser-template/**/* | Bytes — per-file sizes |
| Exceptions | ~8 | NoExceptionHandling, TryCatch, TryCatchThrow, TryFinally, … | ms/op — exception handling |
| Json | ~6 | small/large serialize/deserialize, non-ASCII | ms/op |
| String | ~14 | Normalize, Compare, IndexOf, StartsWith, … | ms/op |
| Span | ~6 | Reverse, IndexOf, SequenceEqual | ms/op |
| Vector | ~16 | Create, Add, Multiply, Dot product, Sum, Min, Max, … | ms/op |
| JSInterop | ~7 | JSExportInt, JSImportString, JSImportManyArgs, LegacyExportInt, … | ms/op |
| WebSocket | ~6 | PartialSend_1B, PartialReceive_100KB, … | ms/op |

---

## Import Decisions

Based on Q&A with @pavelsavara:

| Decision | Choice |
|----------|--------|
| **Import scope** | All historical data (all 5334 commits, 2022-2025) |
| **Build → runtime mapping** | `interp` → `mono`, `aot` → `mono`, `nativeaot` → `naotllvm` (new runtime) |
| **Config filter** | **Only** `default` — import `aot.default` and `interp.default`, drop all other configs |
| **Environment mapping** | `chrome` → `chrome`, `firefox` → `firefox` (no v8/node in old data) |
| **App mapping** | browser-template → `empty-browser`, blazor-template → `empty-blazor` |
| **Timing metrics** | Only AppStart → Reach managed (warm + cold). Drop all other categories. |
| **Size metrics** | `disk-size-total`, `disk-size-wasm`, `disk-size-dlls`. Ignore ICU. |
| **Unit** | Keep as ms/op for AppStart metrics. Change internal ops metrics to ops/sec (model update). |
| **sdkVersion** | Set to `"unknown"` (old data doesn't store SDK version) |
| **Timeout filter** | Values ≥ 20000ms filtered as failed measurements |
| **Data source** | `index.json` from `index2.zip` (pre-computed minTimes and sizes) |
| **Script** | `scripts/migrate-old-data.mjs` — implemented and tested |

---

## Dimension Mapping

### Build → Runtime

| Old build | New runtime | Notes |
|-----------|-------------|-------|
| `interp` | `mono` | Interpreter mode; maps to preset=`no-workload` |
| `aot` | `mono` | AOT compilation; maps to preset=`aot` |
| `nativeaot` | `naotllvm` | New runtime value to add to model |

### Build + Config → Runtime + Preset

The old system combines `build` and `config` into the flavor triple. The new system has a separate `runtime` and `preset`. Only the `default` config is imported (fullest history and richest metrics).

| Old build | Old config | New runtime | New preset | Import? |
|-----------|-----------|-------------|------------|---------|
| `interp` | `default` | `mono` | `no-workload` | ✅ |
| `aot` | `default` | `mono` | `aot` | ✅ |
| `aot` | `simd+wasm-eh` | — | — | ❌ dropped (only 6 months of data, conflicts with `aot.default`) |
| `aot` | `simd` | — | — | ❌ dropped |
| `aot` | `wasm-eh` | — | — | ❌ dropped |
| `aot` | `nosimd` | — | — | ❌ dropped |
| `nativeaot` | `default` | `naotllvm` | `no-workload` | ❌ dropped (only 1 entry) |
| `interp` | `threads` | — | — | ❌ dropped |
| `*` | `legacy`, `hybrid-globalization` | — | — | ❌ dropped |

**Result**: `aot/default/{chrome,firefox}` → `mono/aot/{chrome,firefox}` and `interp/default/{chrome,firefox}` → `mono/no-workload/{chrome,firefox}`. This yields 15,381 source entries → 21,813 result files (some entries produce both browser and blazor results).

### Environment → Engine

| Old env | New engine |
|---------|-----------|
| `chrome` | `chrome` |
| `firefox` | `firefox` |

### Template → App

The old AppStart measurements have prefixes that indicate which template:

| Old measurement prefix | Old template | New app |
|----------------------|-------------|---------|
| `AppStart, Reach managed` (no prefix) | browser-template | `empty-browser` |
| `AppStart, Browser Reach managed` | browser-template | `empty-browser` |
| `AppStart, Blazor Reach managed` | blazor-template | `empty-blazor` |

Note: The unprefixed `AppStart, Reach managed` and `AppStart, Browser Reach managed` both refer to the browser template. The "Browser" prefix was added later; older data uses unprefixed names.

---

## Metric Mapping

### Timing metrics (imported)

Only AppStart "Reach managed" variants are imported. Unit is **ms** (milliseconds per operation, but for startup it's effectively just milliseconds since steps=1 per page load cycle).

| Old measurement key | New metric key | Unit | Template → App |
|--------------------|---------------|------|----------------|
| `AppStart, Reach managed` | `time-to-reach-managed` | `ms` | `empty-browser` |
| `AppStart, Reach managed cold` | `time-to-reach-managed-cold` | `ms` | `empty-browser` |
| `AppStart, Browser Reach managed` | `time-to-reach-managed` | `ms` | `empty-browser` |
| `AppStart, Browser Reach managed cold` | `time-to-reach-managed-cold` | `ms` | `empty-browser` |
| `AppStart, Blazor Reach managed` | `time-to-reach-managed` | `ms` | `empty-blazor` |
| `AppStart, Blazor Reach managed cold` | `time-to-reach-managed-cold` | `ms` | `empty-blazor` |

#### Dropped AppStart metrics (not imported)

| Old key | Reason |
|---------|--------|
| `AppStart, Page show` | Not requested |
| `AppStart, Blazor Page show` | Not requested |
| `AppStart, Browser Page show` | Not requested |
| `AppStart, Blazor First UI` | Not requested |
| `AppStart, Blazor Reach managed snapshot` | Not requested |
| `AppStart, Browser Reach managed snapshot` | Not requested |

### Size metrics (imported)

Size data comes from the index's `sizes` field (or from result JSON's `minTimes` for Size-prefixed entries). Only select aggregate sizes are imported.

| Old measurement key(s) | New metric key | Unit | Notes |
|------------------------|---------------|------|-------|
| `Size, AppBundle` (id 24) or `Size, blazor-template` (id 105) / `Size, browser-template` (id 250) | `download-size-total` | `bytes` | Total published app size |
| `Size, dotnet.wasm` (id 26) or `Size, dotnet.native.wasm` (id 76) | `download-size-wasm` | `bytes` | The main WASM binary |
| `Size, managed` (id 25) | `download-size-dlls` | `bytes` | Managed DLL assemblies total |

**Ignored**: `Size, icudt.dat`, `Size, icudt_no_CJK.dat`, `Size, icudt_EFIGS.dat`, `Size, icudt_hybrid.dat` and all per-individual-file sizes (hundreds of entries for each file in blazor-template and browser-template).

### Dropped categories (not imported)

| Category | Reason |
|----------|--------|
| Exceptions | Not needed for initial import |
| Json | Not needed for initial import |
| String | Not needed for initial import |
| Span | Not needed for initial import |
| Vector | Not needed for initial import |
| JSInterop | Not needed for initial import |
| WebSocket | Not needed for initial import |

---

## Transformation Rules

### 1. Commit identity

| Old field | New field | Transformation |
|-----------|-----------|---------------|
| `hash` (40 chars) | `runtimeGitHash` | Direct copy (old data only has one hash; used as runtime hash) |
| `hash` (40 chars) | `sdkGitHash` | Copy same hash (no separate SDK hash available in old data) |
| (not available) | `vmrGitHash` | Set to `""` (VMR didn't exist for old Mono data) |
| `commitTime` (ISO with offset) | `commitDate` + `commitTime` | Parse → UTC → `YYYY-MM-DD` and `HH-MM-SS-UTC` |
| (not available) | `sdkVersion` | Set to `"unknown"` or reconstruct from runtime version info |
| `timeStamp` | (not mapped) | CI run timestamp — not used in new schema |

### 2. File path construction

From old: `measurements/{hash40}/aot/simd+wasm-eh/chrome/results.json`

New: `data/{year}/{YYYY-MM-DD}/{HH-MM-SS-UTC}_{runtimehash7}_mono_aot_chrome_empty-browser.json`

Steps:
1. Parse `commitTime` → UTC date + time
2. `{year}` = date's year
3. `{YYYY-MM-DD}` = date
4. `{HH-MM-SS-UTC}` = time in UTC with dashes
5. `{runtimehash7}` = first 7 chars of hash
6. `{runtime}` = `mono` (for aot build)
7. `{preset}` = `aot` (for aot build)
8. `{engine}` = `chrome`
9. `{app}` = derived from measurement prefix (empty-browser or empty-blazor)

### 3. Per-run result JSON construction

For each imported entry, produce **two** result JSON files (one per app if both templates have data):

```json
{
  "meta": {
    "commitDate": "2023-06-15",
    "commitTime": "14-23-45-UTC",
    "sdkVersion": "unknown",
    "runtimeGitHash": "abc1234def5678abc1234def5678abc1234def56",
    "sdkGitHash": "abc1234def5678abc1234def5678abc1234def56",
    "vmrGitHash": "",
    "runtime": "mono",
    "preset": "aot",
    "engine": "chrome",
    "app": "empty-browser",
    "ciRunId": "migrated",
    "ciRunUrl": "https://github.com/radekdoulik/WasmPerformanceMeasurements"
  },
  "metrics": {
    "time-to-reach-managed": 289.15,
    "time-to-reach-managed-cold": 7446,
    "download-size-total": 12100920,
    "download-size-wasm": 8187744,
    "download-size-dlls": 1758720
  }
}
```

### 4. Month index construction

After generating all per-run JSON files, build month index files by scanning date directories and grouping by `YYYY-MM`.

### 5. Data source selection

The migration script should read from **index.json** (inside `index2.zip`), not from individual results.json files. The index contains all the pre-computed minTimes and sizes needed, keyed by compact IDs.

Advantages of using the index:
- Single 49MB file vs 85K individual files
- Already has commitTime parsed
- Has pre-computed minTimes (minimum across runs)
- Has sizes data inline

### 6. Filtering pseudocode

```
for each entry in index.Data:
    flavor = FlavorMap.reverse[entry.flavorId]  # e.g. "aot.default.chrome"
    parse flavor → (build, config, env)

    # Filter: only default config, only aot and interp builds
    if flavorId not in {0, 1, 2, 3}: skip

    # Map build to runtime+preset
    if build == "aot":     runtime="mono",  preset_new="aot"
    if build == "interp":  runtime="mono",  preset_new="no-workload"

    # Parse commitTime → UTC
    date, time = parse_to_utc(entry.commitTime)

    # Extract metrics from minTimes using MeasurementMap IDs
    metrics_browser = extract_browser_metrics(entry.minTimes, entry.sizes)
    metrics_blazor  = extract_blazor_metrics(entry.minTimes, entry.sizes)

    # Write per-run JSON files
    if metrics_browser has data:
        write_result(date, time, entry.hash, runtime, preset_new, env, "empty-browser", metrics_browser)
    if metrics_blazor has data:
        write_result(date, time, entry.hash, runtime, preset_new, env, "empty-blazor", metrics_blazor)
```

---

## Estimated Output Volume

| Metric | Value |
|--------|-------|
| Source entries matched | 15,381 (of 21,040 total in index) |
| Result files written | 21,813 (browser + blazor per entry) |
| Total data size | ~18.8 MB |
| Month index files | 43 (2022-03 through 2025-09) |
| Year directories | 4 (2022, 2023, 2024, 2025) |
| Dimensions | mono × {aot, no-workload} × {chrome, firefox} × {empty-browser, empty-blazor} |

---

## Model Updates Required

The following changes to `docs/model.md` are needed to support the migration:

1. **Add `naotllvm` to runtime dimension** — new runtime flavor for NativeAOT data
2. **Add warm/cold reach-managed metrics** — `time-to-reach-managed` (ms) and `time-to-reach-managed-cold` (ms)
3. **Add size breakdown metrics** — `disk-size-total`, `disk-size-wasm`, `disk-size-dlls` (all bytes)
4. **Change ops/min → ops/sec** for internal microbenchmark metrics (per user request)
5. **Remove `time-to-first-ui-change`** — replaced by `time-to-reach-managed` which is the actual measured concept

---

## Resolved Questions

1. **interp/default data**: ✅ Resolved — importing `interp/default` → `mono/no-workload` (4286 chrome + 3080 firefox entries).

2. **nativeaot data**: ✅ Resolved — not imported (only 1 entry in index).

3. **sdkVersion**: ✅ Resolved — set to `"unknown"`.

4. **Size data availability**: ✅ Resolved — sizes are included when present. Missing sizes produce result files without `download-size-*` metrics. Size AppBundle available for ~82% of entries; managed/dotnet.wasm available for ~13%/~10%.

5. **Timeout values**: ✅ Resolved — values ≥ 20,000ms are filtered out as failed measurements.

6. **Error-as-measurement-name**: ✅ Auto-excluded — we only extract specific measurement IDs.

7. **Blazor data quality**: ✅ Resolved — Blazor entries with timeout values are filtered. Valid Blazor metrics are imported (available from ~Oct 2023 onward).
